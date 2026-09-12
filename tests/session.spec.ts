/**
 * Red-first suite for `src/session.ts`: one console connection, driven against
 * a REAL in-process TCP server (no mocked sockets), so the paging, timeout,
 * encoding, and teardown behaviour is exercised over real streams.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ConsoleSession, type ConsoleSessionState } from '../src/session.ts'
import {
  DEFAULT_DORMANT_PATTERN,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
  compilePattern,
  compileSearchPattern,
} from '../src/config-shared.ts'
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
  /**
   * Answer a bare Enter (a lone CR).
   *
   * A real console that stays silent until a key is pressed answers exactly
   * this way, so the fake needs the same hook: `onLine` cannot express it,
   * because an empty line is skipped as "nothing was typed".
   */
  onBareEnter?: () => string | Uint8Array | undefined
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
      if (text === '\r' && options.onBareEnter !== undefined) {
        const answer = options.onBareEnter()
        if (answer !== undefined) socket.write(answer as never)
        return
      }
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
    dormantPattern: compileSearchPattern(DEFAULT_DORMANT_PATTERN),
    dormantAutoWake: true,
    // The keepalive is OFF for the fixture and opted into per test: a timer
    // armed 120s out makes a `beforeEach` cheap but a suite's timing depend on
    // whether some unrelated test ran long enough to fire it. The tests that
    // exercise the keepalive set a small value explicitly.
    dormantProbeMs: 0,
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

  it('wakes a silent console: the lab devices say nothing until Enter', async () => {
    // Both lab devices (a DPtech firewall and switch) send only the Telnet
    // negotiation burst and then stay completely silent -- no banner, no
    // prompt -- until something is typed. A caller that just waits for a
    // prompt therefore never gets one, and the model has no signal at all.
    // Pressing Enter once turns the console into an ordinary `--More--`-paging
    // CLI, so `wakeOnConnect` exists to do exactly that.
    const server = await startFakeConsole({
      greeting: Buffer.from([IAC, WILL, 1, IAC, WILL, 3]),
      onBareEnter: () => '\r\n<DUT1>',
    })
    const session = track(sessionFor(server, { wakeOnConnect: true, bannerWindowMs: 800 }), server)

    const connected = await session.open()
    expect(connected.state).toBe('open')
    // The bare Enter reached the device...
    expect(server.receivedBytes.length).toBeGreaterThan(0)
    expect(Buffer.concat(server.receivedBytes).toString('utf8')).toContain('\r')
    // ...and the prompt it produced is what the connect reports.
    expect(connected.prompt).toBe('<DUT1>')
    expect(connected.banner).toContain('<DUT1>')
  })

  it('does not wake a device that already spoke', async () => {
    // A device that greets on connect must not receive an unsolicited Enter:
    // on some CLIs that is a real keystroke with consequences.
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { wakeOnConnect: true }), server)
    const connected = await session.open()
    expect(connected.prompt).toBe('<DUT1>')
    expect(server.receivedBytes.join('')).not.toContain('\r')
  })

  it('leaves a silent console silent when waking is not requested', async () => {
    const server = await startFakeConsole({ greeting: Buffer.from([IAC, WILL, 1]) })
    const session = track(sessionFor(server, { bannerWindowMs: 150 }), server)
    const connected = await session.open()
    expect(connected.state).toBe('open')
    // Nothing was typed, so nothing came back -- a legal raw console.
    expect(connected.prompt).toBeNull()
    const written = Buffer.concat(server.receivedBytes)
    // Only the negotiation reply (IAC DONT), never a carriage return.
    expect(written.toString('utf8')).not.toContain('\r')
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

  it('clears the local scrollback without touching the connection', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    server.push('\r\nnoise before\r\n')
    await until(() => session.read({ after: 0 }).text.includes('noise before'))

    const cleared = session.clear()
    expect(cleared.droppedBytes).toBeGreaterThan(0)
    // Already-read output is gone...
    expect(session.read({ after: 0 }).text).not.toContain('noise before')
    // ...and the returned cursor is where the next read should start.
    expect(session.read({ after: cleared.cursor }).text).toBe('')

    // The SOCKET is untouched: the session is still open and still answers.
    expect(session.status().state).toBe('open')
    server.push('after clear\r\n')
    await until(() => session.read({ after: cleared.cursor }).text.includes('after clear'))
  })

  it('forgets a prompt that described cleared output', async () => {
    // `waitFor` matches on the retained tail. A prompt left over from output
    // that no longer exists would keep answering `matched` for a prompt the
    // reader cannot see -- so clearing drops it.
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await until(() => session.status().prompt === '<DUT1>')
    session.clear()
    expect(session.status().prompt).toBeNull()
  })

  it('resets paging state so a cleared page prompt cannot strand the reader', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { pagingMode: 'manual' }), server)
    await session.open()
    server.push('\r\nline\r\n--More--')
    await until(() => session.read({ after: 0 }).paging.active)
    session.clear()
    // The pager described discarded output; a page that cannot be answered must
    // not stay "active".
    expect(session.read({ after: 0 }).paging.active).toBe(false)
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

  it('keeps an answer that merely CONTAINS the echoed command', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await session.send('show version')
    // The device echoes the command, then answers with a line that contains the
    // same text. Line-exact filtering drops the echo and keeps the answer; a
    // naive substring removal would corrupt the answer into nothing.
    server.push('\r\nshow version\r\ncommand: show version\r\n<DUT1>')
    await until(() => session.read({ after: 0, stripEcho: 'show version' }).text.includes('command:'))
    const read = session.read({ after: 0, stripEcho: 'show version' })
    expect(read.text).toContain('command: show version')
    expect(read.text.split('\n').filter(line => line.trim() === 'show version')).toHaveLength(0)
  })

  it('treats an empty echo filter as a no-op', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    server.push('\r\nshow version\r\n<DUT1>')
    await until(() => session.read({ after: 0, stripEcho: '' }).text.includes('show version'))
    expect(session.read({ after: 0, stripEcho: '' }).text).toContain('show version')
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

  it('reports a pager the caller may act on via waitFor too', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { pagingMode: 'manual' }), server)
    await session.open()
    server.push('\r\nlines\r\n--More--')
    // The pager stays pending, so a read says so.
    await until(() => session.read({ after: 0 }).paging.active)
    expect(session.read({ after: 0 }).pager).toBe('--More--')
    // Discharging it (as the panel's "next page" button does) clears the flag.
    await session.send('', { submit: false })
    expect(session.status().paging.active).toBe(false)
  })

  it('advances the pager for the caller on demand', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { pagingMode: 'manual' }), server)
    await session.open()
    server.push('\r\nlines\r\n--More--')
    await until(() => session.status().paging.active)
    // The panel's "next page" button is a bare space, not a command line.
    await session.send(' ', { submit: false })
    await until(() => server.received.join('').includes(' '))
    expect(server.received.join('')).toContain(' ')
    expect(session.status().paging.active).toBe(false)
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

  it('blocks on waitFor until the prompt returns', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await session.send('show version')
    // The answer arrives a moment later; waitFor must resolve on it rather than
    // making the caller poll.
    setTimeout(() => server.push('\r\nVersion 1.2.3\r\n<DUT1>'), 60)
    const waited = await session.waitFor({ for: 'prompt', timeoutMs: 2000 })
    expect(waited.matched).toBe(true)
    expect(waited.reason).toBe('matched')
    expect(waited.matchedText).toBe('<DUT1>')
    expect(waited.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('waits for a custom pattern and for quiet output', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await session.send('show version')
    setTimeout(() => server.push('\r\nERROR: something broke\r\n'), 40)
    const byPattern = await session.waitFor({ for: 'pattern', pattern: 'ERROR:.*', timeoutMs: 2000 })
    expect(byPattern.matched).toBe(true)
    expect(byPattern.matchedText).toContain('ERROR')

    setTimeout(() => server.push('\r\ntrailing whisper\r\n'), 40)
    const byIdle = await session.waitFor({ for: 'idle', idleMs: 150, timeoutMs: 2000 })
    expect(byIdle.matched).toBe(true)
    expect(byIdle.reason).toBe('matched')
  })

  it('reports a timeout rather than hanging when nothing arrives', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    const waited = await session.waitFor({ for: 'pattern', pattern: 'NEVER-APPEARS', timeoutMs: 120 })
    expect(waited.matched).toBe(false)
    expect(waited.reason).toBe('timeout')
    expect(waited.elapsedMs).toBeGreaterThanOrEqual(100)
  })

  it('wakes a waiter when the session closes under it', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    // Wait from the current end of the window, so the greeting prompt that is
    // already there cannot satisfy the condition.
    const after = session.read({ after: 0 }).cursor
    setTimeout(() => server.hangup(), 40)
    const waited = await session.waitFor({ for: 'prompt', after, timeoutMs: 3000 })
    expect(waited.matched).toBe(false)
    expect(waited.reason).toBe('closed')
  })

  it('rejects an uncompilable wait pattern instead of silently never matching', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server), server)
    await session.open()
    await expect(session.waitFor({ for: 'pattern', pattern: '(', timeoutMs: 50 })).rejects.toThrow()
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
      dormantPattern: compileSearchPattern(DEFAULT_DORMANT_PATTERN),
      dormantAutoWake: true,
      dormantProbeMs: 0,
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
      dormantPattern: compileSearchPattern(DEFAULT_DORMANT_PATTERN),
      dormantAutoWake: true,
      dormantProbeMs: 0,
      scrollbackLimitBytes: 4096,
    })
    open.push(session)
    const result = await session.open()
    expect(['error', 'closed']).toContain(result.state)
    expect(result.lastError?.code).toBeTruthy()
    expect(result.lastError?.message).not.toBe('')
  })
})

