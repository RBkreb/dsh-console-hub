/**
 * dsh-console-hub — host half.
 *
 * Manages network-device console mappings (Telnet / Raw TCP console servers):
 * device views with credentials kept in the credential seam, per-session
 * console connections with paging-aware reads, the plugin's fenced JSON API for
 * the sidebar tab, and the model-facing `console_*` tools.
 *
 * The browser half ships separately through package.json's `dsh.client`
 * declaration and `exports["./client"]`; it registers the sidebar tab through
 * the `betterSidebar` service. This module never imports it — the two halves
 * meet only through the HTTP route registered below.
 *
 * ## What each capability is gated on
 *
 * Every optional seam is reached through `ctx.inject`, so the plugin loads in a
 * composition that lacks it and starts working when it appears:
 *
 * - `settings` — the device inventory; the one hard dependency. Without a
 *   document to read there is nothing to connect to.
 * - `webServer` — the browser half's API. Without it the model tools still work.
 * - `tools` — the model face, additionally gated on the `agentConsoleTools`
 *   setting, so a deployment can serve the panel while refusing the model.
 * - `systemPrompt` — the paragraph telling the model the tools exist, gated the
 *   same way: describing tools the model does not have invites failing calls.
 * - `approval` — the high-risk fence. Deliberately NOT injected: an absent
 *   approval service must fail *closed* at the guard, not defer registration
 *   until one appears.
 *
 * ## Why the manager is behind a getter
 *
 * A settings write can replace the `PortManager` (see `manager-holder.ts`), so
 * every consumer reads it through `holder.get()` at call time. A captured
 * reference would keep serving the disposed instance.
 *
 * @module dsh-console-hub
 */
import {
  assertSettingsValid,
  CONSOLE_HUB_SETTINGS_NS,
  ConsoleHubSettingsSchema,
  parseSettingsDocument,
  resolveConsoleHubConfig,
  type ConsoleHubConfig,
} from './config.ts'
import { approveConsoleCommand, classifyCommand, type ConsoleFenceSettings } from './guard.ts'
import { buildHubRoute } from './hub-route.ts'
import { ManagerHolder, policyFromSettings } from './manager-holder.ts'
import { registerConsoleTools } from './tools.ts'
import type { ConsoleHubApi, HubSettingsFace } from './routes.ts'
import type { ConsoleSessionApi } from './console-routes.ts'
import type { PortManager } from './port-manager.ts'
import type { ConsoleView } from './config-shared.ts'
import type {
  ConsoleApprovalService,
  ConsoleCredentialProvider,
  ConsoleSettingsScope,
  ConsoleSettingsService,
  ConsoleWebServer,
  Context,
} from './context-types.ts'
import type { ConsoleHubSettings } from './config-shared.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-console-hub'

/**
 * Services this plugin reads.
 *
 * `settings` is the only hard dependency. Every other seam is acquired inside
 * `apply` through `ctx.inject`, so its absence degrades one capability instead
 * of failing the load.
 */
export const inject = ['settings']

/** Placement of the plugin's prompt section among the harness sections. */
const SYSTEM_PROMPT_ORDER = 400

/** How long a panel confirmation token stays replayable. */
const CONFIRMATION_TTL_MS = 120_000

/** A settings scope plus the namespace surface the API layers read. */
interface SettingsBinding {
  service: ConsoleSettingsService
  scope: ConsoleSettingsScope<ConsoleHubSettings>
}

/** A one-shot confirmation token and the moment it stops being replayable. */
interface Confirmation {
  expiresAt: number
}

/** The prompt registry slice this plugin uses. */
interface PromptRegistry {
  section(section: { name: string, order: number, text: string | ((context: unknown) => string) }): () => void
}

/** The running engine, exposed for diagnostics and tests. */
export interface ConsoleHubRuntime {
  /** The live manager holder. */
  holder: ManagerHolder
  /** Resolve the current settings value. */
  settings(): ConsoleHubSettings
}

/** The most recently applied runtime (one plugin instance per process). */
let active: ConsoleHubRuntime | undefined

/**
 * The plugin's live runtime, for diagnostics and tests.
 * @returns the runtime, or `undefined` when the plugin is not applied.
 */
export function runtime(): ConsoleHubRuntime | undefined {
  return active
}

/**
 * Host plugin body.
 *
 * @param ctx - the host context.
 * @param config - the plugin row's host-side configuration.
 */
