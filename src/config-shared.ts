/**
 * Half-agnostic vocabulary of dsh-console-hub: the settings shape, its
 * defaults, the encodings/protocols the console engine understands, and the
 * pure helpers both halves share (pattern compilation, credential addresses).
 *
 * This module is imported by the BROWSER bundle as well as the host, so it must
 * never reach for Node builtins or for the schemastery runtime — the schema
 * itself lives in `config.ts`, which only the host half loads.
 *
 * @module dsh-console-hub/config-shared
 */

// ── Vocabularies ────────────────────────────────────────────────────────────

/** Transport a console mapping speaks. */
export const CONSOLE_KINDS = ['telnet', 'raw'] as const
/** One console transport. */
export type ConsoleKind = typeof CONSOLE_KINDS[number]

/**
 * Character encodings a console session may transcode. The names are the
 * WHATWG/Node labels `TextDecoder` and `iconv-lite` both accept; `utf-8` is
 * handled by Node's own Buffer so it works without the optional decoder.
 */
export const CONSOLE_ENCODINGS = [
  'utf-8',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-kr',
  'latin1',
] as const
/** One supported console encoding. */
export type ConsoleEncoding = typeof CONSOLE_ENCODINGS[number]

/**
 * How a session reacts to a pager prompt (`--More--` and friends):
 * - `auto-more` sends space (next page),
 * - `auto-quit` sends `q` (abandon the rest),
 * - `auto-interrupt` sends Ctrl+C (abandon verbosely),
 * - `manual` leaves it to the caller, surfacing `paging.active` instead.
 */
export const PAGING_MODES = ['auto-more', 'auto-quit', 'auto-interrupt', 'manual'] as const
/** One paging mode. */
export type PagingMode = typeof PAGING_MODES[number]

/**
 * Prompt shapes network CLIs use: `<DUT1>` in user view, `[DUT1]` in config
 * view, `[DUT1-interface-Gi0/1]` in a nested view. Anchored at the tail of the
 * accumulated text because a prompt is only a prompt at the end of output.
 */
export const DEFAULT_PROMPT_PATTERN = '[<\\[]\\s*[\\w.\\-]+(?:-[\\w.\\-/]+)*\\s*[>\\]]'

/**
 * Pager shapes seen from console servers and network CLIs. Matched
 * case-insensitively anywhere in the tail of accumulated text.
 */
export const DEFAULT_PAGER_PATTERN
  = '--\\s*more\\s*--|----\\s*more\\s*----|\\bmore:\\s*$|\\(q\\)uit|press any key|按任意键|continue\\?'

/**
 * Command-line prefixes that must not reach a device without an explicit
 * human decision: entering configuration mode, and restarting the box. Split
 * into two sources because the fence matches each independently — a `show`
 * whose argument merely mentions `config` must stay allowed.
 */
export const DEFAULT_HIGH_RISK_PATTERNS = [
  'config|conf|configure',
  'restart|reboot|reload',
] as const

// ── Settings shape ──────────────────────────────────────────────────────────

/** One device mapping. Never carries a secret — see `SecretPayload`. */
export interface ConsoleView {
  /** Human label shown in the panel and in tool output. */
  name: string
  /** Console-server address. */
  host: string
  /** Mapped console port. */
  port: number
  /** Transport for this mapping. */
  kind: ConsoleKind
  /** Per-view encoding override; empty means "use the plugin default". */
  encoding: string
  /** Optional login user (kept here because it is not a secret). */
  user: string
  /** Per-view prompt pattern override; empty means "use the plugin default". */
  promptPattern: string
  /** Per-view pager pattern override; empty means "use the plugin default". */
  pagerPattern: string
  /** Per-view paging mode override; empty means "use the plugin default". */
  pagingMode: '' | PagingMode
  /** Free-form labels for the panel's filter box. */
  tags: string[]
  /** Free-form notes. */
  notes: string
}

/** The plugin's own settings namespace document (user-editable). */
export interface ConsoleHubSettings {
  /** Encoding used when neither the call nor the view states one. */
  defaultEncoding: ConsoleEncoding
  /** Transport used when neither the call nor the view states one. */
  defaultKind: ConsoleKind
  /** Socket connect budget (ms). */
  connectTimeoutMs: number
  /** How long one `read` waits for fresh bytes before answering (ms). */
  readTimeoutMs: number
  /** Idle lifetime of an unused console session before it is reaped (ms). */
  idleTimeoutMs: number
  /** Concurrent console sessions this host keeps open. */
  maxConsoles: number
  /** Bytes one `read`/`wait` answer may carry before it reports truncation. */
  outputLimitBytes: number
  /** Bytes of raw console output retained per session for cursor reads. */
  scrollbackLimitBytes: number
  /** Paging reaction used when the view does not state one. */
  pagingMode: PagingMode
  /** Safety valve of the automatic pager: pages advanced before it stops. */
  pagingMaxPages: number
  /** Quiet window that must elapse before a pager hit counts as settled (ms). */
  pagingQuietMs: number
  /** `always` fences every command; `high-risk` only the listed patterns. */
  approvalMode: 'always' | 'high-risk'
  /** Command-line patterns that require an explicit human decision. */
  highRiskPatterns: string[]
  /** Default prompt pattern for views that do not override it. */
  promptPattern: string
  /** Default pager pattern for views that do not override it. */
  pagerPattern: string
  /** Prompt snippet appended to the model-facing rules (kept as a separate
   *  field so deployments can add their own site conventions). */
  agentInstructions: string
  /** Whether the model-facing `console_*` tools are registered at all. */
  agentConsoleTools: boolean
  /** Device inventory, keyed by view id (`v-<uuid>`). */
  views: Record<string, ConsoleView>
}

