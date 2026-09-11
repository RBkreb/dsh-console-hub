/**
 * View normalization and the secret guard.
 *
 * A "view" is one device mapping. This module owns the shape the panel, the
 * HTTP API, and the console engine all agree on, plus the invariant that no
 * credential ever enters the settings document: {@link findSecretKeys} scans
 * for secret-shaped keys and the settings path refuses a write that carries
 * one.
 *
 * @module dsh-console-hub/views
 */
import {
  CONSOLE_KINDS,
  isConsoleEncoding,
  type ConsoleKind,
  type ConsoleView,
} from './config-shared.ts'

/** What a caller may supply when creating or updating a view. */
export interface ConsoleViewInput {
  name?: unknown
  host?: unknown
  port?: unknown
  kind?: unknown
  encoding?: unknown
  user?: unknown
  promptPattern?: unknown
  pagerPattern?: unknown
  pagingMode?: unknown
  tags?: unknown
  notes?: unknown
}

/** Credential facts attached to a view for display (never a value). */
export interface ConsoleViewSecretState {
  /** Whether a credential currently resolves for this view. */
  secretConfigured: boolean
  /** Where the value comes from (`file` / `env`), when configured. */
  secretSource?: string
  /** Whether the credential store would accept a write right now. */
  secretWritable?: boolean
}

/** A view as every read path returns it: normalized, plus credential facts. */
export type ConsoleViewRedacted = ConsoleView & ConsoleViewSecretState

/**
 * Mint a new view id: `v-<uuid>`. The `v-` marker is what turns a view id into
 * both a credential record id and an environment-variable reference.
 * @returns a fresh id.
 */
export function newViewId(): string {
  return `v-${crypto.randomUUID()}`
}

/**
 * Assert one supplied field is a non-empty string (after trimming).
 * @param value - the raw field.
 * @param field - field name for the error message.
 * @returns the trimmed value.
 * @throws {TypeError} when the field is missing or blank.
 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`console-hub view: "${field}" must be a non-empty string`)
  }
  return value.trim()
}

/** Read an optional string field, defaulting (and trimming) when absent. */
function optionalText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new TypeError('console-hub view: expected a string field')
  return value.trim()
}

/**
 * Normalize a raw view input into the canonical view record.
 * @param input - fields from the API or the settings document.
 * @returns the normalized view.
 * @throws {TypeError} naming the first field that cannot be accepted.
 */
export function normalizeView(input: ConsoleViewInput): ConsoleView {
  const name = requireText(input.name, 'name')
  const host = requireText(input.host, 'host')

  const port = input.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`console-hub view: "port" must be an integer in 1..65535 (got ${String(port)})`)
  }

  const kind = input.kind === undefined || input.kind === null ? 'telnet' : input.kind
  if (typeof kind !== 'string' || !(CONSOLE_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`console-hub view: "kind" must be one of ${CONSOLE_KINDS.join(' | ')} (got ${String(kind)})`)
  }

  const rawEncoding = optionalText(input.encoding, '')
  if (rawEncoding !== '' && !isConsoleEncoding(rawEncoding)) {
    throw new TypeError(`console-hub view: unsupported "encoding" "${rawEncoding}"`)
  }

  const pagingMode = optionalText(input.pagingMode, '')
  if (pagingMode !== '' && !['auto-more', 'auto-quit', 'auto-interrupt', 'manual'].includes(pagingMode)) {
    throw new TypeError(`console-hub view: unsupported "pagingMode" "${pagingMode}"`)
  }

  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map(tag => (typeof tag === 'string' ? tag.trim() : '')).filter(tag => tag !== ''))]
    : []
  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new TypeError('console-hub view: "tags" must be an array of strings')
  }

  return {
    name,
    host,
    port,
    kind: kind as ConsoleKind,
    // Normalized to the label the engine resolves, so `GBK` and `gbk` cannot
    // behave differently.
    encoding: rawEncoding === '' ? '' : rawEncoding.toLowerCase(),
    user: optionalText(input.user, ''),
    promptPattern: optionalText(input.promptPattern, ''),
    pagerPattern: optionalText(input.pagerPattern, ''),
    pagingMode: pagingMode as ConsoleView['pagingMode'],
    tags,
    notes: optionalText(input.notes, ''),
  }
}

/**
 * Project a view for a read path: the normalized record plus credential facts,
 * and structurally nothing else.
 * @param view - the stored view.
 * @param secret - credential facts read from the credential seam.
 * @returns the projection safe to hand to the panel, the API, and the tools.
 */
export function redactView(view: ConsoleView, secret: ConsoleViewSecretState): ConsoleViewRedacted {
  return {
    name: view.name,
    host: view.host,
    port: view.port,
    kind: view.kind,
    encoding: view.encoding,
    user: view.user,
    promptPattern: view.promptPattern,
    pagerPattern: view.pagerPattern,
    pagingMode: view.pagingMode,
    tags: [...view.tags],
    notes: view.notes,
    secretConfigured: secret.secretConfigured,
    ...secret.secretSource === undefined ? {} : { secretSource: secret.secretSource },
    ...secret.secretWritable === undefined ? {} : { secretWritable: secret.secretWritable },
  }
}

/**
 * Key names that mean "this is a secret". Matched case-insensitively as a
 * substring so `password`, `PassWord`, `passwd`, `secret`, and `apiKey` are all
 * caught rather than only the spellings we happened to think of.
 */
const SECRET_KEY_PATTERN = /pass|secret|credential|apikey|api_key|token|pwd/i

/**
 * Find every secret-shaped key in a value, with dotted paths.
 * @param value - the value to scan (plain objects and arrays are walked).
 * @returns the offending paths, in encounter order; empty when clean.
 */
export function findSecretKeys(value: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path === '' ? key : `${path}.${key}`
      if (SECRET_KEY_PATTERN.test(key)) found.push(childPath)
      walk(child, childPath)
    }
  }
  walk(value, '')
  return found
}

/**
 * Refuse a view set that carries a secret-shaped key. The settings document is
 * plain text and world-readable; a password belongs in the credential seam.
 * @param views - the view map about to be written.
 * @throws {TypeError} naming every offending path at once.
 */
export function assertNoSecretsInViews(views: unknown): void {
  const offenders = findSecretKeys(views)
  if (offenders.length === 0) return
  throw new TypeError(
    `console-hub views must not carry credentials; move ${offenders.join(', ')} to the credential store`,
  )
}

/** Narrow a value to a plain object (not null, not an array). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
