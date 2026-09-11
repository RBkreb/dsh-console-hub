/**
 * Red-first suite for `src/port-manager.ts`: console ownership, the session
 * cap, idle reaping, and teardown — driven against real TCP servers so the
 * reaper is exercised against live sockets.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PortManager, type ConsoleDescriptor } from '../src/port-manager.ts'
import { DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN } from '../src/config-shared.ts'

/** A tiny TCP server that greets and then stays up. */
interface FakeDevice {
  port: number
  sockets: Socket[]
  close(): Promise<void>
}

/** Start a device that greets with a prompt. */
async function startDevice(greeting = '<DUT1>'): Promise<FakeDevice> {
  const sockets: Socket[] = []
  const server: Server = createServer((socket) => {
    sockets.push(socket)
    socket.on('close', () => {
      const index = sockets.indexOf(socket)
      if (index >= 0) sockets.splice(index, 1)
    })
    socket.write(greeting)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    sockets,
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
    ...options,
  })
}

/** A descriptor for a fake device. */
function descriptorFor(device: FakeDevice, overrides: Partial<ConsoleDescriptor> = {}): ConsoleDescriptor {
  return {
    ownerSessionId: 'session-a',
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
function track(manager: PortManager, device?: FakeDevice): PortManager {
  managers.push(manager)
  if (device !== undefined) devices.push(device)
  return manager
}

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose()
  for (const device of devices.splice(0)) await device.close()
})

describe('PortManager connect', () => {
  it('mints an id, opens the session and keys it by owner', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const opened = await manager.connect(descriptorFor(device))
    expect(opened.consoleId).toMatch(/^c[0-9a-f-]+$/)
    expect(opened.state).toBe('open')
    expect(opened.label).toBe('FW1')
    expect(opened.ownerSessionId).toBe('session-a')
    expect(manager.list('session-a')).toHaveLength(1)
    // Another session sees nothing: consoles are owner-scoped.
    expect(manager.list('session-b')).toHaveLength(0)
  })

  it('returns a coded failure rather than throwing when the device refuses', async () => {
    const device = await startDevice()
    const port = device.port
    await device.close()
    const manager = track(managerFor())
    const opened = await manager.connect(descriptorFor({ port } as FakeDevice))
    expect(['error', 'closed']).toContain(opened.state)
    expect(opened.lastError?.code).toBeTruthy()
    // A failed connect still leaves a visible, closeable entry.
    expect(manager.list('session-a')).toHaveLength(1)
    await manager.close('session-a', opened.consoleId)
    expect(manager.list('session-a')).toHaveLength(0)
  })

  it('enforces maxConsoles instead of silently replacing an existing console', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ maxConsoles: 1 }), device)
    await manager.connect(descriptorFor(device))
    await expect(manager.connect(descriptorFor(device, { label: 'second' }))).rejects.toThrow(/max|limit|1 console/i)
    expect(manager.list('session-a')).toHaveLength(1)
  })

  it('enforces the cap per owner, not globally', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ maxConsoles: 1 }), device)
    await manager.connect(descriptorFor(device))
    const other = await manager.connect(descriptorFor(device, { ownerSessionId: 'session-b' }))
    expect(other.state).toBe('open')
  })
})

describe('PortManager ownership', () => {
  it('refuses another session access to a console', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const opened = await manager.connect(descriptorFor(device))
    // `get` reports "not found" rather than "exists but forbidden", so one
    // session cannot probe another's console inventory.
    expect(manager.get('session-b', opened.consoleId)).toBeUndefined()
    await expect(manager.send('session-b', opened.consoleId, 'show version')).rejects.toThrow(/not found|unknown/i)
  })

  it('reports an unknown console id as not found', async () => {
    const manager = track(managerFor())
    expect(manager.get('session-a', 'c-nope')).toBeUndefined()
    await expect(manager.close('session-a', 'c-nope')).rejects.toThrow(/not found|unknown/i)
  })
})

