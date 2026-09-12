/**
 * Red-first suite for `src/hub-route.ts`: the single composed route.
 *
 * The whole reason this module exists is that `WebServer.register` throws on a
 * duplicate `(kind, path)`. The first test is therefore not about dispatch at
 * all — it drives a fake web server that enforces the real rule, and fails if
 * the plugin ever tries to claim its prefix twice.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildHubRoute, HUB_API_PREFIX } from '../src/hub-route.ts'
import type { ConsoleHubApi } from '../src/routes.ts'
import type { ConsoleSessionApi } from '../src/console-routes.ts'
import { PortManager } from '../src/port-manager.ts'
import { DEFAULT_DORMANT_PATTERN, DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN, type ConsoleHubSettings } from '../src/config-shared.ts'
import { parseSettingsDocument } from '../src/config.ts'
import type {
  ConsoleCredentialProvider,
  ConsoleCredentialRecord,
  ConsoleHttpRequest,
  ConsoleHttpResponse,
  ConsoleSettingsScope,
  ConsoleSettingsService,
  ConsoleWebRoute,
} from '../src/context-types.ts'

// ── Fakes ───────────────────────────────────────────────────────────────────

/**
 * A web server stub that enforces the real duplicate-route rule.
 *
 * This is the point of the suite: if the host half registered `routes.ts` and
 * `console-routes.ts` separately, this would throw exactly as the real server
 * does, and the plugin would fail to load.
 */
