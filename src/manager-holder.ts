/**
 * Live reconfiguration of the port manager.
 *
 * `PortManager` captures its options at construction, but the settings document
 * that supplies them is user-editable and marked `live`. Rebuilding the manager
 * on every settings write would destroy open consoles — a slider drag must not
 * close someone's session — so reconfiguration is deferred while consoles are
 * live and applied at the first moment nothing is open.
 *
 * The rule this module owns is deliberately narrow:
 *
 * - No console open → apply immediately.
 * - Any console open → remember the new policy; `sync` applies it once the last
 *   console closes.
 *
 * A policy applied by `sync` is applied to consoles opened AFTER it, never
 * retroactively: the manager builds each session from the options it holds at
 * `connect` time, so an already-open console keeps the timeouts it was opened
 * with. That is the behaviour that keeps a console usable while its owner is
 * editing settings.
 *
 * @module dsh-console-hub/manager-holder
 */
import { PortManager, type PortManagerOptions } from './port-manager.ts'
import type { ConsoleHubSettings } from './config-shared.ts'

/**
 * Derive the manager's policy from a resolved settings value.
 *
 * `idleSweepMs` is a host-config knob rather than a user preference, so it is
 * passed in and carried through.
 *
 * @param settings - the resolved plugin settings.
 * @param idleSweepMs - how often the host's reaper runs.
 * @returns the manager options to construct (or reconfigure) with.
 */
export function policyFromSettings(settings: ConsoleHubSettings, idleSweepMs: number): PortManagerOptions {
  return {
    maxConsoles: settings.maxConsoles,
    scrollbackLimitBytes: settings.scrollbackLimitBytes,
    outputLimitBytes: settings.outputLimitBytes,
    connectTimeoutMs: settings.connectTimeoutMs,
    readTimeoutMs: settings.readTimeoutMs,
    idleTimeoutMs: settings.idleTimeoutMs,
    idleSweepMs,
    pagingMode: settings.pagingMode,
    pagingMaxPages: settings.pagingMaxPages,
    pagingQuietMs: settings.pagingQuietMs,
    promptPattern: settings.promptPattern,
    pagerPattern: settings.pagerPattern,
    // Carried through so a deployment with silent console servers gets the
    // wake Enter without a per-view flag.
    wakeOnConnect: settings.wakeOnConnect,
  }
}

/** Whether two policies differ in any field the manager reads. */
export function policyDiffers(left: PortManagerOptions, right: PortManagerOptions): boolean {
  return (Object.keys(left) as Array<keyof PortManagerOptions>)
    .some(key => left[key] !== right[key])
}

/** How a reconfiguration request was resolved. */
export type ReconfigureOutcome = 'applied' | 'deferred' | 'unchanged'

/**
 * Owns the manager instance and applies policy changes at safe moments.
 *
 * @example
 * const holder = new ManagerHolder(policyFromSettings(settings, 15_000))
 * holder.reconfigure(policyFromSettings(next, 15_000)) // 'deferred'
 * holder.sync()                                        // applies once idle
 */
export class ManagerHolder {
  private manager: PortManager
  private policy: PortManagerOptions
  private pending: PortManagerOptions | undefined
  private reaperStarted = false

  /** @param policy - the initial manager policy. */
  constructor(policy: PortManagerOptions) {
    this.policy = policy
    this.manager = new PortManager(policy)
  }

  /** The current manager. */
  get(): PortManager {
    return this.manager
  }

  /** The policy in force right now. */
  currentPolicy(): PortManagerOptions {
    return this.policy
  }

  /** The policy waiting for the manager to drain, when one is pending. */
  pendingPolicy(): PortManagerOptions | undefined {
    return this.pending
  }

  /**
   * Start the idle reaper on the current manager (idempotent), so a replacement
   * manager is rearmed by {@link sync} without the host tracking it.
   */
  startReaper(): void {
    this.manager.startReaper()
    this.reaperStarted = true
  }

  /**
   * Request a policy change.
   *
   * @param next - the policy to apply.
   * @returns `unchanged` when it matches the live policy, `applied` when the
   *   manager was replaced now, `deferred` when a console is open and the change
   *   is parked until {@link sync} finds the manager empty.
   */
  reconfigure(next: PortManagerOptions): ReconfigureOutcome {
    if (this.pending === undefined && !policyDiffers(this.policy, next)) return 'unchanged'
    // An already-parked change is superseded by the newer one: the user's latest
    // intent is what should land, not the first edit of a burst.
    this.pending = next
    return this.applyIfIdle() ? 'applied' : 'deferred'
  }

  /**
   * Apply a parked policy if nothing is open.
   *
   * The host calls this when a console may have been closed or reaped; it is
   * cheap and idempotent so a short interval is a fine driver.
   *
   * @returns true when a parked policy was applied by this call.
   */
  sync(): boolean {
    return this.applyIfIdle()
  }

  /** Replace the manager when a parked policy exists and nothing is open. */
  private applyIfIdle(): boolean {
    const pending = this.pending
    if (pending === undefined) return false
    if (this.hasLiveConsoles()) return false

    const previous = this.manager
    this.manager = new PortManager(pending)
    this.policy = pending
    this.pending = undefined
    if (this.reaperStarted) this.manager.startReaper()
    // Disposal is fire-and-forget: the old manager holds no consoles (that is
    // the precondition), so this only settles its own handles.
    void previous.dispose()
    return true
  }

  /** Whether any session still holds an open console. */
  private hasLiveConsoles(): boolean {
    return this.manager.openCount() > 0
  }

  /** Dispose the current manager, draining any parked change. */
  async dispose(): Promise<void> {
    this.pending = undefined
    await this.manager.dispose()
  }
}
