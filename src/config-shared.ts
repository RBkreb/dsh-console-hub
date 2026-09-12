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
 * What a device prints when it has torn down the console session on ITS side
 * while leaving the TCP connection up.
 *
 * Measured on the lab hardware, not invented: after a long idle period the
 * device announces
 *
 *     Vty connection is timed out.
 *
 *     Please press ENTER.
 *
 * and then prints nothing at all — no device events, no command output — until
 * somebody presses a key. The socket never closes, so from the plugin's side the
 * console still looks `open` while it is in fact dormant. That is the failure
 * this pattern exists to name.
 *
 * Matched as an unanchored SEARCH, because it arrives in the middle of output
 * rather than at the tail like a prompt, and case-insensitively so a device that
 * shouts `ENTER` and one that whispers `Enter` both count. `press enter` is
 * deliberately distinct from the pager's `press any key`.
 *
 * The bytes, verbatim from `scripts/probe-dormant.mjs`:
 *
 *     \r\nVty connection is timed out.\r\n\r\nPlease press ENTER.
 *
 * The first alternative spans the whole announcement, so the marker a caller is
 * shown is the device's own sentence pair rather than whichever half happened to
 * match first -- an alternation of the two halves alone reported only "Vty
 * connection is timed out", which reads like a socket error instead of a request
 * for a keystroke. The other two alternatives keep detection working for a
 * device that prints only one of the halves.
 */
export const DEFAULT_DORMANT_PATTERN
  = 'vty\\s+connection\\s+is\\s+timed\\s+out[\\s\\S]{0,120}?please\\s+press\\s+enter'
  + '|vty\\s+connection\\s+is\\s+timed\\s+out'
  + '|please\\s+press\\s+enter'

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
  /**
   * How long output must be silent before `for: "idle"` counts as "it stopped"
   * (ms). Overridable per call with `idleMs`.
   *
   * This is the number that defines the idle wait, and the default is MEASURED
   * rather than chosen for tidiness. Both lab devices pace their long answers
   * through the console server in ~960-byte slabs roughly **1000ms** apart
   * (`scripts/probe-output-gaps.mjs`), so any window shorter than that gap
   * matches in the MIDDLE of an answer: at the old 250ms default an idle wait
   * returned `matched: true` having read **0 characters**, with 5760 more
   * arriving afterwards (`scripts/probe-idle-falsedone.mjs`).
   *
   * 1500ms clears the measured 1014ms worst-case gap with margin. On a chatty
   * device it is a floor, not a promise: an idle wait can still match during a
   * genuine lull, which is why `for: "prompt"` is the reliable way to know a
   * command finished and idle is documented as a heuristic.
   */
  idleQuietMs: number
  /** `always` fences every command; `high-risk` only the listed patterns. */
  approvalMode: 'always' | 'high-risk'
  /** Command-line patterns that require an explicit human decision. */
  highRiskPatterns: string[]
  /** Default prompt pattern for views that do not override it. */
  promptPattern: string
  /** Default pager pattern for views that do not override it. */
  pagerPattern: string
  /** Marker text a device prints when it half-closed an idle console. */
  dormantPattern: string
  /**
   * Answer that marker with one bare Enter, which is what the device is asking
   * for. On by default because the alternative is a console that silently prints
   * nothing: the marker exists precisely to request a keystroke.
   */
  dormantAutoWake: boolean
  /**
   * Idle milliseconds after which a bare Enter is sent to KEEP an idle console
   * awake, before the device's own timeout can fire. `0` disables it.
   *
   * A keepalive rather than a recovery: it is cheaper than detecting the
   * half-close and cleaning up after it, and it is the only thing that makes the
   * device keep printing its events. It deliberately does NOT count as "someone
   * is using this console", so the idle reaper can still reclaim a forgotten
   * tab.
   *
   * MEASURED, not guessed: both lab devices tear the console session down after
   * exactly 300s of silence (`scripts/probe-dormant.mjs`), and any real traffic
   * resets that timer. The default sits well under that so the probe always wins
   * the race; a deployment whose devices idle out faster lowers it.
   */
  dormantProbeMs: number
  /**
   * Send one bare Enter when a device says nothing on connect.
   *
   * Some console servers stay completely silent until a key is pressed: no
   * banner, no prompt. Against such a device every read is empty and there is
   * nothing to key off, even though the console is fine. One Enter wakes it.
   *
   * ON by default, which is a deliberate reversal of the first design. Measured
   * against real hardware: without it the device consumes the caller's FIRST
   * command as the wake keystroke -- it echoes the line and returns a prompt
   * with no output, so `show version` appears to do nothing and the console
   * looks broken. Silently losing a command is a far worse failure than an
   * unsolicited newline, and the Enter is sent only after the whole banner
   * window elapsed with no prompt, so a device that greets on connect never
   * receives one at all.
   *
   * A deployment where Enter is meaningfully destructive (a boot menu that acts
   * on any key, say) turns this off.
   */
  wakeOnConnect: boolean
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
  // Measured: both lab devices pause up to ~1014ms between output slabs, so
  // anything at or below that reports "done" mid-answer. See the field's docs.
  idleQuietMs: 1500,
  approvalMode: 'high-risk',
  highRiskPatterns: [...DEFAULT_HIGH_RISK_PATTERNS],
  promptPattern: DEFAULT_PROMPT_PATTERN,
  pagerPattern: DEFAULT_PAGER_PATTERN,
  dormantPattern: DEFAULT_DORMANT_PATTERN,
  dormantAutoWake: true,
  dormantProbeMs: 120_000,
  wakeOnConnect: true,
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
 * Compile a caller-supplied search pattern: case-insensitive and UNANCHORED,
 * because "wait until this appears in the output" is a search over the whole
 * window, not a tail match. Prompt and pager patterns are the anchored ones.
 * @param source - the pattern body.
 * @returns the compiled matcher.
 * @throws {SyntaxError} when `source` is not a valid regular expression.
 */
export function compileSearchPattern(source: string): RegExp {
  return new RegExp(source, 'i')
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
