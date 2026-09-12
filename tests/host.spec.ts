/**
 * Red-first suite for the host half (`src/index.ts`).
 *
 * This is the wiring suite: it drives `apply` against a fake context that
 * mirrors Cordis' `inject` semantics (a callback runs only while every listed
 * service is present) and asserts what the plugin contributes — a settings
 * namespace, one API route, and the gated tool family.
 *
 * Two things it deliberately pins that are easy to get wrong:
 *
 * 1. **The route is registered exactly once.** The web server throws on a
 *    duplicate `(kind, path)`, so a host that registered the inventory table and
 *    the console table separately would fail to load.
 * 2. **The model face is gated, the panel is not.** `agentConsoleTools` must be
 *    able to withdraw the tools while the sidebar API keeps working, and the
 *    withdrawal must actually unregister them.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from '../src/index.ts'
import { parseSettingsDocument } from '../src/config.ts'
import type { ConsoleHubSettings } from '../src/config-shared.ts'
import type { Context, ConsoleWebRoute } from '../src/context-types.ts'

// ── A context that behaves like Cordis ──────────────────────────────────────

/** One settings document with watchers, mirroring the seam's live semantics. */
function settingsService(): {
  service: unknown
  document: () => Record<string, unknown>
  write(patch: Record<string, unknown>): Promise<void>
  registered: { ns?: string, options?: { validate?: (value: ConsoleHubSettings) => void } }
} {
  let document: Record<string, unknown> = {}
  let watchers: Array<(next: ConsoleHubSettings) => void> = []
  const registered: { ns?: string, options?: { validate?: (value: ConsoleHubSettings) => void } } = {}

  /** Resolve the document the way the real seam does: schema, then validate. */
  const resolve = (): ConsoleHubSettings => {
    const value = parseSettingsDocument(document)
    registered.options?.validate?.(value)
    return value
  }

  const notify = (): void => {
    const value = resolve()
    for (const watcher of watchers) watcher(value)
  }

  const scope = {
    get: resolve,
    watch(callback: (next: ConsoleHubSettings) => void) {
      watchers.push(callback)
      return () => {
        watchers = watchers.filter(entry => entry !== callback)
      }
    },
    async update(patch: object) {
      document = { ...document, ...(patch as Record<string, unknown>) }
      // Validate the MERGED document, exactly as the real seam refuses a write
      // that produces an invalid section.
      resolve()
      notify()
    },
    async replace(section: object) {
      document = section as Record<string, unknown>
      resolve()
      notify()
    },
  }

  return {
    registered,
    service: {
      register: (ns: string, _schema: unknown, options?: { validate?: (value: ConsoleHubSettings) => void }) => {
        registered.ns = ns
        registered.options = options
        return scope
      },
      describe: () => [{ ns: 'dsh-console-hub', value: resolve(), revision: 1 }],
      update: async (_ns: string, patch: object) => {
        await scope.update(patch)
      },
    },
    document: () => document,
    write: async (patch) => {
      await scope.update(patch)
    },
  }
}

