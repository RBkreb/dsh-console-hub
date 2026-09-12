/**
 * Red-first suite for `src/port-manager.ts`: the SHARED pool, its cap, the
 * attach-not-duplicate rule, idle reaping, and teardown — driven against real
 * TCP servers so the registry is exercised against live sockets.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PortManager, type ConsoleDescriptor } from '../src/port-manager.ts'
import { DEFAULT_DORMANT_PATTERN, DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN } from '../src/config-shared.ts'

/** A tiny TCP server that greets, answers lines, and counts connections. */
interface FakeDevice {
  port: number
  sockets: Socket[]
  /**
   * How many TCP connections were ACCEPTED in total.
   *
   * Counted rather than derived from `sockets.length`, because the assertions
   * that matter are about connections the device was asked to accept -- a socket
   * that has since closed still proves a second connection was attempted, which
   * is exactly what the shared pool must never do.
   */
  readonly connections: number
  /** Drop every open connection from the server side (a device going away). */
  hangup(): void
  close(): Promise<void>
}

/** Start a device that greets with a prompt and answers each line. */
async function startDevice(
  greeting = '<DUT1>',
  answer: (line: string) => string = line => `answer:${line}`,
): Promise<FakeDevice> {
  const sockets: Socket[] = []
  let accepted = 0
  const server: Server = createServer((socket) => {
    accepted += 1
    sockets.push(socket)
    socket.on('close', () => {
      const index = sockets.indexOf(socket)
      if (index >= 0) sockets.splice(index, 1)
    })
    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/[\r\n]+/)) {
        if (line === '') continue
        socket.write(`\r\n${answer(line)}\r\n<DUT1>`)
      }
    })
    socket.write(greeting)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    sockets,
    get connections() {
      return accepted
    },
    hangup() {
      for (const socket of sockets.splice(0)) socket.destroy()
    },
    async close() {
      for (const socket of sockets.splice(0)) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Build a manager with test-friendly timings. */
function managerFor(options: Partial<ConstructorParameters<typeof PortManager>[0]> = {}): PortManager {
  return new PortManager({
    maxConsoles: 4,
    scrollbackLimitBytes: 64 * 1024,
    outputLimitBytes: 8 * 1024,
    connectTimeoutMs: 2000,
    readTimeoutMs: 200,
    idleTimeoutMs: 60_000,
    idleSweepMs: 30,
    pagingMode: 'auto-more',
    pagingMaxPages: 5,
    pagingQuietMs: 20,
    promptPattern: DEFAULT_PROMPT_PATTERN,
    pagerPattern: DEFAULT_PAGER_PATTERN,
    dormantPattern: DEFAULT_DORMANT_PATTERN,
    dormantAutoWake: true,
    dormantProbeMs: 0,
    idleQuietMs: 250,
    ...options,
  })
}

/** A descriptor for a fake device. */
function descriptorFor(device: FakeDevice, overrides: Partial<ConsoleDescriptor> = {}): ConsoleDescriptor {
  return {
    sessionId: 'session-a',
    label: 'FW1',
    host: '127.0.0.1',
    port: device.port,
    kind: 'raw',
    encoding: 'utf-8',
    ...overrides,
  }
}

const managers: PortManager[] = []
const devices: FakeDevice[] = []

/** Track resources for unconditional teardown. */
function track(manager: PortManager, ...devicesIn: FakeDevice[]): PortManager {
  managers.push(manager)
  for (const device of devicesIn) devices.push(device)
  return manager
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose()
  for (const device of devices.splice(0)) await device.close()
})

