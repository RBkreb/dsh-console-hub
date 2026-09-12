/**
 * Deletion against the REAL settings service, not a fake.
 *
 * This is the test that would have caught the reported bug, and the reason it
 * exists as its own file is the reason the bug shipped at all: every other spec
 * in `tests/` drives a fake settings seam, and the fake's `update` was a
 * top-level spread that DOES delete a nested key. The real seam's `update`
 * (`mergeLayers` in `@deepseek-ai/dsh-settings`) is a recursive merge that
 * cannot. The plugin therefore looked correct under test while silently doing
 * nothing in production -- the route answered `removed: true` and the device
 * stayed on disk.
 *
 * So this suite loads the INSTALLED service from the deployment's own profile,
 * registers the plugin's real namespace on it, and drives the plugin's real
 * route. The assertion is on the provider's stored document, which is the only
 * place the truth lives.
 *
 * It is skipped, loudly, when no profile is present: the packages it needs are
 * deliberately not dependencies of this plugin (they are the HOST's, supplied at
 * runtime), so a checkout without a deployment cannot run it. A skip is honest
 * here -- inventing a stand-in would recreate exactly the gap being closed.
 *
 * @module dsh-console-hub/tests/settings-seam
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSettingsDocument } from '../src/config.ts'
import { buildHubRoute } from '../src/hub-route.ts'
import type { ConsoleSessionApi } from '../src/console-routes.ts'
import type { ConsoleHttpRequest, ConsoleHttpResponse } from '../src/context-types.ts'
import type { ConsoleHubApi } from '../src/routes.ts'

/** Where the deployment keeps the packages the running host actually loads. */
const PROFILE_MODULES = join(homedir(), '.dsh', 'profiles', 'node_modules', '@deepseek-ai')

/** Whether the real settings package is installed for this deployment. */
function realSettingsAvailable(): boolean {
  return existsSync(join(PROFILE_MODULES, 'dsh-settings', 'lib', 'index.js'))
}

/** The message a skipped run prints, so a green suite is never read as coverage. */
const SKIP_REASON =
  `the real @deepseek-ai/dsh-settings is not installed under ${PROFILE_MODULES}; `
  + 'this suite needs the deployment (see the module comment for why a fake cannot replace it)'

/**
 * Load the deployment's own settings service and cordis Context.
 * @returns the base class and Context, or `undefined` when unavailable.
 */
async function loadRealSettings(): Promise<{
  SettingsProvider: new (ctx: unknown, ...args: never[]) => unknown
  Context: new () => unknown
} | undefined> {
  if (!realSettingsAvailable()) return undefined
  const settings = await import(`file:///${PROFILE_MODULES}/dsh-settings/lib/index.js`) as {
    SettingsProvider: new (ctx: unknown, ...args: never[]) => unknown
  }
  // Cordis resolves through the profile's own copy, so the service and its
  // context come from one installation rather than two.
  const cordis = await import(`file:///${PROFILE_MODULES}/cordis/lib/index.js`) as {
    Context: new () => unknown
  }
  return { SettingsProvider: settings.SettingsProvider, Context: cordis.Context }
}

/** Send one call through a routes handler. */
async function callRoute(
  handler: (req: ConsoleHttpRequest, res: ConsoleHttpResponse) => void | Promise<void>,
  method: string,
  payload: unknown,
): Promise<{ status: number, body: unknown }> {
  const request: ConsoleHttpRequest = {
    method: 'POST',
    url: `/dsh-console-hub/api/${method}`,
    headers: { host: '127.0.0.1:43120' },
    [Symbol.asyncIterator]: () => {
      let sent = false
      return {
        next: async () => (sent
          ? { done: true as const, value: undefined }
          : (() => { sent = true; return { done: false as const, value: JSON.stringify(payload) } })()),
      }
    },
  }
  let status = 0
  let body = ''
  const response: ConsoleHttpResponse = {
    writeHead: (code) => { status = code },
    end: (value) => { body = value === undefined ? '' : String(value) },
  }
  await handler(request, response)
  return { status, body: body === '' ? undefined : JSON.parse(body) }
}

const available = realSettingsAvailable()
if (!available) console.warn(`[settings-seam] SKIPPED — ${SKIP_REASON}`)

/**
 * The slice of the installed `SettingsProvider` this suite subclasses.
 *
 * Declared as an interface rather than an inline constructor cast because the
 * base has BOTH `writable` and `load`/`persist` as members, and a cast that
 * spells them as properties makes TypeScript reject the subclass's accessor and
 * overrides. The runtime shape is the real class; only the typing is local,
 * since the package is not a dependency of this plugin.
 */
interface RealSettingsProvider {
  doc: Record<string, unknown>
  document: Record<string, unknown>
  persisted: string[]
  writable: boolean
  register(ns: string, schema: unknown, options?: unknown): {
    replace(section: object): Promise<void>
    get(): unknown
  }
  load(): Promise<Record<string, unknown>>
  persist(ns: string, section: Record<string, unknown>): Promise<void>
  publish(doc: Record<string, unknown>): void
  /** The stored raw section for one namespace, as the seam sees it. */
  section(ns: string): unknown
}

/** The constructor shape the loaded class has. */
type RealSettingsCtor = new (ctx: unknown) => RealSettingsProvider