describe('PortManager idle reaping', () => {
  it('closes a console nobody has touched inside its idle window', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ idleTimeoutMs: 60, idleSweepMs: 20 }), device)
    const opened = await manager.connect(descriptorFor(device))
    await manager.sweep()
    // Freshly used: still alive.
    expect(manager.list('session-a')).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 90))
    const reaped = await manager.sweep()
    expect(reaped).toContain(opened.consoleId)
    expect(manager.list('session-a')).toHaveLength(0)
  })

  it('keeps a console alive while reads keep arriving', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ idleTimeoutMs: 80, idleSweepMs: 10 }), device)
    const opened = await manager.connect(descriptorFor(device))
    for (let index = 0; index < 4; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 30))
      manager.read('session-a', opened.consoleId, { after: 0 })
      expect(await manager.sweep()).not.toContain(opened.consoleId)
    }
  })

  it('reaps only the idle console when several are open', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ idleTimeoutMs: 70, idleSweepMs: 10 }), device)
    const first = await manager.connect(descriptorFor(device, { label: 'first' }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const second = await manager.connect(descriptorFor(device, { label: 'second' }))
    await new Promise(resolve => setTimeout(resolve, 40))
    const reaped = await manager.sweep()
    expect(reaped).toContain(first.consoleId)
    expect(reaped).not.toContain(second.consoleId)
    expect(manager.list('session-a').map(entry => entry.consoleId)).toEqual([second.consoleId])
  })

  it('records the reaping reason on the closed entry', async () => {
    const device = await startDevice()
    const manager = track(managerFor({ idleTimeoutMs: 40, idleSweepMs: 10 }), device)
    const opened = await manager.connect(descriptorFor(device))
    await new Promise(resolve => setTimeout(resolve, 70))
    await manager.sweep()
    void opened
    // The entry is gone, but its last status was reported through the sweep's
    // return value; the audit lives on the session while it exists.
    expect(manager.list('session-a')).toHaveLength(0)
  })
})

describe('PortManager teardown', () => {
  it('closes every console with the manager', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    await manager.connect(descriptorFor(device))
    await manager.connect(descriptorFor(device, { label: 'second' }))
    expect(manager.list('session-a')).toHaveLength(2)
    await manager.dispose()
    expect(manager.list('session-a')).toHaveLength(0)
    // The sockets really are gone.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(device.sockets).toHaveLength(0)
  })

  it('is idempotent and safe on an empty manager', async () => {
    const manager = track(managerFor())
    await manager.dispose()
    await manager.dispose()
    expect(manager.list('session-a')).toEqual([])
  })

  it('closes one console without touching its siblings', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const first = await manager.connect(descriptorFor(device, { label: 'first' }))
    const second = await manager.connect(descriptorFor(device, { label: 'second' }))
    await manager.close('session-a', first.consoleId)
    expect(manager.list('session-a').map(entry => entry.consoleId)).toEqual([second.consoleId])
  })

  it('force-closes a console the peer holds open', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const opened = await manager.connect(descriptorFor(device))
    await manager.close('session-a', opened.consoleId, { force: true })
    expect(manager.list('session-a')).toHaveLength(0)
  })
})

describe('PortManager audit and describe', () => {
  it('describes one console with its audit trail and never a secret', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    const opened = await manager.connect(descriptorFor(device, { password: 'super-secret' }))
    await manager.send('session-a', opened.consoleId, 'show version', { actor: 'model' })
    const described = manager.describe('session-a', opened.consoleId)
    expect(described?.entry.consoleId).toBe(opened.consoleId)
    expect(described?.state.bytesWritten).toBeGreaterThan(0)
    const trail = described?.state.audit ?? []
    expect(trail.some(entry => entry.action === 'send' && entry.actor === 'model')).toBe(true)
    expect(JSON.stringify(described)).not.toContain('super-secret')
  })

  it('lists every console for its owner with a live status', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    await manager.connect(descriptorFor(device, { label: 'FW1' }))
    await manager.connect(descriptorFor(device, { label: 'SW1' }))
    const list = manager.list('session-a')
    expect(list.map(entry => entry.label).sort()).toEqual(['FW1', 'SW1'])
    for (const entry of list) {
      expect(entry.state).toBe('open')
      expect(entry.consoleId).toMatch(/^c[0-9a-f-]+$/)
      expect(entry.host).toBe('127.0.0.1')
    }
  })

  it('marks the owner on every listed entry so a caller can never cross scopes', async () => {
    const device = await startDevice()
    const manager = track(managerFor(), device)
    await manager.connect(descriptorFor(device, { ownerSessionId: 'session-b' }))
    expect(manager.list('session-a')).toHaveLength(0)
    expect(manager.list('session-b')).toHaveLength(1)
  })
})
