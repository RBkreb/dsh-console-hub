/**
 * Red-first suite for `src/session.ts`: one console connection, driven against
 * a REAL in-process TCP server (no mocked sockets), so the paging, timeout,
 * encoding, and teardown behaviour is exercised over real streams.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ConsoleSession, type ConsoleSessionState } from '../src/session.ts'
import { DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN, compilePattern } from '../src/config-shared.ts'
import { IAC, DO, WILL } from '../src/session-codec.ts'

/** A fake serial server: it answers a connect with negotiations and a prompt. */
interface FakeConsole {
  port: number
  /** Everything the client wrote, per connection, as UTF-8 text. */
  readonly received: string[]
  /** Raw bytes the client wrote (for IAC assertions), per connection. */
  readonly receivedBytes: Buffer[]
  /** Push raw bytes to every open connection. */
  push(data: Uint8Array | string): void
  /** Push bytes to the most recent connection only (what a command answers). */
  pushToLast(data: Uint8Array | string): void
  /** Close every open connection from the server side. */
  hangup(): void
  /** Number of connections accepted so far. */
  readonly connections: number
  close(): Promise<void>
}

/** Start a fake console server. */
async function startFakeConsole(options: {
  /** Bytes sent immediately on connect (the negotiation storm + banner). */
  greeting?: Uint8Array | string
  /** Answer each received line with this callback's return value. */
  onLine?: (line: string, index: number) => string | Uint8Array | undefined
} = {}): Promise<FakeConsole> {
  const received: string[] = []
  const receivedBytes: Buffer[] = []
  const sockets = new Set<Socket>()
  let accepted = 0
  const server: Server = createServer((socket) => {
    accepted += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk: Buffer) => {
      receivedBytes.push(chunk)
      const text = chunk.toString('utf8')
      received.push(text)
      if (options.onLine === undefined) return
      for (const line of text.split(/\r?\n/)) {
        if (line === '') continue
        const answer = options.onLine(line, received.length)
        if (answer !== undefined) socket.write(answer)
      }
    })
    if (options.greeting !== undefined) socket.write(options.greeting as never)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake console: no port')
  return {
    port: address.port,
    received,
    receivedBytes,
    push(data) {
      for (const socket of sockets) socket.write(data as never)
    },
    pushToLast(data) {
      const last = [...sockets].at(-1)
      last?.write(data as never)
    },
    hangup() {
      for (const socket of sockets) socket.destroy()
    },
    get connections() {
      return accepted
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Build a session pointed at a fake server, with test-friendly timings. */
function sessionFor(
  server: FakeConsole,
  overrides: Partial<ConstructorParameters<typeof ConsoleSession>[0]> = {},
): ConsoleSession {
  return new ConsoleSession({
    host: '127.0.0.1',
    port: server.port,
    kind: 'telnet',
    encoding: 'utf-8',
    connectTimeoutMs: 2000,
    readTimeoutMs: 300,
    pagingMode: 'auto-more',
    pagingMaxPages: 5,
    pagingQuietMs: 20,
    promptPattern: compilePattern(DEFAULT_PROMPT_PATTERN),
    pagerPattern: compilePattern(DEFAULT_PAGER_PATTERN),
    scrollbackLimitBytes: 64 * 1024,
    ...overrides,
  })
}

/** Poll a predicate until it holds or the budget runs out. */
async function until(predicate: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Wait for a fixed number of milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const open: ConsoleSession[] = []
const servers: FakeConsole[] = []

/** Track a session and server so every test cleans up even when it fails. */
function track(session: ConsoleSession, server: FakeConsole): ConsoleSession {
  open.push(session)
  servers.push(server)
  return session
}

afterEach(async () => {
  for (const session of open.splice(0)) await session.dispose()
  for (const server of servers.splice(0)) await server.close()
})

describe('ConsoleSession connect', () => {
  it('reaches open, strips the negotiation storm and finds the prompt', async () => {
    const storm = new Uint8Array([
      IAC, DO, 24, 0x20, IAC, WILL, 1, 0x20,
      ...Buffer.from('\r\n<DUT1>', 'utf8'),
    ])
    const server = await startFakeConsole({ greeting: storm })
    const session = track(sessionFor(server), server)

    const connected = await session.open()
    expect(connected.state).toBe('open')
    // The banner must not contain the telnet control bytes; the prompt is
    // recognized from the cleaned text.
    expect(connected.banner).not.toMatch(/\u00ff/)
    expect(connected.banner).toContain('<DUT1>')
    expect(connected.prompt).toBe('<DUT1>')
    expect(connected.encoding).toBe('utf-8')

    // The negotiation reply refused the options (WONT/DONT), so the server
    // stops asking.
    await until(() => server.receivedBytes.length > 0 || server.received.length > 0)
    const written = Buffer.concat(server.receivedBytes)
    expect([...written].slice(0, 2)).toEqual([IAC, 252])
  })

  it('reports a refused connection with a machine code', async () => {
    // A server that is closed immediately gives us a port nothing listens on.
    const server = await startFakeConsole()
    const port = server.port
    await server.close()
    servers.push({ ...server, close: async () => {} })
    const session = track(sessionFor({ ...server, port }), { ...server, close: async () => {} })

    const failed = await session.open()
    expect(['error', 'closed']).toContain(failed.state)
    expect(failed.lastError?.code).toBe('ECONNREFUSED')
    expect(failed.lastError?.message).toMatch(/refused|connect/i)
  })

  it('is idempotent: opening twice keeps one connection', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await session.open()
    expect(server.connections).toBe(1)
  })
})

describe('ConsoleSession send / read', () => {
  it('writes the encoded command with the chosen submit key', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await session.send('show version', { submitKey: '\r\n' })
    await until(() => server.received.join('').includes('show version'))
    expect(server.received.join('')).toContain('show version\r\n')
  })

  it('reads incrementally by cursor so nothing is read twice', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()

    server.push('\r\nfirst\r\n')
    await until(() => session.read({ after: 0 }).text.includes('first'))
    const first = session.read({ after: 0 })
    expect(first.text).toContain('first')

    // Reading again from the returned cursor yields only what arrived after.
    server.push('second\r\n')
    await until(() => session.read({ after: first.cursor }).text.includes('second'))
    const second = session.read({ after: first.cursor })
    expect(second.text).toContain('second')
    expect(second.text).not.toContain('first')
  })

  it('decodes with a per-call encoding override', async () => {
    const server = await startFakeConsole({ greeting: '<SW1>' })
    const session = track(sessionFor(server, { encoding: 'utf-8' }), server)
    await session.open()
    // Real GBK bytes for 你好 (the same sequence the codec suite verifies), so
    // the override is exercised against the wire rather than a string round-trip.
    server.push(new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]))
    await until(() => session.read({ after: 0, encoding: 'gbk' }).text.includes('你好'))
    expect(session.read({ after: 0, encoding: 'gbk' }).text).toContain('你好')
    // The session's own encoding is unchanged by a per-call override.
    expect(session.read({ after: 0 }).encoding).toBe('utf-8')
    // And reading those bytes as UTF-8 is what the substitution policy is for:
    // it returns text rather than throwing.
    expect(session.read({ after: 0, encoding: 'utf-8' }).text).toContain('\uFFFD')
  })

  it('filters the echoed command when asked', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await session.send('show version')
    // A real console echoes what was typed.
    server.push('\r\nshow version\r\nVersion 1.2.3\r\n<DUT1>')
    await until(() => session.read({ after: 0, stripEcho: 'show version' }).text.includes('Version'))
    const read = session.read({ after: 0, stripEcho: 'show version' })
    expect(read.text).toContain('Version 1.2.3')
    expect(read.text).not.toContain('show version')
  })

  it('reports the prompt found in a read', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    server.push('\r\nVersion 1.2.3\r\n<DUT1>')
    await until(() => session.read({ after: 0 }).prompt === '<DUT1>')
    expect(session.read({ after: 0 }).prompt).toBe('<DUT1>')
  })

  it('bounds the returned text and says so', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { outputLimitBytes: 64 }), server)
    await session.open()
    server.push(`${'A'.repeat(500)}\r\n<DUT1>`)
    await until(() => session.read({ after: 0 }).bytes >= 64)
    const read = session.read({ after: 0 })
    expect(read.truncated).toBe(true)
    expect(Buffer.byteLength(read.text, 'utf8')).toBeLessThanOrEqual(64)
    // Truncation never splits a multi-byte sequence.
    expect(read.text).not.toContain('\uFFFD')
  })
})