export function apply(ctx: Context, config?: ConsoleHubConfig): void {
  const resolved = resolveConsoleHubConfig(config)
  const logger = ctx.logger

  // The engine starts on the shipped defaults so the plugin is usable the
  // instant it loads. The settings registration below replaces the policy with
  // the user's document before anything can connect.
  const holder = new ManagerHolder(policyFromSettings(parseSettingsDocument({}), resolved.sessionIdleSweepMs))
  holder.startReaper()
  ctx.effect(() => () => {
    if (active?.holder === holder) active = undefined
    void holder.dispose()
  }, 'dsh-console-hub: port manager')

  // Confirmation tokens are per-process and single-use. They are the panel's
  // equivalent of an approval grant: the human already decided, so what is
  // fenced is the REPLAY, not the decision.
  const confirmations = new Map<string, Confirmation>()

  ctx.inject(['settings'], (scoped) => {
    const binding = bindSettings(scoped.settings as ConsoleSettingsService)

    /**
     * The RAW stored section, read live.
     *
     * `scope.get()` returns a value the seam froze when the namespace was
     * registered and refreshes only on a commit it recognises as current.
     * `describe().user`, by contrast, reads the provider's live document -- the
     * same document a write updates unconditionally. When those two disagree,
     * the panel must show what is STORED: that is what survives a restart, and
     * it is what the configuration-surface read path exists for.
     *
     * Returns `undefined` whenever the seam cannot answer, so the caller falls
     * back to the registered scope rather than losing the read entirely.
     *
     * @returns the raw user section, or `undefined` when unavailable.
     */
    const storedSection = (): unknown => {
      const service = binding.service as {
        describe?: () => Array<{ ns: string, user?: unknown }>
      }
      if (typeof service.describe !== 'function') return undefined
      try {
        return service.describe().find(entry => entry.ns === CONSOLE_HUB_SETTINGS_NS)?.user
      } catch (error) {
        logger?.warn(`console-hub: the settings service could not describe its namespaces: ${String(error)}`)
        return undefined
      }
    }

    /** Announce a divergence between the stored section and the frozen value, once. */
    let divergenceReported = false
    const reportDivergence = (stored: unknown, frozen: ConsoleHubSettings): void => {
      if (divergenceReported) return
      const storedViews = Object.keys((stored as { views?: object } | undefined)?.views ?? {}).length
      const frozenViews = Object.keys(frozen.views).length
      if (storedViews === frozenViews) return
      divergenceReported = true
      // This is the line that explains an empty panel over a populated file.
      logger?.warn(
        `console-hub: the settings document holds ${String(storedViews)} saved device(s) but the registered value holds `
        + `${String(frozenViews)}; reading the stored document`, 
      )
    }

    /** Resolve the settings value, preferring the stored document over the frozen one. */
    const readSettings = (): ConsoleHubSettings => {
      const stored = storedSection()
      const frozen = binding.scope.get()
      if (stored !== undefined) reportDivergence(stored, frozen)
      try {
        return parseSettingsDocument(stored ?? frozen)
      } catch (error) {
        // Previously silent, which is what made an unusable stored section look
        // exactly like an empty inventory. Say so, and say why.
        logger?.warn(
          `console-hub: the stored settings section is unusable, serving the shipped defaults: `
          + `${error instanceof Error ? error.message : String(error)}`,
        )
        return parseSettingsDocument({})
      }
    }

    // Announce what the engine starts from, so a load-time mismatch is visible.
    const initial = readSettings()
    logger?.info(
      `console-hub: loaded with ${String(Object.keys(initial.views).length)} saved device(s) `
      + `(settings revision ${String(binding.scope as unknown as { revision?: number }['revision'] ?? 'n/a')})`,
    )

    holder.reconfigure(policyFromSettings(initial, resolved.sessionIdleSweepMs))
    active = { holder, settings: readSettings }

    // A parked policy lands as soon as the manager drains. The interval matches
    // the idle sweep: cheap, and one comparison per tick while idle.
    const drain = setInterval(() => {
      if (holder.sync() && logger !== undefined) logger.info('console-hub: applied the deferred engine policy')
    }, Math.max(1000, resolved.sessionIdleSweepMs))
    drain.unref?.()
    ctx.effect(() => () => {
      clearInterval(drain)
    }, 'dsh-console-hub: policy drain')

    const policyWatch = binding.scope.watch((next) => {
      const outcome = holder.reconfigure(policyFromSettings(next, resolved.sessionIdleSweepMs))
      if (outcome === 'deferred' && logger !== undefined) {
        logger.info('console-hub: engine policy change deferred until the open consoles close')
      }
    })
    ctx.effect(() => policyWatch, 'dsh-console-hub: policy watch')

    installApi(ctx, binding, holder, resolved.requestBodyLimitBytes, readSettings, confirmations, resolved.trustedHosts)

    // The two model-facing surfaces share one gate: both read the same setting
    // and must flip together, so one subscription drives them. The renderers are
    // built ONCE — each closes over the disposer of what it registered, so
    // rebuilding them per commit would lose that handle and register twice.
    const renderers = [installTools(ctx, holder, readSettings), installPrompt(ctx, readSettings)]
    for (const render of renderers) render()
    const gateWatch = binding.scope.watch(() => {
      for (const render of renderers) render()
    })
    ctx.effect(() => gateWatch, 'dsh-console-hub: model gate')
  })
}
/**
 * Register this plugin's settings namespace.
 *
 * The returned scope is the only reader and writer of the section, so every
 * path goes through the schema, the secret guard, and the pattern check.
 *
 * @param settings - the settings service.
 * @returns the binding.
 */
