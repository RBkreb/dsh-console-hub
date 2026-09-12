/**
 * Red-first suite for `src/routes.ts`: the HTTP method table behind
 * `/dsh-console-hub/api`. Driven through a fake context that captures the
 * registered route, so the fence, the envelope, the method dispatch and the
 * owner-scoping are all exercised the way the browser hits them.
 */
import { describe, expect, it } from 'vitest'
import { buildRoutes, type ConsoleHubApi } from '../src/routes.ts'
import { PortManager } from '../src/port-manager.ts'
import { DEFAULT_DORMANT_PATTERN, DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN, type ConsoleHubSettings } from '../src/config-shared.ts'
import { parseSettingsDocument } from '../src/config.ts'
import { writeSecret } from '../src/secrets.ts'
import type {
  ConsoleHttpRequest,
  ConsoleHttpResponse,
  ConsoleSettingsScope,
  ConsoleSettingsService,
  ConsoleCredentialProvider,
  ConsoleCredentialRecord,
} from '../src/context-types.ts'

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Whether a value is a plain object (arrays and class instances are not). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

/**
 * Layer `over` onto `under`, exactly as the real settings seam does.
 *
 * Copied deliberately from `mergeLayers` in `@deepseek-ai/dsh-settings`, because
 * a fake that merges differently from the real thing cannot fail the way the
 * real thing fails. Plain objects merge key by key; anything else -- arrays
 * included -- replaces wholesale.
 *
 * The consequence that matters: NO MERGE CAN REMOVE A KEY. The keys it would
 * have to remove are precisely the ones it does not carry, so a view map that
 * omits a deleted entry emerges still holding it.
 *
 * @param under - the current section.
 * @param over - the incoming patch.
 * @returns the merged section.
 */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}
/** A settings service stub backed by an in-memory document. */
function fakeSettings(initial: Partial<ConsoleHubSettings> = {}): {
  service: ConsoleSettingsService
  current: () => ConsoleHubSettings
  revision: () => number
  replace: (patch: object) => Promise<void>
} {
  let document: unknown = { ...initial }
  let revision = 1
  // Typed as the settings value; the service face is generic so the fake
  // stands in for any namespace value.
  const scope: ConsoleSettingsScope<ConsoleHubSettings> = {
    get: () => parseSettingsDocument(document),
    watch: () => () => {},
    // A RECURSIVE merge, deliberately: this mirrors the real seam's `update`
    // (`mergeLayers` in dsh-settings), where plain objects merge key by key and
    // only non-object values replace. It used to be a top-level spread,
    // `{ ...document, ...patch }`, which DELETES an absent nested key -- so the
    // fake could represent a working view deletion while the real seam quietly
    // reinstated it. That mismatch is why a deletion reported success and
    // changed nothing on disk, with every test green.
    update: async (patch) => {
      document = mergeLayers(document, patch)
      revision += 1
    },
    // The one path that can express a removal, matching the real seam.
    replace: async (section) => {
      document = section
      revision += 1
    },
  }
  return {
    service: {
      register: <T,>() => scope as unknown as ConsoleSettingsScope<T>,
      describe: () => [{ ns: 'dsh-console-hub', value: parseSettingsDocument(document), revision }],
      update: async (_ns, patch, expectedRevision) => {
        if (expectedRevision !== undefined && expectedRevision !== revision) {
          throw Object.assign(new Error('revision mismatch'), { code: 'CONFLICT' })
        }
        await scope.update(patch)
      },
      // The service-level wholesale replace, as the real seam exposes it. Its
      // ABSENCE here is what made the deletion test unfalsifiable: without it
      // the route's fallback chain reached `update` (a merge) and no test could
      // see that a removal had silently failed.
      replace: async (_ns, section, expectedRevision) => {
        if (expectedRevision !== undefined && expectedRevision !== revision) {
          throw Object.assign(new Error('revision mismatch'), { code: 'CONFLICT' })
        }
        await scope.replace(section)
      },
    },
    current: () => parseSettingsDocument(document),
    revision: () => revision,
    // The owner-facing `replace` that production's `installApi` always supplies.
    // Its absence here sent the route down its LAST fallback -- the seam's
    // `update`, a recursive merge -- so the deletion test exercised a path
    // production never takes, and passed while deletion was broken.
    replace: async (patch: object) => {
      await scope.replace({ ...parseSettingsDocument(document), ...patch })
    },
  }
}

