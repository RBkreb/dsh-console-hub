/**
 * Console ownership: which consoles exist, who owns them, and when they go
 * away.
 *
 * A console is a scarce device resource, so every operation is keyed by the
 * owning session and one session can neither see nor touch another's console.
 * The manager also owns the two lifetimes the session itself cannot: the
 * per-owner cap (a connect that would exceed it is refused rather than
 * silently replacing a live console) and the idle reaper (a console nobody has
 * touched inside its window is closed, so a forgotten tab cannot hold a
 * device's serial port open forever).
 *
 * @module dsh-console-hub/port-manager
 */
import { compilePattern, type PagingMode, type ConsoleKind } from './config-shared.ts'
import { ConsoleSession, type ConsoleSessionState } from './session.ts'

/** Everything needed to open one console. */
export interface ConsoleDescriptor {
  /** The session that owns this console. */
  ownerSessionId: string
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
  /** Owning session. */
  ownerSessionId: string
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
  /** Milliseconds since the last read or write. */
  idleMs: number
  /** Session start (ISO). */
  createdAt: string
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
  /** Prompt pattern source, compiled per console (a view may override it). */
  promptPattern: string
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
  private readonly options: PortManagerOptions
  private readonly consoles = new Map<string, Tracked>()
  /** Connect banners, keyed by console id (see `connect`). */
  private readonly banners = new Map<string, string>()
  private reaper: NodeJS.Timeout | undefined
  private disposed = false