describe('ConsoleSession paging', () => {
  it('advances a pager automatically, one page at a time', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()

    // Two pages then the real prompt. The server answers each space with the
    // next page, exactly like a device honoring "next page".
    let pages = 0
    server.push('\r\npage one\r\n--More--')
    await until(() => session.status().paging.pagesConsumed >= 1 || session.status().paging.active)
    await until(() => server.received.join('').includes(' '))
    pages += 1
    server.push('\r\npage two\r\n--More--')
    await until(() => server.received.join('').split(' ').length >= 3 || session.status().paging.pagesConsumed >= 2)
    server.push('\r\nend of output\r\n<DUT1>')

    await until(() => session.read({ after: 0 }).text.includes('end of output'))
    const read = session.read({ after: 0 })
    expect(read.text).toContain('page one')
    expect(read.text).toContain('page two')
    expect(read.text).toContain('end of output')
    expect(read.paging.pagesConsumed).toBeGreaterThanOrEqual(2)
    expect(pages).toBe(1)
  })

  it('stops at pagingMaxPages and reports the reason', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { pagingMaxPages: 2 }), server)
    await session.open()
    // Every page ends in another pager, so the safety valve must fire.
    for (let index = 0; index < 6; index += 1) {
      server.push(`\r\npage ${index}\r\n--More--`)
      await wait(30)
    }
    await until(() => session.status().paging.reason === 'max-pages')
    const status = session.status()
    expect(status.paging.pagesConsumed).toBeLessThanOrEqual(2)
    expect(status.paging.active).toBe(true)
  })

  it('sends q for auto-quit and Ctrl+C for auto-interrupt', async () => {
    for (const [mode, expected] of [['auto-quit', 'q'], ['auto-interrupt', '\u0003']] as const) {
      const server = await startFakeConsole({ greeting: '<DUT1>' })
      const session = track(sessionFor(server, { pagingMode: mode }), server)
      await session.open()
      server.push('\r\nlines\r\n--More--')
      await until(() => server.received.join('').includes(expected))
      expect(server.received.join('')).toContain(expected)
      // The pager was abandoned, so the mode is recorded as satisfied rather
      // than left pending.
      expect(session.status().paging.active).toBe(false)
    }
  })

  it('leaves the pager to the caller in manual mode', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { pagingMode: 'manual' }), server)
    await session.open()
    server.push('\r\nlines\r\n--More--')
    await until(() => session.status().paging.active)
    expect(session.status().paging.active).toBe(true)
    expect(session.status().paging.pagesConsumed).toBe(0)
    // Nothing was written on the session's own initiative.
    expect(server.received.join('')).not.toContain(' ')
  })
})

