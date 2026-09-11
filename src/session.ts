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
  /** Compiled, tail-anchored prompt matcher. */
  promptPattern: RegExp
  /** Compiled, tail-anchored pager matcher. */
  pagerPattern: RegExp
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
  private bytesReceived = 0
  private bytesWritten = 0
  private currentPrompt: string | null = null
  private paging: ConsolePagingState = { active: false, pagesConsumed: 0, reason: null }
  private pagingTimer: NodeJS.Timeout | undefined
  private pagingAbandoned = false
  private pagingHandledAtCursor = 0
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
    return this.connectResult()
  }

  /** Handle one inbound chunk: strip/filter, append, answer negotiation, page. */
  private onData(raw: Uint8Array): void {
    if (this.phase === 'closed' || this.phase === 'closing') return
    this.lastActivityMs = Date.now()
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

    const pager = matchPager(tail, this.options.pagerPattern)
    if (pager !== undefined && !this.pagingAbandoned) {
      this.paging = { ...this.paging, lastPager: pager }
      this.schedulePagingCheck()
    }
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

  /** Write raw bytes, counting them. Swallows EPIPE and friends. */
  private write(bytes: Uint8Array): void {
    const socket = this.socket
    if (socket === undefined || socket.destroyed) return
    socket.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    this.bytesWritten += bytes.byteLength
    this.lastActivityMs = Date.now()
  }

  /**
   * Send one command.
   * @param text - the text to send (no trailing newline needed).
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
    this.record(options.actor ?? 'user', 'send', text)
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
    }
  }

  /** Clear the automatic pager's abandonment so the next page is handled again. */
  resumePaging(): void {
    this.pagingAbandoned = false
    this.paging = { active: false, pagesConsumed: 0, reason: null }
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
    const idleMs = options.idleMs ?? 250

    let lastGrowthAt = Date.now()
    let lastWritten = this.ring.written

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
        // Quiet means: bytes have stopped arriving for the idle window.
        if (this.ring.written !== lastWritten) {
          lastWritten = this.ring.written
          lastGrowthAt = Date.now()
        } else if (Date.now() - lastGrowthAt >= idleMs) {
          return this.waitResult(true, undefined, after, started, 'matched')
        }
      }
      if (this.phase === 'closed' || this.phase === 'error') {
        return this.waitResult(false, undefined, after, started, 'closed')
      }
      if (Date.now() - started >= budgetMs) {
        return this.waitResult(false, undefined, after, started, 'timeout')
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
  ): ConsoleWaitResult {
    this.lastActivityMs = Date.now()
    return {
      matched,
      ...matchedText === undefined ? {} : { matchedText },
      // Everything received up to now is the caller's to read; hand back the
      // current end so a following `read` starts where the wait left off.
      cursor: Math.max(after, 0),
      elapsedMs: Date.now() - started,
      reason,
      paging: { ...this.paging },
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

  /** Release every resource; safe to call repeatedly. */
  async dispose(): Promise<void> {
    if (this.pagingTimer !== undefined) {
      clearTimeout(this.pagingTimer)
      this.pagingTimer = undefined
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
