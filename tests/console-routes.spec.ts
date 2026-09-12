/**
 * Red-first suite for `src/console-routes.ts`: the console session half of the
 * API (`console.*`) plus the `session.describe` lookup. Driven against real
 * in-process TCP servers, so connect/send/read/wait/close go over real streams.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildConsoleRoutes, type ConsoleSessionApi } from '../src/console-routes.ts'
import { PortManager } from '../src/port-manager.ts'
import { DEFAULT_DORMANT_PATTERN, DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN } from '../src/config-shared.ts'
import type { ConsoleHttpRequest, ConsoleHttpResponse } from '../src/context-types.ts'

/** A device stub that echoes commands with a canned answer. */
interface Device {
  port: number
  sockets: Socket[]
  received: string[]
  close(): Promise<void>
}

/** Start a device that greets and answers each line. */
async function startDevice(
  answer: (line: string) => string = line => `answer:${line}`,
  options: {
    /**
     * Answer a bare Enter (a lone CR).
     *
     * Separate from `answer` because an empty line is skipped as "nothing was
     * typed", and a bare Enter is a distinct keystroke a real device answers with
     * its prompt. Without this hook a `console.wake` test would assert on a write
     * no device ever acknowledged -- which is precisely the unverified claim the
     * `answered` flag exists to prevent.
     */
    onBareEnter?: () => string | undefined
  } = {},
): Promise<Device> {
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
      if (options.onBareEnter !== undefined && text === '\r') {
        const reply = options.onBareEnter()
        if (reply !== undefined) socket.write(reply)
        return
      }
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
    dormantPattern: DEFAULT_DORMANT_PATTERN,
    dormantAutoWake: true,
    dormantProbeMs: 0,
    idleQuietMs: 250,
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
      // replays it with the one-shot token this minted. Safe commands pass, and
      // a command a `deny` rule forbids is refused with NO token at all.
      fenceForUser: ({ text }) => text.includes('erase')
        ? { risk: 'denied' as const, reason: `"${text}" is forbidden by the fence rule "never-erase"` }
        : text.includes('config') || text.includes('restart')
          ? { risk: 'high' as const, confirmationToken: `tok-${text}`, reason: `"${text}" is high risk` }
          : { risk: 'safe' as const },
      consumeConfirmation: (_sessionId, _consoleId, token) => token.startsWith('tok-'),
      // Wired the way the host wires it: a pass-through to the live manager, so
      // "what clearing means" has exactly one implementation.
      clear: (_sessionId, consoleId) => manager.clear(consoleId),
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
async function scene(
  answer?: (line: string) => string,
  options: { onBareEnter?: () => string | undefined } = {},
): Promise<{
  api: ConsoleSessionApi
  manager: PortManager
  device: Device
}> {
  const device = await startDevice(answer, options)
  const { api, manager } = apiFor()
  devices.push(device)
  managers.push(manager)
  // Point the view lookup at this device's port.
  api.viewOf = async (_sessionId, viewId) => (viewId === 'v-known'
    ? { viewId, name: 'FW1', host: '127.0.0.1', port: device.port, kind: 'raw', encoding: 'utf-8', user: '', promptPattern: '', pagerPattern: '', pagingMode: '', tags: [], notes: '' }
    : undefined)
  return { api, manager, device }
}

/**
 * A scene with TWO devices, reachable as `v-known` and `v-second`.
 *
 * Needed because a second connect to the SAME target now ATTACHES instead of
 * opening (a second TCP connection to one console-server port would evict the
 * first). So any test about "several consoles" has to mean several devices.
 *
 * @returns the API, the manager, and both devices.
 */
async function twoDeviceScene(): Promise<{
  api: ConsoleSessionApi
  manager: PortManager
  first: Device
  second: Device
}> {
  const first = await startDevice()
  const second = await startDevice()
  const { api, manager } = apiFor()
  devices.push(first, second)
  managers.push(manager)
  const view = (viewId: string, name: string, port: number): Record<string, unknown> => ({
    viewId, name, host: '127.0.0.1', port, kind: 'raw', encoding: 'utf-8',
    user: '', promptPattern: '', pagerPattern: '', pagingMode: '', tags: [], notes: '',
  })
  api.viewOf = async (_sessionId, viewId) => {
    if (viewId === 'v-known') return view(viewId, 'FW1', first.port) as never
    if (viewId === 'v-second') return view(viewId, 'SW1', second.port) as never
    return undefined
  }
  return { api, manager, first, second }
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
  it('lists the SHARED pool to any session, marking who opened each console', async () => {
    // The list is not session-filtered. Filtering is what made a console opened
    // by a since-dead session unreachable: the session check rejected every call
    // that named it, so nothing could list it in order to close it.
    const { api } = await scene()
    await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const mine = await call(api, 'console.list', { sessionId: 'session-a' })
    expect((mine.body as { value: { consoles: unknown[] } }).value.consoles).toHaveLength(1)

    const theirs = await call(api, 'console.list', { sessionId: 'session-b' })
    const rows = (theirs.body as { value: { consoles: { openedBy: string }[] } }).value.consoles
    expect(rows).toHaveLength(1)
    expect(rows[0]?.openedBy).toBe('session-a')
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

  it('describes and drives a console another session opened', async () => {
    // Shared means shared: another session may describe, read and write it. What
    // is asserted is that the access works AND that the trail records the attach,
    // so a shared link still has a history.
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId

    const described = await call(api, 'console.describe', { sessionId: 'session-b', consoleId })
    expect(described.status).toBe(200)
    expect((described.body as { value: { entry: { openedBy: string } } }).value.entry.openedBy).toBe('session-a')

    const sent = await call(api, 'console.send', { sessionId: 'session-b', consoleId, text: 'show clock' })
    expect(sent.status).toBe(200)
  })

  it('still reports a console id that does not exist as not-found', async () => {
    const { api } = await scene()
    const missing = await call(api, 'console.describe', { sessionId: 'session-a', consoleId: 'c-nope' })
    expect(missing.status).toBe(404)
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

  it('accepts an EMPTY send: it presses Enter, which is the wake keystroke', async () => {
    // The route used to answer `bad-request` for `text: ''`, which made the one
    // action a dormant console needs the one action the API would not carry --
    // while the model's own tool path allowed it.
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId

    const sent = await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: '' })
    expect(sent.status).toBe(200)
    // The device receives exactly one CR (the host appends the submit key) and
    // no command text at all.
    await until(() => device.received.join('').includes('\r'))
    expect(device.received.join('')).toContain('\r')
  })

  it('accepts an omitted text as an empty send', async () => {
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const sent = await call(api, 'console.send', { sessionId: 'session-a', consoleId })
    expect(sent.status).toBe(200)
    await until(() => device.received.join('').includes('\r'))
  })

  it('sends whitespace byte for byte instead of trimming it', async () => {
    // A single space is a pager's next-page key. Trimming it would send the
    // NEWLINE instead and page nowhere -- a silent wrong action.
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const sent = await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: ' ' })
    expect(sent.status).toBe(200)
    await until(() => device.received.join('').includes(' \r'))
    expect(device.received.join('')).toContain(' \r')
  })

  it('still refuses a non-string text', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const refused = await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 42 })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('wakes a console through console.wake and through the control action', async () => {
    // The device answers a bare Enter with its prompt -- the lab behaviour -- so
    // `answered: true` here means the device really acknowledged the keystroke,
    // not merely that a write was issued.
    const { api, device } = await scene(undefined, { onBareEnter: () => '\r\n<DUT1>' })
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId

    const before = device.received.length
    const woken = await call(api, 'console.wake', { sessionId: 'session-a', consoleId })
    expect(woken.status).toBe(200)
    const value = (woken.body as { value: { answered: boolean, dormant: boolean } }).value
    expect(value.answered).toBe(true)
    expect(value.dormant).toBe(false)
    // Exactly one CR reached the device: no command text rides along with a wake.
    await until(() => device.received.slice(before).join('').includes('\r'))
    expect(device.received.slice(before).join('')).toBe('\r')

    const viaControl = await call(api, 'console.control', { sessionId: 'session-a', consoleId, action: 'wake' })
    expect(viaControl.status).toBe(200)
    expect((viaControl.body as { value: { answered: boolean } }).value.answered).toBe(true)
  })

  it('reports a wake nobody answered honestly', async () => {
    // No `onBareEnter`: the device ignores the Enter, as one whose port is held
    // by another session would. Claiming recovery here would leave a caller
    // waiting on a console nobody is listening to.
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const woken = await call(api, 'console.wake', { sessionId: 'session-a', consoleId })
    expect(woken.status).toBe(200)
    expect((woken.body as { value: { answered: boolean } }).value.answered).toBe(false)
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
    expect(manager.list()).toHaveLength(0)
  })

  it('clears a console scrollback without closing the connection', async () => {
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId

    // Produce something worth clearing, then wait until the ANSWER is readable.
    // The device replies asynchronously, so a read issued right after the send
    // would race it and see only the greeting -- and a clear with nothing to
    // drop would pass the assertions below for the wrong reason.
    await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'before-clear' })
    const readOnce = async (): Promise<{ text: string, cursor: number }> => {
      const response = await call(api, 'console.read', { sessionId: 'session-a', consoleId, after: 0 })
      return (response.body as { value: { text: string, cursor: number } }).value
    }
    let before = await readOnce()
    const deadline = Date.now() + 2000
    while (!before.text.includes('before-clear') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      before = await readOnce()
    }
    expect(before.text).toContain('before-clear')

    const cleared = await call(api, 'console.clear', { sessionId: 'session-a', consoleId })
    expect(cleared.status).toBe(200)
    const value = (cleared.body as { value: { cursor: number, droppedBytes: number } }).value
    // Bytes really were dropped, and the caller is told where to resume.
    expect(value.droppedBytes).toBeGreaterThan(0)
    expect(value.cursor).toBeGreaterThanOrEqual(before.cursor)

    // The discarded text is no longer readable from the old cursor...
    const after = await call(api, 'console.read', { sessionId: 'session-a', consoleId, after: 0 })
    expect((after.body as { value: { text: string } }).value.text).not.toContain('before-clear')

    // ...and the console is STILL OPEN: the device socket was never touched.
    const list = await call(api, 'console.list', { sessionId: 'session-a' })
    const rows = (list.body as { value: { consoles: { consoleId: string, state: string }[] } }).value.consoles
    expect(rows.find(row => row.consoleId === consoleId)?.state).toBe('open')

    // The device is still usable: a command sent now still reaches it.
    await call(api, 'console.send', { sessionId: 'session-a', consoleId, text: 'after-clear' })
    await until(() => device.received.some(line => line.includes('after-clear')))
  })

  it('reports not-supported when the deployment composes no clear capability', async () => {
    // Distinct from `not-found`: the console EXISTS, this build simply cannot
    // clear it. Answering not-found would send a caller hunting for a console
    // that is sitting right there.
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    delete api.clear
    const refused = await call(api, 'console.clear', { sessionId: 'session-a', consoleId })
    expect(refused.status).toBe(501)
    expect(refused.body).toMatchObject({ ok: false, error: { code: 'not-supported' } })
  })

  it('closes the WHOLE pool in one call, whichever session opened what', async () => {
    // Two devices, opened by two different sessions: `closeAll` is not scoped to
    // a caller, because with one shared pool there is no "my consoles" left. The
    // count is what tells the operator how much device access was released.
    const { api, manager } = await twoDeviceScene()
    await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    await call(api, 'console.connect', { sessionId: 'session-b', viewId: 'v-second' })
    expect(manager.list()).toHaveLength(2)
    const closed = await call(api, 'console.closeAll', { sessionId: 'session-a' })
    expect(closed.status).toBe(200)
    expect((closed.body as { value: { closed: number } }).value.closed).toBe(2)
    expect(manager.list()).toHaveLength(0)
  })

  it('reports a reused connect so the caller knows it attached', async () => {
    // The panel focuses the existing console instead of implying a second device
    // link was made, and the model is told the console may already be under
    // another session's control.
    const { api } = await scene()
    const first = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const opened = (first.body as { value: { consoleId: string, reused: boolean, openedBy: string } }).value
    expect(opened.reused).toBe(false)
    expect(opened.openedBy).toBe('session-a')

    const second = await call(api, 'console.connect', { sessionId: 'session-b', viewId: 'v-known' })
    const attached = (second.body as { value: { consoleId: string, reused: boolean, openedBy: string } }).value
    expect(attached.reused).toBe(true)
    expect(attached.consoleId).toBe(opened.consoleId)
    expect(attached.openedBy).toBe('session-a')
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

  it('refuses a DENIED command even when a valid-looking token is replayed', async () => {
    // The hard block through the panel's own path. A `deny` mints no token, so
    // there is nothing to replay -- and the route must not fall through to the
    // "confirmed" branch on a token it happens to recognise. This is the
    // difference between a deny and an ask, and it is the whole reason `denied`
    // is a separate arm rather than a flavour of `high`.
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId

    const replayed = await call(api, 'console.send', {
      sessionId: 'session-a',
      consoleId,
      text: 'erase startup-config',
      // A token the fake's `consumeConfirmation` WOULD accept, so this proves the
      // denial is checked before any token is considered.
      confirmToken: 'tok-erase startup-config',
    })
    expect(replayed.status).toBe(403)
    expect(replayed.body).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect((replayed.body as { error: { message: string } }).error.message).toMatch(/never-erase/)
    // Nothing reached the device.
    expect(device.received.join('')).not.toContain('erase')
  })

  it('reports a denial from the pre-flight fence, so the panel never offers a confirm button', async () => {
    const { api } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId
    const fenced = await call(api, 'console.fence', { sessionId: 'session-a', consoleId, text: 'erase startup-config' })
    expect(fenced.status).toBe(200)
    const value = (fenced.body as { value: { risk: string, confirmationToken?: string } }).value
    expect(value.risk).toBe('denied')
    // No token, because a denial that carried one is a denial a user could click
    // past.
    expect(value.confirmationToken).toBeUndefined()
  })


  it('lets the panel learn the risk before it writes anything', async () => {
    // The refusal path is not enough on its own: the 403 carries a message but
    // no token, so a panel that only ever calls `console.send` can never obtain
    // the confirmation it needs to replay. `console.fence` answers the same
    // question as a pure pre-flight, and mints the token the panel replays.
    const { api, device } = await scene()
    const connected = await call(api, 'console.connect', { sessionId: 'session-a', viewId: 'v-known' })
    const consoleId = (connected.body as { value: { consoleId: string } }).value.consoleId

    const safe = await call(api, 'console.fence', { sessionId: 'session-a', consoleId, text: 'show version' })
    expect(safe.status).toBe(200)
    expect(safe.body).toMatchObject({ ok: true, value: { risk: 'safe' } })

    const risky = await call(api, 'console.fence', { sessionId: 'session-a', consoleId, text: 'config terminal' })
    expect(risky.status).toBe(200)
    expect(risky.body).toMatchObject({
      ok: true,
      value: { risk: 'high', confirmationToken: 'tok-config terminal' },
    })
    expect((risky.body as { value: { reason: string } }).value.reason).toMatch(/high risk/)

    // Pre-flight is a question, not an action: the device saw nothing.
    expect(device.received.join('')).not.toContain('show version')
    expect(device.received.join('')).not.toContain('config')
  })

  it('answers console.fence for a console it does not own as not-found', async () => {
    const { api } = await scene()
    const refused = await call(api, 'console.fence', {
      sessionId: 'session-a',
      consoleId: 'c0000000000000000000000000000000',
      text: 'show version',
    })
    expect(refused.status).toBe(404)
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