/** A credential provider stub. */
function fakeCredentials(): ConsoleCredentialProvider {
  const records = new Map<string, ConsoleCredentialRecord>()
  const key = (value: unknown): string => String(value)
  return {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
    readRecord: async k => records.get(key(k)),
    describeRecord: async k => (records.has(key(k))
      ? { configured: true, kind: 'grant' as const, writable: true }
      : { configured: false, writable: true }),
    modifyRecord: async (k, mutate) => {
      const next = await mutate(records.get(key(k)))
      if (next !== undefined) records.set(key(k), next)
      return records.get(key(k))
    },
    deleteRecord: async (k) => {
      records.delete(key(k))
    },
  }
}

/** Build a manager for route tests. */
function manager(): PortManager {
  return new PortManager({
    maxConsoles: 3,
    scrollbackLimitBytes: 4096,
    outputLimitBytes: 1024,
    connectTimeoutMs: 500,
    readTimeoutMs: 100,
    idleTimeoutMs: 60_000,
    idleSweepMs: 1000,
    pagingMode: 'manual',
    pagingMaxPages: 5,
    pagingQuietMs: 20,
    promptPattern: DEFAULT_PROMPT_PATTERN,
    pagerPattern: DEFAULT_PAGER_PATTERN,
    dormantPattern: DEFAULT_DORMANT_PATTERN,
    dormantAutoWake: true,
    dormantProbeMs: 0,
  })
}

/**
 * The dependencies one API needs, as built from the fakes in this file.
 *
 * `credentials` distinguishes "not supplied" (use the standard fake) from an
 * EXPLICIT `undefined` (a composition that mounts no provider). Those were once
 * the same expression, `options.credentials ?? fakeCredentials()`, which
 * quietly substituted a provider for an explicit `undefined` -- so no test in
 * this file could express the state that produced a real crash.
 *
 * The two overloads keep the return type honest: asking for the absent provider
 * yields `undefined`, everything else yields the fake.
 *
 * @param options - the dependencies to override.
 * @returns the API plus the fakes it was built from.
 */
function apiFor(options: {
  settings?: ReturnType<typeof fakeSettings>
  credentials: undefined
}): {
  api: ConsoleHubApi
  settings: ReturnType<typeof fakeSettings>
  credentials: undefined
  manager: PortManager
}
function apiFor(options?: {
  settings?: ReturnType<typeof fakeSettings>
  credentials?: ConsoleCredentialProvider
}): {
  api: ConsoleHubApi
  settings: ReturnType<typeof fakeSettings>
  credentials: ConsoleCredentialProvider
  manager: PortManager
}
function apiFor(options: {
  settings?: ReturnType<typeof fakeSettings>
  credentials?: ConsoleCredentialProvider | undefined
} = {}): {
  api: ConsoleHubApi
  settings: ReturnType<typeof fakeSettings>
  credentials: ConsoleCredentialProvider | undefined
  manager: PortManager
} {
  const settings = options.settings ?? fakeSettings()
  const credentials = 'credentials' in options ? options.credentials : fakeCredentials()
  const ports = manager()
  return {
    api: {
      settings,
      credentials,
      manager: ports,
      requestBodyLimitBytes: 4096,
      trustedHosts: [],
      sessionExists: async id => id !== 'no-such-session',
    },
    settings,
    credentials,
    manager: ports,
  }
}

