/**
 * Browser-half API client: the one place the plugin talks to its own host
 * routes.
 *
 * The client is plain `fetch` on purpose — the bundle inlines everything except
 * `react`, so it cannot import a DSH client package, and the plugin's own route
 * is same-origin and already fenced by Host/Origin.
 *
 * @module dsh-console-hub/client/api
 */

/** The subset of `fetch` this client uses (injectable so tests need no network). */
export type FetchLike = (
  url: string,
  init?: { method?: string, headers?: Record<string, string>, body?: string },
) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>

/** The API prefix every call goes to. */
export const API_PREFIX = '/dsh-console-hub/api/'

/** The success envelope the host answers with. */
interface OkEnvelope { ok: true, value: unknown }

/** The failure envelope the host answers with. */
interface ErrEnvelope { ok: false, error: { code: string, message: string } }

/** Whether a parsed body is the failure envelope. */
function isErrEnvelope(body: unknown): body is ErrEnvelope {
  if (body === null || typeof body !== 'object') return false
  const record = body as { ok?: unknown, error?: unknown }
  return record.ok === false && record.error !== null && typeof record.error === 'object'
}

/** Whether a parsed body is the success envelope. */
function isOkEnvelope(body: unknown): body is OkEnvelope {
  return body !== null && typeof body === 'object' && (body as { ok?: unknown }).ok === true
}

/** One method of the plugin API. */
export interface ApiClient {
  /**
   * Invoke one API method.
   * @param method - the dotted method name (`console.list`).
   * @param payload - the JSON request body.
   * @returns the method's value.
   * @throws {Error} when the transport fails or the host answers a failure.
   */
  call<T = unknown>(method: string, payload?: unknown): Promise<T>
}

/**
 * Build an API client.
 * @param fetchImpl - the fetch implementation (defaults to the global one).
 * @returns the client.
 */
export function createApiClient(fetchImpl?: FetchLike): ApiClient {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>)
  return {
    async call<T>(method: string, payload: unknown = {}): Promise<T> {
      const response = await doFetch(`${API_PREFIX}${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        // A body that cannot be parsed is a real failure: returning undefined
        // would make a broken route look like an empty result.
        throw new Error(`console-hub API "${method}" answered an unreadable body: ${String(error)}`)
      }
      if (isErrEnvelope(body)) throw new Error(body.error.message)
      if (isOkEnvelope(body)) return body.value as T
      // Neither envelope: a wiring problem (an intercepting proxy, a wrong
      // prefix), which must be loud rather than silently undefined.
      throw new Error(`console-hub API "${method}" answered an unexpected envelope (HTTP ${String(response.status)})`)
    },
  }
}
