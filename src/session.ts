/**
 * One console connection: a raw TCP socket to a console-server port, plus the
 * telnet/encoding/paging behaviour layered on it.
 *
 * The session is deliberately socket-shaped rather than shell-shaped: a console
 * mapping carries a device CLI, not an interactive login shell, so there is no
 * PTY, no resize, and no signal vocabulary. What it does own is paging — the
 * `--More--` family that every network CLI emits — which is handled here so
 * neither the panel nor the model has to babysit it.
 *
 * Every read is cursor-addressed over a bounded scrollback window: a reader
 * either gets exactly the bytes it missed or learns they aged out.
 *
 * @module dsh-console-hub/session
 */
import { Socket } from 'node:net'
import { compileSearchPattern, type PagingMode, type ConsoleKind } from './config-shared.ts'
import {
  createRingBuffer,
  decodeBytes,
  encodeText,
  matchPager,
  matchPrompt,
  negotiationReply,
  stripIac,
  type RingBuffer,
} from './session-codec.ts'

/** Lifecycle state of one console session. */
export type ConsoleSessionPhase = 'connecting' | 'open' | 'closing' | 'closed' | 'error'

/** A machine-coded failure the session recorded instead of throwing. */
export interface ConsoleSessionError {
  /** Stable code: a socket errno, or `peer-closed` / `idle-timeout`. */
  code: string
  /** Human-readable explanation. */
  message: string
}

/** Automatic-paging progress. */
export interface ConsolePagingState {
  /** Whether a pager prompt is currently waiting for someone to act. */
  active: boolean
  /** Pages the session consumed automatically so far. */
  pagesConsumed: number
  /** Why the automatic pager stopped, or is waiting: `null` while idle. */
  reason: 'manual' | 'max-pages' | 'abandoned' | null
  /** The pager text last seen, for logging. */
  lastPager?: string
}

/**
 * Whether the DEVICE has torn the console session down while the socket stayed
 * up — the half-close a console server performs after a long idle period.
 *
 * This is distinct from the socket's own liveness, which is why it needs its own
 * state: the TCP connection is perfectly healthy and the plugin's `state` stays
 * `open`, but the device prints nothing at all until a key arrives. A caller
 * that only looked at `state` would wait forever for output that never comes.
 */
export interface ConsoleDormancyState {
  /**
   * Whether the device is currently believed dormant.
   *
   * Set when the marker text is seen, and REFUTED — never merely assumed
   * recovered — once fresh device output arrives after a wake, or after a
   * command comes back with a prompt. Seeing the marker is proof; not seeing it
   * is not.
   */
  dormant: boolean
  /** When the marker was last seen (ISO), or null. */
  detectedAt: string | null
  /** The marker text as the device printed it, for display. */
  marker: string | null
  /** Bare Enters this session sent to wake or keep the console awake. */
  wakesSent: number
  /** Keepalive Enters sent, as opposed to recoveries after a detected dormancy. */
  keepalivesSent: number
}

/** One audit entry: who did what on this console. */
export interface ConsoleAuditEntry {
  /** When it happened (ISO). */
  at: string
  /** Who acted. */
  actor: 'user' | 'model' | 'system'
  /** What they did. */
  action: string
  /** Human-readable detail (never a credential). */
  detail: string
}

/** The full status of one session. */
export interface ConsoleSessionState {
  state: ConsoleSessionPhase
  kind: ConsoleKind
  host: string
  port: number
  encoding: string
  /** Milliseconds since the last read or write. */
  idleMs: number
  /** When the socket opened (ISO), or null. */
  openedAt: string | null
  /** When the session closed (ISO), or null. */
  closedAt: string | null
  /** Terminal failure, or null. */
  lastError: ConsoleSessionError | null
  /** Prompt found on the most recent read, or null. */
  prompt: string | null
  paging: ConsolePagingState
  /** Whether the device half-closed this idle console (see {@link ConsoleDormancyState}). */
  dormancy: ConsoleDormancyState
  /** Bytes received in total. */
  bytesReceived: number
  /** Bytes written in total. */
  bytesWritten: number
  /** Audit trail, oldest first. */
  audit: readonly ConsoleAuditEntry[]
}

/** What {@link ConsoleSession.open} returns: the status plus the connect banner. */
export interface ConsoleConnectResult extends ConsoleSessionState {
  /** Everything the device said on connect (bounded), telnet noise removed. */
  banner: string
}

/** What one `waitFor` waits for. */
export type ConsoleWaitCondition = 'prompt' | 'idle' | 'pattern'

/** Options for {@link ConsoleSession.waitFor}. */
export interface ConsoleWaitOptions {
  /** What to watch for: the CLI prompt, quiet output, or a custom pattern. */
  for?: ConsoleWaitCondition
  /** Required when `for` is `pattern`; a case-insensitive regular expression body. */
  pattern?: string
  /** Budget in milliseconds; defaults to the session's read timeout. */
  timeoutMs?: number
  /** Cursor the wait starts from (the caller's last read cursor). */
  after?: number
  /** Quiet window that satisfies the `idle` condition. */
  idleMs?: number
}

/**
 * What `for: "idle"` means, precisely.
 *
 * The condition is satisfied when output ARRIVED and then stopped arriving for a
 * whole quiet window (`idleQuietMs`, 1500ms by default, overridable per call).
 * Two consequences a caller has to know, because both have bitten:
 *
 * 1. It is a WAIT: a console that has already been quiet for longer than the
 *    window satisfies it as soon as any output arrives. A console with NOTHING
 *    arriving never satisfies it at all -- it times out instead. So read
 *    `matched` rather than assuming silence is success.
 * 2. It is a HEURISTIC, and the quiet window is the whole of it. A device that
 *    pauses longer than the window mid-answer makes this report "done" early --
 *    measured on the lab hardware at ~1014ms between slabs, which is why the
 *    default sits above that. `for: "prompt"` is the reliable "the command
 *    finished" signal; use idle only for output that does not end in a prompt.
 */
