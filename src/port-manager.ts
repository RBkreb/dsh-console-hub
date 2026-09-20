/**
 * Console ownership: which consoles exist and when they go away.
 *
 * ONE SHARED POOL, not one pool per agent session. That is the whole design, and
 * it is driven by the hardware: a console-server port maps a single TCP
 * connection to the device's serial line, so two connections to the same device
 * are either refused or (as measured on the lab firewall) cause the device to
 * tear down the first one. Consoles are therefore a scarce, host-wide resource,
 * and modelling them per session got both halves wrong:
 *
 * - `maxConsoles` did not bound device usage at all. MEASURED with the old
 *   per-owner cap: three sequential sessions against one device, each capped at
 *   3, left 9 live TCP connections to the SAME port.
 * - A session that died left its consoles behind, and because a dead session
 *   failed the session check on every route, nothing could list or close them --
 *   they were reachable only by the idle reaper, and they did not count against
 *   anyone's cap.
 *
 * Sharing collapses both: the cap is global, so nothing can exceed what the
 * device will accept, and `connect` to an already-open target ATTACHES to that
 * console instead of opening a second connection that would evict it.
 *
 * Lifetimes are consequently one mechanism rather than several: a console is
 * closed explicitly, or reaped when nobody touches it for `idleTimeoutMs`. There
 * is no per-session cleanup to get right, and therefore none to leak.
 *
 * `openedBy` is recorded for display and the audit trail. It is PROVENANCE, not
 * permission: any session may read, write, wake or close any console in the pool.
 *
 * @module dsh-console-hub/port-manager
 */
import { compilePattern, compileSearchPattern, type PagingMode, type ConsoleKind } from './config-shared.ts'
import { ConsoleSession, type ConsoleSessionState } from './session.ts'

/** Everything needed to open one console. */
export interface ConsoleDescriptor {
  /** The session asking for it; recorded as the opener, not used as a permission. */
  sessionId: string
  /** Human label shown in lists and cards. */
  label: string
  /** Device address. */
  host: string
  /** Mapped console port. */
  port: number
  /** Transport. */
  kind: ConsoleKind
  /** Encoding for this console. */
  encoding: string
  /** Login user, when the device wants one (not a secret). */
  user?: string
  /** Resolved login password; never retained beyond the connect. */
  password?: string
  /** Compiled prompt matcher override for this console. */
  promptPattern?: RegExp
  /** Compiled pager matcher override for this console. */
  pagerPattern?: RegExp
  /** Paging mode override for this console. */
  pagingMode?: PagingMode
}

/** One live console as a list entry reports it. */
export interface ConsoleEntry {
  /** Opaque handle the caller passes back. */
  consoleId: string
  /**
   * The session that OPENED this console, for display and the audit trail.
   *
   * Deliberately not called `owner` and deliberately not checked by anything:
   * every session may use every console, because the underlying device link is
   * shared whether or not this process admits it.
   */
  openedBy: string
  /** Human label. */
  label: string
  host: string
  port: number
  kind: ConsoleKind
  encoding: string
  /** Whether a credential was used to open it. */
  secure: boolean
  /** Lifecycle state. */
  state: ConsoleSessionState['state']
  /** Terminal failure, when one happened. */
  lastError: ConsoleSessionState['lastError']
  /**
   * Whether the DEVICE has half-closed this console while the socket stayed up.
   *
   * Surfaced on the entry, not only in the detailed status, because it changes
   * what a caller should DO: a dormant console answers nothing until someone
   * presses Enter, so a list showing `open` is actively misleading without it.
   */
  dormant: boolean
  /** The marker text that proved it, when it is dormant. */
  dormantText: string | null
  /** Milliseconds since the last read or write. */
  idleMs: number
  /** Session start (ISO). */
  createdAt: string
}

/** What one connect produced. */
export interface ConsoleConnectOutcome {
  /** The console, whether it was opened or attached to. */
  entry: ConsoleEntry
  /**
   * True when an existing console for the same target was reused.
   *
   * Reported because it changes what the caller should do: a reused console may
   * already be under another session's control, and closing it to "clean up"
   * would pull the device link out from under whoever else is using it.
   */
  reused: boolean
}

