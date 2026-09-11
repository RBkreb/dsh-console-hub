/**
 * Red-first suite for `src/config-shared.ts`: the pure, half-agnostic
 * vocabulary (constants, defaults, derived credential addresses, regex
 * compilation). It must stay importable from the browser bundle, so the source
 * may not reach for Node or for schemastery.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONSOLE_ENCODINGS,
  CONSOLE_KINDS,
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
  PAGING_MODES,
  SECRET_REF_PREFIX,
compileCommandFence,
  compilePattern,
  isConsoleEncoding,
  recordIdOf,
  secretRefOf,
  viewIdOf,
} from '../src/config-shared.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('config-shared', () => {
  it('stays free of Node and schema imports (the browser half shares it)', async () => {
    const source = await readFile(join(REPO_ROOT, 'src/config-shared.ts'), 'utf8')
    expect(source).not.toMatch(/from\s+'node:/)
    expect(source).not.toMatch(/@deepseek-ai\/schemastery/)
    // The schema module is host-only; this file must stay importable from the
    // browser bundle.
    expect(source).not.toMatch(/from\s+'@deepseek-ai\/schemastery'/)
  })

  it('recognizes only supported encodings', () => {
    for (const encoding of CONSOLE_ENCODINGS) expect(isConsoleEncoding(encoding)).toBe(true)
    expect(isConsoleEncoding('utf-8')).toBe(true)
    expect(isConsoleEncoding('UTF-8')).toBe(true)
    expect(isConsoleEncoding('gbk')).toBe(true)
    expect(isConsoleEncoding('rot13')).toBe(false)
    expect(isConsoleEncoding('')).toBe(false)
    expect(isConsoleEncoding(undefined)).toBe(false)
  })

  it('derives credential addresses that satisfy the credentials grammar', () => {
    const viewId = 'v-0d3f5a1e-9b2c-4d4e-8f10-1a2b3c4d5e6f'
    // `<scope>/<id>` with both segments lowercase hyphenated identifiers.
    expect(viewIdOf(viewId)).toBe(viewId)
    expect(recordIdOf(viewId)).toMatch(/^[a-z][a-z0-9-]*$/)
    // POSIX env-var reference grammar.
    expect(secretRefOf(viewId)).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    expect(secretRefOf(viewId).startsWith(SECRET_REF_PREFIX)).toBe(true)
    // Deterministic, so no extra field has to be persisted.
    expect(recordIdOf(viewId)).toBe(recordIdOf(viewId))
    expect(secretRefOf(viewId)).toBe(secretRefOf(viewId))
    // Distinct views never collide.
    expect(recordIdOf(viewId)).not.toBe(recordIdOf('v-11111111-1111-4111-8111-111111111111'))
  })

  it('compiles prompt and pager patterns as case-insensitive tail matches', () => {
    const pattern = compilePattern(DEFAULT_PAGER_PATTERN)
    expect(pattern.test('  --More--  ')).toBe(true)
    expect(pattern.test('---- More ----')).toBe(true)
    expect(pattern.test('normal output line')).toBe(false)
    const prompt = compilePattern(DEFAULT_PROMPT_PATTERN)
    expect(prompt.test('<DUT1>')).toBe(true)
    expect(prompt.test('[DUT1]')).toBe(true)
    expect(prompt.test('  [DUT1-interface-Gi0/1] ')).toBe(true)
    expect(prompt.test('show version output')).toBe(false)
    expect(() => compilePattern('(')).toThrow()
  })

  it('compiles the high-risk fence as case-insensitive command-line matches', () => {
    const fence = compileCommandFence('config|conf|configure')
    expect(fence.test('config terminal')).toBe(true)
    expect(fence.test('CONF t')).toBe(true)
    expect(fence.test('configure')).toBe(true)
    expect(fence.test('show running-config')).toBe(false)
    expect(fence.test('display current-configuration')).toBe(false)
    expect(() => compileCommandFence('(')).toThrow()
  })

  it('ships defaults consistent with the declared vocabularies', () => {
    const defaults = DEFAULT_CONSOLE_HUB_SETTINGS
    expect(CONSOLE_KINDS).toContain(defaults.defaultKind)
    expect(CONSOLE_ENCODINGS).toContain(defaults.defaultEncoding)
    expect(PAGING_MODES).toContain(defaults.pagingMode)
    expect(defaults.views).toEqual({})
    expect(defaults.connectTimeoutMs).toBeGreaterThan(0)
    expect(defaults.idleTimeoutMs).toBeGreaterThan(defaults.readTimeoutMs)
    expect(defaults.maxConsoles).toBeGreaterThan(0)
    for (const source of [defaults.promptPattern, defaults.pagerPattern, ...defaults.highRiskPatterns]) {
      expect(() => compilePattern(source)).not.toThrow()
    }
    // The high-risk fence must cover the plain and abbreviated forms, and the
    const fence = defaults.highRiskPatterns.map(source => compileCommandFence(source))
    for (const command of ['config terminal', 'conf t', 'restart', 'reboot', 'reload']) {
      expect(fence.some(pattern => pattern.test(command))).toBe(true)
    }
    // …without swallowing ordinary reads that merely mention them.
    for (const command of ['show running-config', 'display current-configuration', 'show version']) {
      expect(fence.some(pattern => pattern.test(command))).toBe(false)
    }
  })
})