function bindSettings(settings: ConsoleSettingsService): SettingsBinding {
  const scope = settings.register<ConsoleHubSettings>(CONSOLE_HUB_SETTINGS_NS, ConsoleHubSettingsSchema, {
    // The schema cannot express "this string must compile as a regular
    // expression", so `validate` refuses the WRITE that produced a bad pattern
    // instead of letting a live console throw on its first read.
    applies: 'live',
    validate: (value: ConsoleHubSettings) => {
      assertSettingsValid(value)
    },
  } as never)
  return { service: settings, scope }
}

/** The fence policy a settings value describes. */
function fencePolicyOf(settings: ConsoleHubSettings): ConsoleFenceSettings {
  return { approvalMode: settings.approvalMode, highRiskPatterns: settings.highRiskPatterns }
}

/**
 * Mint a single-use confirmation token.
 * @param store - the token store.
 * @returns the token to hand the panel.
 */
function mintConfirmation(store: Map<string, Confirmation>): string {
  const now = Date.now()
  // Opportunistically drop expired entries: a long-lived process must not
  // accumulate one grant per high-risk command ever attempted.
  for (const [token, entry] of store) {
    if (entry.expiresAt < now) store.delete(token)
  }
  const token = `ct-${Math.random().toString(36).slice(2, 10)}-${now.toString(36)}`
  store.set(token, { expiresAt: now + CONFIRMATION_TTL_MS })
  return token
}

/**
 * Redeem a confirmation token.
 *
 * Consumption happens before the caller writes, so a failure downstream cannot
 * leave a reusable grant behind.
 *
 * @param store - the token store.
 * @param token - the token the panel replayed.
 * @returns whether the token was live.
 */
function consumeConfirmation(store: Map<string, Confirmation>, token: string): boolean {
  const entry = store.get(token)
  if (entry === undefined) return false
  store.delete(token)
  return Date.now() <= entry.expiresAt
}

/**
 * Register the plugin's HTTP API for the browser half.
 *
 * @param ctx - the host context.
 * @param binding - the registered settings namespace.
 * @param holder - the manager holder.
 * @param requestBodyLimitBytes - the request body cap.
 * @param readSettings - resolves the live settings value.
 * @param confirmations - the one-shot confirmation-token store.
 * @param trustedHosts - non-loopback authorities this deployment serves.
 */
