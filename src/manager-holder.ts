/**
 * Live reconfiguration of the port manager.
 *
 * A settings write must never close a console someone is using — but it also
 * must never be SILENTLY IGNORED, and that is what this module used to get
 * wrong. It parked the whole policy while any console was open and applied it
 * once the last one closed, so toggling a setting changed nothing until the user
 * closed every console and toggled it again. The setting appeared broken.
 *
 * The parked design existed because policy changes were applied by REPLACING
 * the manager, and the outgoing manager had to be disposed — which closes the
 * consoles it owns. Admitting the change in place removes that dilemma
 * entirely: `PortManager.updateOptions` swaps the policy without touching the
 * open consoles, because each `ConsoleSession` already copies the values it
 * needs at construction.
 *
 * So there is no deferral left to reason about. A policy change applies
 * immediately, and it applies to consoles opened AFTER it — an already-open
 * console keeps the timeouts, patterns and wake behaviour it was opened with,
 * which is the property the deferred version was protecting.
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
 * @returns the manager options to construct (or adopt).
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
    idleQuietMs: settings.idleQuietMs,
    promptPattern: settings.promptPattern,
    pagerPattern: settings.pagerPattern,
    dormantPattern: settings.dormantPattern,
    dormantAutoWake: settings.dormantAutoWake,
    dormantProbeMs: settings.dormantProbeMs,
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
export type ReconfigureOutcome = 'applied' | 'unchanged'

/**
 * Owns the manager instance and keeps its policy in step with the settings
 * document.
 *
 * @example
 * const holder = new ManagerHolder(policyFromSettings(settings, 15_000))
 * holder.reconfigure(policyFromSettings(next, 15_000)) // 'applied'
 */
export class ManagerHolder {
  private readonly manager: PortManager
  private policy: PortManagerOptions

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

  /**
   * Start the idle reaper on the manager (idempotent).
   *
   * Kept as a holder method so the host has one place to arm the reaper without
   * reaching through `get()`, and so arming stays paired with ownership.
   */
  startReaper(): void {
    this.manager.startReaper()
  }

  /**
   * Adopt a policy change.
   *
   * Applies immediately, including while consoles are open: the manager keeps
   * its consoles and only its future behaviour changes. Deliberately NOT
   * deferred — a change that waits for the user to close everything is a change
   * that appears not to work.
   *
   * @param next - the policy to adopt.
   * @returns `unchanged` when it matches the live policy, else `applied`.
   */
  reconfigure(next: PortManagerOptions): ReconfigureOutcome {
    if (!policyDiffers(this.policy, next)) return 'unchanged'
    this.policy = next
    this.manager.updateOptions(next)
    return 'applied'
  }

  /** Dispose the manager, closing every console it holds. */
  async dispose(): Promise<void> {
    await this.manager.dispose()
  }
}
