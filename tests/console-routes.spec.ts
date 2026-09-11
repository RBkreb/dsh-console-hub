/**
 * Red-first suite for `src/console-routes.ts`: the console session half of the
 * API (`console.*`) plus the `session.describe` lookup. Driven against real
 * in-process TCP servers, so connect/send/read/wait/close go over real streams.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildConsoleRoutes, type ConsoleSessionApi } from '../src/console-routes.ts'
import { PortManager } from '../src/port-manager.ts'
import { DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN } from '../src/config-shared.ts'
import type { ConsoleHttpRequest, ConsoleHttpResponse } from '../src/context-types.ts'

/** A device stub that echoes commands with a canned answer. */
interface Device {
  port: number
  sockets: Socket[]
  received: string[]
  close(): Promise<void>
}

/** Start a device that greets and answers each line. */
async function startDevice(answer: (line: string) => string = line => `answer:${line}`): Promise<Device> {
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
        socket.write(`\r\n${answer(line)}\r\n<DUT1>`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    sockets,
    received,
    async close() {
      for (const socket of sockets.splice(0)) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Build the dependencies one call needs. */
function apiFor(): {
  api: ConsoleSessionApi
  manager: PortManager
} {
  const manager = new PortManager({
    maxConsoles: 3,
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
  })
  return {
    api: {
      manager,
      requestBodyLimitBytes: 8192,
      trustedHosts: [],
      sessionExists: async id => id !== 'no-such-session',
      /** A view lookup the connect path uses; unknown ids fail the call. */
      viewOf: async (_sessionId, viewId) => (viewId === 'v-known'
        ? { viewId, name: 'FW1', host: '127.0.0.1', port: 0, kind: 'raw', encoding: 'utf-8', user: '', promptPattern: '', pagerPattern: '', pagingMode: '', tags: [], notes: '' }
        : undefined),
      defaultEncoding: () => 'utf-8',
      defaults: () => ({
        connectTimeoutMs: 1000,
        encoding: 'utf-8',
        kind: 'raw' as const,
        pagingMode: 'manual' as const,
      }),
      // The panel path's fence: a high-risk command is refused until the panel
      // replays it with the one-shot token this minted. Safe commands pass.
      fenceForUser: ({ text }) => text.includes('config') || text.includes('restart')
        ? { risk: 'high' as const, confirmationToken: `tok-${text}`, reason: `"${text}" is high risk` }
        : { risk: 'safe' as const },
      consumeConfirmation: (_sessionId, _consoleId, token) => token.startsWith('tok-'),
    },
    manager,
  }
}

/** Send one call through the registered console route. */
async function call(
  api: ConsoleSessionApi,
  method: string,
  payload: unknown,
  options: { headers?: Record<string, string>, httpMethod?: string } = {},
): Promise<{ status: number, body: unknown }> {
  const route = buildConsoleRoutes(api)
  const text = JSON.stringify(payload ?? {})
  const request: ConsoleHttpRequest = {
    method: options.httpMethod ?? 'POST',
    url: `/dsh-console-hub/api/${method}`,
    headers: { host: '127.0.0.1:43120', ...options.headers },
    [Symbol.asyncIterator]: () => {
      let sent = false
      return {
        next: async () => {
          if (sent) return { done: true as const, value: undefined }
          sent = true
          return { done: false as const, value: text }
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
    end(value) {
      body = value === undefined ? '' : String(value)
    },
  }
  await route.handler(request, response)
  return { status, body: body === '' ? undefined : JSON.parse(body) }
}

const devices: Device[] = []
const managers: PortManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose()
  for (const device of devices.splice(0)) await device.close()
})

/** Poll a predicate until it holds, or fail the test with a clear message. */
async function until(predicate: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the device to answer')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Build an API plus a device, tracked for teardown. */
async function scene(answer?: (line: string) => string): Promise<{
  api: ConsoleSessionApi
  manager: PortManager
  device: Device
}> {
  const device = await startDevice(answer)
  const { api, manager } = apiFor()
  devices.push(device)
  managers.push(manager)
  // Point the view lookup at this device's port.
  api.viewOf = async (_sessionId, viewId) => (viewId === 'v-known'
    ? { viewId, name: 'FW1', host: '127.0.0.1', port: device.port, kind: 'raw', encoding: 'utf-8', user: '', promptPattern: '', pagerPattern: '', pagingMode: '', tags: [], notes: '' }
    : undefined)
  return { api, manager, device }
}

describe('console route envelope', () => {
  it('shares the same fence and method rules as the base API', async () => {
    const { api } = await scene()
    const route = buildConsoleRoutes(api)
    expect(route.path).toBe('/dsh-console-hub/api')

    const forbidden = await call(api, 'console.list', {}, { headers: { host: 'evil.example.com' } })
    expect(forbidden.status).toBe(403)

    const wrongMethod = await call(api, 'console.list', {}, { httpMethod: 'GET' })
    expect(wrongMethod.status).toBe(405)

    const unknown = await call(api, 'console.nope', { sessionId: 'session-a' })
    expect(unknown.status).toBe(404)
  })
})

describe('console.connect', () => {
  it('connects by view id and reports the banner and prompt', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    expect(connected.status).toBe(200)
    const value = (connected.body as {
      value: { consoleId: string, state: string, banner: string, prompt: string | null, secure: boolean }
    }).value
    expect(value.state).toBe('open')
    expect(value.consoleId).toMatch(/^c[0-9a-f]+$/)
    expect(value.banner).toContain('<DUT1>')
    expect(value.prompt).toBe('<DUT1>')
    expect(value.secure).toBe(false)
  })

  it('connects by explicit endpoint with an encoding override', async () => {
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', {
      sessionId: 'session-a',
      host: '127.0.0.1',
      port: device.port,
      kind: 'raw',
      encoding: 'gbk',
      name: 'ad-hoc',
    })
    expect(connected.status).toBe(200)
    expect((connected.body as { value: { encoding: string, label: string } }).value.encoding).toBe('gbk')
    expect((connected.body as { value: { label: string } }).value.label).toBe('ad-hoc')
  })

  it('reports an unknown view as not found', async () => {
    const { api } = await scene()
    const missing = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-nope' })
    expect(missing.status).toBe(404)
  })

  it('requires either a view id or a host and port', async () => {
    const { api } = await scene()
    const nothing = await call(api, 'console.connect', { sessionId: 'session-a' })
    expect(nothing.status).toBe(400)
    const hostOnly = await call(api, 'console.connect', { sessionId: 'session-a', host: '127.0.0.1' })
    expect(hostOnly.status).toBe(400)
  })

  it('returns a coded failure result when the device is unreachable', async () => {
    const device = await startDevice()
    const port = device.port
    await device.close()
    const { api } = apiFor()
    managers.push(api.manager)
    const connected = await call(api, 'console.connect', {
      sessionId: 'session-a',
      host: '127.0.0.1',
      port,
      kind: 'raw',
    })
    // A failed connect is a RESULT (the entry exists, its state says error), not
    // an HTTP error: the panel needs to show it.
    expect(connected.status).toBe(200)
    const value = (connected.body as { value: { state: string, lastError: { code: string } } }).value
    expect(['error', 'closed']).toContain(value.state)
    expect(value.lastError.code).toBeTruthy()
  })

  it('never echoes a supplied password back', async () => {
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', {
      sessionId: 'session-a',
      host: '127.0.0.1',
      port: device.port,
      kind: 'raw',
      password: 'top-secret',
    })
    expect(JSON.stringify(connected.body)).not.toContain('top-secret')
    expect((connected.body as { value: { secure: boolean } }).value.secure).toBe(true)
  })
})