function installApi(
  ctx: Context,
  binding: SettingsBinding,
  holder: ManagerHolder,
  requestBodyLimitBytes: number,
  readSettings: () => ConsoleHubSettings,
  confirmations: Map<string, Confirmation>,
  trustedHosts: readonly string[] = [],
): void {
  let revision = 0

  const settingsFace: HubSettingsFace = {
    service: binding.service,
    current: readSettings,
    revision: () => revision,
    replace: async (patch: object) => {
      await binding.scope.update(patch)
      revision += 1
    },
  }

  /**
   * Whether a session id names a live session.
   *
   * Advisory only, and deliberately never a refusal. The panel sends the id of
   * the conversation it is attached to, and every call it makes reuses that same
   * id -- so consoles end up consistently scoped to it whether or not a session
   * store in THIS process happens to recognise it. Isolation comes from the
   * manager's per-owner scoping plus the route's browser-trust and
   * authentication fences, not from this lookup.
   *
   * It was a hard gate once, and that broke the whole panel in a composition
   * whose session store did not know the panel's id: saving a device failed with
   * `no session "..."` even though the same code worked under another profile.
   * A gate with a catastrophic failure mode that protects nothing is worth less
   * than the diagnostic it can still provide, so an unrecognised id is logged
   * and accepted rather than rejected.
   */
  const unrecognised = new Set<string>()
  const sessionExists = async (sessionId: string): Promise<boolean> => {
    if (sessionId === '') return false
    const sessions = ctx.get<{ get?: (id: string) => unknown }>('sessions')
    if (sessions?.get === undefined) return true
    let known: boolean
    try {
      known = sessions.get(sessionId) !== undefined
    } catch (error) {
      // A store that throws is even less of an authority on the caller's
      // identity than one that merely does not know it.
      ctx.logger?.warn(`console-hub: the session store rejected a lookup for "${sessionId}": ${String(error)}`)
      return true
    }
    if (!known && !unrecognised.has(sessionId)) {
      // Once per id: this runs on every panel request, and the useful signal is
      // the first occurrence, not the hundredth.
      unrecognised.add(sessionId)
      ctx.logger?.warn(
        `console-hub: the session store does not know "${sessionId}"; serving it anyway, because the panel's own id is `
        + 'consistent across calls and consoles are scoped by it regardless',
      )
    }
    return true
  }

  const hub: ConsoleHubApi = {
    settings: settingsFace,
    // Read on EVERY call, never captured: Cordis resolves a service only once
    // its providing fiber is ACTIVE, and this plugin does not inject
    // `credentials`. It injects only `settings`, so this table is built while
    // the credentials provider may still be activating -- a one-time read
    // stored `undefined` and every credential path then threw
    // "Cannot read properties of undefined (reading 'deleteRecord')".
    // `sessionExists` below reads ITS service the same way, for the same
    // reason.
    get credentials(): ConsoleCredentialProvider | undefined {
      return ctx.get<ConsoleCredentialProvider>('credentials')
    },
    // Read through the holder on EVERY call: a deferred policy change replaces
    // the instance, and a captured reference would keep serving the disposed one.
    get manager(): PortManager {
      return holder.get()
    },
    requestBodyLimitBytes,
    trustedHosts,
    sessionExists,
  }

  const session: ConsoleSessionApi = {
    get manager(): PortManager {
      return holder.get()
    },
    requestBodyLimitBytes,
    trustedHosts,
    sessionExists,
    viewOf: async (_sessionId, viewId) => {
      const view = readSettings().views[viewId]
      return view === undefined ? undefined : { viewId, ...view }
    },
    defaultEncoding: () => readSettings().defaultEncoding,
    defaults: () => {
      const value = readSettings()
      return {
        connectTimeoutMs: value.connectTimeoutMs,
        encoding: value.defaultEncoding,
        kind: value.defaultKind,
        pagingMode: value.pagingMode,
      }
    },
    // The panel's path. The human is already in the loop, so this does NOT go
    // through `ctx.approval` — that seam requires an open agent turn, which a
    // sidebar click has none of. What it mints instead is the single-use token
    // the panel must replay after a second explicit confirmation.
    fenceForUser: ({ text, label }) => {
      const policy = fencePolicyOf(readSettings())
      if (policy.approvalMode !== 'always' && classifyCommand(text, policy).risk === 'safe') {
        return { risk: 'safe' as const }
      }
      return {
        risk: 'high' as const,
        confirmationToken: mintConfirmation(confirmations),
        reason: `"${text}" is a high-risk command on "${label}"`,
      }
    },
    consumeConfirmation: (_sessionId, _consoleId, token) => consumeConfirmation(confirmations, token),
  }

  ctx.inject(['webServer'], (webScoped) => {
    const server = webScoped.webServer as ConsoleWebServer
    // When the deployment composes its connection seam, that seam owns browser
    // authentication for `/api`. This route must honour the same trust it
    // applies to the built-in API rather than inventing a weaker one.
    const connection = ctx.get<{
      requestRejection?: (request: { headers: Record<string, string | string[] | undefined> }) => number | undefined
    }>('connection')
    const reject = connection?.requestRejection
    const route = buildHubRoute({
      hub,
      session,
      ...reject === undefined ? {} : { authorize: req => reject.call(connection, { headers: req.headers }) },
    })
    const dispose = server.register(route as never)
    ctx.effect(() => dispose, 'dsh-console-hub: api route')
  })
}

