/**
 * Wire helpers for the plugin's JSON API: a bounded body reader, the response
 * envelope, and the shared error type.
 *
 * Every API method answers `{ok: true, value}` or
 * `{ok: false, error: {code, message}}` with an HTTP status matching the code,
 * so the browser half has exactly one shape to branch on.
 *
 * @module dsh-console-hub/wire
 */
import type { ConsoleHttpRequest, ConsoleHttpResponse } from './context-types.ts'

/** Machine-readable error codes of the plugin API. */
export type HubErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'too-large'
  | 'connect-failed'
  | 'session-gone'
  | 'bad-encoding'
  | 'max-consoles'
  | 'credential-rejected'
  | 'settings-rejected'
  | 'settings-conflict'
  | 'internal'

/** One API failure with its wire code and HTTP status. */
export class HubError extends Error {
  /**
   * @param code - the wire code.
   * @param message - human-readable explanation.
   * @param status - HTTP status to answer with.
   */
  constructor(
    readonly code: HubErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = 'HubError'
  }
}

/** Default body cap when a caller declares none. */
const DEFAULT_MAX_BODY_BYTES = 1 << 20

/** Success envelope of one API method. */
export interface HubOk<T> { ok: true, value: T }

/** Failure envelope of one API method. */
export interface HubErr { ok: false, error: { code: HubErrorCode, message: string } }

/**
 * Read and parse a bounded JSON request body.
 * @param req - the request to drain.
 * @param maxBytes - the body cap; larger bodies are refused before parsing.
 * @returns the parsed value; an empty body parses to `{}`.
 * @throws {HubError} `bad-request` for malformed JSON, `too-large` over the cap.
 */
export async function readJsonBody(req: ConsoleHttpRequest, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as never)
    total += buffer.length
    if (total > maxBytes) {
      throw new HubError('too-large', `request body exceeds ${maxBytes} bytes`, 413)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HubError('bad-request', 'request body is not valid JSON')
  }
}

/**
 * Write a JSON response.
 * @param res - the response to write.
 * @param status - HTTP status.
 * @param body - any JSON-serializable value.
 */
export function writeJson(res: ConsoleHttpResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Write the success envelope.
 * @param res - the response to write.
 * @param value - the method's canonical result.
 */
export function writeOk(res: ConsoleHttpResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value } satisfies HubOk<unknown>)
}

/**
 * Write the failure envelope for any thrown value.
 * @param res - the response to write.
 * @param error - a `HubError`, any other throw, or a non-Error value.
 */
export function writeError(res: ConsoleHttpResponse, error: unknown): void {
  if (error instanceof HubError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } } satisfies HubErr)
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } } satisfies HubErr)
}

/**
 * Narrow a payload field to a non-empty string.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the field's value.
 * @throws {HubError} `bad-request` when the field is missing or not a non-empty string.
 */
export function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new HubError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

/**
 * Narrow an optional payload field to a string.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent.
 * @throws {HubError} `bad-request` when present but not a string.
 */
export function optionalString(payload: unknown, key: string): string | undefined {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HubError('bad-request', `"${key}" must be a string`)
  return value
}

/**
 * Narrow an optional payload field to a boolean.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent.
 * @throws {HubError} `bad-request` when present but not a boolean.
 */
export function optionalBoolean(payload: unknown, key: string): boolean | undefined {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new HubError('bad-request', `"${key}" must be a boolean`)
  return value
}

/**
 * Narrow an optional payload field to a finite number.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent.
 * @throws {HubError} `bad-request` when present but not a finite number.
 */
export function optionalNumber(payload: unknown, key: string): number | undefined {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HubError('bad-request', `"${key}" must be a number`)
  return value
}