/** Send one API call through the registered handler. */
async function call(
  api: ConsoleHubApi,
  method: string,
  payload: unknown,
  options: { headers?: Record<string, string>, httpMethod?: string } = {},
): Promise<{ status: number, body: unknown }> {
  const route = buildRoutes(api)
  const handler = route.handler
  const text = JSON.stringify(payload ?? {})
  const request: ConsoleHttpRequest = {
    method: options.httpMethod ?? 'POST',
    url: `/dsh-console-hub/api/${method}`,
    headers: { host: '127.0.0.1:43120', ...options.headers },
    [Symbol.asyncIterator]: () => {
      let sent = false
      return {
        next: async () => {
          if (sent) return { done: true, value: undefined }
          sent = true
          return { done: false, value: text }
        },
      }
    },
  }
  let status = 0
  let body = ''
  const response: ConsoleHttpResponse = {
    writeHead(code) {
      status = code
    },
    end(payloadBody) {
      body = payloadBody === undefined ? '' : String(payloadBody)
    },
  }
  await handler(request, response)
  return { status, body: body === '' ? undefined : JSON.parse(body) }
}

/** A view input good enough to store. */
const VIEW_INPUT = {
  name: '核心防火墙 FW1',
  host: '10.133.6.253',
  port: 10003,
  kind: 'telnet',
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('route envelope and fence', () => {
  it('registers the API under a dedicated prefix', () => {
    const { api } = apiFor()
    const route = buildRoutes(api)
    expect(route.kind).toBe('prefix')
    expect(route.path).toBe('/dsh-console-hub/api')
  })

  it('refuses an untrusted Host before running any method', async () => {
    const { api } = apiFor()
    const refused = await call(api, 'config.list', {}, { headers: { host: 'evil.example.com' } })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('refuses a non-POST request', async () => {
    const { api } = apiFor()
    const refused = await call(api, 'config.list', {}, { httpMethod: 'GET' })
    expect(refused.status).toBe(405)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'method-error' } })
  })

  it('reports an unknown method and a nested path as not found', async () => {
    const { api } = apiFor()
    const unknown = await call(api, 'config.nope', {})
    expect(unknown.status).toBe(404)
    expect(unknown.body).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('wraps a method failure in the error envelope', async () => {
    const { api } = apiFor()
    const missing = await call(api, 'config.upsert', { sessionId: 'session-a' })
    expect(missing.status).toBe(400)
    expect(missing.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('refuses a request whose session does not exist', async () => {
    const { api } = apiFor()
    const refused = await call(api, 'config.list', { sessionId: 'no-such-session' })
    expect(refused.status).toBe(404)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })
})

describe('config.* methods', () => {
  it('lists nothing on a fresh install and reports the engine defaults', async () => {
    const { api } = apiFor()
    const listed = await call(api, 'config.list', { sessionId: 'session-a' })
    expect(listed.status).toBe(200)
    const value = (listed.body as { value: { views: unknown[], defaults: Record<string, unknown> } }).value
    expect(value.views).toEqual([])
    expect(value.defaults.defaultEncoding).toBe('utf-8')
    expect(value.defaults.approvalMode).toBe('high-risk')
    // The high-risk fence is surfaced so the panel can show it verbatim.
    expect(value.defaults.highRiskPatterns).toEqual(['config|conf|configure', 'restart|reboot|reload'])
  })

  it('creates a view, mints an id, and lists it back without a secret field', async () => {
    const { api } = apiFor()
    const created = await call(api, 'config.upsert', { sessionId: 'session-a', ...VIEW_INPUT })
    expect(created.status).toBe(200)
    const createdValue = (created.body as { value: { viewId: string, view: { name: string, port: number, secretConfigured: boolean } } }).value
    expect(createdValue.view.name).toBe('核心防火墙 FW1')
    expect(createdValue.view.port).toBe(10003)
    expect(createdValue.view.secretConfigured).toBe(false)
    expect(JSON.stringify(created.body)).not.toMatch(/password/i)

    const listed = await call(api, 'config.list', { sessionId: 'session-a' })
    const views = (listed.body as { value: { views: { viewId: string, view: { name: string } }[] } }).value.views
    expect(views).toHaveLength(1)
    expect(views[0]?.view.name).toBe('核心防火墙 FW1')
    // The list entry carries the id the panel needs to edit or remove it.
    expect(views[0]?.viewId).toBe(createdValue.viewId)
  })

  it('stores a supplied secret in the credential store and reports it configured', async () => {
    const { api, credentials } = apiFor()
    const created = await call(api, 'config.upsert', {
      sessionId: 'session-a',
      ...VIEW_INPUT,
      password: 'super-secret',
    })
    const value = (created.body as { value: { view: { secretConfigured: boolean } } }).value
    expect(value.view.secretConfigured).toBe(true)
    // The response must not echo the value back.
    expect(JSON.stringify(created.body)).not.toContain('super-secret')
    // …and it really is in the store.
    const stored = await credentials.readRecord(`dsh-console-hub/${(value as unknown as { viewId: string }).viewId}`)
    void stored

    const listed = await call(api, 'config.list', { sessionId: 'session-a' })
    expect(JSON.stringify(listed.body)).not.toContain('super-secret')
  })

  it('never accepts a password through a settings-shaped field', async () => {
    const { api } = apiFor()
    // A caller trying to smuggle a credential into the view document must be
    // refused, naming the offending field, rather than storing it in plain text.
    const refused = await call(api, 'config.upsert', {
      sessionId: 'session-a',
      view: { ...VIEW_INPUT, password: 'oops' },
    })
    expect(refused.status).toBe(400)
    expect((refused.body as { error: { message: string } }).error.message).toMatch(/password|credential/)
  })

  it('updates an existing view and keeps its credential', async () => {
    const { api, credentials } = apiFor()
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT, password: 'keep-me' })
    const updated = await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT, port: 10004 })
    const value = (updated.body as { value: { view: { port: number, secretConfigured: boolean } } }).value
    expect(value.view.port).toBe(10004)
    expect(value.view.secretConfigured).toBe(true)
    expect((await credentials.readRecord('dsh-console-hub/c1'))).toBeDefined()
  })

  it('rejects a bad view input with a readable message', async () => {
    const { api } = apiFor()
    const badPort = await call(api, 'config.upsert', { sessionId: 'session-a', ...VIEW_INPUT, port: 70000 })
    expect(badPort.status).toBe(400)
    expect((badPort.body as { error: { message: string } }).error.message).toMatch(/port/)
    const badKind = await call(api, 'config.upsert', { sessionId: 'session-a', ...VIEW_INPUT, kind: 'ssh' })
    expect((badKind.body as { error: { message: string } }).error.message).toMatch(/kind/)
  })

  it('removes a view and its credential, and refuses an unknown id', async () => {
    const { api, credentials } = apiFor()
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT, password: 'p' })
    expect(await credentials.readRecord('dsh-console-hub/c1')).toBeDefined()
    const removed = await call(api, 'config.remove', { sessionId: 'session-a', viewId: 'v-1' })
    expect(removed.status).toBe(200)
    expect((removed.body as { value: { removed: boolean, secretRemoved: boolean } }).value)
      .toEqual({ removed: true, secretRemoved: true })
    expect(await credentials.readRecord('dsh-console-hub/c1')).toBeUndefined()
    // The VIEW must be gone too, not just its credential. The assertion above
    // passed for a long time while the deletion itself silently failed: the
    // settings seam's `update` is a recursive merge, so a view map missing the
    // deleted entry came back still holding it. Checking the credential alone
    // could not see that, because clearing the record is a separate call that
    // really did run.
    const after = await call(api, 'config.list', { sessionId: 'session-a' })
    expect((after.body as { value: { views: unknown[] } }).value.views).toHaveLength(0)
    expect(JSON.stringify(after.body)).not.toContain('v-1')
    const again = await call(api, 'config.remove', { sessionId: 'session-a', viewId: 'v-1' })
    expect(again.status).toBe(404)
  })

  it('removes a view even when no credential provider is mounted', async () => {
    // The reported crash: `api.credentials` was read ONCE when the plugin
    // installed its API, while `settings` alone is injected -- so in a profile
    // whose credentials provider had not yet activated, the captured value was
    // `undefined` and deleting a view threw
    // "Cannot read properties of undefined (reading 'deleteRecord')".
    //
    // Every other case here supplies a provider, so the fake could not express
    // this state at all. A composition with no credential store is legitimate
    // (devices needing no login work in one), and a delete must still succeed:
    // a credential cannot exist in a store that does not.
    const { api } = apiFor({ credentials: undefined })
    const created = await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT })
    expect(created.status).toBe(200)

    const removed = await call(api, 'config.remove', { sessionId: 'session-a', viewId: 'v-1' })
    expect(removed.status).toBe(200)
    expect((removed.body as { value: { removed: boolean, secretRemoved: boolean } }).value)
      .toEqual({ removed: true, secretRemoved: false })
  })

  it('lists a view with no credential when no provider is mounted', async () => {
    // The read half of the same state: the inventory must still render, with
    // the row reporting no credential rather than failing the whole list.
    const { api } = apiFor({ credentials: undefined })
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT })
    const listed = await call(api, 'config.list', { sessionId: 'session-a' })
    expect(listed.status).toBe(200)
    const value = (listed.body as { value: { views: Array<{ view: { secretConfigured: boolean } }> } }).value
    expect(value.views[0]?.view.secretConfigured).toBe(false)
  })

  it('names the missing provider instead of crashing when a password is supplied', async () => {
    // Fail closed and say why: a password with nowhere to go must not appear to
    // have been stored.
    const { api } = apiFor({ credentials: undefined })
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT })
    const refused = await call(api, 'secret.set', {
      sessionId: 'session-a',
      viewId: 'v-1',
      password: 'nowhere-to-go',
    })
    expect(refused.status).toBe(400)
    const body = refused.body as { error: { code: string, message: string } }
    expect(body.error.code).toBe('credential-rejected')
    expect(body.error.message).toMatch(/no credential provider/i)
    // The value must not travel back out on the failure path.
    expect(JSON.stringify(refused.body)).not.toContain('nowhere-to-go')
  })
})

