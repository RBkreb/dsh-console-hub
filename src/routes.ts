/**
 * The plugin's HTTP API table, served under `/dsh-console-hub/api`.
 *
 * Every request passes the browser-trust fence first, then dispatches on the
 * path's last segment to one method. Methods answer the shared envelope and
 * never throw raw: a `HubError` carries the wire code and status, and anything
 * else becomes an `internal` 500.
 *
 * The surface is deliberately split in two: `config.*`/`secret.*`/`settings.*`
 * manage the device inventory (the panel's data), while the console session
 * methods live in `console-routes.ts` because they operate on live sockets.
 *
 * @module dsh-console-hub/routes
 */
import {
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
  DEFAULT_HIGH_RISK_PATTERNS,
  type ConsoleHubSettings,
} from './config-shared.ts'
import { parseSettingsDocument } from './config.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { HubError, optionalNumber, optionalString, readJsonBody, requireString, writeError, writeOk, writeJson } from './wire.ts'
import { clearSecret, describeSecret, secretKeyOfView, writeSecret } from './secrets.ts'
import {
  applySettingsPatch,
  listViews,
  removeView,
  upsertView,
  type InventoryApi,
} from './inventory.ts'
import type {
  ConsoleCredentialProvider,
  ConsoleHttpRequest,
  ConsoleHttpResponse,
  ConsoleSettingsScope,
  ConsoleSettingsService,
  ConsoleWebRoute,
} from './context-types.ts'
import type { PortManager } from './port-manager.ts'

/** The settings service face plus the owner scope the plugin registered. */
export interface HubSettingsFace {
  service: ConsoleSettingsService
  current(): ConsoleHubSettings
  /** Revision of the raw document, for write guards. */
  revision(): number
  /** Replace the whole section (used by the API's settings writes). */
  replace?(patch: object): Promise<void>
}

/** Everything the API methods need from the host. */
export interface ConsoleHubApi {
  settings: HubSettingsFace
  /**
   * The credential seam, or `undefined` in a composition that mounts none.
   *
   * Deliberately optional rather than required: devices needing no login work
   * without one, and `secrets.ts` reads absence as "no credential configured".
   * Every consumer must therefore handle it -- a delete of a view whose
   * credential cannot exist is a no-op, not a crash.
   */
  credentials: ConsoleCredentialProvider | undefined
  manager: PortManager
  /** Cap on one request body. */
  requestBodyLimitBytes: number
  /** Non-loopback authorities this deployment serves. */
  trustedHosts: readonly string[]
  /** Whether a session id names a live session (owner scoping). */
  sessionExists(sessionId: string): Promise<boolean>
}

/** One dispatchable method: takes the parsed payload, returns the wire value. */
type Handler = (payload: unknown) => Promise<unknown>

/** Read the session id every method requires and prove the session exists. */
async function requireSession(api: ConsoleHubApi, payload: unknown): Promise<string> {
  const sessionId = requireString(payload, 'sessionId')
  // An unknown session is `not-found`, never a leak of which ids exist.
  if (!(await api.sessionExists(sessionId))) {
    throw new HubError('not-found', `no session "${sessionId}"`, 404)
  }
  return sessionId
}

/** Resolve one stored view or fail with `not-found`. */
function requireView(settings: ConsoleHubSettings, viewId: string): ConsoleHubSettings['views'][string] {
  const view = settings.views[viewId]
  if (view === undefined) throw new HubError('not-found', `no view "${viewId}"`, 404)
  return view
}