/** A web server stub that enforces the real duplicate-route rule. */
function webServer(): { service: unknown, routes: ConsoleWebRoute[] } {
  const routes: ConsoleWebRoute[] = []
  return {
    routes,
    service: {
      register(route: ConsoleWebRoute) {
        if (routes.some(existing => existing.kind === route.kind && existing.path === route.path)) {
          throw new Error(`route conflict: ${route.kind} ${route.path}`)
        }
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
}

/** A tool registry stub recording names and honouring disposal. */
function toolRegistry(): { service: unknown, names: () => string[] } {
  const registered = new Map<string, () => void>()
  return {
    service: {
      register(definition: unknown) {
        const toolName = (definition as { name?: string }).name ?? '?'
        if (registered.has(toolName)) throw new Error(`duplicate tool ${toolName}`)
        const dispose = (): void => {
          registered.delete(toolName)
        }
        registered.set(toolName, dispose)
        return dispose
      },
    },
    names: () => [...registered.keys()].sort(),
  }
}

/** A credential provider stub. */
function credentials(): unknown {
  const records = new Map<string, unknown>()
  return {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
    readRecord: async (key: unknown) => records.get(String(key)),
    describeRecord: async () => ({ configured: false, writable: true }),
    modifyRecord: async (key: unknown, mutate: (current: unknown) => Promise<unknown>) => {
      const next = await mutate(records.get(String(key)))
      if (next !== undefined) records.set(String(key), next)
      return records.get(String(key))
    },
    deleteRecord: async (key: unknown) => {
      records.delete(String(key))
    },
  }
}

/** A context that runs an `inject` callback only while its services exist. */
function fakeContext(services: Record<string, unknown>): {
  ctx: Context
  disposers: Array<() => void>
  injected: string[]
  flush(): Promise<void>
} {
  const disposers: Array<() => void> = []
  const injected: string[] = []
  const pendingCallbacks: Array<() => Promise<void>> = []
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: (serviceName: string) => services[serviceName],
    inject(list: readonly string[], callback: (inner: Context) => void | (() => void)) {
      injected.push([...list].join(','))
      if (!list.every(entry => services[entry] !== undefined)) return () => {}
      const inner = { ...ctx, get: (serviceName: string) => services[serviceName] } as unknown as Context & Record<string, unknown>
      for (const entry of list) inner[entry] = services[entry]
      // Cordis resolves an injected dependency ASYNCHRONOUSLY: its fiber runner
      // awaits a microtask before invoking the callback. Running it
      // synchronously here would hide exactly the bug this suite exists to
      // catch — code that reads the service right after `ctx.inject` returns.
      let dispose: (() => void) | undefined
      let disposed = false
      pendingCallbacks.push(async () => {
        if (disposed) return
        const result = callback(inner)
        if (typeof result === 'function') dispose = result
      })
      return () => {
        disposed = true
        dispose?.()
      }
    },
    effect(effect: () => void | (() => void)) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }
  return {
    ctx: ctx as unknown as Context,
    disposers,
    injected,
    /** Run the queued inject callbacks, as Cordis' fiber runner would. */
    async flush() {
      while (pendingCallbacks.length > 0) {
        const callback = pendingCallbacks.shift()
        await callback?.()
      }
    },
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('host plugin identity', () => {
  it('names itself for the cordis.yml row and declares its one hard dependency', () => {
    expect(name).toBe('dsh-console-hub')
    // `settings` is the only hard dependency: it owns the device inventory.
    expect(inject).toEqual(['settings'])
    // An approval service must NOT be a hard dependency — the guard has to fail
    // closed rather than defer registration until one appears.
    expect(inject).not.toContain('approval')
  })
})

describe('settings namespace', () => {
  it('registers the documented namespace with live semantics and a pattern check', async () => {
    const settings = settingsService()
    const { ctx, flush } = fakeContext({ settings: settings.service })
    apply(ctx)
    await flush()
    expect(settings.registered.ns).toBe('dsh-console-hub')
    // `validate` is the seam that refuses an uncompilable pattern at WRITE time
    // rather than letting a live console throw on its first read.
    expect(typeof settings.registered.options?.validate).toBe('function')
    expect(() => settings.registered.options?.validate?.({
      ...parseSettingsDocument({}),
      promptPattern: '(',
    })).toThrow(/uncompilable/i)
  })

  it('serves the inventory through the route it registers', async () => {
    const settings = settingsService()
    await settings.write({
      views: {
        fw1: { name: 'FW1', host: '10.133.6.253', port: 10003, kind: 'telnet' },
      },
    })
    const server = webServer()
    const { ctx, flush } = fakeContext({ settings: settings.service, webServer: server.service })
    apply(ctx)
    await flush()
    expect(server.routes).toHaveLength(1)

    // Drive one call through the registered route: the host must answer from
    // the live settings document.
    const route = server.routes[0] as ConsoleWebRoute
    const response = await callRoute(route, 'config.list', { sessionId: 'session-a' })
    expect(response.status).toBe(200)
    const value = (response.body as { value: { views: Array<{ viewId: string, view: { name: string } }> } }).value
    expect(value.views).toHaveLength(1)
    expect(value.views[0]?.view.name).toBe('FW1')
  })
})

describe('capability gating', () => {
  it('registers the API route exactly once, so the web server sees no conflict', async () => {
    const settings = settingsService()
    const server = webServer()
    const { ctx, flush } = fakeContext({ settings: settings.service, webServer: server.service })
    // A duplicate registration would throw inside the captured thrower; apply
    // must therefore contribute exactly one route.
    expect(() => apply(ctx)).not.toThrow()
    await flush()
    // The route lands inside the `webServer` inject callback, which Cordis runs
    // asynchronously — so the assertion waits for that, exactly as the harness
    // does before it serves traffic.
    expect(server.routes.map(route => route.path)).toEqual(['/dsh-console-hub/api'])
  })

  it('loads without a web server, a tools registry, sessions, credentials, or approval', async () => {
    // The plugin must survive a minimal composition: a settings provider alone.
    const settings = settingsService()
    const { ctx, flush } = fakeContext({ settings: settings.service })
    expect(() => apply(ctx)).not.toThrow()
    await flush()
  })

  it('registers the console tool family while the setting enables it', async () => {
    const settings = settingsService()
    const tools = toolRegistry()
    const { ctx, flush } = fakeContext({ settings: settings.service, tools: tools.service })
    apply(ctx)
    await flush()
    expect(tools.names()).toContain('console_list')
    expect(tools.names()).toContain('console_send')
    expect(tools.names()).toContain('console_connect')
  })

  it('withdraws the tool family when the setting turns it off, and restores it', async () => {
    const settings = settingsService()
    const tools = toolRegistry()
    const { ctx, flush } = fakeContext({ settings: settings.service, tools: tools.service })
    apply(ctx)
    await flush()
    const enabled = tools.names().length
    expect(enabled).toBeGreaterThan(0)

    // The model face is what the setting gates; turning it off must actually
    // unregister the tools, not merely stop advertising them.
    await settings.write({ agentConsoleTools: false })
    expect(tools.names()).toEqual([])

    await settings.write({ agentConsoleTools: true })
    expect(tools.names().length).toBe(enabled)
  })

  it('keeps the panel API alive when the model tools are withdrawn', async () => {
    const settings = settingsService()
    const tools = toolRegistry()
    const server = webServer()
    const { ctx, flush } = fakeContext({
      settings: settings.service,
      tools: tools.service,
      webServer: server.service,
    })
    apply(ctx)
    await flush()
    await settings.write({ agentConsoleTools: false })
    expect(tools.names()).toEqual([])
    // The sidebar panel reads through the route, which is not gated.
    expect(server.routes).toHaveLength(1)
  })

  it('does not inject the approval seam, so a missing answerer fails closed', async () => {
    const settings = settingsService()
    const { ctx, injected, flush } = fakeContext({ settings: settings.service })
    apply(ctx)
    await flush()
    expect(injected).not.toContain('approval')
  })

  it('finds the credential seam even when it activates after the API is installed', async () => {
    // The reported crash, reproduced at the level it happened: the API table was
    // built with a ONE-TIME `ctx.get('credentials')` while only `settings` is
    // injected, so a provider that activated a moment later was never seen and
    // deleting a view threw "Cannot read properties of undefined (reading
    // 'deleteRecord')".
    //
    // The service is therefore registered AFTER `apply` has run: a lazy lookup
    // finds it, a captured one cannot.
    const settings = settingsService()
    const server = webServer()
    const services: Record<string, unknown> = { settings: settings.service, webServer: server.service }
    const { ctx, flush } = fakeContext(services)
    apply(ctx)
    await flush()

    // The provider arrives late, exactly as Cordis activates an independent row.
    services.credentials = credentials()

    await settings.write({ views: { fw1: { name: 'FW1', host: '10.133.6.253', port: 10003, kind: 'telnet' } } })
    const route = server.routes[0] as ConsoleWebRoute

    // A credential write proves the seam was reached: with a captured
    // `undefined` this answers 500/credential-rejected instead of 200.
    const set = await callRoute(route, 'secret.set', {
      sessionId: 'session-a',
      viewId: 'fw1',
      password: 'late-provider',
    })
    expect(set.status).toBe(200)

    // And the delete that started this: it must not throw.
    const removed = await callRoute(route, 'config.remove', { sessionId: 'session-a', viewId: 'fw1' })
    expect(removed.status).toBe(200)
    expect((removed.body as { value: { removed: boolean } }).value.removed).toBe(true)
  })
})

/** Send one call through a registered route. */
async function callRoute(
  route: ConsoleWebRoute,
  method: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number, body: unknown }> {
  const request = {
    method: 'POST',
    url: `/dsh-console-hub/api/${method}`,
    headers: { host: '127.0.0.1:43120', ...headers },
    [Symbol.asyncIterator]: () => {
      let sent = false
      return {
        next: async () => {
          if (sent) return { done: true as const, value: undefined }
          sent = true
          return { done: false as const, value: JSON.stringify(payload ?? {}) }
        },
      }
    },
  }
  let status = 200
  let body = ''
  const response = {
    writeHead: (next: number) => {
      status = next
    },
    end: (chunk?: string | Uint8Array) => {
      body = typeof chunk === 'string' ? chunk : ''
    },
  }
  await route.handler(request as never, response as never)
  return { status, body: body === '' ? undefined : JSON.parse(body) }
}
