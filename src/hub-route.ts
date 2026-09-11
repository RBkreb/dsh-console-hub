/**
 * The one HTTP route this plugin registers.
 *
 * The plugin's API is split across two modules — inventory methods
 * (`config.*`/`secret.*`/`settings.*`) in `routes.ts`, live-socket methods
 * (`console.*`) in `console-routes.ts` — but the web server keys routes by
 * `(kind, path)` and THROWS on a duplicate. Registering both would therefore
 * fail the plugin load, so the two tables compose here into a single handler
 * that owns the prefix.
 *
 * Dispatch is by method namespace rather than by trying one table then the
 * other: `console.*` always belongs to the session table, everything else to
 * the inventory table. That keeps a method's owner a static fact instead of a
 * consequence of which table happens to answer `not-found` first.
 *
 * @module dsh-console-hub/hub-route
 */
import { dispatchApi, type ConsoleHubApi } from './routes.ts'
import { dispatchConsole, type ConsoleSessionApi } from './console-routes.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { HubError, readJsonBody, writeError, writeJson, writeOk } from './wire.ts'
import type { ConsoleHttpRequest, ConsoleHttpResponse, ConsoleWebRoute } from './context-types.ts'

/** The prefix both halves share. */
export const HUB_API_PREFIX = '/dsh-console-hub/api'

/** Everything the combined route needs. */
export interface HubRouteDeps {
  /** The inventory/settings half. */
  hub: ConsoleHubApi
  /** The console-session half. */
  session: ConsoleSessionApi
  /**
   * An additional request gate owned by the host, run after the built-in
   * browser-trust fence.
   *
   * The host uses this to layer the deployment's own browser authentication on
   * top of this plugin's fence when that seam is composed — a web deployment
   * authenticates its browser sessions, and this route must honour that. It
   * returns an HTTP status to refuse with, or `undefined` to allow.
   *
   * @param req - the incoming request.
   * @returns the refusal status, or `undefined`.
   */
  authorize?(req: ConsoleHttpRequest): number | undefined
}

/** The method namespace the session table owns. */
const CONSOLE_METHOD_PREFIX = 'console.'

/**
 * Build the combined route.
 * @param deps - both API tables plus the optional host gate.
 * @returns the route registration.
 */
export function buildHubRoute(deps: HubRouteDeps): ConsoleWebRoute {
  return {
    kind: 'prefix',
    path: HUB_API_PREFIX,
    handler: async (req: ConsoleHttpRequest, res: ConsoleHttpResponse) => {
      // The plugin's own fence first: it is the one every deployment gets, and
      // it must hold even when no host gate is composed.
      if (!isTrustedApiRequest(req, deps.hub.trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      const hostStatus = deps.authorize?.(req)
      if (hostStatus !== undefined) {
        writeJson(res, hostStatus, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const prefix = `${HUB_API_PREFIX}/`
      const method = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
      if (method === '' || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown console-hub API method' } })
        return
      }
      try {
        const payload = await readJsonBody(req, deps.hub.requestBodyLimitBytes)
        const value = method.startsWith(CONSOLE_METHOD_PREFIX)
          ? await dispatchConsole(deps.session, method, payload)
          : await dispatchApi(deps.hub, method, payload)
        writeOk(res, value)
      } catch (error) {
        writeError(res, error)
      }
    },
  }
}

export { HubError }