describe('console.list / console.describe', () => {
  it('lists the caller session consoles only', async () => {
    const { api } = await scene()
    await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const mine = await call(api, 'console.list', { sessionId: 'session-a' })
    expect((mine.body as { value: { consoles: unknown[] } }).value.consoles).toHaveLength(1)
    const theirs = await call(api, 'console.list', { sessionId: 'session-b' })
    expect((theirs.body as { value: { consoles: unknown[] } }).value.consoles).toHaveLength(0)
  })

  it('describes one console with its audit trail', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'show version' })
    const described = await call(api, 'console.describe', { sessionId: 'session-a', consoleId })
    const value = (described.body as {
      value: { entry: { consoleId: string }, state: { audit: { action: string, detail: string }[] } }
    }).value
    expect(value.entry.consoleId).toBe(consoleId)
    expect(value.state.audit.some(entry => entry.action === 'send')).toBe(true)
  })

  it('hides another session console behind not-found', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const refused = await call(api, 'console.describe', { sessionId: 'session-b', consoleId })
    expect(refused.status).toBe(404)
  })
})

describe('console.send / console.read / console.waitFor', () => {
  it('sends a command and reads its answer back by cursor', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId

    const sent = await call(api, 'console.send', {
      sessionId: 'session-a',
      consoleId,
      text: 'show version',
      actor: 'model',
      submitKey: '\r',
    })
    expect(sent.status).toBe(200)
    expect((sent.body as { value: { written: number, aborted: boolean } }).value.aborted).toBe(false)

    const waited = await call(api, 'console.waitFor', {
      sessionId: 'session-a',
      consoleId,
      for: 'pattern',
      pattern: 'answer:show version',
      timeoutMs: 2000,
    })
    const waitValue = (waited.body as { value: { matched: boolean, matchedText?: string } }).value
    expect(waitValue.matched).toBe(true)

    const read = await call(api, 'console.read', { sessionId: 'session-a', consoleId, after: 0 })
    const readValue = (read.body as { value: { text: string, cursor: number, encoding: string } }).value
    expect(readValue.text).toContain('answer:show version')
    expect(readValue.cursor).toBeGreaterThan(0)
    expect(readValue.encoding).toBe('utf-8')

    // Reading from the returned cursor yields nothing new, so a poll loop is
    // not a busy re-read of the same bytes.
    const again = await call(api, 'console.read', { sessionId: 'session-a', consoleId, after: readValue.cursor })
    expect((again.body as { value: { text: string } }).value.text).toBe('')
  })

  it('sends without submitting when asked, and honours a custom submit key', async () => {
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'partial', submit: false })
    await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'done', submitKey: '\n' })
    // The device reads on its own schedule, so wait for both writes to land.
    await until(() => device.received.join('').includes('partialdone\n'))
    expect(device.received.join('')).toContain('partialdone\n')
  })

  it('reports a send to a closed console as session-gone', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    await call(api, 'console.close', { sessionId: 'session-a', consoleId, force: true })
    const refused = await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'x' })
    expect(refused.status).toBe(404)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'not-found' } })
  })

  it('decodes a read with a per-call encoding override', async () => {
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    device.sockets[0]?.write(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]))
    await new Promise(resolve => setTimeout(resolve, 50))
    const read = await call(api, 'console.read', { sessionId: 'session-a', consoleId, after: 0, encoding: 'gbk' })
    expect((read.body as { value: { text: string } }).value.text).toContain('你好')
    const bad = await call(api, 'console.read', { sessionId: 'session-a', consoleId, after: 0, encoding: 'rot13' })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ ok: false, error: { code: 'bad-encoding' } })
  })

  it('filters the echoed command when asked', async () => {
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    // A device that does not echo leaves the filter a no-op; the flag still has
    // to be accepted and the real answer must survive it.
    await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'show version' })
    // Wait for the answer to actually land before reading it.
    const waited = await call(api, 'console.waitFor', {
      sessionId: 'session-a',
      consoleId,
      for: 'pattern',
      pattern: 'answer:show version',
      timeoutMs: 2000,
    })
    expect((waited.body as { value: { matched: boolean } }).value.matched).toBe(true)
    const read = await call(api, 'console.read', {
      sessionId: 'session-a',
      consoleId,
      after: 0,
      stripEcho: 'show version',
    })
    expect(read.status).toBe(200)
    expect((read.body as { value: { text: string } }).value.text).toContain('answer:show version')
  })

  it('reports a wait timeout as a result, not an error', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const waited = await call(api, 'console.waitFor', {
      sessionId: 'session-a',
      consoleId,
      for: 'pattern',
      pattern: 'NEVER',
      timeoutMs: 80,
    })
    expect(waited.status).toBe(200)
    const value = (waited.body as { value: { matched: boolean, reason: string } }).value
    expect(value.matched).toBe(false)
    expect(value.reason).toBe('timeout')
  })

  it('refuses an uncompilable wait pattern with bad-request', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const waited = await call(api, 'console.waitFor', {
      sessionId: 'session-a',
      consoleId,
      for: 'pattern',
      pattern: '(',
      timeoutMs: 50,
    })
    expect(waited.status).toBe(400)
    expect(waited.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
})