/** The defaults a configuration surface shows. */
function defaultsFor(settings: ConsoleHubSettings): {
  defaultEncoding: string
  defaultKind: string
  pagingMode: string
  approvalMode: string
  highRiskPatterns: string[]
  promptPattern: string
  pagerPattern: string
  /** Marker text a device prints when it half-closed an idle console. */
  dormantPattern: string
  /** Whether that marker is answered with one bare Enter. */
  dormantAutoWake: boolean
  /** Idle input milliseconds before a keepalive Enter; `0` disables it. */
  dormantProbeMs: number
  /** Whether a silent console is woken with one bare Enter on connect. */
  wakeOnConnect: boolean
  connectTimeoutMs: number
  readTimeoutMs: number
  idleTimeoutMs: number
  maxConsoles: number
  outputLimitBytes: number
  scrollbackLimitBytes: number
  pagingMaxPages: number
  pagingQuietMs: number
  /** Quiet window that satisfies `for: "idle"` (ms). */
  idleQuietMs: number
  agentConsoleTools: boolean
} {
  return {
    defaultEncoding: settings.defaultEncoding,
    defaultKind: settings.defaultKind,
    pagingMode: settings.pagingMode,
    approvalMode: settings.approvalMode,
    highRiskPatterns: [...settings.highRiskPatterns],
    promptPattern: settings.promptPattern,
    pagerPattern: settings.pagerPattern,
    dormantPattern: settings.dormantPattern,
    dormantAutoWake: settings.dormantAutoWake,
    dormantProbeMs: settings.dormantProbeMs,
    wakeOnConnect: settings.wakeOnConnect,
    connectTimeoutMs: settings.connectTimeoutMs,
    readTimeoutMs: settings.readTimeoutMs,
    idleTimeoutMs: settings.idleTimeoutMs,
    maxConsoles: settings.maxConsoles,
    outputLimitBytes: settings.outputLimitBytes,
    scrollbackLimitBytes: settings.scrollbackLimitBytes,
    pagingMaxPages: settings.pagingMaxPages,
    pagingQuietMs: settings.pagingQuietMs,
    idleQuietMs: settings.idleQuietMs,
    agentConsoleTools: settings.agentConsoleTools,
  }
}

/** The `config.*` methods. */
function configHandlers(api: ConsoleHubApi): Record<string, Handler> {
  return {
    async 'config.list'(payload) {
      await requireSession(api, payload)
      // The inventory read is shared with the model's `console_list_views`, so
      // the panel and the model can never disagree about what is configured.
      return { views: await listViews(inventoryOf(api)), defaults: defaultsFor(api.settings.current()) }
    },

    async 'config.upsert'(payload) {
      await requireSession(api, payload)
      return upsertView(inventoryOf(api), payload)
    },

    async 'config.remove'(payload) {
      await requireSession(api, payload)
      return removeView(inventoryOf(api), payload)
    },
  }
}

/** The `secret.*` methods. */
function secretHandlers(api: ConsoleHubApi): Record<string, Handler> {
  return {
    async 'secret.status'(payload) {
      await requireSession(api, payload)
      const settings = api.settings.current()
      const viewId = requireString(payload, 'viewId')
      requireView(settings, viewId)
      const info = await describeSecret(api.credentials, viewId)
      return {
        configured: info.configured,
        writable: info.writable,
        ...info.source === undefined ? {} : { source: info.source },
        viewId,
      }
    },

    async 'secret.set'(payload) {
      await requireSession(api, payload)
      const settings = api.settings.current()
      const viewId = requireString(payload, 'viewId')
      requireView(settings, viewId)
      const password = requireString(payload, 'password')
      const user = optionalString(payload, 'user')
      try {
        await writeSecret(api.credentials, viewId, { password, ...user === undefined || user === '' ? {} : { user } })
      } catch (error) {
        throw new HubError('credential-rejected', error instanceof Error ? error.message : String(error))
      }
      const info = await describeSecret(api.credentials, viewId)
      return { configured: info.configured, writable: info.writable, viewId }
    },

    async 'secret.clear'(payload) {
      await requireSession(api, payload)
      const settings = api.settings.current()
      const viewId = requireString(payload, 'viewId')
      requireView(settings, viewId)
      // Clearing an absent credential is a no-op, so only a store REFUSAL is an
      // error worth reporting.
      try {
        await clearSecret(api.credentials, viewId)
      } catch (error) {
        throw new HubError('credential-rejected', error instanceof Error ? error.message : String(error))
      }
      return { configured: false, viewId }
    },
  }
}