/**
 * Register the model-facing tool family, gated on `agentConsoleTools`.
 *
 * The family is registered INSIDE the `tools` inject callback, not by the
 * caller: Cordis resolves an injected dependency asynchronously (its fiber
 * runner awaits before running the callback), so anything the caller does
 * immediately after `ctx.inject` returns sees the service as still absent.
 * Registration therefore has to be driven from inside the callback, and the
 * callback re-runs whenever the service is replaced.
 *
 * @param ctx - the host context.
 * @param holder - the manager holder.
 * @param readSettings - resolves the live settings value.
 * @returns the gate, which the settings watcher calls on every commit.
 */
function installTools(
  ctx: Context,
  holder: ManagerHolder,
  readSettings: () => ConsoleHubSettings,
): () => void {
  let dispose: (() => void) | undefined
  let registry: { register(tool: unknown): () => void } | undefined

  /** Bring the registration in line with the current setting. */
  const sync = (): void => {
    const wanted = readSettings().agentConsoleTools
    if (!wanted || registry === undefined) {
      // Withdrawing must actually unregister: a model that still saw the tools
      // would keep calling them and hitting a refusal.
      dispose?.()
      dispose = undefined
      return
    }
    if (dispose !== undefined) return
    dispose = registerConsoleTools({
      registry,
      // Read the live manager and settings on every call: a settings write can
      // replace either while a console is open.
      get manager(): PortManager {
        return holder.get()
      },
      views: () => readSettings().views as Record<string, ConsoleView>,
      defaults: () => {
        const value = readSettings()
        return { encoding: value.defaultEncoding, kind: value.defaultKind, pagingMode: value.pagingMode }
      },
      guard: async ({ exec, sessionId, consoleId, text }) => {
        const decision = await approveConsoleCommand(
          {
            exec,
            consoleLabel: holder.get().get(sessionId, consoleId)?.label ?? consoleId,
            command: text,
          },
          {
            policy: fencePolicyOf(readSettings()),
            // Not injected: absent means the guard fails closed with a reason.
            approver: ctx.get<ConsoleApprovalService>('approval'),
          },
        )
        if (!decision.approved) throw new Error(decision.reason ?? 'the command was refused')
      },
    })
  }

  ctx.inject(['tools'], (toolScoped) => {
    registry = toolScoped.tools as unknown as typeof registry
    sync()
    // The callback's disposer releases the family with this inner fiber, so an
    // HMR replace does not leave the tools registered against a dead service.
    return () => {
      dispose?.()
      dispose = undefined
      registry = undefined
    }
  })

  return sync
}


/**
 * Register the prompt section describing the console tools.
 *
 * Like {@link installTools}, registration happens INSIDE the inject callback:
 * Cordis resolves the service asynchronously, so the section cannot be added by
 * the caller right after `ctx.inject` returns. The section is gated on the same
 * setting as the tools — describing tools the model does not have would invite
 * calls that always fail.
 *
 * @param ctx - the host context.
 * @param readSettings - resolves the live settings value.
 * @returns the gate, which the settings watcher calls on every commit.
 */
function installPrompt(ctx: Context, readSettings: () => ConsoleHubSettings): () => void {
  let dispose: (() => void) | undefined
  let prompt: PromptRegistry | undefined

  /** Bring the section in line with the current setting. */
  const sync = (): void => {
    const wanted = readSettings().agentConsoleTools
    if (!wanted || prompt === undefined) {
      dispose?.()
      dispose = undefined
      return
    }
    if (dispose !== undefined) return
    dispose = prompt.section({
      name: 'dsh-console-hub',
      order: SYSTEM_PROMPT_ORDER,
      text: () => {
        const settings = readSettings()
        const extra = settings.agentInstructions.trim()
        return [
          'Network device consoles are available through the console_* tools.',
          'A console is scoped to YOUR session: console_connect and console_list only ever see consoles this session opened.',
          'Workflow: console_connect (by viewId, or by host+port), then console_send, then console_read, passing the `cursor`',
          'from each read back as `after` so no output is read twice. Use console_wait_for to wait for the device prompt',
          'instead of sleeping, and console_close when finished.',
          'High-risk commands (entering configuration mode, restarting) require user approval; a refusal is a decision to',
          'report, not an error to retry.',
          ...extra === '' ? [] : ['', extra],
        ].join('\n')
      },
    })
  }

  ctx.inject(['systemPrompt'], (promptScoped) => {
    prompt = promptScoped.systemPrompt as unknown as PromptRegistry
    sync()
    return () => {
      dispose?.()
      dispose = undefined
      prompt = undefined
    }
  })

  return sync
}

export { DEFAULT_CONSOLE_HUB_SETTINGS } from './config-shared.ts'
export type { ConsoleHubSettings } from './config-shared.ts'
