/**
 * Red-first suite for `src/manager-holder.ts`.
 *
 * The behaviour under test is a policy, not a mechanism: a settings write must
 * never close a console someone is using. Everything here is driven against a
 * real `PortManager` connected to a real in-process TCP device, because the
 * interesting case (a parked change landing once the last console closes) only
 * exists when consoles are genuinely open.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagerHolder, policyFromSettings, policyDiffers } from '../src/manager-holder.ts'
import { DEFAULT_CONSOLE_HUB_SETTINGS, DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN } from '../src/config-shared.ts'
import type { PortManagerOptions } from '../src/port-manager.ts'

/** A device stub that greets and answers each line. */
interface Device {
  port: number
  close(): Promise<void>
}

async function startDevice(): Promise<Device> {
  const sockets: Socket[] = []
  const server: Server = createServer((socket) => {
    sockets.push(socket)
    socket.on('close', () => {
      const index = sockets.indexOf(socket)
      if (index >= 0) sockets.splice(index, 1)
    })
    socket.write('<DUT1>')
    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/[\r\n]+/)) {
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
    async close() {
      for (const socket of sockets.splice(0)) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

const openDevices: Device[] = []
const openHolders: ManagerHolder[] = []

afterEach(async () => {
  for (const holder of openHolders.splice(0)) await holder.dispose()
  for (const device of openDevices.splice(0)) await device.close()
})

/** A base policy from the shipped defaults, with short timeouts for tests. */
function basePolicy(): PortManagerOptions {
  return {
    ...policyFromSettings(DEFAULT_CONSOLE_HUB_SETTINGS, 1000),
    connectTimeoutMs: 1000,
    readTimeoutMs: 200,
    idleTimeoutMs: 60_000,
    pagingMode: 'manual',
    pagingQuietMs: 20,
  }
}

/** A holder over a fresh policy. */
function holderFor(policy: PortManagerOptions = basePolicy()): ManagerHolder {
  const holder = new ManagerHolder(policy)
  openHolders.push(holder)
  return holder
}

/** Connect one console through a holder's current manager. */
async function connect(holder: ManagerHolder, device: Device, label = 'FW1'): Promise<string> {
  const entry = await holder.get().connect({
    ownerSessionId: 'session-a',
    label,
    host: '127.0.0.1',
    port: device.port,
    kind: 'raw',
    encoding: 'utf-8',
    pagingMode: 'manual',
  })
  return entry.consoleId
}
/**
 * Poll until a condition holds, so an assertion never races the device.
 *
 * The device answers asynchronously on a real socket, so a read issued the
 * instant a send resolves can legitimately see nothing yet.
 *
 * @param check - the condition to poll.
 * @param timeoutMs - budget before giving up.
 */
async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('until: condition never held')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('policyFromSettings', () => {
  it('carries every field the manager reads, plus the host-owned sweep interval', () => {
    const policy = policyFromSettings(DEFAULT_CONSOLE_HUB_SETTINGS, 15_000)
    expect(policy.maxConsoles).toBe(DEFAULT_CONSOLE_HUB_SETTINGS.maxConsoles)
    expect(policy.idleTimeoutMs).toBe(DEFAULT_CONSOLE_HUB_SETTINGS.idleTimeoutMs)
    expect(policy.pagingMode).toBe(DEFAULT_CONSOLE_HUB_SETTINGS.pagingMode)
    expect(policy.promptPattern).toBe(DEFAULT_CONSOLE_HUB_SETTINGS.promptPattern)
    expect(policy.pagerPattern).toBe(DEFAULT_CONSOLE_HUB_SETTINGS.pagerPattern)
    // The sweep interval is host config, not a user preference, so it comes
    // from the argument rather than the settings document.
    expect(policy.idleSweepMs).toBe(15_000)
  })

  it('uses the shipped patterns, so an untouched install matches the engine defaults', () => {
    const policy = policyFromSettings(DEFAULT_CONSOLE_HUB_SETTINGS, 15_000)
    expect(policy.promptPattern).toBe(DEFAULT_PROMPT_PATTERN)
    expect(policy.pagerPattern).toBe(DEFAULT_PAGER_PATTERN)
  })
})

describe('policyDiffers', () => {
  it('detects a change in any single field', () => {
    const left = basePolicy()
    expect(policyDiffers(left, { ...left })).toBe(false)
    expect(policyDiffers(left, { ...left, maxConsoles: left.maxConsoles + 1 })).toBe(true)
    expect(policyDiffers(left, { ...left, idleTimeoutMs: left.idleTimeoutMs + 1 })).toBe(true)
    expect(policyDiffers(left, { ...left, promptPattern: `${left.promptPattern}x` })).toBe(true)
  })
})

describe('ManagerHolder', () => {
  it('applies a policy change immediately when nothing is open', () => {
    const holder = holderFor()
    const next = { ...basePolicy(), idleTimeoutMs: 1234 }
    expect(holder.reconfigure(next)).toBe('applied')
    expect(holder.currentPolicy().idleTimeoutMs).toBe(1234)
    expect(holder.pendingPolicy()).toBeUndefined()
  })

  it('reports an identical policy as unchanged and does not replace the manager', () => {
    const holder = holderFor()
    const before = holder.get()
    expect(holder.reconfigure({ ...basePolicy() })).toBe('unchanged')
    // Replacing the instance for a no-op write would be observable to anything
    // holding the old reference, so identity is part of the contract.
    expect(holder.get()).toBe(before)
  })

  it('defers a policy change while a console is open, keeping the console usable', async () => {
    const device = await startDevice()
    openDevices.push(device)
    const holder = holderFor()
    const consoleId = await connect(holder, device)
    const before = holder.get()

    expect(holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 999 })).toBe('deferred')
    // The console survives the settings write: this is the whole point.
    expect(holder.get()).toBe(before)
    expect(holder.get().get('session-a', consoleId)?.state).toBe('open')
    expect(holder.pendingPolicy()?.idleTimeoutMs).toBe(999)
    // The live policy is still the old one.
    expect(holder.currentPolicy().idleTimeoutMs).toBe(60_000)
  })

  it('lands the parked policy once the last console closes', async () => {
    const device = await startDevice()
    openDevices.push(device)
    const holder = holderFor()
    const consoleId = await connect(holder, device)

    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 999 })
    // A sync with a console still open is a no-op.
    expect(holder.sync()).toBe(false)
    expect(holder.pendingPolicy()).toBeDefined()

    await holder.get().close('session-a', consoleId)
    expect(holder.sync()).toBe(true)
    expect(holder.currentPolicy().idleTimeoutMs).toBe(999)
    expect(holder.pendingPolicy()).toBeUndefined()
  })

  it('keeps the newest parked policy when several writes arrive while busy', async () => {
    const device = await startDevice()
    openDevices.push(device)
    const holder = holderFor()
    const consoleId = await connect(holder, device)

    // A burst of edits (a number input firing per keystroke) must converge on
    // the LAST value, not the first.
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 111 })
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 222 })
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 333 })
    expect(holder.pendingPolicy()?.idleTimeoutMs).toBe(333)

    await holder.get().close('session-a', consoleId)
    holder.sync()
    expect(holder.currentPolicy().idleTimeoutMs).toBe(333)
  })

  it('does not apply a parked policy to a console that is already open', async () => {
    const device = await startDevice()
    openDevices.push(device)
    const holder = holderFor()
    const consoleId = await connect(holder, device)

    // Park a change with a much shorter read timeout, then confirm the OPEN
    // console still answers under the policy it was opened with.
    holder.reconfigure({ ...basePolicy(), readTimeoutMs: 50 })
    await holder.get().send('session-a', consoleId, 'show version')
    await until(() => holder.get().read('session-a', consoleId, {}).text.includes('answer:show version'))
    const read = holder.get().read('session-a', consoleId, {})
    expect(read.text).toContain('answer:show version')
  })

  it('rearms the idle reaper on a replacement manager, so the new policy actually reaps', async () => {
    const device = await startDevice()
    openDevices.push(device)
    // A short idle lifetime and sweep so the reaper fires inside the test.
    const holder = holderFor({ ...basePolicy(), idleTimeoutMs: 50, idleSweepMs: 20 })
    holder.startReaper()

    const first = await connect(holder, device)
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 50, idleSweepMs: 20, maxConsoles: 7 })
    await holder.get().close('session-a', first)
    expect(holder.sync()).toBe(true)

    // The REPLACEMENT manager must have its own reaper running. Without one the
    // idle console below would never be collected, which is exactly the leak a
    // naive reconfigure introduces.
    await connect(holder, device, 'FW2')
    await until(() => holder.get().openCount() === 0, 4000)
    expect(holder.get().openCount()).toBe(0)
  })

  it('drops a parked policy on dispose instead of applying it', async () => {
    const device = await startDevice()
    openDevices.push(device)
    const holder = holderFor()
    await connect(holder, device)
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 999 })
    await holder.dispose()
    openHolders.splice(openHolders.indexOf(holder), 1)
    expect(holder.pendingPolicy()).toBeUndefined()
    expect(holder.get().openCount()).toBe(0)
  })
})