  /** @param options - fully-defaulted manager settings. */
  constructor(options: PortManagerOptions) {
    this.options = options
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
   * Open one console.
   * @param descriptor - device, transport, and credential facts.
   * @returns the new console entry (its state is `error`/`closed` when the connect failed).
   * @throws {Error} when the owner is at its console cap.
   */
  async connect(descriptor: ConsoleDescriptor): Promise<ConsoleEntry> {
    if (this.disposed) throw new Error('console-hub: the port manager is disposed')
    const owned = this.ownedBy(descriptor.ownerSessionId)
    if (owned.length >= this.options.maxConsoles) {
      throw new Error(
        `console-hub: session already holds ${owned.length} console(s); the limit is ${this.options.maxConsoles}`,
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
      promptPattern: descriptor.promptPattern ?? compilePattern(this.options.promptPattern),
      pagerPattern: descriptor.pagerPattern ?? compilePattern(this.options.pagerPattern),
      scrollbackLimitBytes: this.options.scrollbackLimitBytes,
      outputLimitBytes: this.options.outputLimitBytes,
      ...descriptor.password === undefined ? {} : { password: descriptor.password },
    })
    const entry: ConsoleEntry = {
      consoleId,
      ownerSessionId: descriptor.ownerSessionId,
      label: descriptor.label,
      host: descriptor.host,
      port: descriptor.port,
      kind: descriptor.kind,
      encoding: descriptor.encoding === '' ? 'utf-8' : descriptor.encoding,
      secure: descriptor.password !== undefined && descriptor.password !== '',
      state: 'connecting',
      lastError: null,
      idleMs: 0,
      createdAt: new Date().toISOString(),
    }
    this.consoles.set(consoleId, { entry, session, secure: entry.secure })

    const connected = await session.open()
    // The connect banner is the one thing only `open()` knows; keep it on the
    // manager's own record so a later `describe` can report what a device said
    // when it was first opened.
    this.banners.set(consoleId, connected.banner)
    return this.refresh(consoleId, connected)
  }

  /**
   * Every console owned by one session, with a live status.
   * @param ownerSessionId - the owning session.
   * @returns the owner's consoles, oldest first.
   */
  list(ownerSessionId: string): ConsoleEntry[] {
    return this.ownedBy(ownerSessionId).map(tracked => this.refresh(tracked.entry.consoleId))
  }

  /**
   * Look up one console, owner-scoped.
   * @param ownerSessionId - the requesting session.
   * @param consoleId - the console handle.
   * @returns the entry, or `undefined` when it does not exist or is not this owner's.
   */
  get(ownerSessionId: string, consoleId: string): ConsoleEntry | undefined {
    const tracked = this.consoles.get(consoleId)
    if (tracked === undefined || tracked.entry.ownerSessionId !== ownerSessionId) return undefined
    return this.refresh(consoleId)
  }

  /**
   * The banner one console's device sent when it was opened.
   * @param ownerSessionId - the requesting session.
   * @param consoleId - the console handle.
   * @returns the banner, or an empty string when none was seen.
   */
  bannerOf(ownerSessionId: string, consoleId: string): string {
    const tracked = this.consoles.get(consoleId)
    if (tracked === undefined || tracked.entry.ownerSessionId !== ownerSessionId) return ''
    return this.banners.get(consoleId) ?? ''
  }

  /**
   * Describe one console, owner-scoped.
   * @param ownerSessionId - the requesting session.
   * @param consoleId - the console handle.
   * @returns the entry plus its full status, or `undefined`.
   */
  describe(ownerSessionId: string, consoleId: string): ConsoleDetail | undefined {
    const tracked = this.consoles.get(consoleId)
    if (tracked === undefined || tracked.entry.ownerSessionId !== ownerSessionId) return undefined
    return { entry: this.refresh(consoleId), state: tracked.session.status() }
  }

  /**
   * Send one command to a console.
   * @param ownerSessionId - the requesting session.
   * @param consoleId - the console handle.
   * @param text - the command text.
   * @param options - submit key/encoding/actor overrides.
   * @returns the entry after writing.
   * @throws {Error} when the console is unknown to this owner or already closed.
   */
  async send(
    ownerSessionId: string,
    consoleId: string,
    text: string,
    options: { submitKey?: string, encoding?: string, actor?: 'user' | 'model' | 'system', submit?: boolean } = {},
  ): Promise<ConsoleEntry> {
    const tracked = this.require(ownerSessionId, consoleId)
    const status = await tracked.session.send(text, options)
    return this.refresh(consoleId, status)
  }

  /**
   * Read one console's output window.
   * @param ownerSessionId - the requesting session.
   * @param consoleId - the console handle.
   * @param options - cursor, encoding, and echo-filter overrides.
   * @returns the decoded window.
   * @throws {Error} when the console is unknown to this owner.
   */
  read(
    ownerSessionId: string,
    consoleId: string,
    options: { after?: number, encoding?: string, stripEcho?: string, maxBytes?: number } = {},
    // The read result shape is the session's; re-exported by callers through
    // the session module rather than restated here.
  ): ReturnType<ConsoleSession['read']> {
    const tracked = this.require(ownerSessionId, consoleId)
    const result = tracked.session.read(options)
    this.refresh(consoleId)
    return result
  }

  /**
   * Wait on one console.
   * @param ownerSessionId - the requesting session.
   * @param consoleId - the console handle.
   * @param options - condition and budget.
   * @returns the wait outcome.
   * @throws {Error} when the console is unknown to this owner.
   */
  waitFor(
    ownerSessionId: string,
    consoleId: string,
    options: Parameters<ConsoleSession['waitFor']>[0] = {},
  ): ReturnType<ConsoleSession['waitFor']> {
    const tracked = this.require(ownerSessionId, consoleId)
    return tracked.session.waitFor(options).then((result) => {
      this.refresh(consoleId)
      return result
    })
  }

  /**
   * Clear a console's pending pager state so the next page is handled again.
   * @param ownerSessionId - the requesting session.
   * @param consoleId - the console handle.
   * @throws {Error} when the console is unknown to this owner.
   */
  resumePaging(ownerSessionId: string, consoleId: string): void {
    const tracked = this.require(ownerSessionId, consoleId)
    tracked.session.resumePaging()
    this.refresh(consoleId)
  }

  /**
   * Close one console and drop it from the registry.
   * @param ownerSessionId - the requesting session.
   * @param consoleId - the console handle.
   * @param options - `force` destroys the socket.
   * @throws {Error} when the console is unknown to this owner.
   */
  async close(ownerSessionId: string, consoleId: string, options: { force?: boolean } = {}): Promise<void> {
    const tracked = this.require(ownerSessionId, consoleId)
    await tracked.session.close(options)
    tracked.session.dispose()
    this.consoles.delete(consoleId)
    this.banners.delete(consoleId)
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

  /** Every tracked console owned by one session. */
  private ownedBy(ownerSessionId: string): Tracked[] {
    return [...this.consoles.values()].filter(tracked => tracked.entry.ownerSessionId === ownerSessionId)
  }

  /** Resolve a console for an owner or throw the not-found error. */
  private require(ownerSessionId: string, consoleId: string): Tracked {
    const tracked = this.consoles.get(consoleId)
    if (tracked === undefined || tracked.entry.ownerSessionId !== ownerSessionId) {
      // Deliberately the same message for "does not exist" and "belongs to
      // someone else": a session must not be able to probe another's inventory.
      throw new Error(`console-hub: console "${consoleId}" not found for this session`)
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
    }
    return tracked.entry
  }
}