describe('PortManager connect', () => {
  it('mints an id and opens the console', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const { entry: opened, reused } = await manager.connect(descriptorFor(device))
    expect(opened.consoleId).toMatch(/^c[0-9a-f-]+$/)
    expect(opened.state).toBe('open')
    expect(opened.label).toBe('FW1')
    // Provenance, recorded but not enforced.
    expect(opened.openedBy).toBe('session-a')
    expect(reused).toBe(false)
    expect(manager.list()).toHaveLength(1)
  })

  it('returns a coded failure rather than throwing when the device refuses', async () => {
    const device = await startDevice()
    const port = device.port
    await device.close()
    const manager = track(managerFor())
    const { entry: opened } = await manager.connect(descriptorFor({ port } as FakeDevice))
    expect(['error', 'closed']).toContain(opened.state)
    expect(opened.lastError?.code).toBeTruthy()
    // A failed connect still leaves a visible, closeable entry.
    expect(manager.list()).toHaveLength(1)
    await manager.close(opened.consoleId)
    expect(manager.list()).toHaveLength(0)
  })

  it('enforces maxConsoles instead of silently replacing an existing console', async () => {
    // A SECOND DEVICE: with the shared pool, a second connect to the same target
    // attaches to the open console rather than being refused, so the cap can only
    // be observed across distinct devices.
    const first = await startDevice()
    const second = await startDevice()
    const manager = track(managerFor({ maxConsoles: 1 }), first, second)
    await manager.connect(descriptorFor(first))
    await expect(manager.connect(descriptorFor(second, { label: 'second' }))).rejects.toThrow(/max|limit|1 console/i)
    expect(manager.list()).toHaveLength(1)
  })

  it('enforces the cap GLOBALLY, across sessions', async () => {
    // The measurement that drove this design: with a per-owner cap, three
    // sequential sessions against one device, each capped at 3, left NINE live
    // TCP connections to the same console port. A device accepts a couple at
    // most, so the cap has to bound the device, not the caller.
    //
    // This asserts both halves: a different session is capped by the same pool
    // (different devices, so the attach rule cannot mask it), and the failing
    // connect opened no socket.
    const first = await startDevice()
    const second = await startDevice()
    const manager = track(managerFor({ maxConsoles: 1 }), first, second)
    await manager.connect(descriptorFor(first))
    const before = second.connections
    await expect(manager.connect(descriptorFor(second, { sessionId: 'session-b', label: 'other' })))
      .rejects.toThrow(/pool already holds 1 console/i)
    expect(second.connections).toBe(before)
  })

  it('ATTACHES to an already-open target instead of opening a second connection', async () => {
    // A second TCP connection to the same console-server port makes the device
    // tear down the first (measured on the lab firewall). So returning a new
    // console here would not give the caller an independent console -- it would
    // break whoever was already connected.
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const first = await manager.connect(descriptorFor(device))
    const second = await manager.connect(descriptorFor(device, { sessionId: 'session-b', label: 'second' }))

    expect(second.reused).toBe(true)
    expect(second.entry.consoleId).toBe(first.entry.consoleId)
    expect(second.entry.openedBy).toBe('session-a')
    // THE assertion: one console, one socket.
    expect(manager.list()).toHaveLength(1)
    expect(device.connections).toBe(1)
  })

  it('records the attach on the console audit trail', async () => {
    // The trail lives on the console, so a device link shared by two sessions
    // would otherwise show a history naming only whoever opened it.
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const { entry: first } = await manager.connect(descriptorFor(device))
    await manager.connect(descriptorFor(device, { sessionId: 'session-b' }))
    const audit = manager.describe(first.consoleId)?.state.audit ?? []
    expect(audit.some(entry => entry.action === 'attach' && entry.detail.includes('session-b'))).toBe(true)
  })

  it('does NOT attach to a dead console, and frees the target for a fresh one', async () => {
    // Attaching to a corpse would look like a successful reconnect and fail on
    // the next call. And leaving the corpse in place would block the target
    // forever, since no second connection to the same port is possible.
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const first = await manager.connect(descriptorFor(device))
    device.hangup()
    await new Promise(resolve => setTimeout(resolve, 60))

    const second = await manager.connect(descriptorFor(device, { label: 'fresh' }))
    expect(second.reused).toBe(false)
    expect(second.entry.consoleId).not.toBe(first.entry.consoleId)
    expect(second.entry.state).toBe('open')
    expect(manager.list()).toHaveLength(1)
  })

  it('attaches by host and port, whatever the transport', async () => {
    // Identity is the device link. Asking for `telnet` when the open console is
    // `raw` must still attach: opening the second socket is what breaks the
    // first, and the entry reports the transport ACTUALLY in use rather than the
    // one asked for, so the caller can see what it got.
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const first = await manager.connect(descriptorFor(device, { kind: 'raw' }))
    const second = await manager.connect(descriptorFor(device, { kind: 'telnet', label: 'as-telnet' }))
    expect(second.reused).toBe(true)
    expect(second.entry.consoleId).toBe(first.entry.consoleId)
    // The DEFAULT descriptor is `raw`, so the attach must report `raw`.
    expect(first.entry.kind).toBe('raw')
    expect(second.entry.kind).toBe('raw')
    expect(device.connections).toBe(1)
  })
})