/**
 * View the API's dependency table through the shared inventory interface.
 *
 * The two differ in one direction only: this table always has a settings face,
 * while the interface tolerates one that cannot be written. The adapter also
 * passes the OWNER SCOPE through, which is what lets the shared write path reach
 * `scope.replace` rather than falling back to the merge.
 *
 * @param api - the API dependencies.
 * @returns the inventory view of them.
 */
function inventoryOf(api: ConsoleHubApi): InventoryApi {
  const scope = api.settings as HubSettingsFace & { scope?: ConsoleSettingsScope<ConsoleHubSettings> }
  return {
    current: () => api.settings.current(),
    ...api.settings.replace === undefined ? {} : { replace: (patch: object) => api.settings.replace?.(patch) as Promise<void> },
    ...scope.scope === undefined ? {} : { scope: scope.scope },
    credentials: api.credentials,
  }
}

/** The `settings.*` methods. */
function settingsHandlers(api: ConsoleHubApi): Record<string, Handler> {
  return {
    async 'settings.get'(payload) {
      await requireSession(api, payload)
      const settings = api.settings.current()
      return {
        revision: api.settings.revision(),
        settings,
        defaults: defaultsFor(settings),
      }
    },

    async 'settings.update'(payload) {
      await requireSession(api, payload)
      const record = payload as Record<string, unknown>
      const patch = record.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new HubError('bad-request', 'missing or invalid "patch"')
      }
      const expectedRevision = optionalNumber(payload, 'expectedRevision')
      if (expectedRevision !== undefined && expectedRevision !== api.settings.revision()) {
        throw new HubError(
          'settings-conflict',
          `the settings document changed (expected revision ${expectedRevision}, found ${api.settings.revision()})`,
          409,
        )
      }
      const settings = await applySettingsPatch(inventoryOf(api), patch)
      // The SAME shape `settings.get` answers, so a caller can refresh its view
      // from either reply. Answering the raw section here while the client
      // declared `defaults` is what made a settings control vanish after a
      // toggle: the field it read was simply absent.
      return { revision: api.settings.revision(), settings, defaults: defaultsFor(settings) }
    },
  }
}

/** Every method the base API serves. */
export function apiHandlers(api: ConsoleHubApi): Record<string, Handler> {
  return { ...configHandlers(api), ...secretHandlers(api), ...settingsHandlers(api) }
}

/**
 * Dispatch one parsed method name.
 * @param api - the API dependencies.
 * @param method - the path segment after the API prefix.
 * @param payload - the parsed request body.
 * @returns the method's wire value.
 * @throws {HubError} `not-found` when no method claims the name.
 */
export async function dispatchApi(api: ConsoleHubApi, method: string, payload: unknown): Promise<unknown> {
  const handlers = apiHandlers(api)
  const handler = handlers[method]
  if (handler === undefined) {
    throw new HubError('not-found', `unknown console-hub API method "${method}"`, 404)
  }
  return handler(payload)
}

/**
 * Build the route this plugin registers, with the full dispatch pipeline:
 * fence → method parse → body read → handler → envelope.
 * @param api - the API dependencies.
 * @returns the web-server route registration.
 */
export function buildRoutes(api: ConsoleHubApi): ConsoleWebRoute {
  return {
    kind: 'prefix',
    path: '/dsh-console-hub/api',
    handler: async (req: ConsoleHttpRequest, res: ConsoleHttpResponse) => {
      if (!isTrustedApiRequest(req, api.trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const prefix = '/dsh-console-hub/api/'
      if (!pathname.startsWith(prefix)) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown console-hub API method' } })
        return
      }
      const method = pathname.slice(prefix.length)
      if (method === '' || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown console-hub API method' } })
        return
      }
      try {
        const payload = await readJsonBody(req, api.requestBodyLimitBytes)
        writeOk(res, await dispatchApi(api, method, payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }
}

// Re-exported so the host half can build the defaults it registers without
// importing the settings module directly.
export { DEFAULT_CONSOLE_HUB_SETTINGS, DEFAULT_HIGH_RISK_PATTERNS, DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN }
export { secretKeyOfView }
