/**
 * Red-first suite for `src/secrets.ts`: the credential half of a device view,
 * driven against a FAKE credential provider so the seam's contract (never
 * returning a value on a read path) is exercised without a real credential
 * file.
 */
import { describe, expect, it } from 'vitest'
import {
  clearSecret,
  describeSecret,
  parseSecretPayload,
  readSecret,
  resolveSecret,
  secretRefOfView,
  writeSecret,
} from '../src/secrets.ts'
import { secretRefOf } from '../src/config-shared.ts'
import type { ConsoleCredentialProvider, ConsoleCredentialRecord } from '../src/context-types.ts'

/** A minimal in-memory stand-in for `ctx.credentials`. */
function fakeCredentials(options: {
  /** Values the ambient environment layer would supply, keyed by reference. */
  env?: Record<string, string>
  /** Whether writes are refused (a read-only shadowing source). */
  readOnly?: boolean
  /** Mounted or absent. */
  absent?: boolean
} = {}): ConsoleCredentialProvider & { records: Map<string, ConsoleCredentialRecord> } {
  const records = new Map<string, ConsoleCredentialRecord>()
  const env = options.env ?? {}
  const keyOf = (key: unknown): string => String(key)
  const refOf = (ref: unknown): string => String(ref)
  return {
    records,
    async resolve(ref) {
      if (options.absent === true) throw new Error('no credential provider mounted')
      const name = refOf(ref)
      const ambient = env[name]
      if (ambient !== undefined && ambient !== '') return { value: ambient, source: 'env' }
      const record = records.get(`v1|${name}`)
      if (record?.kind === 'api-key' && typeof record.key === 'string' && record.key !== '') {
        return { value: record.key, source: 'file' }
      }
      return undefined
    },
    async describe(ref) {
      if (options.absent === true) throw new Error('no credential provider mounted')
      const value = await this.resolve(ref)
      const writable = options.readOnly !== true
      return value === undefined
        ? { configured: false, writable }
        : { configured: true, source: value.source, writable }
    },
    async set(ref, value) {
      if (options.readOnly === true) throw new Error(`reference "${refOf(ref)}" is shadowed by a read-only source`)
      if (options.absent === true) throw new Error('no credential provider mounted')
      records.set(`v1|${refOf(ref)}`, { kind: 'api-key', key: value })
    },
    async unset(ref) {
      records.delete(`v1|${refOf(ref)}`)
    },
    async readRecord(key) {
      // A mounted-but-unwritable provider still reads; only an ABSENT provider
      // throws, exactly like `ctx.credentials` being undefined.
      if (options.absent === true) throw new Error('no credential provider mounted')
      return records.get(keyOf(key))
    },
    async describeRecord(key) {
      if (options.absent === true) throw new Error('no credential provider mounted')
      const record = records.get(keyOf(key))
      return record === undefined
        ? { configured: false, writable: options.readOnly !== true }
        : { configured: true, kind: record.kind, writable: options.readOnly !== true }
    },
    async modifyRecord(key, mutate) {
      if (options.readOnly === true) throw new Error('the credential store is read-only')
      if (options.absent === true) throw new Error('no credential provider mounted')
      const name = keyOf(key)
      const next = await mutate(records.get(name))
      if (next === undefined) return records.get(name)
      records.set(name, next)
      return next
    },
    async deleteRecord(key) {
      if (options.readOnly === true) throw new Error('the credential store is read-only')
      if (options.absent === true) throw new Error('no credential provider mounted')
      records.delete(keyOf(key))
    },
  }
}

/** A view id shaped like the ones the plugin mints. */
const VIEW = 'v-0d3f5a1e-9b2c-4d4e-8f10-1a2b3c4d5e6f'

describe('secret payload', () => {
  it('round-trips a password and an optional user', () => {
    const payload = parseSecretPayload({ version: 1, user: 'admin', password: 's3cret' })
    expect(payload).toEqual({ version: 1, user: 'admin', password: 's3cret' })
    expect(parseSecretPayload({ version: 1, password: 'only' })).toEqual({ version: 1, password: 'only' })
  })

  it('refuses a payload it cannot vouch for', () => {
    expect(parseSecretPayload(undefined)).toBeUndefined()
    expect(parseSecretPayload(null)).toBeUndefined()
    expect(parseSecretPayload({ version: 2, password: 'x' })).toBeUndefined()
    expect(parseSecretPayload({ version: 1 })).toBeUndefined()
    expect(parseSecretPayload({ version: 1, password: '' })).toBeUndefined()
    expect(parseSecretPayload({ version: 1, password: 42 })).toBeUndefined()
    expect(parseSecretPayload({ version: 1, password: 'x', user: 7 })).toBeUndefined()
    expect(parseSecretPayload('not an object')).toBeUndefined()
  })
})

