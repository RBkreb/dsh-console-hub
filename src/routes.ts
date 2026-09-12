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
import { assertNoSecretsInViews, newViewId, normalizeView, redactView, type ConsoleViewRedacted } from './views.ts'
import { clearSecret, describeSecret, secretKeyOfView, writeSecret } from './secrets.ts'
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
    wakeOnConnect: settings.wakeOnConnect,
    connectTimeoutMs: settings.connectTimeoutMs,
    readTimeoutMs: settings.readTimeoutMs,
    idleTimeoutMs: settings.idleTimeoutMs,
    maxConsoles: settings.maxConsoles,
    outputLimitBytes: settings.outputLimitBytes,
    scrollbackLimitBytes: settings.scrollbackLimitBytes,
    pagingMaxPages: settings.pagingMaxPages,
    pagingQuietMs: settings.pagingQuietMs,
    agentConsoleTools: settings.agentConsoleTools,
  }
}

/** One view, redacted, with its credential facts loaded. */
async function redactedView(
  api: ConsoleHubApi,
  viewId: string,
  view: ConsoleHubSettings['views'][string],
): Promise<ConsoleViewRedacted> {
  const secret = await describeSecret(api.credentials, viewId)
  return redactView(view, {
    secretConfigured: secret.configured,
    ...secret.source === undefined ? {} : { secretSource: secret.source },
    secretWritable: secret.writable,
  })
}

/** The `config.*` methods. */
function configHandlers(api: ConsoleHubApi): Record<string, Handler> {
  return {
    async 'config.list'(payload) {
      await requireSession(api, payload)
      const settings = api.settings.current()
      const views = await Promise.all(
        Object.entries(settings.views).map(async ([viewId, view]) =>
          ({ viewId, view: await redactedView(api, viewId, view) })),
      )
      views.sort((left, right) => left.view.name.localeCompare(right.view.name))
      return { views, defaults: defaultsFor(settings) }
    },

    async 'config.upsert'(payload) {
      await requireSession(api, payload)
      const settings = api.settings.current()
      const requestedId = optionalString(payload, 'viewId')
      const viewId = requestedId ?? newViewId()
      // Upsert means create-or-update: a supplied id that does not exist yet is a
      // creation, so the only thing to check is that the id is usable as both a
      // settings key and a credential record id.
      if (requestedId !== undefined && !/^[a-z][a-z0-9-]*$/.test(requestedId)) {
        throw new HubError('bad-request', `"viewId" must match [a-z][a-z0-9-]* (got "${requestedId}")`)
      }

      // The view document is built from the fields the view owns, so a flat
      // payload's `sessionId` (or a caller's stray key) can never be mistaken
      // for a view field, and a secret-shaped key inside `view` is still caught.
      const record = payload as Record<string, unknown>
      const nested = record.view
      if (nested !== undefined && (nested === null || typeof nested !== 'object' || Array.isArray(nested))) {
        throw new HubError('bad-request', '"view" must be a JSON object')
      }
      if (nested !== undefined) {
        // A caller who nested a credential inside the view document gets a
        // named refusal rather than a silent drop.
        try {
          assertNoSecretsInViews(nested)
        } catch (error) {
          throw new HubError('bad-request', error instanceof Error ? error.message : String(error))
        }
      }
      const source = nested ?? {
        name: record.name,
        host: record.host,
        port: record.port,
        kind: record.kind,
        encoding: record.encoding,
        user: record.user,
        promptPattern: record.promptPattern,
        pagerPattern: record.pagerPattern,
        pagingMode: record.pagingMode,
        tags: record.tags,
        notes: record.notes,
      }
      let view
      try {
        view = normalizeView(source as never)
      } catch (error) {
        throw new HubError('bad-request', error instanceof Error ? error.message : String(error))
      }

      // The password travels beside the view, never inside it; a secret-shaped
      // key in the document is refused by name.
      const password = optionalString(record, 'password')
      if (password !== undefined && password !== '') {
        await writeSecretOrReject(api, viewId, { password, ...optionalString(record, 'user') === undefined ? {} : { user: optionalString(record, 'user') as string } })
      }

      const nextViews = { ...settings.views, [viewId]: view }
      await applySettingsPatch(api, { views: nextViews })
      return { viewId, view: await redactedView(api, viewId, view) }
    },

    async 'config.remove'(payload) {
      await requireSession(api, payload)
      const settings = api.settings.current()
      const viewId = requireString(payload, 'viewId')
      requireView(settings, viewId)

      const nextViews = { ...settings.views }
      const secretWasConfigured = (await describeSecret(api.credentials, viewId)).configured
      delete nextViews[viewId]
      await applySettingsPatch(api, { views: nextViews })
      // Dropping a view drops its credential with it: a record left behind by a
      // deleted view would be unreachable and would keep a secret on disk.
      await clearSecret(api.credentials, viewId)
      return { removed: true, secretRemoved: secretWasConfigured }
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
      await writeSecretOrReject(api, viewId, { password, ...user === undefined || user === '' ? {} : { user } })
      const info = await describeSecret(api.credentials, viewId)
      return { configured: info.configured, writable: info.writable, viewId }
    },

    async 'secret.clear'(payload) {
      await requireSession(api, payload)
      const settings = api.settings.current()
      const viewId = requireString(payload, 'viewId')
      requireView(settings, viewId)
      await clearSecretOrReject(api, viewId)
      return { configured: false, viewId }
    },
  }
}

/** Write a credential, mapping any store refusal onto the wire code. */
async function writeSecretOrReject(
  api: ConsoleHubApi,
  viewId: string,
  secret: { password: string, user?: string },
): Promise<void> {
  try {
    await writeSecret(api.credentials, viewId, secret)
  } catch (error) {
    throw new HubError('credential-rejected', error instanceof Error ? error.message : String(error))
  }
}

/** Clear a credential, mapping any store refusal onto the wire code. */
async function clearSecretOrReject(api: ConsoleHubApi, viewId: string): Promise<void> {
  try {
    await clearSecret(api.credentials, viewId)
  } catch (error) {
    throw new HubError('credential-rejected', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Apply a settings patch through the write path every writer uses, so the
 * schema, the pattern check, and the secret guard all run.
 * @param api - the API dependencies.
 * @param patch - the partial settings document to merge.
 * @returns the resolved settings after the write.
 * @throws {HubError} `settings-rejected` when the resulting document is invalid.
 */
async function applySettingsPatch(api: ConsoleHubApi, patch: object): Promise<ConsoleHubSettings> {
  const merged = { ...api.settings.current(), ...patch }
  try {
    // Validating the MERGED document refuses the write before it commits.
    parseSettingsDocument(merged)
  } catch (error) {
    throw new HubError('settings-rejected', error instanceof Error ? error.message : String(error))
  }
  const scope = api.settings as HubSettingsFace & { scope?: ConsoleSettingsScope<ConsoleHubSettings> }
  if (scope.scope !== undefined) await scope.scope.update(merged)
  else if (scope.replace !== undefined) await scope.replace(merged)
  else await api.settings.service.update('dsh-console-hub', patch)
  return api.settings.current()
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
      const settings = await applySettingsPatch(api, patch)
      return { revision: api.settings.revision(), settings }
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