/**
 * The half-close a device performs on an idle console.
 *
 * Measured against the real lab hardware (see `scripts/probe-dormant.mjs`, which
 * produced this verbatim): after exactly 300s of silence the device prints
 *
 *     \r\nVty connection is timed out.\r\n\r\nPlease press ENTER.
 *
 * and then goes completely quiet -- no device events, no command output -- while
 * the TCP connection stays up. The fake below reproduces that, because the whole
 * failure mode is "the socket is fine and the console is dead".
 */
describe('ConsoleSession dormancy', () => {
  /** The marker, byte for byte as the real device emits it. */
  const MARKER = '\r\nVty connection is timed out.\r\n\r\nPlease press ENTER.'

  it('detects the marker, wakes the device, and reports the recovery', async () => {
    // The fake starts silent: it does NOT greet, because a device that has just
    // half-closed the session prints nothing at all until a key arrives.
    let awake = false
    const server = await startFakeConsole({
      greeting: '<DUT1>',
      onBareEnter: () => {
        // This is the essential half of the fake: the device answers the wake
        // Enter and NOTHING ELSE. A fake that answered every write would let a
        // broken implementation pass by waking on some other byte.
        if (awake) return '<DUT1>'
        awake = true
        return '\r\n<DUT1>'
      },
    })
    const session = track(sessionFor(server, { dormantAutoWake: true }), server)
    await session.open()
    await until(() => session.status().prompt !== null)

    // The device half-closes: the marker arrives, and from now on it ignores
    // everything except a bare Enter.
    awake = false
    const writesBefore = server.received.length
    server.push(MARKER)

    // Detection is the session's own job -- it happens on the data path, without
    // anybody reading, because the device's EVENTS are what stopped.
    await until(() => session.status().dormancy.dormant)
    expect(session.status().dormancy.marker).toContain('Please press ENTER')
    expect(session.status().dormancy.detectedAt).not.toBeNull()

    // And the automatic wake recovers it without a caller doing anything.
    await until(() => session.status().dormancy.dormant === false)
    const status = session.status()
    expect(status.dormancy.wakesSent).toBe(1)
    // A keepalive would have counted itself separately; this was a recovery.
    expect(status.dormancy.keepalivesSent).toBe(0)
    const written = server.received.slice(writesBefore).join('')
    expect(written).toBe('\r')
  })

  it('does NOT claim recovery when the device stays silent', async () => {
    // A device that ignores the Enter entirely -- a port held by another
    // session, say. Reporting `dormant: false` here would be a lie that leaves a
    // caller waiting on a console nobody is listening to.
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { dormantAutoWake: false }), server)
    await session.open()
    server.push('\r\nVty connection is timed out.\r\n\r\nPlease press ENTER.')
    await until(() => session.isDormant())

    // `dormantAutoWake: false` means detection only; the explicit wake is the
    // caller's, and it must report honestly.
    const answered = await session.wake('probe')
    expect(answered).toBe(false)
    expect(session.isDormant()).toBe(true)
    expect(session.status().dormancy.dormant).toBe(true)
  })

  it('wakes exactly once per detection, so its own output cannot re-trigger it', async () => {
    // The scrollback still CONTAINS the marker after the wake. A scanner that
    // re-examined the whole window on every chunk would re-set the flag from it,
    // and the session would press Enter again on every byte the device sent --
    // an unsolicited keystroke per read.
    let bareEnters = 0
    const server = await startFakeConsole({
      greeting: '<DUT1>',
      onBareEnter: () => {
        bareEnters += 1
        // Answer with the prompt AND keep printing, the way a recovered device
        // would resume its event log.
        return `\r\n<DUT1>\r\n%LINK-3-UPDOWN: an event`
      },
    })
    const session = track(sessionFor(server, { dormantAutoWake: true }), server)
    await session.open()
    server.push('\r\nVty connection is timed out.\r\n\r\nPlease press ENTER.')
    await until(() => bareEnters >= 1)
    await until(() => session.status().dormancy.dormant === false)

    // Feed more output, as a live device would.
    for (let index = 0; index < 5; index += 1) {
      server.push(`\r\n%LINK-3-UPDOWN: event ${String(index)}`)
      await wait(20)
    }
    expect(bareEnters).toBe(1)
    expect(session.status().dormancy.wakesSent).toBe(1)
  })

  it('augments `read` and `waitFor` with the dormancy state', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { dormantAutoWake: false }), server)
    await session.open()

    // Healthy: no dormancy reported.
    expect(session.read({ after: 0 }).dormant).toBe(false)

    server.push('\r\nVty connection is timed out.\r\n\r\nPlease press ENTER.')
    await until(() => session.isDormant())
    const read = session.read({ after: 0 })
    expect(read.dormant).toBe(true)
    expect(read.dormantText).toContain('Please press ENTER')

    // A wait that begins dormant and finds nothing must say so: otherwise the
    // caller cannot tell "the device is slow" from "the device is not
    // listening", and will simply wait again.
    const waited = await session.waitFor({ for: 'prompt', after: 0, timeoutMs: 150 })
    expect(waited.matched).toBe(false)
    expect(waited.reason).toBe('timeout')
    expect(waited.dormant).toBe(true)
    expect(waited.dormantBlocked).toBe(true)
  })

  it('does NOT report dormantBlocked when the wait actually matched', async () => {
    // The device answers before the budget runs out, so the wait succeeded. A
    // stale flag here would make a caller distrust a result it can see.
    const server = await startFakeConsole({
      greeting: '<DUT1>',
      onBareEnter: () => '\r\n<DUT1>',
    })
    const session = track(sessionFor(server, { dormantAutoWake: true }), server)
    await session.open()
    server.push('\r\nVty connection is timed out.\r\n\r\nPlease press ENTER.')
    await until(() => session.status().dormancy.dormant === false)

    // The marker is still in the window; a wait for anything must not be
    // reported as blocked by a dormancy that is over.
    const waited = await session.waitFor({ for: 'prompt', after: 0, timeoutMs: 150 })
    expect(waited.matched).toBe(true)
    expect(waited.dormantBlocked).toBeUndefined()
  })

  it('sends a keepalive before the device can time out, and does not count it as use', async () => {
    // The keepalive exists to stop the half-close happening at all. It must fire
    // on ITS own clock while nobody is watching -- and it must NOT refresh the
    // idle clock the reaper reads, or a forgotten tab would become immortal.
    //
    // The fake device is SILENT: it never answers the Enter. That is what makes
    // the assertion sharp, because a device that answers would legitimately
    // refresh the idle clock with its own reply, and the test could not then tell
    // the probe's write from the device's answer.
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { dormantAutoWake: true, dormantProbeMs: 60 }), server)
    await session.open()
    expect(server.received.join('')).toBe('')

    // Wait for the first probe to reach the device.
    await until(() => server.received.join('') !== '', 2500)
    expect(server.received.join('')).toBe('\r')

    // Now sample the idle clock WITHOUT reading -- a read legitimately resets it,
    // so reading here would mask exactly the bug this test exists to catch --
    // and watch across at least one more probe.
    //
    // `idleMs` is the clock the reaper reads. The invariant is that a probe does
    // not touch it: it must keep climbing through the probe, and never jump
    // backwards. An absolute threshold alone cannot see the difference, because
    // the clock recovers to a large value between probes either way -- which is
    // how a `write()` in place of `writeRaw()` slipped past the first version.
    const startedAt = Date.now()
    let lastIdle = session.status().idleMs
    let drops = 0
    const deadline = startedAt + 900
    while (Date.now() < deadline) {
      const idleNow = session.status().idleMs
      if (idleNow < lastIdle) drops += 1
      lastIdle = idleNow
      await wait(10)
    }

    const elapsed = Date.now() - startedAt
    const status = session.status()
    // The clock tracked wall-clock time across the probes: it was never reset.
    expect(drops).toBe(0)
    expect(lastIdle).toBeGreaterThanOrEqual(elapsed - 60)
    expect(lastIdle).toBeGreaterThan(500)
    // And the probes really did happen in that window, each writing a bare CR.
    expect(status.dormancy.keepalivesSent).toBeGreaterThanOrEqual(2)
    expect(server.received.join('')).toBe('\r'.repeat(status.dormancy.keepalivesSent))
    expect(status.state).toBe('open')
    // A keepalive nobody answered must NOT mark the console dormant: a device
    // ignoring a probe is not a device announcing a half-close.
    expect(status.dormancy.dormant).toBe(false)
  })

  it('does not let a wake ANSWER keep the console looking used', async () => {
    // The keepalive must not make a forgotten console immortal. Against the lab
    // firewall the device answers every probe, and those answers were refreshing
    // the clock the idle reaper reads -- so a console nobody had touched stayed
    // below the reaper's threshold forever. The live suite caught it as
    // `idleMs: 846` where the probe period was 3000ms.
    //
    // This is the miniature: a device that answers every bare Enter, probed fast,
    // and an idle clock that must still cross the probe period.
    let answers = 0
    const server = await startFakeConsole({
      greeting: '<DUT1>',
      onBareEnter: () => {
        answers += 1
        return '\r\n<DUT1>'
      },
    })
    const session = track(sessionFor(server, { dormantAutoWake: true, dormantProbeMs: 100 }), server)
    await session.open()

    // Wait until several probes have been answered.
    await until(() => answers >= 3, 3000)
    // The idle clock has to exceed the probe period, which it cannot do if each
    // answered probe reset it.
    expect(session.status().idleMs).toBeGreaterThan(100)
    // Sanity: the device really did answer, so the exclusion is being exercised.
    expect(answers).toBeGreaterThanOrEqual(3)
    expect(session.status().state).toBe('open')
  })

  it('keeps probing a CHATTY idle device, whose output does not count as input', async () => {
    // The hardware finding that shaped this design. MEASURED against the lab
    // firewall (`scripts/probe-idle-input.mjs`): after the connect wake nothing
    // was sent for 300s, the device streamed output the entire time, and it STILL
    // announced "Vty connection is timed out. Please press ENTER."
    //
    // So the device's idle timer counts INPUT. A keepalive whose clock reset on
    // inbound bytes would therefore never fire against exactly the device that
    // needs it -- which is what the live suite caught (`keepalivesSent: 0`).
    // This test is that case in miniature: a device that talks constantly and
    // never receives a keystroke.
    let bareEnters = 0
    const server = await startFakeConsole({
      greeting: '<DUT1>',
      onBareEnter: () => {
        bareEnters += 1
        return '\r\n<DUT1>'
      },
    })
    const session = track(sessionFor(server, { dormantAutoWake: true, dormantProbeMs: 150 }), server)
    await session.open()

    // Keep the DEVICE talking, without ever writing to it.
    const chatter = setInterval(() => { server.push('\r\n%LINK-3-UPDOWN: an event') }, 25)
    try {
      await until(() => bareEnters >= 2, 3000)
      expect(bareEnters).toBeGreaterThanOrEqual(2)
      expect(session.status().dormancy.keepalivesSent).toBeGreaterThanOrEqual(2)
      // It never mistook its own probes for a half-close announcement.
      expect(session.status().dormancy.dormant).toBe(false)
    } finally {
      clearInterval(chatter)
    }
  })

  it('real activity resets the keepalive, so an active session is never probed', async () => {
    let bareEnters = 0
    const server = await startFakeConsole({
      greeting: '<DUT1>',
      onLine: () => '\r\ndone\r\n<DUT1>',
      onBareEnter: () => {
        bareEnters += 1
        return '\r\n<DUT1>'
      },
    })
    const session = track(sessionFor(server, { dormantProbeMs: 120 }), server)
    await session.open()

    // Send a real command every 40ms for 400ms. The probe window never elapses
    // without fresh traffic, so no unsolicited Enter may reach the device.
    for (let index = 0; index < 10; index += 1) {
      await session.send(`show item ${String(index)}`)
      await wait(40)
    }
    expect(bareEnters).toBe(0)
    expect(session.status().dormancy.keepalivesSent).toBe(0)

    // Once the conversation stops, the keepalive resumes and fires.
    await until(() => bareEnters >= 1, 2000)
    expect(bareEnters).toBeGreaterThanOrEqual(1)
  })

  it('a read does not disturb a console whose keepalive is disabled', async () => {
    const server = await startFakeConsole({ greeting: '<DUT1>' })
    const session = track(sessionFor(server, { dormantProbeMs: 0 }), server)
    await session.open()
    await wait(80)
    expect(server.received.join('')).toBe('')
  })
})
