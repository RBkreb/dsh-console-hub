/**
 * Schemastery schemas and defaults for dsh-console-hub.
 *
 * Two declarations live here:
 * - {@link ConsoleHubSettingsSchema}, registered with the user-settings seam as
 *   the `dsh-console-hub` namespace (device inventory + engine defaults). It
 *   has NO slot for a secret: passwords live in the credential seam.
 * - {@link Config}, the cordis.yml row configuration (host-side limits that are
 *   deployment knobs rather than user preferences).
 *
 * The schema language cannot express "this string must be a compilable regular
 * expression", so {@link assertSettingsValid} carries that cross-field check;
 * the settings seam runs it through its `validate` hook, which refuses the
 * WRITE that produced the bad value instead of letting a live console throw on
 * its first read.
 *
 * @module dsh-console-hub/config
 */
import z from '@deepseek-ai/schemastery'
import {
  CONSOLE_ENCODINGS,
  CONSOLE_KINDS,
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_HIGH_RISK_PATTERNS,
  PAGING_MODES,
  compileCommandFence,
  compilePattern,
  type ConsoleHubSettings,
} from './config-shared.ts'
import { assertNoSecretsInViews } from './views.ts'

/** The user-settings namespace holding the device inventory and engine defaults. */
export const CONSOLE_HUB_SETTINGS_NS = 'dsh-console-hub'

/** Transport union shared by the plugin default and every view override. */
const kindUnion = z.union([z.const('telnet'), z.const('raw')])

/** Per-view paging union: the empty string means "inherit the plugin default". */
const viewPagingUnion = z.union([
  z.const(''),
  z.const('auto-more'),
  z.const('auto-quit'),
  z.const('auto-interrupt'),
  z.const('manual'),
])

/** Build the row schema for one device mapping (no secret slot exists). */
function viewSchema(): z<ConsoleHubSettings['views'][string]> {
  return z.object({
    name: z.string(),
    host: z.string(),
    port: z.number().step(1).min(1).max(65535),
    kind: kindUnion.default(DEFAULT_CONSOLE_HUB_SETTINGS.defaultKind),
    encoding: z.string().default(''),
    user: z.string().default(''),
    promptPattern: z.string().default(''),
    pagerPattern: z.string().default(''),
    pagingMode: viewPagingUnion.default(''),
    tags: z.array(z.string()).default([]),
    notes: z.string().default(''),
  })
}

/**
 * The user-settings schema. Written through the settings seam and read by both
 * halves (the browser half reads it through the plugin's own fenced route, so
 * it never imports this module).
 *
 * Every key it declares is checked by {@link parseSettingsDocument}, which is
 * the only way a settings value is ever constructed.
 */
export const ConsoleHubSettingsSchema: z<ConsoleHubSettings> = z.object({
  defaultEncoding: z.union(CONSOLE_ENCODINGS.map(value => z.const(value))).default('utf-8'),
  defaultKind: z.union(CONSOLE_KINDS.map(value => z.const(value))).default('telnet'),
  connectTimeoutMs: z.number().step(1).min(500).max(120_000).default(8000),
  readTimeoutMs: z.number().step(1).min(100).max(600_000).default(15_000),
  idleTimeoutMs: z.number().step(1).min(1000).max(86_400_000).default(600_000),
  maxConsoles: z.number().step(1).min(1).max(256).default(16),
  outputLimitBytes: z.number().step(1).min(256).max(16 * 1024 * 1024).default(64 * 1024),
  scrollbackLimitBytes: z.number().step(1).min(4096).max(64 * 1024 * 1024).default(256 * 1024),
  pagingMode: z.union(PAGING_MODES.map(value => z.const(value))).default('auto-more'),
  pagingMaxPages: z.number().step(1).min(1).max(10_000).default(50),
  pagingQuietMs: z.number().step(1).min(0).max(10_000).default(120),
  approvalMode: z.union([z.const('always'), z.const('high-risk')]).default('high-risk'),
  highRiskPatterns: z.array(z.string()).default([...DEFAULT_HIGH_RISK_PATTERNS]),
  promptPattern: z.string().default(DEFAULT_CONSOLE_HUB_SETTINGS.promptPattern),
  pagerPattern: z.string().default(DEFAULT_CONSOLE_HUB_SETTINGS.pagerPattern),
  agentInstructions: z.string().default(''),
  agentConsoleTools: z.boolean().default(true),
  views: z.dict(viewSchema()).default({}),
})

/**
 * The fields {@link findBadPatterns} reads. Declared structurally (rather than
 * as the whole settings value) because the check runs on a raw document before
 * it is known to be a complete settings value.
 */