export type ConsoleIdleSemantics = 'output-arrived-then-stopped-for-idleMs'

/** The outcome of one `waitFor`. */
export interface ConsoleWaitResult {
  /** Whether the condition was met inside the budget. */
  matched: boolean
  /** The prompt or pattern text that satisfied it. */
  matchedText?: string
  /** Cursor to pass as the next `read`'s `after`. */
  cursor: number
  /** Milliseconds spent waiting. */
  elapsedMs: number
  /** Why it ended. */
  reason: 'matched' | 'timeout' | 'closed'
  /** Pager state after the wait. */
  paging: ConsolePagingState
  /** Whether the device went dormant during the wait (the wait may still have matched). */
  dormant: boolean
  /**
   * Set when the wait STARTED with the device dormant and could not do anything
   * about it before the budget ran out.
   *
   * A caller that waited for a prompt on a dormant console gets no output and no
   * prompt — indistinguishable from "the device is slow" unless this says so.
   */
  dormantBlocked?: boolean
}

/** How often a wait re-examines the tail of the output. */
const WAIT_POLL_MS = 25

/** What one `read` returns. */
export interface ConsoleReadResult {
  /** Decoded text from `after` onward, capped by the output limit. */
  text: string
  /** Absolute cursor to pass as the next call's `after`. */
  cursor: number
  /** Whether more bytes remained than the output limit allowed. */
  truncated: boolean
  /** Bytes available at `after` (before the output cap). */
  bytes: number
  /** Encoding actually used. */
  encoding: string
  /** Prompt found at the tail of the returned text, or undefined. */
  prompt?: string
  /** Pager found at the tail of the returned text, or undefined. */
  pager?: string
  /** Paging progress after this read. */
  paging: ConsolePagingState
  /** Whether the device is dormant, for a caller that needs to wake it first. */
  dormant: boolean
  /** Where that belief came from: the marker, or an inference. */
  dormantText?: string
}

/**
 * Drop one echoed command LINE from decoded console output.
 *
 * A device that echoes what was typed repeats the command on its own line, so
 * the filter removes whole lines whose trimmed text equals the command. A naive
 * substring removal would corrupt a legitimate answer that merely CONTAINS the
 * command — a `show version` whose output mentions `show version` is exactly the
 * output a caller asked for, and must survive.
 *
 * @param text - the decoded output.
 * @param command - the command whose echo should be removed (empty = no-op).
 * @returns the text without its echoed command lines.
 */
export function stripEchoedCommand(text: string, command: string): string {
  const target = command.trim()
  if (target === '') return text
  return text
    .split(/(?<=\n)/)
    .filter(line => line.replace(/[\r\n]+$/, '').trim() !== target)
    .join('')
}

/** Construction options for one session (already defaulted by the caller). */
export interface ConsoleSessionOptions {
  host: string
  port: number
  kind: ConsoleKind
  encoding: string
  connectTimeoutMs: number
  readTimeoutMs: number
  pagingMode: PagingMode
  pagingMaxPages: number
  pagingQuietMs: number
  /**
   * Quiet window that satisfies `waitFor({for:'idle'})`, in milliseconds.
   *
   * A per-session default so the value is a deployment setting rather than a
   * literal buried in the wait loop; a call may still override it. See
   * {@link ConsoleIdleSemantics} for what it means and why 1500 is the default.
   */
  idleQuietMs: number
  /** Compiled, tail-anchored prompt matcher. */
  promptPattern: RegExp
  /** Compiled, tail-anchored pager matcher. */
  pagerPattern: RegExp
  /**
   * Compiled, UNANCHORED matcher for the "the console timed out, press ENTER"
   * marker a device prints when it has half-closed an idle session.
   *
   * Unanchored on purpose, unlike the prompt and pager matchers: the marker
   * arrives in the middle of output, not at the tail waiting to be matched.
   */
  dormantPattern: RegExp
  /**
   * Answer that marker with one bare Enter — the keystroke the device is asking
   * for by printing it.
   *
   * On by default, because the marker IS a request for a keypress: a console
   * that prints it and receives nothing stays silent forever, and every later
   * read is empty.
   *
   * It is also the master switch for the keepalive: the panel presents this as
   * one "automate the Enters" box, so `false` stops {@link dormantProbeMs} too.
   */
  dormantAutoWake: boolean
  /**
   * Idle milliseconds after which a bare Enter is sent to stop an idle console
   * timing out. `0` disables the keepalive entirely.
   *
   * A keepalive, not a recovery: it fires BEFORE the device's own timeout, so
   * the device never half-closes in the first place and keeps printing its
   * events. Detecting the half-close afterwards is strictly worse — the device
   * has already stopped printing by then.
   *
   * Gated by {@link dormantAutoWake}, which the panel shows as the single
   * "automate the Enters" switch: a non-zero window here sends nothing while
   * that flag is off. The window itself is preserved, so re-checking the box
   * resumes on the interval the operator already chose.
   */
  dormantProbeMs: number
  scrollbackLimitBytes: number
  /** Cap on one read's returned text (bytes). */
  outputLimitBytes?: number
  /** Login password, used once to answer a password prompt and then dropped. */
  password?: string
  /** How long `open` waits for a banner/prompt before reporting what it has. */
  bannerWindowMs?: number
  /**
   * Send one bare Enter when the device says nothing on connect.
   *
   * Some console servers -- both lab devices among them -- send only the Telnet
   * negotiation burst and then stay silent until a key is pressed. With no
   * banner and no prompt there is nothing for the caller (or the model) to key
   * off, so the console looks dead when it is merely asleep. One Enter turns it
   * into an ordinary CLI.
   *
   * The Enter is sent ONLY when the banner window elapsed without a prompt, so
   * a device that greets on connect never receives an unsolicited keystroke.
   */
  wakeOnConnect?: boolean
}