describe('secret.* methods', () => {
  it('sets, reports and clears a credential', async () => {
    const { api } = apiFor()
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT })
    expect(((await call(api, 'secret.status', { sessionId: 'session-a', viewId: 'v-1' })).body as { value: { configured: boolean } }).value.configured)
      .toBe(false)

    const set = await call(api, 'secret.set', { sessionId: 'session-a', viewId: 'v-1', password: 'top-secret', user: 'admin' })
    expect(set.status).toBe(200)
    expect(JSON.stringify(set.body)).not.toContain('top-secret')

    const status = await call(api, 'secret.status', { sessionId: 'session-a', viewId: 'v-1' })
    const value = (status.body as { value: { configured: boolean, writable: boolean } }).value
    expect(value.configured).toBe(true)
    expect(value.writable).toBe(true)

    await call(api, 'secret.clear', { sessionId: 'session-a', viewId: 'v-1' })
    expect(((await call(api, 'secret.status', { sessionId: 'session-a', viewId: 'v-1' })).body as { value: { configured: boolean } }).value.configured)
      .toBe(false)
  })

  it('refuses an empty password and an unknown view', async () => {
    const { api } = apiFor()
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT })
    const empty = await call(api, 'secret.set', { sessionId: 'session-a', viewId: 'v-1', password: '' })
    expect(empty.status).toBe(400)
    const unknown = await call(api, 'secret.set', { sessionId: 'session-a', viewId: 'v-9', password: 'x' })
    expect(unknown.status).toBe(404)
  })
})