export interface PatternBearingFields {
  promptPattern: string
  pagerPattern: string
  highRiskPatterns: readonly string[]
  views: Record<string, { promptPattern: string, pagerPattern: string }>
}

/** One rejected pattern and the field that carries it. */
export interface PatternRejection {
  /** Dotted path of the offending field (`views.v1.promptPattern`). */
  field: string
  /** The source that failed to compile. */
  source: string
  /** The engine's own message, verbatim. */
  message: string
}

/**
 * Compile-check every pattern a settings value carries.
 * @param settings - the pattern-bearing fields of a settings value or document.
 * @returns one entry per malformed pattern; empty when all of them compile.
 */
export function findBadPatterns(settings: PatternBearingFields): PatternRejection[] {
  const bad: PatternRejection[] = []
  const check = (field: string, source: string, compile: (source: string) => RegExp): void => {
    try {
      compile(source)
    } catch (error) {
      bad.push({ field, source, message: error instanceof Error ? error.message : String(error) })
    }
  }
  check('promptPattern', settings.promptPattern, compilePattern)
  check('pagerPattern', settings.pagerPattern, compilePattern)
  settings.highRiskPatterns.forEach((source, index) => {
    check(`highRiskPatterns.${index}`, source, compileCommandFence)
  })
  for (const [id, view] of Object.entries(settings.views)) {
    if (view.promptPattern !== '') check(`views.${id}.promptPattern`, view.promptPattern, compilePattern)
    if (view.pagerPattern !== '') check(`views.${id}.pagerPattern`, view.pagerPattern, compilePattern)
  }
  return bad
}

/**
 * Assert every pattern a settings value carries is compilable. Handed to the
 * settings seam as its `validate` hook (and used for direct callers).
 * @param settings - the resolved section, schema-valid by construction.
 * @throws {TypeError} naming every malformed pattern at once.
 */
export function assertSettingsValid(settings: ConsoleHubSettings): void {
  const bad = findBadPatterns(settings)
  if (bad.length === 0) return
  throw new TypeError(
    `console-hub settings carry ${bad.length} uncompilable pattern(s): `
    + bad.map(entry => `${entry.field}: ${entry.message}`).join('; '),
  )
}
/**
 * Parse an untrusted settings document into a complete settings value.
 *
 * This is the one entry point every writer and reader goes through: it applies
 * schema defaults, rejects values the vocabulary/range forbid, and refuses a
 * document that carries a credential key. Callers never construct a settings
 * value field by field.
 *
 * @param document - the raw stored section (or any partial value).
 * @returns the resolved settings value.
 * @throws {Error} when the document violates the schema or carries a secret.
 */
export function parseSettingsDocument(document: unknown): ConsoleHubSettings {
  const input = document === undefined || document === null ? {} : document
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('console-hub settings must be a JSON object')
  }
  // The secret guard runs BEFORE schema resolution so an offending key cannot
  // be dropped by a future schema change and then silently accepted.
  assertNoSecretsInViews((input as { views?: unknown }).views)
  // The schema is typed by its RESOLVED shape, so a raw document is cast at
  // this one boundary — after which every field is schema-produced.
  const resolved = ConsoleHubSettingsSchema(input as ConsoleHubSettings)
  assertSettingsValid(resolved)
  return resolved
}

/** Host-side limits that belong to the composition, not to user preferences. */
export interface ConsoleHubConfig {
  /** Largest JSON request body the plugin's API accepts (bytes). */
  requestBodyLimitBytes?: number
  /** How often the idle-session reaper runs (ms). */
  sessionIdleSweepMs?: number
}

/** Schemastery schema for the plugin row configuration. */
export const Config: z<ConsoleHubConfig> = z.object({
  requestBodyLimitBytes: z.number().step(1).min(1024).max(64 * 1024 * 1024).default(1 << 20),
  sessionIdleSweepMs: z.number().step(1).min(1000).max(3_600_000).default(15_000),
})

/** Fully defaulted host configuration. */
export interface ResolvedConsoleHubConfig {
  requestBodyLimitBytes: number
  sessionIdleSweepMs: number
}

/**
 * Apply direct-call defaults after Loader schema validation has normally run.
 * @param config - deployment-provided host settings.
 * @returns complete settings consumed by the host half.
 * @throws {Error} when a provided value is outside its declared range.
 */
export function resolveConsoleHubConfig(config: ConsoleHubConfig | undefined): ResolvedConsoleHubConfig {
  return Config(config ?? {}) as ResolvedConsoleHubConfig
}

export { DEFAULT_CONSOLE_HUB_SETTINGS }
export { ConsoleHubSettingsSchema as SettingsSchema }
export type { ConsoleHubSettings }
