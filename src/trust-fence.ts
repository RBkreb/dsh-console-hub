/**
 * Browser-trust fence for the plugin's own routes.
 *
 * Behaviourally identical to the `/api` gateway's fence: a loopback Host, or an
 * authority the deployment declared trusted, passes; a cross-site browser
 * marker or a foreign Origin refuses. This is a DNS-rebinding and cross-site
 * defense, NOT authentication — the shipped Web composition supplies the
 * session authentication; this fence keeps a page on another origin from
 * reaching the routes at all.
 *
 * @module dsh-console-hub/trust-fence
 */
import type { ConsoleHttpRequest } from './context-types.ts'

/** Read one header as a string, ignoring repeated/array forms. */
function header(headers: ConsoleHttpRequest['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalize a Host-header authority into a URL, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a hostname names the loopback authority.
 * @param hostname - a URL hostname (`localhost`, `127.0.0.1`, `[::1]`).
 * @returns true for the loopback family.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one plugin request may be served.
 * @param request - the node HTTP request facts (headers are all this reads).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours (loopback or trusted) and the browser markers agree.
 */
export function isTrustedApiRequest(request: ConsoleHttpRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin fence: when a browser attaches one it must name this hostname. The
  // port is deliberately not re-decided — some Chromium builds (Edge 151)
  // serialize the Origin of a non-default-port loopback page without the port,
  // and refusing those would brick every route on the page. An absent Origin is
  // fine (the Host fence already bound the request); the literal `null` is an
  // opaque origin and is refused.
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}