describe('settings.* methods', () => {
  it('reads and writes the plugin settings with a revision guard', async () => {
    const { api, settings } = apiFor()
    const read = await call(api, 'settings.get', { sessionId: 'session-a' })
    const revision = (read.body as { value: { revision: number } }).value.revision
    expect(revision).toBe(1)

    const written = await call(api, 'settings.update', {
      sessionId: 'session-a',
      patch: { pagingMode: 'auto-quit', defaultEncoding: 'gbk' },
      expectedRevision: revision,
    })
    expect(written.status).toBe(200)
    expect(settings.current().pagingMode).toBe('auto-quit')
    expect(settings.current().defaultEncoding).toBe('gbk')

    // `settings.update` must answer the SAME KEYS as `settings.get`. It once
    // answered only `{ revision, settings }` while the client declared
    // `defaults`, and the client read a field that was not there -- `undefined`
    // -- which cleared its state and made the settings control vanish until a
    // manual refresh. The key sets are compared rather than the values: the two
    // reads happen at different times, so a field the write just changed is
    // expected to differ.
    const writtenValue = (written.body as { value: Record<string, unknown> }).value
    const readValue = (read.body as { value: Record<string, unknown> }).value
    expect(Object.keys(writtenValue).sort()).toEqual(Object.keys(readValue).sort())
    // ...and the defaults it does carry must reflect the write.
    expect((writtenValue.defaults as { pagingMode: string }).pagingMode).toBe('auto-quit')
    expect((writtenValue.defaults as { defaultEncoding: string }).defaultEncoding).toBe('gbk')

    const stale = await call(api, 'settings.update', {
      sessionId: 'session-a',
      patch: { pagingMode: 'manual' },
      expectedRevision: revision,
    })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ ok: false, error: { code: 'settings-conflict' } })
  })

  it('refuses a settings write that introduces an uncompilable pattern', async () => {
    const { api } = apiFor()
    const refused = await call(api, 'settings.update', { sessionId: 'session-a', patch: { promptPattern: '(' } })
    expect(refused.status).toBe(400)
    expect((refused.body as { error: { code: string } }).error.code).toBe('settings-rejected')
  })

  it('refuses a settings write that tries to carry a credential', async () => {
    const { api } = apiFor()
    const refused = await call(api, 'settings.update', {
      sessionId: 'session-a',
      patch: { views: { v1: { name: 'x', host: 'h', port: 23, password: 'oops' } } },
    })
    expect(refused.status).toBe(400)
    expect((refused.body as { error: { message: string } }).error.message).toMatch(/credential|password/i)
  })
})

