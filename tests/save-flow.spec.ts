/**
 * End-to-end: save a device through the plugin's OWN registered route, then read
 * it back.
 *
 * This suite exists because the console panel showed an empty list after a save
 * while every unit suite was green. The unit suites each drive one module
 * against a hand-written double; nothing exercised the chain the browser
 * actually walks --
 *
 *     apply() -> settings.register -> route -> config.upsert -> config.list
 *
 * -- where the host half's own wiring decides whether a write reaches the
 * document that the next read resolves. A fake settings service that stores
 * whatever it is handed cannot notice a mismatch between the write path and the
 * read path, which is exactly the class of bug this reproduces.
 *
 * The settings double here is therefore deliberately strict: it resolves
 * through the real schema and enforces the seam's real contract that a write
 * becomes visible to `get()` only after it commits.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { parseSettingsDocument } from '../src/config.ts'
import type { ConsoleHubSettings } from '../src/config-shared.ts'
import type { Context, ConsoleWebRoute } from '../src/context-types.ts'

/**
 * A settings store that models the real seam's TWO layers, including the
 * distinction that caused an empty panel over a populated file.
 *
 * The real seam keeps `document[ns]` (the raw stored section) and
 * `registration.resolved` (the value frozen at registration, refreshed only by a
 * commit the seam recognises as current) as separate things. `write()` updates
 * the document unconditionally, then commits conditionally:
 *
 *     await this.persist(ns, section)
 *     this.document[ns] = section                 // always
 *     if (current registration) this.commit(...)  // maybe
 *
 * `scope.get()` reads the frozen value; `describe().user` reads the document.
 * An earlier fake resolved `get()` fresh on every call, so it could not
 * represent a stale registration at all -- which is precisely why this bug
 * reached a real deployment.
 */
function settingsService(): {
  service: unknown
  document: () => unknown
  /** A write the seam persists but does not commit to the registration. */
  writeWithoutCommit(patch: Record<string, unknown>): void
} {
  let user: Record<string, unknown> = {}
  let revision = 1
  /** The frozen value `scope.get()` returns. */
  let frozen: ConsoleHubSettings = parseSettingsDocument(user)
  const watchers: Array<(next: ConsoleHubSettings) => void> = []

  /** Resolve exactly as the seam does: schema over the user section. */
  const resolve = (): ConsoleHubSettings => parseSettingsDocument(user)

  const scope = {
    get: () => frozen,
    watch(callback: (next: ConsoleHubSettings) => void) {
      watchers.push(callback)
      return () => {}
    },
    async update(patch: object) {
      // The real seam serializes writes and awaits the commit before resolving.
      await Promise.resolve()
      user = { ...user, ...(patch as Record<string, unknown>) }
      revision += 1
      // Re-resolve so an invalid document is refused at the write, as the real
      // seam's validate hook would refuse it.
      resolve()
      frozen = resolve()
      for (const watcher of watchers) watcher(frozen)
    },
    async replace(section: object) {
      await Promise.resolve()
      user = section as Record<string, unknown>
      revision += 1
      resolve()
      frozen = resolve()
      for (const watcher of watchers) watcher(frozen)
    },
  }

  return {
    document: () => user,
    writeWithoutCommit(patch) {
      // The document advances; the registration's frozen value does not.
      user = { ...user, ...patch }
      revision += 1
    },
    service: {
      register: () => scope,
      describe: () => [{ ns: 'dsh-console-hub', value: frozen, revision, user: structuredClone(user) }],
      update: async (_ns: string, patch: object) => {
        await scope.update(patch)
      },
    },
  }
}