describe.skipIf(!available)('device deletion against the real settings service', () => {
  /**
   * Build a real provider, the plugin's real route, and a two-device document.
   *
   * @returns the provider, the stored-section reader, and the route handler.
   */
  async function scene(): Promise<{
    stored: () => Record<string, unknown>
    persisted: () => string[]
    call: (method: string, payload: unknown) => Promise<{ status: number, body: unknown }>
  }> {
    const loaded = await loadRealSettings()
    if (loaded === undefined) throw new Error('real settings unavailable')
    const { SettingsProvider, Context } = loaded

    // The smallest real subclass: the shipped `memory.ts` fixture's shape, so
    // the service under test is the genuine one and only its storage is memory.
    const Base = SettingsProvider as unknown as RealSettingsCtor
    const provider = new (class extends Base {
      constructor(ctx: unknown) {
        super(ctx)
        this.doc = {}
        this.persisted = []
      }

      override get writable(): boolean {
        return true
      }

      override load(): Promise<Record<string, unknown>> {
        return Promise.resolve(structuredClone(this.doc))
      }

      override async persist(ns: string, section: Record<string, unknown>): Promise<void> {
        // Exactly how the file provider stores it: the section as given,
        // retaining whatever keys the writer included -- the whole question.
        this.persisted.push(ns)
        this.doc[ns] = structuredClone(section)
      }
    })(new Context())

    // The base publishes its initial document from `load()` during Service.init.
    // Driving init is what makes the provider usable the way the host uses it.
    await provider.publish(await provider.load())

    const schema = (await import('../src/config.ts')).ConsoleHubSettingsSchema
    const scope = provider.register('dsh-console-hub', schema, { applies: 'live' })

    const view = (name: string, host: string): Record<string, unknown> => ({
      name, host, port: 23, kind: 'raw', encoding: '', user: '',
      promptPattern: '', pagerPattern: '', pagingMode: '', tags: [], notes: '',
    })
    await scope.replace({ ...parseSettingsDocument({}), views: { 'v-keep': view('KEEP', '10.0.0.1'), 'v-drop': view('DROP', '10.0.0.2') } })

    const stored = (): Record<string, unknown> => {
      const section = provider.doc['dsh-console-hub'] as { views?: Record<string, unknown> } | undefined
      return section?.views ?? {}
    }

    const route = buildHubRoute({
      hub: {
        settings: {
          service: provider as never,
          current: () => parseSettingsDocument(provider.doc['dsh-console-hub'] ?? {}),
          revision: () => 1,
          // The owner-facing `replace` that production's `installApi` always
          // supplies. Omitting it is not a harmless simplification: the route
          // would fall to its LAST fallback (the seam's `update`, a recursive
          // merge) and this suite would then be testing a path production never
          // takes -- passing while real deletion stayed broken.
          replace: async (patch: object) => {
            await scope.replace({ ...parseSettingsDocument(provider.doc['dsh-console-hub'] ?? {}), ...patch })
          },
        },
        credentials: undefined,
        manager: { get: () => ({ list: () => [] }) } as never,
        requestBodyLimitBytes: 1_000_000,
        trustedHosts: [],
        sessionExists: async () => true,
      } as unknown as ConsoleHubApi,
      session: {
        get manager() {
          return { list: () => [] }
        },
        requestBodyLimitBytes: 1_000_000,
        trustedHosts: [],
        sessionExists: async () => true,
        viewOf: async () => undefined,
        defaultEncoding: () => 'utf-8',
        defaults: () => ({ connectTimeoutMs: 1000, encoding: 'utf-8', kind: 'raw', pagingMode: 'manual' }),
      } as unknown as ConsoleSessionApi,
    })

    return {
      stored,
      persisted: () => provider.persisted,
      call: (method, payload) => callRoute(route.handler, method, payload),
    }
  }

  it('really removes the device from the provider document', async () => {
    const real = await scene()
    expect(Object.keys(real.stored()).sort()).toEqual(['v-drop', 'v-keep'])

    const removed = await real.call('config.remove', { sessionId: 'session-a', viewId: 'v-drop' })
    expect(removed.status).toBe(200)
    expect((removed.body as { value: { removed: boolean } }).value.removed).toBe(true)

    // A write that never reached storage would make the assertion below fail for
    // a reason unrelated to merging, so that is ruled out first.
    expect(real.persisted(), 'the delete never reached settings.persist').toContain('dsh-console-hub')

    // THE assertion. With `update` (a merge) this list still holds `v-drop`:
    // the merge cannot carry the absence of the key it was asked to delete.
    expect(Object.keys(real.stored()).sort()).toEqual(['v-keep'])
  })

  it('keeps an untouched device and its fields intact', async () => {
    const real = await scene()
    await real.call('config.remove', { sessionId: 'session-a', viewId: 'v-drop' })
    const kept = real.stored()['v-keep'] as { name: string, host: string }
    expect(kept.name).toBe('KEEP')
    expect(kept.host).toBe('10.0.0.1')
  })

  it('removes the last device, leaving a valid empty view map', async () => {
    // The edge the merge is worst at: deleting the final entry has to leave an
    // EMPTY map, and a merge would leave the whole map behind.
    const real = await scene()
    await real.call('config.remove', { sessionId: 'session-a', viewId: 'v-drop' })
    await real.call('config.remove', { sessionId: 'session-a', viewId: 'v-keep' })
    expect(Object.keys(real.stored())).toEqual([])
  })
})

// Guards the guard: if the profile check ever silently misreports, this fails
// loudly rather than letting the suite above vanish without a trace.
describe('the real-seam suite is not silently absent', () => {
  it('reports whether the deployment is present', () => {
    const modules = existsSync(PROFILE_MODULES) ? readdirSync(PROFILE_MODULES).length : 0
    expect(typeof available).toBe('boolean')
    if (!available) {
      expect(modules, 'no deployment modules found at all').toBe(0)
    }
  })
})