/** Fully-defaulted manager settings. */
export interface PortManagerOptions {
  /** Consoles one session may hold open at once. */
  maxConsoles: number
  scrollbackLimitBytes: number
  outputLimitBytes: number
  connectTimeoutMs: number
  readTimeoutMs: number
  /** Idle lifetime before a console is reaped (ms). */
  idleTimeoutMs: number
  /** How often the host's reaper runs (ms). */
  idleSweepMs: number
  pagingMode: PagingMode
  pagingMaxPages: number
  pagingQuietMs: number
  /** Quiet window that satisfies `waitFor({for:'idle'})` (ms). */
  idleQuietMs: number
  /** Prompt pattern source, compiled per console (a view may override it). */
  promptPattern: string
  /** Marker source for a device that half-closed an idle console. */
  dormantPattern: string
  /**
   * Whether a detected dormancy is answered with one bare Enter.
   *
   * Also the master switch for the keepalive ({@link dormantProbeMs}): the panel
   * shows one checkbox for "automate the Enters", so this off means no automatic
   * Enter at all.
   */
  dormantAutoWake: boolean
  /**
   * Idle milliseconds before a keepalive Enter; `0` disables it.
   *
   * Subject to {@link dormantAutoWake}: a non-zero window sends nothing while
   * that flag is off.
   */
  dormantProbeMs: number
  /**
   * Send one bare Enter when a device says nothing on connect.
   *
   * Off by default: a device that does not need it must never receive an
   * unsolicited keystroke. A deployment for silent console servers turns it on.
   */
  wakeOnConnect?: boolean
  /** Pager pattern source, compiled per console. */
  pagerPattern: string
}

/** One tracked console. */
interface Tracked {
  entry: ConsoleEntry
  session: ConsoleSession
  secure: boolean
}

/** Mint a console id that is also usable as a stable map key. */
function newConsoleId(): string {
  return `c${crypto.randomUUID().replace(/-/g, '')}`
}

/** The manager's own view of one console. */
export interface ConsoleDetail {
  entry: ConsoleEntry
  state: ConsoleSessionState
}

/** Owns every live console and their lifetimes. */
export class PortManager {
  /** The policy in force. Replaced wholesale by {@link updateOptions}. */
  private options: PortManagerOptions
  private readonly consoles = new Map<string, Tracked>()
  /** Connect banners, keyed by console id (see `connect`). */
  private readonly banners = new Map<string, string>()
  private reaper: NodeJS.Timeout | undefined
  private disposed = false

  /** @param options - fully-defaulted manager settings. */
  constructor(options: PortManagerOptions) {
    this.options = options
  }

  /**
   * Adopt a new policy WITHOUT disturbing the open consoles.
   *
   * This exists so a settings change never has to be deferred. Replacing the
   * manager would work, but the replacement owns no consoles, so the outgoing
   * one has to be disposed -- and `dispose` closes every console it holds. That
   * is what forced the old deferred-until-empty behaviour, and the visible
   * result was a setting that silently did nothing until the user closed
   * everything and toggled it again.
   *
   * Mutating in place is safe because a live console is already insulated from
   * this object: {@link connect} copies each value it needs into the
   * `ConsoleSession` it builds, so an open session keeps the timeouts, patterns
   * and wake behaviour it was opened with. What changes is what the NEXT
   * connect uses, which is exactly what a policy edit means.
   *
   * The two fields read live rather than copied are handled deliberately:
   *
   * - `idleTimeoutMs`: `sweep` reads it per tick, so a shorter lifetime starts
   *   applying at once. A user who shortens it wants that.
   * - `idleSweepMs`: the interval was armed with the old value, so the reaper is
   *   re-armed when it changes.
   * - `maxConsoles`: only consulted at `connect`, so a limit lowered below the
   *   current count stops new consoles without evicting open ones.
   * - `dormantAutoWake` / `dormantProbeMs`: PUSHED into every open session, which
   *   is the one case that is neither "next connect" nor "read live". These two
   *   are the operator's dormancy policy, edited from controls that sit right
   *   next to the open consoles, and freezing them meant the panel showed the
   *   new value while the device kept receiving Enters on the old schedule --
   *   the reported "取消勾选还是会继续空闲保活 / 改成 10s 还是 120s 延时". A
   *   connection's timeouts and patterns genuinely must not change under a
   *   console in use; a keepalive window must, or the switch does nothing.
   *
   * @param next - the policy to adopt.
   */
  updateOptions(next: PortManagerOptions): void {
    const sweepChanged = next.idleSweepMs !== this.options.idleSweepMs
    const dormancyChanged = next.dormantProbeMs !== this.options.dormantProbeMs
      || next.dormantAutoWake !== this.options.dormantAutoWake
    this.options = next
    if (dormancyChanged) {
      // Pushed, not merely stored: an open session has no other way to learn
      // that the operator moved the control. Nothing is written to the device --
      // this re-arms a timer and re-reads a flag.
      for (const tracked of this.consoles.values()) {
        tracked.session.adoptDormancyPolicy({
          dormantProbeMs: next.dormantProbeMs,
          dormantAutoWake: next.dormantAutoWake,
        })
      }
    }
    if (sweepChanged && this.reaper !== undefined) {
      // Re-arm so the new cadence takes effect; `startReaper` is idempotent, so
      // clearing first is what makes it start again.
      clearInterval(this.reaper)
      this.reaper = undefined
      this.startReaper()
    }
  }