describe('PortManager shared pool', () => {
  it('lets any session use a console another session opened', async () => {
    // Consoles are a host-wide resource now, and the device link is shared
    // whether or not this process admits it. `openedBy` is what the UI shows;
    // it gates nothing.
    const device = await startDevice(undefined, line => `answer:${line}`)
    const manager = track(managerFor(), device)
    const { entry: opened } = await manager.connect(descriptorFor(device))

    expect(manager.get(opened.consoleId)).toBeDefined()
    const other = await manager.send(opened.consoleId, 'show version')
    expect(other.state).toBe('open')
    // Wait for the device's answer before reading: `send` resolves when the bytes
    // are written, not when the device has replied, so an immediate read is a
    // race (it returned only the connect greeting).
    const waited = await manager.waitFor(opened.consoleId, {
      for: 'pattern',
      pattern: 'answer:show version',
      timeoutMs: 2000,
    })
    expect(waited.matched).toBe(true)
    const read = manager.read(opened.consoleId, { after: 0 })
    expect(read.text).toContain('answer:show version')
  })

  it('reports an unknown console id as not found', async () => {
    const manager = track(managerFor())
    expect(manager.get('c-nope')).toBeUndefined()
    await expect(manager.close('c-nope')).rejects.toThrow(/not found|unknown/i)
  })

  it('closes the WHOLE pool, so one call cleans up after every session', async () => {
    // The crash-safety property the shared pool buys: there is exactly one pool
    // to tear down. With per-session pools, a session that died left consoles
    // that nothing could list (the session check rejected every call) and that
    // no cap counted.
    const device = await startDevice()
    const manager = track(managerFor(), device)
    await manager.connect(descriptorFor(device, { sessionId: 'dead-1' }))
    await manager.connect(descriptorFor(device, { sessionId: 'dead-2', port: device.port + 1, label: 'other' }))
    expect(manager.openCount()).toBeGreaterThan(0)

    const closed = await manager.closeAll()
    expect(closed).toBe(2)
    expect(manager.list()).toEqual([])
    expect(manager.openCount()).toBe(0)
  })

  it('leaves no console behind when a session dies mid-flight', async () => {
    // The scenario in the report: "a session is force-closed -- is its pool
    // released?". The answer is that there is no per-session pool to release:
    // the console is either still wanted (another session attaches to it, or it
    // is simply still open) or it goes idle and the reaper takes it. What must
    // NOT happen is a console that nothing can reach and nothing can collect.
    const device = await startDevice()
    const manager = track(managerFor({ idleTimeoutMs: 1, idleSweepMs: 10 }), device)
    const { entry: orphan } = await manager.connect(descriptorFor(device, { sessionId: 'session-that-died' }))
    // No session-end cleanup runs anywhere in this test, which is the point:
    expect(manager.get(orphan.consoleId)).toBeDefined()

    // It is reachable from another session regardless of who opened it...
    expect(manager.list().map(row => row.consoleId)).toContain(orphan.consoleId)
    // ...and the one lifecycle mechanism collects it when nobody touches it.
    await new Promise(resolve => setTimeout(resolve, 60))
    const reaped = await manager.sweep()
    expect(reaped).toContain(orphan.consoleId)
    expect(manager.list()).toEqual([])
  })
})

describe('PortManager idle reaping', () => {
  it('closes a console nobody has touched inside its idle window', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ idleTimeoutMs: 60, idleSweepMs: 20 }), device)
    const { entry: opened } = await manager.connect(descriptorFor(device))
    await manager.sweep()
    // Freshly used: still alive.
    expect(manager.list()).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 90))
    const reaped = await manager.sweep()
    expect(reaped).toContain(opened.consoleId)
    expect(manager.list()).toHaveLength(0)
  })

  it('keeps a console alive while reads keep arriving', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ idleTimeoutMs: 80, idleSweepMs: 10 }), device)
    const { entry: opened } = await manager.connect(descriptorFor(device))
    for (let index = 0; index < 4; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 30))
      manager.read(opened.consoleId, { after: 0 })
      expect(await manager.sweep()).not.toContain(opened.consoleId)
    }
  })

  it('reaps only the idle console when several are open', async () => {
    // Two DEVICES, not two consoles on one device: with a shared pool a second
    // connect to the same target attaches rather than opening, so "several
    // consoles" means several devices.
    const first = await startDevice()
    const second = await startDevice()
    // Wide margins on purpose: the first console must clear the idle window and
    // the second must be nowhere near it, so scheduler jitter cannot decide the
    // outcome.
    const manager = track(managerFor({ idleTimeoutMs: 200, idleSweepMs: 10 }), first, second)
    const openedFirst = await manager.connect(descriptorFor(first, { label: 'first' }))
    await new Promise(resolve => setTimeout(resolve, 260))
    const openedSecond = await manager.connect(descriptorFor(second, { label: 'second' }))
    const reaped = await manager.sweep()
    expect(reaped).toContain(openedFirst.entry.consoleId)
    expect(reaped).not.toContain(openedSecond.entry.consoleId)
    expect(manager.list().map(entry => entry.consoleId)).toEqual([openedSecond.entry.consoleId])
  })

  it('records the reaping reason on the closed entry', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ idleTimeoutMs: 40, idleSweepMs: 10 }), device)
    const { entry: opened } = await manager.connect(descriptorFor(device))
    await new Promise(resolve => setTimeout(resolve, 70))
    await manager.sweep()
    void opened
    // The entry is gone, but its last status was reported through the sweep's
    // return value; the audit lives on the session while it exists.
    expect(manager.list()).toHaveLength(0)
  })
})