/** Default page size cap when the caller declares none. */
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024

/** How much trailing text the pager/prompt matcher is given. */
const TAIL_BYTES = 1024

/** Cap on the banner text returned by {@link ConsoleSession.open}. */
const BANNER_LIMIT_BYTES = 4096

/**
 * How long a session waits for fresh device output after sending a wake Enter
 * before concluding the device is still dormant.
 *
 * The measured wake round trip on both lab devices is 35-45ms, so this is an
 * order of magnitude of headroom for a slower box. It is a budget for ONE
 * attempt, not a retry policy: a second Enter would be a second unsolicited
 * keystroke, and a console that ignores the first is not fixed by a second.
 */
const WAKE_SETTLE_MS = 400

/**
 * How much of the ringing scrollback is searched for the dormancy marker.
 *
 * Search, not tail-match: the marker is emitted mid-stream and is then followed
 * by nothing at all, so anchoring it to the tail — the way a prompt is anchored
 * — would miss it as soon as the reader's own output shifted the tail. The
 * window is the newest bytes only, so a marker printed an hour ago and long
 * since pushed out cannot resurrect a stale belief.
 */
const DORMANT_WINDOW_BYTES = 4096

/** Bound a UTF-8 string to a byte budget without splitting a code point. */
function boundUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  let end = maxBytes
  // Walk back off a continuation byte so the retained prefix decodes cleanly.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/** One console session. Created by the port manager, never directly by tools. */
export class ConsoleSession {
  private readonly options: ConsoleSessionOptions
  private readonly ring: RingBuffer
  private readonly outputLimitBytes: number
  private readonly auditTrail: ConsoleAuditEntry[] = []
  private socket: Socket | undefined
  private phase: ConsoleSessionPhase = 'connecting'
  private banner = ''
  private lastError: ConsoleSessionError | null = null
  private openedAt: string | null = null
  private closedAt: string | null = null
  private lastActivityMs = Date.now()
  /**
   * When this session last WROTE a byte to the device.
   *
   * Deliberately not the same clock as `lastActivityMs`, which advances on
   * every read too (a console somebody is watching must not be reaped). This one
   * drives the keepalive, and it is set ONLY by outbound bytes, because that is
   * what the device's own idle timer counts: measured, a device that streamed
   * output continuously for 300s still timed the session out, so inbound traffic
   * is not what keeps it alive (`scripts/probe-idle-input.mjs`).
   */
  private lastWireAt = Date.now()
  private bytesReceived = 0
  private bytesWritten = 0
  private currentPrompt: string | null = null
  private paging: ConsolePagingState = { active: false, pagesConsumed: 0, reason: null }
  private pagingTimer: NodeJS.Timeout | undefined
  private pagingAbandoned = false
  private pagingHandledAtCursor = 0
  private dormancy: ConsoleDormancyState = { dormant: false, detectedAt: null, marker: null, wakesSent: 0, keepalivesSent: 0 }
  /** Cursor of the newest byte the dormancy search has already examined. */
  private dormantScannedTo = 0
  private keepaliveTimer: NodeJS.Timeout | undefined
  /** Set while `wake()` is mid-flight so a probe cannot stack Enters. */
  private waking = false
  private opened: Promise<ConsoleConnectResult> | undefined
  private password: string | undefined

  /**
   * @param options - fully-defaulted session settings (see the caller).
   */
  constructor(options: ConsoleSessionOptions) {
    this.options = options
    this.ring = createRingBuffer(options.scrollbackLimitBytes)
    this.outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES
    this.password = options.password === undefined || options.password === '' ? undefined : options.password
  }

  /** Append one audit entry, keeping the trail bounded. */
  private record(actor: ConsoleAuditEntry['actor'], action: string, detail: string): void {
    this.auditTrail.push({ at: new Date().toISOString(), actor, action, detail })
    // The trail is diagnostic, not a transcript; keep the newest entries.
    if (this.auditTrail.length > 200) this.auditTrail.splice(0, this.auditTrail.length - 200)
  }

  /** The decoded tail of the scrollback, for prompt/pager matching. */
  private tailText(): string {
    const window = this.ring.slice(Math.max(0, this.ring.written - TAIL_BYTES))
    return decodeBytes(window, this.options.encoding === '' ? 'utf-8' : this.options.encoding)
  }
  /** The connect result: the status plus the banner the device sent. */
  private connectResult(): ConsoleConnectResult {
    return { ...this.status(), banner: this.banner }
  }

  /** Current status snapshot. Never carries a credential. */
  status(): ConsoleSessionState {
    return {
      state: this.phase,
      kind: this.options.kind,
      host: this.options.host,
      port: this.options.port,
      encoding: this.options.encoding === '' ? 'utf-8' : this.options.encoding,
      idleMs: Date.now() - this.lastActivityMs,
      openedAt: this.openedAt,
      closedAt: this.closedAt,
      lastError: this.lastError,
      prompt: this.currentPrompt,
      paging: { ...this.paging },
      dormancy: { ...this.dormancy },
      bytesReceived: this.bytesReceived,
      bytesWritten: this.bytesWritten,
      audit: [...this.auditTrail],
    }
  }

  /**
   * Connect and wait a short window for a banner/prompt.
   *
   * A silent peer is legal (a raw mapping may print nothing), so this resolves
   * with whatever arrived rather than failing on a missing prompt. Calling it
   * again on a live session is a no-op that returns the current status.
   *
   * @returns the status after the attempt.
   */
  async open(): Promise<ConsoleConnectResult> {
    if (this.opened !== undefined) return this.opened
    this.opened = this.connect()
    return this.opened
  }