  /** Start the periodic idle reaper (no-op when already started or disposed). */
  startReaper(): void {
    if (this.reaper !== undefined || this.disposed) return
    this.reaper = setInterval(() => {
      void this.sweep()
    }, this.options.idleSweepMs)
    // The reaper must never hold the host open on its own.
    this.reaper.unref?.()
  }

  /**
   * Open one console, or ATTACH to the one already open for this target.
   *
   * Attaching rather than opening a second connection is the point of the shared
   * pool, and it is not a convenience: a second TCP connection to the same
   * console-server port makes the device tear down the first (measured on the lab
   * firewall, which is what the half-close test relies on). So "open another one"
   * would not give the caller an independent console -- it would silently break
   * whoever was already connected.
   *
   * A console that is already dead is discarded here rather than attached to, so
   * a caller never receives a handle that cannot work.
   *
   * @param descriptor - device, transport, and credential facts.
   * @returns the console plus whether it was reused.
   * @throws {Error} when the pool is at its cap.
   */
  async connect(descriptor: ConsoleDescriptor): Promise<ConsoleConnectOutcome> {
    if (this.disposed) throw new Error('console-hub: the port manager is disposed')

    const existing = this.liveForTarget(descriptor.host, descriptor.port)
    if (existing !== undefined) {
      // The audit trail is per console, so an attach is recorded on it: without
      // this, two sessions driving one device would leave a trail that only ever
      // names the first.
      existing.session.recordAttach(descriptor.sessionId)
      return { entry: this.refresh(existing.entry.consoleId), reused: true }
    }

    // GLOBAL cap. A per-owner cap did not bound device usage at all: three
    // sequential sessions against one device, each capped at 3, held 9 live TCP
    // connections to the same port.
    if (this.consoles.size >= this.options.maxConsoles) {
      throw new Error(
        `console-hub: the pool already holds ${this.consoles.size} console(s); the limit is ${this.options.maxConsoles}`,
      )
    }

    const consoleId = newConsoleId()
    const session = new ConsoleSession({
      host: descriptor.host,
      port: descriptor.port,
      kind: descriptor.kind,
      encoding: descriptor.encoding,
      connectTimeoutMs: this.options.connectTimeoutMs,
      readTimeoutMs: this.options.readTimeoutMs,
      pagingMode: descriptor.pagingMode ?? this.options.pagingMode,
      pagingMaxPages: this.options.pagingMaxPages,
      pagingQuietMs: this.options.pagingQuietMs,
      idleQuietMs: this.options.idleQuietMs,
      promptPattern: descriptor.promptPattern ?? compilePattern(this.options.promptPattern),
      pagerPattern: descriptor.pagerPattern ?? compilePattern(this.options.pagerPattern),
      // SEARCH-compiled: the half-close marker is printed mid-stream, so the
      // tail-anchored `compilePattern` would never see it.
      dormantPattern: compileSearchPattern(this.options.dormantPattern),
      dormantAutoWake: this.options.dormantAutoWake,
      dormantProbeMs: this.options.dormantProbeMs,
      scrollbackLimitBytes: this.options.scrollbackLimitBytes,
      outputLimitBytes: this.options.outputLimitBytes,
      // Wake a console that says nothing on connect. Some console servers (both
      // lab devices among them) stay silent until a key arrives, which would
      // otherwise leave the caller with no banner and no prompt.
      wakeOnConnect: this.options.wakeOnConnect,
      ...descriptor.password === undefined ? {} : { password: descriptor.password },
    })
    const entry: ConsoleEntry = {
      consoleId,
      openedBy: descriptor.sessionId,
      label: descriptor.label,
      host: descriptor.host,
      port: descriptor.port,
      kind: descriptor.kind,
      encoding: descriptor.encoding === '' ? 'utf-8' : descriptor.encoding,
      secure: descriptor.password !== undefined && descriptor.password !== '',
      state: 'connecting',
      lastError: null,
      dormant: false,
      dormantText: null,
      idleMs: 0,
      createdAt: new Date().toISOString(),
    }
    this.consoles.set(consoleId, { entry, session, secure: entry.secure })

    const connected = await session.open()
    // The connect banner is the one thing only `open()` knows; keep it on the
    // manager's own record so a later `describe` can report what a device said
    // when it was first opened.
    this.banners.set(consoleId, connected.banner)
    return { entry: this.refresh(consoleId, connected), reused: false }
  }

