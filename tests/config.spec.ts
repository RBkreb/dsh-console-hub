/**
 * Red-first suite for `src/config.ts`: the settings schema, the document entry
 * point every writer goes through, and `resolveConsoleHubConfig` (host-side
 * row configuration that direct callers reach without the Loader).
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
  ConsoleHubSettingsSchema,
  assertSettingsValid,
  findBadPatterns,
  parseSettingsDocument,
  resolveConsoleHubConfig,
} from '../src/config.ts'
import { DEFAULT_CONSOLE_HUB_SETTINGS, PAGING_MODES } from '../src/config-shared.ts'

describe('parseSettingsDocument', () => {
  it('fills every default from an empty or absent document', () => {
    expect(parseSettingsDocument({})).toEqual(DEFAULT_CONSOLE_HUB_SETTINGS)
    expect(parseSettingsDocument(undefined)).toEqual(DEFAULT_CONSOLE_HUB_SETTINGS)
  })

  it('keeps a stored view and applies its own defaults', () => {
    const settings = parseSettingsDocument({
      views: {
        'v-0d3f5a1e-9b2c-4d4e-8f10-1a2b3c4d5e6f': {
          name: '核心防火墙 FW1',
          host: '10.133.6.253',
          port: 10003,
        },
      },
    })
    const view = settings.views['v-0d3f5a1e-9b2c-4d4e-8f10-1a2b3c4d5e6f']
    expect(view?.name).toBe('核心防火墙 FW1')
    expect(view?.host).toBe('10.133.6.253')
    expect(view?.port).toBe(10003)
    // Unstated per-view fields inherit the declared defaults.
    expect(view?.kind).toBe(DEFAULT_CONSOLE_HUB_SETTINGS.defaultKind)
    expect(view?.encoding).toBe('')
    expect(view?.tags).toEqual([])
  })

  it('rejects values the vocabulary and ranges forbid', () => {
    expect(() => parseSettingsDocument({ defaultEncoding: 'rot13' })).toThrow()
    expect(() => parseSettingsDocument({ defaultKind: 'ssh' })).toThrow()
    expect(() => parseSettingsDocument({ pagingMode: 'sometimes' })).toThrow()
    expect(() => parseSettingsDocument({ maxConsoles: 0 })).toThrow()
    expect(() => parseSettingsDocument({ outputLimitBytes: 1.5 })).toThrow()
    expect(() => parseSettingsDocument({ views: { v1: { name: 'x', host: 'h', port: 70000 } } })).toThrow()
    expect(() => parseSettingsDocument({ views: { v1: { name: 'x', host: 'h', port: 23, kind: 'ssh' } } })).toThrow()
    expect(() => parseSettingsDocument('not an object')).toThrow(/JSON object/)
    expect(() => parseSettingsDocument([])).toThrow(/JSON object/)
  })

  it('refuses a document that carries a credential', () => {
    // The settings document is a plain-text file; a password written into a
    // view must be refused at the write, naming the offending path.
    expect(() => parseSettingsDocument({
      views: { v1: { name: 'x', host: 'h', port: 23, password: 'oops' } },
    })).toThrow(/v1\.password/)
    expect(() => parseSettingsDocument({
      views: { v1: { name: 'x', host: 'h', port: 23, meta: { apiKey: 'k' } } },
    })).toThrow(/v1\.meta\.apiKey/)
    // A clean document is accepted.
    expect(() => parseSettingsDocument({ views: { v1: { name: 'x', host: 'h', port: 23 } } })).not.toThrow()
  })

  it('flags patterns the runtime could not compile, naming every field', () => {
    // The schema language cannot express "compilable regular expression", so
    // this cross-field check is what refuses a malformed source at the write
    // rather than letting a live console throw on its first read.
    // The schema is typed by its resolved shape; a raw partial document is cast
    // here so the check can be exercised without going through the write path
    // that would reject it first.
    const bad = findBadPatterns(ConsoleHubSettingsSchema({
      promptPattern: '(',
      pagerPattern: '[unclosed',
      highRiskPatterns: ['restart', '('],
      views: { v1: { name: 'x', host: 'h', port: 23, promptPattern: '((' } },
    } as never))
    expect(bad.map(entry => entry.field).sort()).toEqual([
      'highRiskPatterns.1',
      'pagerPattern',
      'promptPattern',
      'views.v1.promptPattern',
    ])
    for (const entry of bad) expect(entry.message).not.toBe('')
    expect(() => parseSettingsDocument({ promptPattern: '(' })).toThrow(/promptPattern/)
    expect(() => parseSettingsDocument({ pagerPattern: '[unclosed' })).toThrow(/pagerPattern/)
    expect(() => parseSettingsDocument({ highRiskPatterns: ['('] })).toThrow(/highRiskPatterns\.0/)
    expect(() => parseSettingsDocument({ views: { v1: { name: 'x', host: 'h', port: 23, pagerPattern: '[' } } }))
      .toThrow(/views\.v1\.pagerPattern/)
    expect(() => assertSettingsValid(parseSettingsDocument({}))).not.toThrow()
  })

  it('accepts exactly the declared paging modes', () => {
    for (const mode of PAGING_MODES) {
      expect(parseSettingsDocument({ pagingMode: mode }).pagingMode).toBe(mode)
    }
  })

  it('compiles the dormant pattern against the SEARCH matcher it actually runs', () => {
    // The dormancy marker is matched anywhere in the stream, not at the tail, so
    // it is validated with `compileSearchPattern`. Validating it with the
    // tail-anchored `compilePattern` would accept a source that then behaved
    // differently at runtime -- the two matchers wrap the source differently.
    expect(() => parseSettingsDocument({ dormantPattern: '(' })).toThrow(/dormantPattern/)
    const bad = findBadPatterns(ConsoleHubSettingsSchema({ dormantPattern: '[unclosed' } as never))
    expect(bad.map(entry => entry.field)).toEqual(['dormantPattern'])
  })

  it('defaults the dormancy controls to on, with a keepalive under the measured timeout', () => {
    const resolved = parseSettingsDocument({})
    expect(resolved.dormantAutoWake).toBe(true)
    expect(resolved.dormantPattern).toContain('please')
    // Measured: both lab devices half-close at exactly 300s
    // (`scripts/probe-dormant.mjs`). The default keepalive must fire WELL inside
    // that, or it would race the thing it exists to prevent.
    expect(resolved.dormantProbeMs).toBeGreaterThan(0)
    expect(resolved.dormantProbeMs).toBeLessThan(300_000)
  })

  it('allows disabling the keepalive, and refuses a negative window', () => {
    expect(parseSettingsDocument({ dormantProbeMs: 0 }).dormantProbeMs).toBe(0)
    expect(() => parseSettingsDocument({ dormantProbeMs: -1 })).toThrow(/dormantProbeMs/)
  })
})

describe('resolveConsoleHubConfig', () => {
  it('applies defaults for direct callers', () => {
    expect(resolveConsoleHubConfig(undefined)).toEqual({
      requestBodyLimitBytes: 1 << 20,
      sessionIdleSweepMs: 15000,
      // Empty by default: loopback needs no declaration, and a non-loopback
      // deployment must opt in explicitly rather than be trusted by accident.
      trustedHosts: [],
    })
  })

  it('honours provided values and validates them through the schema', () => {
    expect(resolveConsoleHubConfig({ requestBodyLimitBytes: 2048, sessionIdleSweepMs: 1000 }))
      .toEqual({ requestBodyLimitBytes: 2048, sessionIdleSweepMs: 1000, trustedHosts: [] })
    // A deployment reached by name must be able to declare it, or the plugin's
    // own Host fence would refuse every non-loopback call.
    expect(resolveConsoleHubConfig({ trustedHosts: ['harness.internal:43120'] }).trustedHosts)
      .toEqual(['harness.internal:43120'])
    expect(() => resolveConsoleHubConfig({ requestBodyLimitBytes: 0 })).toThrow()
  })

  it('exposes the schemastery schema as the loader-facing Config', () => {
    expect(typeof (Config as unknown as (value: unknown) => unknown)).toBe('function')
  })
})