describe('console.control / console.close', () => {
  it('clears the pager state on demand', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const controlled = await call(api, 'console.control', { sessionId: 'session-a', consoleId, action: 'drain' })
    expect(controlled.status).toBe(200)
    expect((controlled.body as { value: { paging: { active: boolean } } }).value.paging.active).toBe(false)
  })

  it('refuses an unknown control action', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const refused = await call(api, 'console.control', { sessionId: 'session-a', consoleId, action: 'explode' })
    expect(refused.status).toBe(400)
  })

  it('closes a console and drops it from the list', async () => {
    const { api, manager } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const closed = await call(api, 'console.close', { sessionId: 'session-a', consoleId })
    expect(closed.status).toBe(200)
    expect((closed.body as { value: { closed: boolean, consoleId: string } }).value.closed).toBe(true)
    expect(manager.list('session-a')).toHaveLength(0)
  })

  it('closes every console for a session in one call', async () => {
    const { api, manager } = await scene()
    await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    expect(manager.list('session-a')).toHaveLength(2)
    const closed = await call(api, 'console.closeAll', { sessionId: 'session-a', force: true })
    expect(closed.status).toBe(200)
    expect((closed.body as { value: { closed: number } }).value.closed).toBe(2)
    expect(manager.list('session-a')).toHaveLength(0)
  })
})