  /**
   * How many consoles the pool holds.
   * @returns the number of tracked consoles.
   */
  openCount(): number {
    return this.consoles.size
  }

  /**
   * Every console in the pool, with a live status.
   *
   * No session argument: the pool is shared, so "whose console is this" is a
   * display fact carried on the entry rather than a filter. Filtering by session
   * is what made a dead session's consoles unreachable -- nothing could list them
   * to close them.
   *
   * @returns every console, oldest first.
   */
  list(): ConsoleEntry[] {
    return [...this.consoles.values()].map(tracked => this.refresh(tracked.entry.consoleId))
  }

  /**
   * Look up one console.
   * @param consoleId - the console handle.
   * @returns the entry, or `undefined` when it does not exist.
   */
  get(consoleId: string): ConsoleEntry | undefined {
    const tracked = this.consoles.get(consoleId)
    if (tracked === undefined) return undefined
    return this.refresh(consoleId)
  }

  /**
   * The banner one console's device sent when it was opened.
   * @param consoleId - the console handle.
   * @returns the banner, or an empty string when none was seen.
   */
  bannerOf(consoleId: string): string {
    return this.banners.get(consoleId) ?? ''
  }

  /**
   * Describe one console.
   * @param consoleId - the console handle.
   * @returns the entry plus its full status, or `undefined`.
   */
  describe(consoleId: string): ConsoleDetail | undefined {
    const tracked = this.consoles.get(consoleId)
    if (tracked === undefined) return undefined
    return { entry: this.refresh(consoleId), state: tracked.session.status() }
  }

  /**
   * Send one command to a console.
   * @param consoleId - the console handle.
   * @param text - the command text.
   * @param options - submit key/encoding/actor overrides.
   * @returns the entry after writing.
   * @throws {Error} when the console is unknown or already closed.
   */
  async send(
    consoleId: string,
    text: string,
    options: { submitKey?: string, encoding?: string, actor?: 'user' | 'model' | 'system', submit?: boolean } = {},
  ): Promise<ConsoleEntry> {
    const tracked = this.require(consoleId)
    const status = await tracked.session.send(text, options)
    return this.refresh(consoleId, status)
  }

  /**
   * Read one console's output window.
   * @param consoleId - the console handle.
   * @param options - cursor, encoding, and echo-filter overrides.
   * @returns the decoded window.
   * @throws {Error} when the console is unknown.
   */
  read(
    consoleId: string,
    options: { after?: number, encoding?: string, stripEcho?: string, maxBytes?: number } = {},
    // The read result shape is the session's; re-exported by callers through
    // the session module rather than restated here.
  ): ReturnType<ConsoleSession['read']> {
    const tracked = this.require(consoleId)
    const result = tracked.session.read(options)
    this.refresh(consoleId)
    return result
  }

  /**
   * Wait on one console.
   * @param consoleId - the console handle.
   * @param options - condition and budget.
   * @returns the wait outcome.
   * @throws {Error} when the console is unknown.
   */
  waitFor(
    consoleId: string,
    options: Parameters<ConsoleSession['waitFor']>[0] = {},
  ): ReturnType<ConsoleSession['waitFor']> {
    const tracked = this.require(consoleId)
    return tracked.session.waitFor(options).then((result) => {
      this.refresh(consoleId)
      return result
    })
  }

  /**
   * Clear a console's pending pager state so the next page is handled again.
   * @param consoleId - the console handle.
   * @throws {Error} when the console is unknown.
   */
  resumePaging(consoleId: string): void {
    const tracked = this.require(consoleId)
    tracked.session.resumePaging()
    this.refresh(consoleId)
  }

  /**
   * Discard one console's local scrollback, leaving the connection untouched.
   *
   * `cursor` is the offset the caller should read from next; passing it on is
   * what keeps a reader from being handed output it already displayed. The
   * socket, the encoding, the login and the device's own scrollback are all
   * unaffected -- only this process's copy is dropped.
   *
   * @param consoleId - the console handle.
   * @returns the next read cursor and how many bytes were discarded.
   * @throws {Error} when the console is unknown.
   */
  clear(consoleId: string): { cursor: number, droppedBytes: number } {
    const tracked = this.require(consoleId)
    const result = tracked.session.clear()
    this.refresh(consoleId)
    return result
  }