describe('ConsoleSession lifecycle', () => {
  it('closes gracefully and reports the terminal state', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    const closed = await session.close()
    expect(closed.state).toBe('closed')
    expect(closed.closedAt).not.toBeNull()
  })

  it('force-closes a session the peer is holding open', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    const closed = await session.close({ force: true })
    expect(closed.state).toBe('closed')
  })

  it('is idempotent on repeated close and dispose', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await session.close()
    await session.close()
    await session.dispose()
    await session.dispose()
    expect(session.status().state).toBe('closed')
  })

  it('records a peer hangup as closed-with-reason instead of throwing', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    server.hangup()
    await until(() => session.status().state === 'closed')
    const status: ConsoleSessionState = session.status()
    expect(status.state).toBe('closed')
    expect(status.lastError?.code).toBe('peer-closed')
    // Writing to a dead console is a clean error, not an unhandled rejection.
    await expect(session.send('show version')).rejects.toThrow(/closed/i)
  })

  it('keeps the audit trail of who did what', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await session.send('show version', { actor: 'model' })
    const audit = session.status().audit
    expect(audit.some(entry => entry.action === 'connect')).toBe(true)
    const sent = audit.find(entry => entry.action === 'send')
    expect(sent?.actor).toBe('model')
    expect(sent?.detail).toContain('show version')
  })

  it('never keeps a secret in the audit trail or the status', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { password: 'super-secret' }), server)
    await session.open()
    expect(JSON.stringify(session.status())).not.toContain('super-secret')
  })

  it('treats a silent peer as a usable raw console', async () => {
    // A server that accepts the TCP handshake and then says nothing: legal for a
    // raw mapping, so a read reports no new data instead of hanging.
    const sockets: Socket[] = []
    const silent = createServer((socket) => { sockets.push(socket) })
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    const address = silent.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    const session = new ConsoleSession({
      host: '127.0.0.1',
      port: address.port,
      kind: 'raw',
      encoding: 'utf-8',
      connectTimeoutMs: 500,
      readTimeoutMs: 50,
      pagingMode: 'manual',
      pagingMaxPages: 5,
      pagingQuietMs: 20,
      promptPattern: compilePattern(DEFAULT_PROMPT_PATTERN),
      pagerPattern: compilePattern(DEFAULT_PAGER_PATTERN),
      scrollbackLimitBytes: 4096,
      bannerWindowMs: 100,
    })
    open.push(session)
    const result = await session.open()
    expect(result.state).toBe('open')
    expect(result.banner).toBe('')
    expect(result.prompt).toBeNull()
    expect(session.read({ after: 0 }).text).toBe('')
    // `close()` waits for open connections, so drop them first — the same
    // teardown order the real host uses.
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => silent.close(() => resolve()))
  })

  it('settles on an unreachable peer instead of hanging', async () => {
    // TEST-NET-1 (RFC 5737) is guaranteed not to be a real host, so the connect
    // must settle with a coded failure rather than block forever.
    const session = new ConsoleSession({
      host: '192.0.2.1',
      port: 10003,
      kind: 'raw',
      encoding: 'utf-8',
      connectTimeoutMs: 300,
      readTimeoutMs: 50,
      pagingMode: 'manual',
      pagingMaxPages: 5,
      pagingQuietMs: 20,
      promptPattern: compilePattern(DEFAULT_PROMPT_PATTERN),
      pagerPattern: compilePattern(DEFAULT_PAGER_PATTERN),
      scrollbackLimitBytes: 4096,
    })
    open.push(session)
    const result = await session.open()
    expect(['error', 'closed']).toContain(result.state)
    expect(result.lastError?.code).toBeTruthy()
    expect(result.lastError?.message).not.toBe('')
  })
})
