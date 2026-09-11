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
 * A settings store that models the real seam's layering: schema defaults, then
 * the user section. `update` commits asynchronously, so a write that is read
 * back synchronously is a real failure rather than a fake quirk.
 */
function settingsService(): { service: unknown, document: () => unknown } {
  let user: Record<string, unknown> = {}
  let revision = 1
  const watchers: Array<(next: ConsoleHubSettings) => void> = []

  /** Resolve exactly as the seam does: schema over the user section. */
  const resolve = (): ConsoleHubSettings => parseSettingsDocument(user)

  const scope = {
    get: resolve,
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
      for (const watcher of watchers) watcher(resolve())
    },
    async replace(section: object) {
      await Promise.resolve()
      user = section as Record<string, unknown>
      revision += 1
      resolve()
      for (const watcher of watchers) watcher(resolve())
    },
  }

  return {
    document: () => user,
    service: {
      register: () => scope,
      describe: () => [{ ns: 'dsh-console-hub', value: resolve(), revision }],
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
  return { route: server.routes[0] as ConsoleWebRoute, document: settings.document }
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