  /**
   * Send one bare Enter to wake a console the device half-closed, or to keep an
   * idle one from timing out.
   *
   * The session decides what the evidence is; the manager only routes it, so the
   * panel, the routes and the model all ask the same question in the same way.
   *
   * @param consoleId - the console handle.
   * @returns whether the device answered the Enter.
   * @throws {Error} when the console is unknown.
   */
  async wake(consoleId: string): Promise<boolean> {
    const tracked = this.require(consoleId)
    const answered = await tracked.session.wake('probe')
    this.refresh(consoleId)
    return answered
  }

  /**
   * Close one console and drop it from the pool.
   * @param consoleId - the console handle.
   * @param options - `force` destroys the socket.
   * @throws {Error} when the console is unknown.
   */
  async close(consoleId: string, options: { force?: boolean } = {}): Promise<void> {
    const tracked = this.require(consoleId)
    await tracked.session.close(options)
    tracked.session.dispose()
    this.consoles.delete(consoleId)
    this.banners.delete(consoleId)
  }

  /**
   * Close every console in the pool.
   *
   * Deliberately the whole pool and not "mine": there is no per-session
   * partition left to scope it to, and a caller that wants a subset has the
   * handles to close them individually.
   *
   * @returns how many were closed.
   */
  async closeAll(): Promise<number> {
    const ids = [...this.consoles.keys()]
    for (const consoleId of ids) await this.close(consoleId, { force: true })
    return ids.length
  }

  /**
   * Close every console whose owner has gone idle past the configured window,
   * plus every console whose session died under it.
   * @returns the console ids that were reaped.
   */
  async sweep(): Promise<string[]> {
    const reaped: string[] = []
    for (const [consoleId, tracked] of [...this.consoles]) {
      const status = tracked.session.status()
      const dead = status.state === 'closed' || status.state === 'error'
      const idle = status.state === 'open' && status.idleMs >= this.options.idleTimeoutMs
      if (!dead && !idle) continue
      if (idle) tracked.session.recordIdleReap?.()
      await tracked.session.close({ force: true })
      tracked.session.dispose()
      this.consoles.delete(consoleId)
      this.banners.delete(consoleId)
      reaped.push(consoleId)
    }
    return reaped
  }

  /** Close every console and stop the reaper. Safe to call repeatedly. */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.reaper !== undefined) {
      clearInterval(this.reaper)
      this.reaper = undefined
    }
    for (const [consoleId, tracked] of [...this.consoles]) {
      await tracked.session.close({ force: true })
      tracked.session.dispose()
      this.consoles.delete(consoleId)
      this.banners.delete(consoleId)
    }
  }

  /**
   * The console already serving a target, when there is a usable one.
   *
   * Only a console that is still `open` or `connecting` counts. A dead one is
   * discarded here rather than returned: handing a caller a handle that cannot
   * work would look like a successful reconnect and fail on the next call, and
   * leaving it in place would also block the target forever, since no second
   * connection to the same port is possible.
   */
  private liveForTarget(host: string, port: number): Tracked | undefined {
    for (const [consoleId, tracked] of [...this.consoles]) {
      if (tracked.entry.host !== host || tracked.entry.port !== port) continue
      const state = tracked.session.status().state
      if (state === 'open' || state === 'connecting') return tracked
      // Dead: drop it so the target is free. Synchronous teardown, because the
      // caller is about to open a replacement for the same port.
      tracked.session.dispose()
      this.consoles.delete(consoleId)
      this.banners.delete(consoleId)
    }
    return undefined
  }

  /** Resolve a console or throw the not-found error. */
  private require(consoleId: string): Tracked {
    const tracked = this.consoles.get(consoleId)
    if (tracked === undefined) {
      throw new Error(`console-hub: console "${consoleId}" not found`)
    }
    return tracked
  }

  /** Refresh one entry from its session's live status. */
  private refresh(consoleId: string, status?: ConsoleSessionState): ConsoleEntry {
    const tracked = this.consoles.get(consoleId)
    if (tracked === undefined) throw new Error(`console-hub: console "${consoleId}" is gone`)
    const live = status ?? tracked.session.status()
    tracked.entry = {
      ...tracked.entry,
      state: live.state,
      lastError: live.lastError,
      idleMs: live.idleMs,
      dormant: live.dormancy.dormant,
      dormantText: live.dormancy.marker,
    }
    return tracked.entry
  }
}
