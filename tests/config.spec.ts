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

  it('defaults idleQuietMs ABOVE the measured mid-answer pause', () => {
    // The requirement, not the literal. Both lab devices pace long answers
    // through the console server in ~960-byte slabs ~1000ms apart
    // (`scripts/probe-output-gaps.mjs`), so a quiet window at or below that
    // reports "the output stopped" BETWEEN two slabs of the same answer. At the
    // old 250ms default an idle wait returned `matched: true` having read 0
    // characters, with 5760 more arriving afterwards
    // (`scripts/probe-idle-falsedone.mjs`).
    //
    // Asserting the RELATION rather than the number means a future tuning that
    // drops it back under the measured pause fails here, whatever value it picks.
    const measuredPauseMs = 1014
    const resolved = parseSettingsDocument({})
    expect(resolved.idleQuietMs).toBeGreaterThan(measuredPauseMs)
    // And it must still be usable as a wait: a value near the read timeout would
    // make `for: "idle"` useless.
    expect(resolved.idleQuietMs).toBeLessThan(resolved.readTimeoutMs)
  })

  it('refuses an idleQuietMs so small it would match instantly', () => {
    // A 1ms window would satisfy `for: "idle"` on the first poll after any byte,
    // which is the same false-'done' failure in a different disguise.
    expect(() => parseSettingsDocument({ idleQuietMs: 1 })).toThrow(/idleQuietMs/)
    expect(parseSettingsDocument({ idleQuietMs: 50 }).idleQuietMs).toBe(50)
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

  it('ships the rollback and restart rules, and NOT a bare config-mode fence', () => {
    const resolved = parseSettingsDocument({})
    expect(resolved.fenceRules.map(rule => rule.id)).toEqual(['config-rollback', 'restart'])
    expect(resolved.fenceRules.every(rule => rule.action === 'ask')).toBe(true)
    // Entering configuration mode must stay unfenced: that is the whole point of
    // declaring the rollback rule with TWO tokens.
    expect(resolved.fenceRules.some(rule => rule.tokens === 'configuration')).toBe(false)
  })

  it('refuses a fence rule that would silently match nothing', () => {
    // The dangerous typo: a rule with no matcher looks configured and enforces
    // nothing. Accepting it would let a deployment believe it had a fence it
    // never had, so the WRITE is refused and the operator finds out immediately.
    expect(() => parseSettingsDocument({
      fenceRules: [{ id: 'oops', action: 'ask' }],
    })).toThrow(/fenceRules\.0/)
    expect(() => parseSettingsDocument({
      fenceRules: [{ id: 'oops', action: 'ask', tokens: '   ' }],
    })).toThrow(/match no command/)
  })

  it('refuses a fence rule with two matchers, or an unnamed one', () => {
    // Two matchers is ambiguous about which was meant, so it is refused rather
    // than resolved by an undocumented precedence.
    expect(() => parseSettingsDocument({
      fenceRules: [{ id: 'both', action: 'ask', tokens: 'reboot', pattern: 'reboot' }],
    })).toThrow(/both/)
    expect(() => parseSettingsDocument({
      fenceRules: [{ id: '  ', action: 'ask', tokens: 'reboot' }],
    })).toThrow(/non-empty name/)
  })

  it('refuses duplicate rule ids, which would make an audit trail ambiguous', () => {
    expect(() => parseSettingsDocument({
      fenceRules: [
        { id: 'same', action: 'ask', tokens: 'reboot' },
        { id: 'same', action: 'deny', tokens: 'erase' },
      ],
    })).toThrow(/duplicate/)
  })

  it('refuses an unknown action and a malformed rule pattern', () => {
    expect(() => parseSettingsDocument({
      fenceRules: [{ id: 'x', action: 'maybe', tokens: 'reboot' }],
    })).toThrow(/action/)
    expect(() => parseSettingsDocument({
      fenceRules: [{ id: 'x', action: 'ask', pattern: '(' }],
    })).toThrow(/fenceRules\.0\.pattern/)
  })

  it('accepts a hand-written rule set, including a deny', () => {
    const resolved = parseSettingsDocument({
      fenceRules: [
        { id: 'no-erase', action: 'deny', pattern: 'erase\\s+startup-config', note: 'wipes the saved config' },
        { id: 'write', action: 'ask', tokens: 'write|copy run', note: 'persists config' },
      ],
    })
    expect(resolved.fenceRules).toHaveLength(2)
    expect(resolved.fenceRules[0]?.action).toBe('deny')
    // Defaults fill the fields a rule left out, so the runtime never sees
    // `undefined` where it expects a string.
    expect(resolved.fenceRules[0]?.tokens).toBe('')
    expect(resolved.fenceRules[1]?.pattern).toBe('')
  })
})