describe('panel-path high-risk fence', () => {
  it('sends a safe command without any confirmation', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const sent = await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'show version' })
    expect(sent.status).toBe(200)
  })

  it('refuses a high-risk command until the panel replays it with the token', async () => {
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId

    const refused = await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'config terminal' })
    expect(refused.status).toBe(403)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    // The refusal must name why, so the panel can show it before confirming.
    expect((refused.body as { error: { message: string } }).error.message).toMatch(/high-risk|high risk/)
    // Nothing reached the device.
    expect(device.received.join('')).not.toContain('config')

    const confirmed = await call(api, 'console.send', {
      sessionId: 'session-a',
      consoleId,
      text: 'config terminal',
      confirmToken: 'tok-config terminal',
    })
    expect(confirmed.status).toBe(200)
    await until(() => device.received.join('').includes('config terminal'))
    expect(device.received.join('')).toContain('config terminal')
  })

  it('refuses a confirmation token the fence did not mint', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const refused = await call(api, 'console.send', {
      sessionId: 'session-a',
      consoleId,
      text: 'restart',
      confirmToken: 'not-a-real-token',
    })
    expect(refused.status).toBe(403)
  })
})

describe('console id validation', () => {
  it('requires a consoleId on every console method', async () => {
    const { api } = await scene()
    for (const method of ['console.send', 'console.read', 'console.waitFor', 'console.describe', 'console.close']) {
      const refused = await call(api, method, { sessionId: 'session-a' })
      expect(refused.status).toBe(400)
      expect(refused.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
  })
})