  /** The connect implementation behind {@link open}'s single-shot promise. */
  private async connect(): Promise<ConsoleConnectResult> {
    const socket = new Socket()
    this.socket = socket
    socket.setNoDelay(true)
    // No read timeout on the socket itself: reads are answered from the local
    // window, so an idle device must not be treated as a failure.
    socket.setTimeout(0)

    const bannerWindowMs = this.options.bannerWindowMs ?? 300
    const connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(`connect to ${this.options.host}:${this.options.port} timed out`), { code: 'ETIMEDOUT' }))
      }, this.options.connectTimeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    socket.on('data', (chunk: Buffer) => {
      this.onData(new Uint8Array(chunk))
    })
    socket.on('close', () => {
      if (this.phase !== 'closing' && this.phase !== 'closed') {
        this.fail('peer-closed', 'the device closed the console connection')
      }
      if (this.phase === 'closing') this.finishClosed()
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // A post-connect socket error is recorded, not thrown: the caller polls
      // `status()` and reads `lastError`.
      if (socket.destroyed) return
      this.fail(error.code ?? 'socket-error', error.message)
    })

    try {
      socket.connect({ host: this.options.host, port: this.options.port })
      await connected
    } catch (error) {
      const failure = error as NodeJS.ErrnoException
      this.fail(failure.code ?? 'connect-failed', failure.message)
      return this.connectResult()
    }

    this.phase = 'open'
    this.openedAt = new Date().toISOString()
    this.lastActivityMs = Date.now()
    this.record('system', 'connect', `connected to ${this.options.host}:${this.options.port} (${this.options.kind})`)

    // Wait for a banner/prompt, but only briefly: a device that says nothing is
    // still a usable raw console.
    const deadline = Date.now() + bannerWindowMs
    while (Date.now() < deadline && this.currentPrompt === null && this.phase === 'open') {
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    // A device that stayed silent through the whole window is very likely
    // asleep rather than absent: some console servers emit nothing at all until
    // a key arrives. One bare Enter wakes it, and only then do we wait the
    // second window for the prompt it produces. A device that already spoke is
    // never sent an unsolicited keystroke.
    if (this.options.wakeOnConnect === true && this.currentPrompt === null && this.phase === 'open') {
      this.write(encodeText('\r', this.options.encoding === '' ? 'utf-8' : this.options.encoding))
      this.record('system', 'wake', 'sent a bare Enter to wake a silent console')
      const wakeDeadline = Date.now() + bannerWindowMs
      while (Date.now() < wakeDeadline && this.currentPrompt === null && this.phase === 'open') {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }

    const bannerText = decodeBytes(this.ring.slice(0), this.options.encoding === '' ? 'utf-8' : this.options.encoding)
    this.banner = boundUtf8(bannerText, BANNER_LIMIT_BYTES)
    // Start guarding against the device's idle timeout from the moment the
    // console is usable: an unused console is precisely the one that times out,
    // so waiting for the first read to arm this would arm it too late.
    this.armKeepalive()
    return this.connectResult()
  }

  /** Handle one inbound chunk: strip/filter, append, answer negotiation, page. */
  private onData(raw: Uint8Array): void {
    if (this.phase === 'closed' || this.phase === 'closing') return
    // An automated wake's ANSWER is not user activity. Without this the keepalive
    // would make a forgotten console immortal: the probe goes out, the device
    // answers, that answer refreshes the clock the reaper reads, and the reaper
    // can never reclaim a console nobody has touched. (Measured: a 3s probe
    // against the lab firewall drew an answer every cycle, holding `idleMs` under
    // the probe period indefinitely -- the live suite caught it.)
    //
    // Only the wake's own answer is excluded. A panel polling `read` and a model
    // running a command still count, which is exactly what "somebody is using
    // this console" means.
    if (!this.waking) this.lastActivityMs = Date.now()
    // `lastWireAt` is deliberately NOT touched here: the keepalive measures how
    // long since WE last wrote, and a chatty device would otherwise postpone it
    // forever -- while still timing the session out.
    this.bytesReceived += raw.length

    const cleaned = this.options.kind === 'telnet' ? stripIac(raw) : raw
    if (this.options.kind === 'telnet') {
      const reply = negotiationReply(raw)
      if (reply.length > 0) this.write(reply)
    }
    if (cleaned.length === 0) return
    this.ring.append(cleaned)

    // Answer a login prompt once, then drop the secret: an unauthenticated
    // console that asks for a password is the only place it is ever needed.
    if (this.password !== undefined) {
      const tail = this.tailText()
      if (/password\s*:\s*$/i.test(tail)) {
        this.write(encodeText(`${this.password}\r\n`, this.options.encoding))
        this.record('system', 'auth', 'answered a password prompt')
        this.password = undefined
      }
    }

    const tail = this.tailText()
    const prompt = matchPrompt(tail, this.options.promptPattern)
    if (prompt !== undefined) this.currentPrompt = prompt

    this.scanForDormancy()

    const pager = matchPager(tail, this.options.pagerPattern)
    if (pager !== undefined && !this.pagingAbandoned) {
      this.paging = { ...this.paging, lastPager: pager }
      this.schedulePagingCheck()
    }
  }

  /**
   * Look for the dormancy marker in the bytes received since the last scan.
   *
   * Scanned incrementally and windowed backwards, which is what makes this
   * correct rather than merely cheap:
   *
   * - Incremental, so a marker is SEEN once and waking it can then clear the
   *   flag. Re-scanning the whole window on every chunk would re-set the flag
   *   from a marker that is still sitting in the scrollback, and the session
   *   would wake the device on every keystroke of its own output.
   * - Windowed, so a marker printed long ago — since pushed out of the ring by
   *   newer output — cannot resurrect a stale belief.
   *
   * A refusal is the only refutation: once woken, the flag clears, and it is
   * `wake()` (not this scan) that decides whether the wake worked.
   */
  private scanForDormancy(): void {
    const from = this.dormantScannedTo
    const to = this.ring.written
    this.dormantScannedTo = to
    if (to <= from) return
    const windowStart = Math.max(from, this.ring.oldestCursor, to - DORMANT_WINDOW_BYTES)
    if (windowStart >= to) return
    const text = decodeBytes(
      this.ring.slice(windowStart),
      this.options.encoding === '' ? 'utf-8' : this.options.encoding,
    )
    const found = this.options.dormantPattern.exec(text)
    if (found === null) return
    this.markDormant(found[0].trim())
  }

  /**
   * Record that the device reported itself half-closed, and answer it.
   *
   * The wake is fired here, from inside the data path, rather than left to the
   * next `read`: the device has already stopped printing DEVICE EVENTS, and the
   * whole point is to restart them now, not at the next time somebody happens to
   * poll. A session in a composition that disabled `dormantAutoWake` only
   * records the state, so a caller can see it and decide.
   */
  private markDormant(marker: string): void {
    if (this.phase !== 'open') return
    const first = !this.dormancy.dormant
    this.dormancy = { ...this.dormancy, dormant: true, detectedAt: new Date().toISOString(), marker }
    if (first) this.record('system', 'dormant', `the device half-closed this console: ${marker}`)
    if (this.options.dormantAutoWake === true && !this.waking) void this.wake('marker')
  }

  /**
   * Send one bare Enter and report whether the device came back.
   *
   * The keystroke is exactly one: a device that asks to be woken by ENTER gets
   * ENTER, and a second would be a second unsolicited write to hardware nobody
   * asked to disturb. Whether it worked is decided by EVIDENCE — fresh device
   * output, or a prompt — never by "we wrote bytes and felt better".
   *
   * The write is deliberate about activity: it goes through {@link write}, which
   * does not touch `lastActivityMs`, because a keepalive must not make a
   * forgotten console look used. That is what lets the idle reaper still reclaim
   * it — a console kept awake by a probe is alive, not in use.
   *
   * @param reason - `marker` when answering a detected dormancy, `probe` when
   *   keeping an idle console from timing out, `keepalive` for the timer.
   * @returns whether the device answered.
   */
  async wake(reason: 'marker' | 'probe' | 'keepalive' = 'marker'): Promise<boolean> {
    if (this.phase !== 'open' || this.waking) return this.dormancy.dormant === false
    this.waking = true
    try {
      const before = this.ring.written
      this.writeRaw(encodeText('\r', this.options.encoding === '' ? 'utf-8' : this.options.encoding))
      const keepalive = reason !== 'marker'
      this.dormancy = {
        ...this.dormancy,
        wakesSent: this.dormancy.wakesSent + 1,
        keepalivesSent: this.dormancy.keepalivesSent + (keepalive ? 1 : 0),
      }
      this.record('system', reason === 'marker' ? 'wake' : 'keepalive', keepalive
        ? 'sent a bare Enter to keep an idle console from timing out'
        : 'sent a bare Enter to wake a console the device had half-closed')

      // Wait for the device to prove it is back. Output is the evidence: a
      // prompt alone is enough, but a device that resumes printing its events
      // without a prompt is just as recovered.
      const deadline = Date.now() + WAKE_SETTLE_MS
      while (Date.now() < deadline && this.phase === 'open') {
        if (this.ring.written > before) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const answered = this.ring.written > before
      if (answered) {
        this.dormancy = { ...this.dormancy, dormant: false }
        this.record('system', 'wake', 'the device answered the wake Enter')
        return true
      }
      // No answer: the belief stands. Claiming recovery here is exactly the bug
      // that would leave a caller waiting on a console nobody is listening to.
      return false
    } finally {
      this.waking = false
    }
  }

  /**
   * Arm (or disarm) the idle keepalive.
   *
   * Fires `dormantProbeMs` after the last byte the CONSOLE WROTE, so an active
   * conversation is never interrupted and a console nobody is typing into gets
   * one bare Enter before the device's own timeout can fire.
   *
   * The clock is INPUT-driven, and that is measured rather than assumed.
   * `scripts/probe-idle-input.mjs` sent nothing at all after the connect wake and
   * watched the lab firewall for 300s while counting what it sent: the device
   * kept emitting output the whole time and STILL announced
   *
   *     Vty connection is timed out. Please press ENTER.
   *
   * So the device's idle timer counts keystrokes, not traffic. Keying the probe
   * on "any activity" would therefore have suppressed it on exactly the device
   * that needs it -- a device that streams events would never look idle and would
   * time out anyway. `lastWireAt` is set by what we SEND, never by what arrives.
   *
   * A keepalive deliberately does not restart the countdown from itself: it
   * checks the clock and re-arms from the last real input.
   *
   * The `dormantAutoWake` flag gates it together with the marker answer: the
   * panel offers ONE switch for "automate the Enters", so unchecking it must
   * silence the probe as well as the recovery. The window is kept rather than
   * zeroed, so re-checking resumes on the interval already chosen.
   */
  private armKeepalive(): void {
    if (this.keepaliveTimer !== undefined) clearTimeout(this.keepaliveTimer)
    this.keepaliveTimer = undefined
    const probeMs = this.options.dormantProbeMs
    if (probeMs <= 0 || this.options.dormantAutoWake !== true || this.phase !== 'open') return
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = undefined
      if (this.phase !== 'open') return
      if (Date.now() - this.lastWireAt < probeMs) {
        // Someone wrote while this timer was pending: re-arm from that moment
        // rather than probing on a stale clock. Device output is deliberately
        // NOT a reason to postpone -- see the note above.
        this.armKeepalive()
        return
      }
      void this.wake('keepalive').finally(() => { this.armKeepalive() })
    }, probeMs)
    // A pending keepalive must never hold the process open.
    this.keepaliveTimer.unref?.()
  }

  /** Whether the device is currently believed dormant. */
  isDormant(): boolean {
    return this.dormancy.dormant
  }

  /**
   * Adopt a changed dormancy policy on a session that is ALREADY OPEN.
   *
   * This is the one part of the session's options that is deliberately NOT
   * frozen at construction, and the reason is who owns the decision. The
   * timeouts, encodings and patterns describe the CONNECTION, so changing one
   * mid-session would re-interpret a console that is in use. `dormantAutoWake`
   * and `dormantProbeMs` describe a POLICY THE OPERATOR IS EDITING, and the two
   * controls that carry them sit in the panel next to the consoles they govern:
   *
   * - Turning the keepalive off (or shortening it) has to stop the Enters going
   *   to the hardware. Leaving it frozen meant the panel showed the new value
   *   while the device kept receiving probes on the old schedule -- reported as
   *   "取消勾选还是会继续空闲保活" and "改成 10s 还是 120s 延时".
   * - Turning auto-wake off has to stop the session answering a half-close. It
   *   also stops the KEEPALIVE, because the panel presents this one switch as
   *   "automate the Enters for me": the box is labelled 空闲休眠自动唤醒 and its
   *   tooltip describes both the marker answer and the probe under a single
   *   "开启后". Unchecking it while probes kept going out was the other half of
   *   the same report, so the flag now gates every automatic Enter, and the
   *   seconds value is PRESERVED rather than zeroed -- re-checking resumes the
   *   keepalive on the window the operator already chose.
   *
   * Nothing is sent to the device here, and no state is invented: `dormantAutoWake`
   * is read at the moment a marker arrives, so mutating the option is the whole
   * of that half, and the keepalive is simply re-armed from the new window.
   * Re-arming DISARMS first, which is what makes `0` take effect at once.
   *
   * @param policy - the dormancy fields to adopt.
   */
  adoptDormancyPolicy(policy: { dormantProbeMs: number, dormantAutoWake: boolean }): void {
    const timerChanged = policy.dormantProbeMs !== this.options.dormantProbeMs
      || policy.dormantAutoWake !== this.options.dormantAutoWake
    this.options.dormantProbeMs = policy.dormantProbeMs
    this.options.dormantAutoWake = policy.dormantAutoWake
    // The flag gates the timer as well as the marker answer, so a change to
    // EITHER field re-arms: re-checking the box must resume a keepalive that
    // unchecking it stopped.
    if (timerChanged) this.armKeepalive()
  }

  /** Debounce the pager decision so a partly-rendered pager is not answered twice. */
  private schedulePagingCheck(): void {
    if (this.pagingTimer !== undefined) clearTimeout(this.pagingTimer)
    this.pagingTimer = setTimeout(() => {
      this.pagingTimer = undefined
      this.applyPaging()
    }, this.options.pagingQuietMs)
    // A pending pager decision must never hold the process open.
    this.pagingTimer.unref?.()
  }

  /** Act on a settled pager prompt according to the configured mode. */
  private applyPaging(): void {
    if (this.phase !== 'open') return
    const tail = this.tailText()
    const pager = matchPager(tail, this.options.pagerPattern)
    if (pager === undefined || this.pagingAbandoned) return
    // A pager at a cursor we already answered, with no new bytes behind it,
    // would otherwise be answered repeatedly.
    if (this.ring.written === this.pagingHandledAtCursor) return
    this.pagingHandledAtCursor = this.ring.written

    const mode = this.options.pagingMode
    if (mode === 'manual') {
      this.paging = { active: true, pagesConsumed: this.paging.pagesConsumed, reason: 'manual', lastPager: pager }
      return
    }
    if (this.paging.pagesConsumed >= this.options.pagingMaxPages) {
      this.paging = { active: true, pagesConsumed: this.paging.pagesConsumed, reason: 'max-pages', lastPager: pager }
      this.record('system', 'paging', `stopped after ${this.paging.pagesConsumed} pages (pagingMaxPages)`)
      return
    }
    const pages = this.paging.pagesConsumed + 1
    if (mode === 'auto-quit') {
      this.write(encodeText('q', this.options.encoding))
      this.pagingAbandoned = true
      this.paging = { active: false, pagesConsumed: pages, reason: 'abandoned', lastPager: pager }
      this.record('system', 'paging', 'abandoned the pager with q')
      return
    }
    if (mode === 'auto-interrupt') {
      this.write(encodeText('\u0003', this.options.encoding))
      this.pagingAbandoned = true
      this.paging = { active: false, pagesConsumed: pages, reason: 'abandoned', lastPager: pager }
      this.record('system', 'paging', 'abandoned the pager with Ctrl+C')
      return
    }
    // auto-more: ask for the next page.
    this.write(encodeText(' ', this.options.encoding))
    this.paging = { active: false, pagesConsumed: pages, reason: null, lastPager: pager }
  }

  /**
   * Write raw bytes without counting them as user activity.
   *
   * Split out from {@link write} for exactly one caller: the dormancy keepalive.
   * `lastActivityMs` is what the idle reaper reads, and a probe is not somebody
   * using the console — folding it in would make a forgotten tab immortal,
   * which is the opposite of what the reaper exists for. It also resets the
   * keepalive's own "has anyone spoken" clock, so the two cannot fight.
   */
  private writeRaw(bytes: Uint8Array): void {
    const socket = this.socket
    if (socket === undefined || socket.destroyed) return
    socket.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    this.bytesWritten += bytes.byteLength
    // Every byte OUT is input as far as the device is concerned -- including a
    // pager answer, a negotiation reply and a wake Enter -- so the device's idle
    // timer is reset by it. What arrives does NOT count; see `lastWireAt`.
    this.lastWireAt = Date.now()
  }

  /** Write raw bytes, counting them. Swallows EPIPE and friends. */
  private write(bytes: Uint8Array): void {
    this.writeRaw(bytes)
    this.lastActivityMs = Date.now()
  }

  /**
   * Send one line.
   *
   * An EMPTY line is a legitimate send, not a mistake: it presses Enter, which
   * is how a dormant console is woken, how a `--More--` prompt is dismissed by
   * hand, and how a device that swallows the first keystroke is prompted a
   * second time. The route used to refuse `text === ''`, which left the one
   * action a stuck console needs as the one action the API would not carry.
   *
   * @param text - the text to send; `''` sends the submit key alone.
   * @param options - submit key, encoding override, and the audit actor.
   * @returns the status after writing.
   * @throws {Error} when the session is not open.
   */
  async send(
    text: string,
    options: { submitKey?: string, encoding?: string, actor?: ConsoleAuditEntry['actor'], submit?: boolean } = {},
  ): Promise<ConsoleSessionState> {
    if (this.phase !== 'open') {
      throw new Error(`console session is ${this.phase}; cannot send "${text}"`)
    }
    const submit = options.submit ?? true
    const submitKey = options.submitKey ?? '\r'
    const payload = submit ? `${text}${submitKey}` : text
    this.write(encodeText(payload, options.encoding ?? this.options.encoding))
    // One `send` starts a new answer, so the pager state resets.
    this.pagingAbandoned = false
    this.paging = { active: false, pagesConsumed: 0, reason: null }
    // A real write is activity: restart the keepalive's clock from it.
    this.armKeepalive()
    // An empty line is recorded as such rather than as an empty string, so the
    // audit trail says "an Enter was pressed" instead of showing nothing.
    this.record(options.actor ?? 'user', 'send', text === '' ? '(Enter)' : text)
    return this.status()
  }

  /**
   * Read everything received after `after`, without consuming it: the same
   * cursor can be read again, and a later cursor never re-reads earlier bytes.
   * @param options - cursor, encoding override, and echo filter.
   * @returns the decoded window plus the next cursor.
   */
  read(options: { after?: number, encoding?: string, stripEcho?: string, maxBytes?: number } = {}): ConsoleReadResult {
    const encoding = options.encoding ?? this.options.encoding
    const after = options.after ?? 0
    const window = this.ring.slice(after)
    const limit = options.maxBytes ?? this.outputLimitBytes
    const consumed = Math.min(window.length, limit)
    const slice = window.slice(0, consumed)
    let text = decodeBytes(slice, encoding)
    if (options.stripEcho !== undefined) {
      text = stripEchoedCommand(text, options.stripEcho)
    }
    const tail = this.tailText()
    const prompt = matchPrompt(tail, this.options.promptPattern)
    const pager = matchPager(tail, this.options.pagerPattern)
    this.lastActivityMs = Date.now()
    return {
      text,
      cursor: after + consumed,
      truncated: window.length > consumed,
      bytes: window.length,
      encoding: encoding === '' ? 'utf-8' : encoding,
      ...prompt === undefined ? {} : { prompt },
      ...pager === undefined ? {} : { pager },
      paging: { ...this.paging },
      dormant: this.dormancy.dormant,
      ...this.dormancy.marker === null ? {} : { dormantText: this.dormancy.marker },
    }
  }

  /** Clear the automatic pager's abandonment so the next page is handled again. */
  resumePaging(): void {
    this.pagingAbandoned = false
    this.paging = { active: false, pagesConsumed: 0, reason: null }
  }

  /**
   * Discard everything read so far, so the next read starts from a clean pane.
   *
   * The wire is untouched: this is a READER-side reset, not a device command.
   * The bytes are dropped from the local ring buffer, which is also what
   * `waitFor` searches and where the prompt/pager matchers look -- so the
   * remembered prompt goes too, because it described output that no longer
   * exists. Anything the device sends AFTER this is received and readable as
   * usual; nothing is sent to the device and nothing is unplugged.
   *
   * Existing cursors are NOT renumbered. `written` keeps counting from where it
   * was, so a caller holding a pre-clear cursor reads from a window that no
   * longer contains it and gets nothing -- the honest answer, and the same one
   * a cursor that aged out under the size limit already gets.
   *
   * @returns the cursor a reader should use next, and how many bytes were dropped.
   */
  clear(): { cursor: number, droppedBytes: number } {
    const droppedBytes = this.ring.length
    this.ring.clear()
    // The pager state described the discarded output: a page prompt printed in
    // it can never be answered now, so keeping it would strand the reader on a
    // page that no longer exists.
    this.resumePaging()
    // A prompt remembered from discarded output would keep `waitFor` reporting
    // `matched` for a prompt the reader cannot see.
    this.currentPrompt = null
    // The marker was discarded with everything else, so the search starts fresh
    // from the cursor the window now begins at.
    this.dormantScannedTo = this.ring.written
    this.record('system', 'clear', `cleared ${String(droppedBytes)} byte(s) of local scrollback`)
    return { cursor: this.ring.written, droppedBytes }
  }

  /**
   * Wait until output satisfies a condition, the budget runs out, or the
   * session closes. This is the one blocking read every caller uses, so no
   * caller needs a polling loop of its own.
   * @param options - condition, starting cursor, and budget.
   * @returns the outcome, including why it ended.
   */
  async waitFor(options: ConsoleWaitOptions = {}): Promise<ConsoleWaitResult> {
    const started = Date.now()
    const budgetMs = options.timeoutMs ?? this.options.readTimeoutMs
    const after = options.after ?? 0
    const condition = options.for ?? 'prompt'
    // A caller's pattern is a SEARCH over the window; the session's own prompt
    // and pager matchers are the tail-anchored ones.
    const matcher = condition === 'pattern' ? compileSearchPattern(options.pattern ?? '') : undefined
    const idleMs = options.idleMs ?? this.options.idleQuietMs

    // `quietSince` starts as null on purpose. An idle wait means "wait until the
    // output STOPS", which is not a property of a console that has not started:
    // a session with nothing new at the cursor is already quiet, so arming the
    // clock at `started` made the call return `matched` on its FIRST poll, having
    // read nothing at all. The clock starts at the first byte ARRIVED, so the
    // condition can only be satisfied by output that really did go quiet.
    let quietSince: number | null = null
    let lastWritten = this.ring.written
    // A wait that begins on a dormant console is waiting for output the device
    // will not send until someone presses a key. Recorded so the caller can tell
    // "the device is slow" from "the device is not listening".
    const startedDormant = this.dormancy.dormant

    for (;;) {
      const tail = this.tailText()
      if (condition === 'prompt') {
        const prompt = matchPrompt(tail, this.options.promptPattern)
        if (prompt !== undefined && this.ring.written > after) {
          return this.waitResult(true, prompt, after, started, 'matched')
        }
      } else if (condition === 'pattern' && matcher !== undefined) {
        const found = matcher.exec(tail)
        if (found !== null) return this.waitResult(true, found[0], after, started, 'matched')
      } else if (condition === 'idle') {
        // Quiet means: bytes ARRIVED, and then none arrived for the whole
        // window. Both halves are required -- see `quietSince`.
        if (this.ring.written !== lastWritten) {
          lastWritten = this.ring.written
          quietSince = Date.now()
        } else if (quietSince !== null && Date.now() - quietSince >= idleMs) {
          return this.waitResult(true, undefined, after, started, 'matched')
        }
      }
      if (this.phase === 'closed' || this.phase === 'error') {
        return this.waitResult(false, undefined, after, started, 'closed', startedDormant)
      }
      if (Date.now() - started >= budgetMs) {
        return this.waitResult(false, undefined, after, started, 'timeout', startedDormant)
      }
      await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS))
    }
  }

  /** Assemble one wait outcome. */
  private waitResult(
    matched: boolean,
    matchedText: string | undefined,
    after: number,
    started: number,
    reason: ConsoleWaitResult['reason'],
    startedDormant = false,
  ): ConsoleWaitResult {
    this.lastActivityMs = Date.now()
    // Only reported when the wait FAILED because of it: a wait that matched
    // plainly got its answer, and a stale flag would make the caller distrust a
    // result it can see for itself.
    const blocked = startedDormant && this.dormancy.dormant && reason !== 'matched'
    return {
      matched,
      ...matchedText === undefined ? {} : { matchedText },
      // Everything received up to now is the caller's to read; hand back the
      // current end so a following `read` starts where the wait left off.
      cursor: Math.max(after, 0),
      elapsedMs: Date.now() - started,
      reason,
      paging: { ...this.paging },
      dormant: this.dormancy.dormant,
      ...blocked ? { dormantBlocked: true } : {},
    }
  }

  /**
   * Close the session.
   * @param options - `force` destroys the socket instead of ending it.
   * @returns the terminal status.
   */
  async close(options: { force?: boolean } = {}): Promise<ConsoleSessionState> {
    if (this.phase === 'closed') return this.status()
    const socket = this.socket
    this.phase = 'closing'
    if (options.force === true || socket === undefined || socket.destroyed) {
      socket?.destroy()
      this.finishClosed()
      return this.status()
    }
    await new Promise<void>((resolve) => {
      // A peer that never answers `end` must not stall the caller.
      const timer = setTimeout(() => {
        socket.destroy()
        resolve()
      }, 2000)
      socket.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.end()
    })
    this.finishClosed()
    return this.status()
  }

  /** Record that the reaper, not a caller, ended this console. */
  recordIdleReap(): void {
    this.lastError = { code: 'idle-timeout', message: 'the console was closed after sitting idle' }
    this.record('system', 'reap', 'closed after the idle window elapsed')
  }

  /**
   * Record that another session attached to this already-open console.
   *
   * The audit trail lives on the console, so without this a device link under
   * two sessions would have a trail naming only whoever opened it -- and the
   * second session's reads and writes would appear from nowhere.
   *
   * @param sessionId - the session that attached.
   */
  recordAttach(sessionId: string): void {
    this.record('system', 'attach', `session ${sessionId} attached to this shared console`)
  }

  /** Release every resource; safe to call repeatedly. */
  async dispose(): Promise<void> {
    if (this.pagingTimer !== undefined) {
      clearTimeout(this.pagingTimer)
      this.pagingTimer = undefined
    }
    if (this.keepaliveTimer !== undefined) {
      clearTimeout(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }
    this.password = undefined
    if (this.phase !== 'closed') await this.close({ force: true })
  }

  /** Mark the closed terminal state and drop the socket reference. */
  private finishClosed(): void {
    if (this.pagingTimer !== undefined) {
      clearTimeout(this.pagingTimer)
      this.pagingTimer = undefined
    }
    if (this.keepaliveTimer !== undefined) {
      clearTimeout(this.keepaliveTimer)
      this.keepaliveTimer = undefined
    }
    if (this.phase !== 'closed') {
      this.phase = 'closed'
      this.closedAt = new Date().toISOString()
      this.record('system', 'close', 'console session closed')
    }
    this.socket = undefined
    this.password = undefined
  }

  /** Record a terminal failure and close. */
  private fail(code: string, message: string): void {
    if (this.phase === 'error' || this.phase === 'closed') return
    this.lastError = { code, message }
    this.phase = 'error'
    this.record('system', 'error', `${code}: ${message}`)
    this.finishClosed()
  }
}