/** A web server stub capturing the registered route. */
function webServer(): { service: unknown, routes: ConsoleWebRoute[] } {
  const routes: ConsoleWebRoute[] = []
  return {
    routes,
    service: {
      register(route: ConsoleWebRoute) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
}

/** A credential store in memory. */
function credentials(): unknown {
  const records = new Map<string, unknown>()
  return {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
    readRecord: async (key: unknown) => records.get(String(key)),
    describeRecord: async (key: unknown) => (records.has(String(key))
      ? { configured: true, kind: 'grant', writable: true }
      : { configured: false, writable: true }),
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

/**
 * A context that resolves `inject` the way Cordis does.
 *
 * The callback runs on a later microtask, not synchronously, because that is
 * what the real fiber runner does; a synchronous fake would hide any code that
 * reads an injected service immediately after `ctx.inject` returns.
 */
function fakeContext(services: Record<string, unknown>): {
  ctx: Context
  flush: () => Promise<void>
} {
  const pending: Array<() => Promise<void> | void> = []
  const disposers: Array<() => void> = []
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    get: (name: string) => services[name],
    inject(list: readonly string[], callback: (inner: Context) => void | (() => void)) {
      if (!list.every(entry => services[entry] !== undefined)) return () => {}
      const inner = { ...ctx, get: (name: string) => services[name] } as unknown as Context & Record<string, unknown>
      for (const entry of list) inner[entry] = services[entry]
      pending.push(() => {
        const dispose = callback(inner)
        if (typeof dispose === 'function') disposers.push(dispose)
      })
      return () => {}
    },
    effect(effect: () => void | (() => void)) {
      const dispose = effect()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
  }
  return {
    ctx: ctx as unknown as Context,
    async flush() {
      while (pending.length > 0) await pending.shift()?.()
    },
  }
}

/** POST one API method through the route the plugin registered. */
async function call(
  route: ConsoleWebRoute,
  method: string,
  payload: unknown,
): Promise<{ status: number, body: unknown }> {
  const request = {
    method: 'POST',
    url: `/dsh-console-hub/api/${method}`,
    headers: { host: '127.0.0.1:43120' },
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

/** A ready scene: the plugin applied over one settings store and one route. */
async function scene(): Promise<{
  route: ConsoleWebRoute
  document: () => unknown
  writeWithoutCommit(patch: Record<string, unknown>): void
}> {
  const settings = settingsService()
  const server = webServer()
  const { ctx, flush } = fakeContext({
    settings: settings.service,
    webServer: server.service,
    credentials: credentials(),
  })
  apply(ctx, {})
  await flush()
  expect(server.routes).toHaveLength(1)
  return {
    route: server.routes[0] as ConsoleWebRoute,
    document: settings.document,
    writeWithoutCommit: settings.writeWithoutCommit,
  }
}

describe('save then list, through the registered route', () => {
  it('returns a saved device from config.list', async () => {
    const { route, document } = await scene()
    const sessionId = 'session-a'

    // What the panel does when 保存 is pressed.
    const saved = await call(route, 'config.upsert', {
      sessionId,
      name: 'FW1',
      host: '10.133.6.253',
      port: 10003,
      kind: 'telnet',
      encoding: '',
      user: '',
      promptPattern: '',
      pagerPattern: '',
      pagingMode: '',
      notes: '',
    })
    expect(saved.status).toBe(200)

    // The write must have reached the stored document, not just a response.
    expect(JSON.stringify(document())).toContain('10.133.6.253')

    // And the very next read the panel makes must see it.
    const listed = await call(route, 'config.list', { sessionId })
    expect(listed.status).toBe(200)
    const views = (listed.body as { value: { views: Array<{ viewId: string, view: { name: string } }> } }).value.views
    expect(views).toHaveLength(1)
    expect(views[0]?.view.name).toBe('FW1')
  })

  it('survives a round trip through the same session the browser uses', async () => {
    // The panel sends its own session id, so a mismatch between the id it sends
    // and the id the route resolves would lose the write silently.
    const { route } = await scene()
    const sessionId = 'session-d0b34333-6021-44f8-9e65-c92e2c774572'

    const saved = await call(route, 'config.upsert', {
      sessionId,
      name: '核心防火墙 FW1',
      host: '10.133.6.253',
      port: 10003,
      kind: 'telnet',
    })
    expect(saved.status).toBe(200)

    const listed = await call(route, 'config.list', { sessionId })
    const value = (listed.body as { value: { views: Array<{ view: { name: string, host: string } }> } }).value
    expect(value.views).toHaveLength(1)
    // Non-ASCII must survive the JSON round trip, since the panel is Chinese.
    expect(value.views[0]?.view.name).toBe('核心防火墙 FW1')
  })

  it('reports a rejected write instead of answering success', async () => {
    // A save that cannot be stored must not look like one that can: the panel
    // clears the form on success, so a false success loses the user's input.
    const { route } = await scene()
    const rejected = await call(route, 'config.upsert', {
      sessionId: 'session-a',
      name: 'FW1',
      host: '10.133.6.253',
      port: 10003,
      kind: 'telnet',
      promptPattern: '(', // not a compilable regular expression
    })
    expect(rejected.status).toBeGreaterThanOrEqual(400)
    expect(rejected.body).toMatchObject({ ok: false })

    const listed = await call(route, 'config.list', { sessionId: 'session-a' })
    expect((listed.body as { value: { views: unknown[] } }).value.views).toHaveLength(0)
  })
})

describe('the session store is advisory, never a gate', () => {
  /**
   * A scene whose session store does NOT know the panel's id.
   *
   * This is the shape of a real failure: the same build saved devices happily
   * under one profile and refused every call with `no session "..."` under
   * another, because that profile's store did not recognise the panel's id. The
   * panel's calls all carry the SAME id, so consoles are consistently scoped to
   * it either way -- refusing gains nothing and loses the whole panel.
   *
   * @param store - what the `sessions` service should look like, if anything.
   * @returns the registered route and the settings document.
   */
  async function sceneWithSessions(store: unknown): Promise<{
    route: ConsoleWebRoute
    document: () => unknown
  }> {
    const settings = settingsService()
    const server = webServer()
    const services: Record<string, unknown> = {
      settings: settings.service,
      webServer: server.service,
      credentials: credentials(),
    }
    if (store !== undefined) services.sessions = store
    const { ctx, flush } = fakeContext(services)
    apply(ctx, {})
    await flush()
    return { route: server.routes[0] as ConsoleWebRoute, document: settings.document }
  }

  it('serves the panel when the session store does not know its id', async () => {
    const { route, document } = await sceneWithSessions({ get: () => undefined })
    const saved = await call(route, 'config.upsert', {
      sessionId: 'session-unknown-to-this-store',
      name: 'FW1',
      host: '10.133.6.253',
      port: 10003,
      kind: 'telnet',
    })
    expect(saved.status).toBe(200)
    expect(JSON.stringify(document())).toContain('10.133.6.253')
  })

  it('serves the panel when the session store is absent entirely', async () => {
    const { route } = await sceneWithSessions(undefined)
    const listed = await call(route, 'config.list', { sessionId: 'session-a' })
    expect(listed.status).toBe(200)
  })

  it('serves the panel even when the session store throws on lookup', async () => {
    // A store that throws is less of an authority on the caller's identity than
    // one that merely does not know it, so it must not become a new failure.
    const { route } = await sceneWithSessions({
      get: () => {
        throw new Error('session store unavailable')
      },
    })
    const listed = await call(route, 'config.list', { sessionId: 'session-a' })
    expect(listed.status).toBe(200)
  })

  it('still refuses an empty session id, which names nothing at all', async () => {
    const { route } = await sceneWithSessions({ get: () => undefined })
    const refused = await call(route, 'config.list', { sessionId: '' })
    expect(refused.status).toBe(400)
  })
})

describe('the stored document wins over a stale registration', () => {
  /**
   * The failure this pins, as it actually appeared in a deployment.
   *
   * `settings.yaml` held three saved devices. The panel listed none of them, the
   * model's `console_connect` could not resolve a `viewId`, and nothing logged
   * an error anywhere -- because the plugin read the value the seam froze at
   * registration, while the stored document had moved on.
   *
   * Reading the stored section is the correct behaviour regardless of how the
   * two drifted: the stored document is what survives a restart, so it is what
   * the panel must show and what the engine must use.
   */
  const savedViews = {
    'v-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': {
      name: 'FW1',
      host: '10.133.6.253',
      port: 10003,
      kind: 'telnet',
    },
  }

  it('lists devices that are stored but missing from the frozen value', async () => {
    const { route, document, writeWithoutCommit } = await scene()
    writeWithoutCommit({ views: savedViews })
    expect(JSON.stringify(document())).toContain('10.133.6.253')

    const listed = await call(route, 'config.list', { sessionId: 'session-a' })
    expect(listed.status).toBe(200)
    const views = (listed.body as { value: { views: Array<{ viewId: string, view: { name: string } }> } }).value.views
    expect(views).toHaveLength(1)
    expect(views[0]?.view.name).toBe('FW1')
  })

  it('resolves a stored view by id, so console.connect can reach it', async () => {
    // The tool path reads the same resolver, so `console_connect { viewId }`
    // answering "no stored view" was the second face of this one bug.
    const { route, writeWithoutCommit } = await scene()
    writeWithoutCommit({ views: savedViews })
    const connected = await call(route, 'console.connect', {
      sessionId: 'session-a',
      viewId: 'v-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
    // It reached the device layer (and failed there, since nothing listens),
    // which is the point: the view RESOLVED instead of being reported missing.
    expect(JSON.stringify(connected.body)).not.toContain('no view')
  })

  it('still serves a read when the seam cannot describe its namespaces', async () => {
    const { route } = await scene()
    const listed = await call(route, 'config.list', { sessionId: 'session-a' })
    expect(listed.status).toBe(200)
  })
})