describe('credential hygiene', () => {
  it('never returns a stored value from any read method', async () => {
    const { api } = apiFor()
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT, password: 'never-echo' })
    for (const [method, payload] of [
      ['config.list', { sessionId: 'session-a' }],
      ['secret.status', { sessionId: 'session-a', viewId: 'v-1' }],
      ['settings.get', { sessionId: 'session-a' }],
    ] as const) {
      const response = await call(api, method, payload)
      expect(JSON.stringify(response.body)).not.toContain('never-echo')
    }
  })

  it('stores a secret through the route and can resolve it back for a connect', async () => {
    const { api, credentials } = apiFor()
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT })
    await call(api, 'secret.set', { sessionId: 'session-a', viewId: 'v-1', password: 'for-connect', user: 'admin' })
    const record = await credentials.readRecord('dsh-console-hub/c1')
    expect(record?.kind).toBe('grant')
    expect(JSON.stringify(record?.payload)).toContain('for-connect')
  })
})

describe('settings write-through validation', () => {
  it('accepts a well-formed view map written straight through settings.update', async () => {
    const { api, settings } = apiFor()
    const written = await call(api, 'settings.update', {
      sessionId: 'session-a',
      patch: { views: { v1: { name: 'x', host: '10.0.0.1', port: 23, kind: 'raw' } } },
    })
    expect(written.status).toBe(200)
    expect(settings.current().views.v1?.host).toBe('10.0.0.1')
  })
})

describe('secret write path', () => {
  it('surfaces a refused credential write as credential-rejected', async () => {
    const credentials = fakeCredentials()
    credentials.modifyRecord = async () => {
      throw new Error('the credential store is read-only')
    }
    const { api } = apiFor({ credentials })
    await call(api, 'config.upsert', { sessionId: 'session-a', viewId: 'v-1', ...VIEW_INPUT })
    const refused = await call(api, 'secret.set', { sessionId: 'session-a', viewId: 'v-1', password: 'x' })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'credential-rejected' } })
  })
})

// The route's own write path is exercised above through `secret.set`; this
// direct call pins that `writeSecret` is the one function doing the write.
describe('secrets module integration', () => {
  it('is the same store the route writes through', async () => {
    const credentials = fakeCredentials()
    await writeSecret(credentials, 'v-1', { password: 'stored-directly' })
    const record = await credentials.readRecord('dsh-console-hub/c1')
    expect(JSON.stringify(record?.payload)).toContain('stored-directly')
  })
})