/** Defaults applied when the stored document (or a direct caller) omits a field. */
export const DEFAULT_CONSOLE_HUB_SETTINGS: ConsoleHubSettings = {
  defaultEncoding: 'utf-8',
  defaultKind: 'telnet',
  connectTimeoutMs: 8000,
  readTimeoutMs: 15000,
  idleTimeoutMs: 600_000,
  maxConsoles: 16,
  outputLimitBytes: 64 * 1024,
  scrollbackLimitBytes: 256 * 1024,
  pagingMode: 'auto-more',
  pagingMaxPages: 50,
  pagingQuietMs: 120,
  approvalMode: 'high-risk',
  highRiskPatterns: [...DEFAULT_HIGH_RISK_PATTERNS],
  promptPattern: DEFAULT_PROMPT_PATTERN,
  pagerPattern: DEFAULT_PAGER_PATTERN,
  agentInstructions: '',
  agentConsoleTools: true,
  views: {},
}

/** Per-view defaults for fields a stored view may omit. */
export const DEFAULT_CONSOLE_VIEW: Omit<ConsoleView, 'name' | 'host' | 'port'> = {
  kind: DEFAULT_CONSOLE_HUB_SETTINGS.defaultKind,
  encoding: '',
  user: '',
  promptPattern: '',
  pagerPattern: '',
  pagingMode: '',
  tags: [],
  notes: '',
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** The credentials seam scope that owns this plugin's records. */
export const CONSOLE_HUB_CREDENTIAL_SCOPE = 'dsh-console-hub'

/** Prefix of the environment-variable reference that may shadow a record. */
export const SECRET_REF_PREFIX = 'DSH_CONSOLE_'

/**
 * Compile a prompt or pager source into a tail-anchored, case-insensitive
 * matcher. A prompt/pager is only meaningful at the end of accumulated output,
 * so the anchor lives here rather than in every caller.
 * @param source - the pattern body.
 * @returns the compiled matcher.
 * @throws {SyntaxError} when `source` is not a valid regular expression.
 */
export function compilePattern(source: string): RegExp {
  return new RegExp(`(?:${source})\\s*$`, 'i')
}

/**
 * Compile one high-risk source into a whole-command matcher: anchored at the
 * start (so `show running-config` is not fenced) and case-insensitive.
 * @param source - the pattern body.
 * @returns the compiled matcher.
 * @throws {SyntaxError} when `source` is not a valid regular expression.
 */
export function compileCommandFence(source: string): RegExp {
  return new RegExp(`^(?:${source})\\b`, 'i')
}

/**
 * Whether a value names a supported encoding, accepting any letter case.
 * @param value - candidate encoding label.
 * @returns true when the console engine can transcode with it.
 */
export function isConsoleEncoding(value: unknown): value is ConsoleEncoding {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return (CONSOLE_ENCODINGS as readonly string[]).includes(normalized)
}

/**
 * The identity of one view. Kept as a function so every producer of a view id
 * spells the shape in one place.
 * @param viewId - the stored key.
 * @returns the same key.
 */
export function viewIdOf(viewId: string): string {
  return viewId
}

/**
 * The credential record id derived from a view id: `v-<uuid>` becomes
 * `c<32 hex>`, which satisfies the seam's `^[a-z][a-z0-9-]*$` grammar for both
 * key segments. Deriving rather than storing keeps the document free of a
 * second identifier that could drift.
 * @param viewId - the stored view key.
 * @returns the record id segment.
 */
export function recordIdOf(viewId: string): string {
  const hex = viewId.replace(/[^0-9a-z]/gi, '').toLowerCase()
  // Strip the leading `v` marker so the segment starts with the digest.
  const digest = hex.startsWith('v') ? hex.slice(1) : hex
  return `c${digest}`
}

/**
 * The environment-variable reference that may shadow a stored credential.
 * @param viewId - the stored view key.
 * @returns a POSIX-style reference name.
 */
export function secretRefOf(viewId: string): string {
  return `${SECRET_REF_PREFIX}${recordIdOf(viewId).toUpperCase().replace(/-/g, '_')}`
}