describe('writeSecret / readSecret', () => {
  it('stores a grant record under the derived key and reads it back', async () => {
    const credentials = fakeCredentials()
    await writeSecret(credentials, VIEW, { password: 's3cret', user: 'admin' })
    const payload = await readSecret(credentials, VIEW)
    expect(payload?.password).toBe('s3cret')
    expect(payload?.user).toBe('admin')
    // The record carries a grant payload the seam never interprets.
    const record = await credentials.readRecord(`dsh-console-hub/${secretRefOfView(VIEW).toLowerCase()}` as never)
    void record
  })

  it('never stores the value under a reference a read path returns', async () => {
    const credentials = fakeCredentials()
    await writeSecret(credentials, VIEW, { password: 's3cret' })
    // `describeSecret` must report facts, never the value.
    const info = await describeSecret(credentials, VIEW)
    expect(JSON.stringify(info)).not.toContain('s3cret')
  })

  it('rejects an empty password', async () => {
    const credentials = fakeCredentials()
    await expect(writeSecret(credentials, VIEW, { password: '' })).rejects.toThrow(/empty|password/i)
  })

  it('surfaces a refused write instead of pretending it landed', async () => {
    const credentials = fakeCredentials({ readOnly: true })
    await expect(writeSecret(credentials, VIEW, { password: 'x' })).rejects.toThrow(/read-only|shadow/i)
    // And clearing is refused too, rather than silently leaving the secret.
    await expect(clearSecret(credentials, VIEW)).rejects.toThrow(/read-only|shadow/i)
  })

  it('clears a stored credential and tolerates clearing an absent one', async () => {
    const credentials = fakeCredentials()
    await writeSecret(credentials, VIEW, { password: 's3cret' })
    expect((await readSecret(credentials, VIEW))?.password).toBe('s3cret')
    await clearSecret(credentials, VIEW)
    expect(await readSecret(credentials, VIEW)).toBeUndefined()
    await clearSecret(credentials, VIEW)
    expect(await readSecret(credentials, VIEW)).toBeUndefined()
  })

  it('ignores a record written by another owner', async () => {
    const credentials = fakeCredentials()
    // Someone else's payload shape under our key must read as "no credential".
    await credentials.modifyRecord(
      { toString: () => 'dsh-console-hub/whatever' } as never,
      async () => ({ kind: 'grant', payload: { version: 1, password: 'x' } }),
    )
    expect(await readSecret(credentials, VIEW)).toBeUndefined()
  })
})

describe('resolveSecret', () => {
  it('prefers the environment reference over the stored record', async () => {
    const credentials = fakeCredentials({
      env: { [secretRefOf(VIEW)]: 'from-env' },
    })
    await writeSecret(credentials, VIEW, { password: 'from-store', user: 'admin' })
    const resolved = await resolveSecret(credentials, VIEW)
    expect(resolved?.password).toBe('from-env')
    expect(resolved?.source).toBe('env')
    // The non-secret half still comes from the record.
    expect(resolved?.user).toBe('admin')
  })

  it('falls back to the stored record when the environment has nothing', async () => {
    const credentials = fakeCredentials()
    await writeSecret(credentials, VIEW, { password: 'from-store', user: 'admin' })
    const resolved = await resolveSecret(credentials, VIEW)
    expect(resolved).toEqual({ password: 'from-store', user: 'admin', source: 'record' })
  })

  it('splits a bare `user:pass` environment value', async () => {
    const credentials = fakeCredentials({ env: { [secretRefOf(VIEW)]: 'admin:from-env' } })
    const resolved = await resolveSecret(credentials, VIEW)
    expect(resolved?.user).toBe('admin')
    expect(resolved?.password).toBe('from-env')
  })

  it('treats an empty environment value as absent', async () => {
    const credentials = fakeCredentials({ env: { [secretRefOf(VIEW)]: '' } })
    await writeSecret(credentials, VIEW, { password: 'from-store' })
    const resolved = await resolveSecret(credentials, VIEW)
    expect(resolved?.password).toBe('from-store')
  })

  it('returns undefined when nothing is configured at all', async () => {
    const credentials = fakeCredentials()
    expect(await resolveSecret(credentials, VIEW)).toBeUndefined()
  })

  it('fails closed when no credential provider is mounted', async () => {
    const credentials = fakeCredentials({ absent: true })
    // Reading is a fact-finding question, so it answers "nothing configured"
    // rather than throwing.
    expect(await resolveSecret(credentials, VIEW)).toBeUndefined()
    expect(await describeSecret(credentials, VIEW)).toEqual({ configured: false, writable: false, recordConfigured: false })
    // Writing must fail loudly instead of silently dropping the secret.
    await expect(writeSecret(credentials, VIEW, { password: 'x' })).rejects.toThrow()
  })
})

describe('describeSecret', () => {
  it('reports configured state, source and writability without the value', async () => {
    const credentials = fakeCredentials()
    expect(await describeSecret(credentials, VIEW)).toEqual({ configured: false, writable: true, recordConfigured: false })
    await writeSecret(credentials, VIEW, { password: 's3cret' })
    const info = await describeSecret(credentials, VIEW)
    expect(info.configured).toBe(true)
    expect(info.writable).toBe(true)
    expect(JSON.stringify(info)).not.toContain('s3cret')
  })

  it('reports an unreadable store as unconfigured rather than throwing', async () => {
    const credentials: ConsoleCredentialProvider = {
      resolve: async () => { throw new Error('store unavailable') },
      describe: async () => { throw new Error('store unavailable') },
      set: async () => { throw new Error('store unavailable') },
      unset: async () => { throw new Error('store unavailable') },
      readRecord: async () => { throw new Error('store unavailable') },
      describeRecord: async () => { throw new Error('store unavailable') },
      modifyRecord: async () => { throw new Error('store unavailable') },
      deleteRecord: async () => { throw new Error('store unavailable') },
    }
    expect(await readSecret(credentials, VIEW)).toBeUndefined()
    expect((await describeSecret(credentials, VIEW)).configured).toBe(false)
  })
})
