/**
 * Red-first suite for `src/views.ts`: view normalization (the shape the panel
 * and the console engine both consume) and the secret guard that keeps a
 * password out of the settings document.
 */
import { describe, expect, it } from 'vitest'
import {
  assertNoSecretsInViews,
  findSecretKeys,
  newViewId,
  normalizeView,
  redactView,
} from '../src/views.ts'
import { DEFAULT_CONSOLE_HUB_SETTINGS } from '../src/config-shared.ts'

describe('newViewId', () => {
  it('mints ids the credential grammar accepts', () => {
    const id = newViewId()
    // `v-<uuid>` and the derived record id must both stay inside the seam's
    // `^[a-z][a-z0-9-]*$` segment grammar.
    expect(id).toMatch(/^v-[0-9a-f-]{36}$/)
    expect(id.startsWith('v-')).toBe(true)
    expect(newViewId()).not.toBe(id)
  })
})

describe('normalizeView', () => {
  it('trims text and fills the per-view defaults', () => {
    const view = normalizeView({
      name: '  核心防火墙 FW1  ',
      host: '  10.133.6.253 ',
      port: 10003,
    })
    expect(view.name).toBe('核心防火墙 FW1')
    expect(view.host).toBe('10.133.6.253')
    expect(view.port).toBe(10003)
    expect(view.kind).toBe(DEFAULT_CONSOLE_HUB_SETTINGS.defaultKind)
    expect(view.encoding).toBe('')
    expect(view.tags).toEqual([])
  })

  it('deduplicates and trims tags, dropping empties', () => {
    const view = normalizeView({ name: 'sw', host: 'h', port: 23, tags: [' 核心 ', '核心', '', '  '] })
    expect(view.tags).toEqual(['核心'])
  })

  it('rejects values a caller could not have meant', () => {
    expect(() => normalizeView({ name: '', host: 'h', port: 23 })).toThrow(/name/)
    expect(() => normalizeView({ name: 'x', host: '', port: 23 })).toThrow(/host/)
    expect(() => normalizeView({ name: 'x', host: 'h', port: 0 })).toThrow(/port/)
    expect(() => normalizeView({ name: 'x', host: 'h', port: 70_000 })).toThrow(/port/)
    expect(() => normalizeView({ name: 'x', host: 'h', port: 22.5 })).toThrow(/port/)
    expect(() => normalizeView({ name: 'x', host: 'h', port: 23, kind: 'ssh' })).toThrow(/kind/)
    expect(() => normalizeView({ name: 'x', host: 'h', port: 23, encoding: 'rot13' })).toThrow(/encoding/)
  })

  it('keeps an explicitly chosen encoding and transport', () => {
    const view = normalizeView({
      name: 'sw', host: 'h', port: 10015, kind: 'raw', encoding: 'GBK',
    })
    expect(view.kind).toBe('raw')
    expect(view.encoding).toBe('gbk')
  })
})

describe('redactView', () => {
  it('never carries a value a secret could ride in', () => {
    const view = normalizeView({ name: 'x', host: 'h', port: 23 })
    const redacted = redactView(view, { secretConfigured: true })
    expect(redacted).toMatchObject({ name: 'x', host: 'h', port: 23, secretConfigured: true })
    // The redacted projection is the only shape the API and the tools may
    // return, so it must not carry a password slot at all.
    expect(JSON.stringify(redacted)).not.toMatch(/password|secret["':]/i)
  })

  it('reports an unconfigured credential without inventing one', () => {
    const view = normalizeView({ name: 'x', host: 'h', port: 23 })
    expect(redactView(view, { secretConfigured: false }).secretConfigured).toBe(false)
  })
})

describe('secret guard', () => {
  it('finds secret-shaped keys case-insensitively and nested', () => {
    expect(findSecretKeys({ name: 'x', password: 'p' })).toEqual(['password'])
    expect(findSecretKeys({ v: { name: 'x', PassWord: 'p' } })).toEqual(['v.PassWord'])
    expect(findSecretKeys({ v: { secret: 'p', passwd: 'p', apiKey: 'p' } }).sort())
      .toEqual(['v.apiKey', 'v.passwd', 'v.secret'])
    expect(findSecretKeys({ v: { name: 'x', host: 'h' } })).toEqual([])
  })

  it('throws naming every offending path', () => {
    expect(() => assertNoSecretsInViews({ v1: { name: 'x', password: 'p' } })).toThrow(/v1\.password/)
    expect(() => assertNoSecretsInViews({ v1: { name: 'x' } })).not.toThrow()
  })
})
