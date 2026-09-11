/**
 * Red-first suite for `src/trust-fence.ts` and `src/wire.ts`: the browser-trust
 * fence in front of every plugin route, and the JSON envelope helpers.
 *
 * The fence is a DNS-rebinding / cross-site defense, not authentication, so its
 * refusals are pinned case by case.
 */
import { describe, expect, it } from 'vitest'
import { isLoopbackHostname, isTrustedApiRequest } from '../src/trust-fence.ts'
import { HubError, readJsonBody, requireString, writeError, writeJson, writeOk } from '../src/wire.ts'
import type { ConsoleHttpRequest, ConsoleHttpResponse } from '../src/context-types.ts'

/** A request stub with only the fields the fence reads. */
function request(headers: Record<string, string>): ConsoleHttpRequest {
  return {
    method: 'POST',
    url: '/',
    headers,
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  }
}

/** A response stub that records what was written. */
function response(): ConsoleHttpResponse & { status?: number, headers?: Record<string, string>, body?: string } {
  const target: ConsoleHttpResponse & { status?: number, headers?: Record<string, string>, body?: string } = {
    writeHead(status, headers) {
      target.status = status
      target.headers = headers
    },
    end(body) {
      target.body = body === undefined ? '' : Buffer.from(body as never).toString('utf8')
    },
  }
  return target
}

/** A body-backed request. */
function bodyRequest(chunks: string[], method = 'POST'): ConsoleHttpRequest {
  let index = 0
  return {
    method,
    url: '/',
    headers: { host: '127.0.0.1' },
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const next = chunks[index]
        if (next === undefined) return { done: true as const, value: undefined }
        index += 1
        return { done: false as const, value: next }
      },
    }),
  }
}

describe('isLoopbackHostname', () => {
  it('accepts the loopback family', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.1.2.3')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
  })

  it('refuses anything else', () => {
    expect(isLoopbackHostname('example.com')).toBe(false)
    expect(isLoopbackHostname('128.0.0.1')).toBe(false)
    expect(isLoopbackHostname('10.133.6.253')).toBe(false)
    expect(isLoopbackHostname('127.0.0.256')).toBe(false)
    expect(isLoopbackHostname('')).toBe(false)
  })
})

describe('isTrustedApiRequest', () => {
  it('accepts a loopback Host from the same origin', () => {
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:43120' }), [])).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'localhost:43120', origin: 'http://localhost:43120' }), [])).toBe(true)
  })

  it('accepts an explicitly trusted (LAN) authority', () => {
    expect(isTrustedApiRequest(request({ host: '192.168.1.10:43120' }), ['192.168.1.10:43120'])).toBe(true)
    // A port-less trusted entry trusts every port on that host.
    expect(isTrustedApiRequest(request({ host: 'app.internal:9999' }), ['app.internal'])).toBe(true)
  })

  it('refuses a Host that is neither loopback nor trusted', () => {
    expect(isTrustedApiRequest(request({ host: 'evil.example.com' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '192.168.1.10:43120' }), ['192.168.1.11:43120'])).toBe(false)
  })

  it('refuses a missing or unparsable Host', () => {
    expect(isTrustedApiRequest(request({}), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: 'not a host' }), [])).toBe(false)
  })

  it('refuses a cross-site browser marker', () => {
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' }), [])).toBe(true)
  })

  it('refuses a foreign Origin and the opaque "null" origin', () => {
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:43120', origin: 'http://evil.example.com' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:43120', origin: 'null' }), [])).toBe(false)
    // A same-hostname Origin passes even when the browser dropped the port.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:43120', origin: 'http://127.0.0.1' }), [])).toBe(true)
  })
})

describe('wire helpers', () => {
  it('reads and parses a JSON body', async () => {
    await expect(readJsonBody(bodyRequest(['{"a":', '1}']), 1024)).resolves.toEqual({ a: 1 })
  })

  it('treats an empty body as an empty object', async () => {
    await expect(readJsonBody(bodyRequest(['']), 1024)).resolves.toEqual({})
    await expect(readJsonBody(bodyRequest([]), 1024)).resolves.toEqual({})
  })

  it('refuses malformed JSON and an oversized body with distinct codes', async () => {
    await expect(readJsonBody(bodyRequest(['{oops']), 1024)).rejects.toMatchObject({ code: 'bad-request' })
    await expect(readJsonBody(bodyRequest(['x'.repeat(2048)]), 64)).rejects.toMatchObject({ code: 'too-large' })
  })

  it('writes the success envelope', () => {
    const res = response()
    writeOk(res, { hello: 'world' })
    expect(res.status).toBe(200)
    expect(res.headers?.['content-type']).toContain('application/json')
    expect(JSON.parse(res.body ?? '')).toEqual({ ok: true, value: { hello: 'world' } })
  })

  it('maps a HubError to its code and status', () => {
    const res = response()
    writeError(res, new HubError('not-found', 'no such console', 404))
    expect(res.status).toBe(404)
    expect(JSON.parse(res.body ?? '')).toEqual({ ok: false, error: { code: 'not-found', message: 'no such console' } })
  })

  it('maps an unexpected throw to an internal 500', () => {
    const res = response()
    writeError(res, new Error('boom'))
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body ?? '')).toMatchObject({ ok: false, error: { code: 'internal' } })
    const nonError = response()
    writeError(nonError, 'just a string')
    expect(JSON.parse(nonError.body ?? '')).toMatchObject({ ok: false, error: { message: 'just a string' } })
  })

  it('writes a JSON body with an explicit status', () => {
    const res = response()
    writeJson(res, 403, { ok: false })
    expect(res.status).toBe(403)
    expect(res.body).toBe('{"ok":false}')
  })

  it('requires a non-empty string field', () => {
    expect(requireString({ a: 'x' }, 'a')).toBe('x')
    expect(() => requireString({ a: '' }, 'a')).toThrow(/a/)
    expect(() => requireString({ a: 1 }, 'a')).toThrow(/a/)
    expect(() => requireString({}, 'a')).toThrow(/a/)
    expect(() => requireString(null, 'a')).toThrow(/a/)
  })
})