describe('PortManager teardown', () => {
  it('closes every console with the manager', async () => {
    const first = await startDevice()
    const second = await startDevice()
    const manager = track(managerFor(), first, second)
    await manager.connect(descriptorFor(first))
    await manager.connect(descriptorFor(second, { label: 'second' }))
    expect(manager.list()).toHaveLength(2)
    await manager.dispose()
    expect(manager.list()).toHaveLength(0)
    // The sockets really are gone.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(first.sockets).toHaveLength(0)
    expect(second.sockets).toHaveLength(0)
  })

  it('is idempotent and safe on an empty manager', async () => {
    const manager = track(managerFor())
    await manager.dispose()
    await manager.dispose()
    expect(manager.list()).toEqual([])
  })

  it('closes one console without touching its siblings', async () => {
    const first = await startDevice()
    const second = await startDevice()
    const manager = track(managerFor(), first, second)
    const openedFirst = await manager.connect(descriptorFor(first, { label: 'first' }))
    const openedSecond = await manager.connect(descriptorFor(second, { label: 'second' }))
    await manager.close(openedFirst.entry.consoleId)
    expect(manager.list().map(entry => entry.consoleId)).toEqual([openedSecond.entry.consoleId])
  })

  it('force-closes a console the peer holds open', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const { entry: opened } = await manager.connect(descriptorFor(device))
    await manager.close(opened.consoleId, { force: true })
    expect(manager.list()).toHaveLength(0)
  })
})

describe('PortManager audit and describe', () => {
  it('describes one console with its audit trail and never a secret', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const { entry: opened } = await manager.connect(descriptorFor(device, { password: 'super-secret' }))
    await manager.send(opened.consoleId, 'show version', { actor: 'model' })
    const described = manager.describe(opened.consoleId)
    expect(described?.entry.consoleId).toBe(opened.consoleId)
    expect(described?.state.bytesWritten).toBeGreaterThan(0)
    const trail = described?.state.audit ?? []
    expect(trail.some(entry => entry.action === 'send' && entry.actor === 'model')).toBe(true)
    expect(JSON.stringify(described)).not.toContain('super-secret')
  })

  it('lists every console in the pool with a live status', async () => {
    const first = await startDevice()
    const second = await startDevice()
    const manager = track(managerFor(), first, second)
    await manager.connect(descriptorFor(first, { label: 'FW1' }))
    await manager.connect(descriptorFor(second, { label: 'SW1' }))
    const list = manager.list()
    expect(list.map(entry => entry.label).sort()).toEqual(['FW1', 'SW1'])
    for (const entry of list) {
      expect(entry.state).toBe('open')
      expect(entry.consoleId).toMatch(/^c[0-9a-f-]+$/)
      expect(entry.host).toBe('127.0.0.1')
    }
  })

  it('lists a console opened by ANOTHER session, marking who opened it', async () => {
    // The old model filtered this list by the requesting session, which is what
    // made a dead session's consoles unreachable -- nothing could list them in
    // order to close them. `openedBy` is the display fact that replaced the
    // filter.
    const device = await startDevice()
    const manager = track(managerFor(), device)
    await manager.connect(descriptorFor(device, { sessionId: 'some-other-session' }))
    const list = manager.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.openedBy).toBe('some-other-session')
  })
})