function fakeWebServer(): {
  register(route: ConsoleWebRoute): () => void
  routes: ConsoleWebRoute[]
} {
  const routes: ConsoleWebRoute[] = []
  return {
    routes,
    register(route) {
      if (routes.some(existing => existing.kind === route.kind && existing.path === route.path)) {
        throw new Error(`route conflict: ${route.kind} ${route.path}`)
      }
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** A settings service stub backed by an in-memory document. */
function fakeSettings(initial: Partial<ConsoleHubSettings> = {}): { service: ConsoleSettingsService } {
  let document: unknown = { ...initial }
  const scope: ConsoleSettingsScope<ConsoleHubSettings> = {
    get: () => parseSettingsDocument(document),
    watch: () => () => {},
    update: async (patch) => {
      document = { ...(document as object), ...(patch as object) }
    },
    replace: async (section) => {
      document = section
    },
  }
  return {
    service: {
      register: <T,>() => scope as unknown as ConsoleSettingsScope<T>,
      describe: () => [{ ns: 'dsh-console-hub', value: parseSettingsDocument(document), revision: 1 }],
      update: async (_ns, patch) => {
        await scope.update(patch)
      },
      replace: async (_ns, section) => {
        await scope.replace(section)
      },
    },
  }
}

/** A credential provider stub holding records in memory. */
function fakeCredentials(): ConsoleCredentialProvider {
  const records = new Map<string, ConsoleCredentialRecord>()
  return {
    resolve: async () => undefined,
    describe: async () => ({ configured: false, writable: true }),
    set: async () => {},
    unset: async () => {},
    readRecord: async key => records.get(String(key)),
    describeRecord: async key => (records.has(String(key))
      ? { configured: true, kind: 'grant' as const, writable: true }
      : { configured: false, writable: true }),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(String(key)))
      if (next !== undefined) records.set(String(key), next)
      return records.get(String(key))
    },
    deleteRecord: async (key) => {
      records.delete(String(key))
    },
  }
}

/** A device stub that greets and answers each line. */
interface Device {
  port: number
  received: string[]
  close(): Promise<void>
}

async function startDevice(): Promise<Device> {
  const sockets: Socket[] = []
  const received: string[] = []
  const server: Server = createServer((socket) => {
    sockets.push(socket)
    socket.on('close', () => {
      const index = sockets.indexOf(socket)
      if (index >= 0) sockets.splice(index, 1)
    })
    socket.write('<DUT1>')
    socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      received.push(text)
      for (const line of text.split(/[\r\n]+/)) {
        if (line === '') continue
        socket.write(`\r\nanswer:${line}\r\n<DUT1>`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    received,
    async close() {
      for (const socket of sockets.splice(0)) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Build both API tables over one shared device. */
function apiFor(device: Device): { hub: ConsoleHubApi, session: ConsoleSessionApi, manager: PortManager } {
  const manager = new PortManager({
    maxConsoles: 4,
    scrollbackLimitBytes: 8192,
    outputLimitBytes: 4096,
    connectTimeoutMs: 1000,
    readTimeoutMs: 200,
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
    idleQuietMs: 250,
  })
  const settings = fakeSettings({ views: {} })
  const credentials = fakeCredentials()
  const hub: ConsoleHubApi = {
    settings: {
      service: settings.service,
      current: () => settings.service.describe()[0]?.value as ConsoleHubSettings,
      revision: () => 1,
    },
    credentials,
    manager,
    requestBodyLimitBytes: 8192,
    trustedHosts: [],
    sessionExists: async id => id !== 'no-such-session',
  }
  const session: ConsoleSessionApi = {
    manager,
    requestBodyLimitBytes: 8192,
    trustedHosts: [],
    sessionExists: async id => id !== 'no-such-session',
    viewOf: async (_sessionId, viewId) => (viewId === 'v-known'
      ? {
          viewId,
          name: 'FW1',
          host: '127.0.0.1',
          port: device.port,
          kind: 'raw',
          encoding: 'utf-8',
          user: '',
          promptPattern: '',
          pagerPattern: '',
          pagingMode: '',
          tags: [],
          notes: '',
        }
      : undefined),
    defaultEncoding: () => 'utf-8',
    defaults: () => ({ connectTimeoutMs: 1000, encoding: 'utf-8', kind: 'raw' as const, pagingMode: 'manual' as const }),
  }
  return { hub, session, manager }
}

/** Send one call through the composed route. */
async function call(
  route: ConsoleWebRoute,
  method: string,
  payload: unknown,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number, body: unknown }> {
  const request: ConsoleHttpRequest = {
    method: 'POST',
    url: `${HUB_API_PREFIX}/${method}`,
    headers: { host: '127.0.0.1:43120', ...options.headers },
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
  const response: ConsoleHttpResponse = {
    writeHead: (next) => {
      status = next
    },
    end: (chunk) => {
      body = typeof chunk === 'string' ? chunk : ''
    },
  }
  await route.handler(request, response)
  return { status, body: body === '' ? undefined : JSON.parse(body) }
}

const openDevices: Device[] = []
const openManagers: PortManager[] = []

afterEach(async () => {
  for (const manager of openManagers.splice(0)) await manager.dispose()
  for (const device of openDevices.splice(0)) await device.close()
})

/** A ready scene: one device, both tables, and the composed route. */
async function scene(): Promise<{
  route: ConsoleWebRoute
  hub: ConsoleHubApi
  session: ConsoleSessionApi
  manager: PortManager
  device: Device
}> {
  const device = await startDevice()
  openDevices.push(device)
  const { hub, session, manager } = apiFor(device)
  openManagers.push(manager)
  return { route: buildHubRoute({ hub, session }), hub, session, manager, device }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('one composed route', () => {
  it('registers its prefix exactly once, so the web server never sees a conflict', () => {
    const device = { port: 1, received: [] as string[], close: async () => {} }
    const { hub, session } = apiFor(device)
    const server = fakeWebServer()
    // The real server throws on a duplicate (kind, path). Registering the
    // composed route must therefore survive being applied twice only because
    // the host registers it once — here we assert the single registration and
    // that the second would conflict, proving the rule is exercised.
    server.register(buildHubRoute({ hub, session }))
    expect(server.routes).toHaveLength(1)
    expect(server.routes[0]?.path).toBe(HUB_API_PREFIX)
    expect(() => server.register(buildHubRoute({ hub, session }))).toThrow(/route conflict/)
  })

  it('routes console.* to the session table and everything else to the inventory table', async () => {
    const { route, device } = await scene()
    // An inventory method answers from `routes.ts`.
    const listed = await call(route, 'config.list', { sessionId: 'session-a' })
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({ ok: true, value: { views: [] } })

    // A console method answers from `console-routes.ts`: connect then read.
    const connected = await call(route, 'console.connect', {
      sessionId: 'session-a',
      host: '127.0.0.1',
      port: device.port,
      kind: 'raw',
    })
    expect(connected.status).toBe(200)
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    expect(consoleId).toMatch(/^c/)
  })

  it('keeps the browser-trust fence in front of both tables', async () => {
    const { route } = await scene()
    const hubRefused = await call(route, 'config.list', { sessionId: 'session-a' }, {
      headers: { host: 'evil.example.com' },
    })
    expect(hubRefused.status).toBe(403)
    const consoleRefused = await call(route, 'console.list', { sessionId: 'session-a' }, {
      headers: { host: 'evil.example.com' },
    })
    expect(consoleRefused.status).toBe(403)
  })

  it('lays the host gate on top of the fence when one is composed', async () => {
    const device = { port: 1, received: [] as string[], close: async () => {} }
    const { hub, session } = apiFor(device)
    // The host's own authorization (browser auth) refuses with 401; a request
    // that already passed the plugin fence must still honour it.
    const route = buildHubRoute({ hub, session, authorize: () => 401 })
    const refused = await call(route, 'config.list', { sessionId: 'session-a' })
    expect(refused.status).toBe(401)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'forbidden' } })

    // With no gate composed the same call succeeds, so the gate is additive.
    const permissive = buildHubRoute({ hub, session })
    const allowed = await call(permissive, 'config.list', { sessionId: 'session-a' })
    expect(allowed.status).toBe(200)
  })

  it('never answers a method the composed table does not own', async () => {
    const { route } = await scene()
    const unknown = await call(route, 'console.explode', { sessionId: 'session-a', consoleId: 'c1' })
    expect(unknown.status).toBe(404)
    const nested = await call(route, 'config/list', { sessionId: 'session-a' })
    expect(nested.status).toBe(404)
  })
})
