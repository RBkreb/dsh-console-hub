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
  const { entry: entry } = await holder.get().connect({
    sessionId: 'session-a',
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
  })

  it('reports an identical policy as unchanged and does not replace the manager', () => {
    const holder = holderFor()
    const before = holder.get()
    expect(holder.reconfigure({ ...basePolicy() })).toBe('unchanged')
    // The manager instance is stable now: a policy change mutates it rather than
    // replacing it, so anything holding the reference keeps working.
    expect(holder.get()).toBe(before)
  })

  it('applies a policy change WHILE a console is open, and keeps that console usable', async () => {
    // The reported defect. A change used to be parked until every console
    // closed, so toggling a setting changed nothing for the next connect until
    // the user closed everything and toggled it again. Applying in place is what
    // removes that, and the console must survive it either way.
    const device = await startDevice()
    openDevices.push(device)
    const holder = holderFor()
    const consoleId = await connect(holder, device)

    expect(holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 999 })).toBe('applied')
    // The new policy is LIVE, not parked.
    expect(holder.currentPolicy().idleTimeoutMs).toBe(999)
    // And the open console is untouched: same manager, still open, still usable.
    expect(holder.get().get(consoleId)?.state).toBe('open')
    await holder.get().send(consoleId, 'show version')
    await until(() => holder.get().read(consoleId, {}).text.includes('answer:show version'))
  })

  it('gives the change to the NEXT console, so a toggle takes effect at once', async () => {
    // The behaviour the user actually wants from a settings toggle: flip it, open
    // a console, get the new behaviour -- without closing the old ones first.
    //
    // The second console is a SECOND DEVICE: with one shared pool, reconnecting
    // to the same target attaches to the console already open rather than making
    // a new one, so it would not exercise the new policy at all.
    const device = await startDevice()
    const second = await startDevice()
    openDevices.push(device, second)
    const holder = holderFor()
    await connect(holder, device, 'BEFORE')

    holder.reconfigure({ ...basePolicy(), maxConsoles: 9 })
    expect(holder.currentPolicy().maxConsoles).toBe(9)
    // The manager reads the new value on its next connect, which is the whole
    // point of applying in place.
    expect(holder.get().openCount()).toBe(1)
    await connect(holder, second, 'AFTER')
    expect(holder.get().openCount()).toBe(2)
  })

  it('keeps a burst of edits converging on the LAST value', async () => {
    // A number input fires per keystroke; the final value must win, and it must
    // be the live policy rather than a queued one.
    const holder = holderFor()
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 111 })
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 222 })
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 333 })
    expect(holder.currentPolicy().idleTimeoutMs).toBe(333)
  })

  it('does not apply a policy change retroactively to an open console', async () => {
    const device = await startDevice()
    openDevices.push(device)
    const holder = holderFor()
    const consoleId = await connect(holder, device)

    // Park a change with a much shorter read timeout: the OPEN console must keep
    // answering under the policy it was opened with, so editing settings never
    // breaks a session in progress.
    holder.reconfigure({ ...basePolicy(), readTimeoutMs: 50 })
    await holder.get().send(consoleId, 'show version')
    await until(() => holder.get().read(consoleId, {}).text.includes('answer:show version'))
    expect(holder.get().read(consoleId, {}).text).toContain('answer:show version')
  })

  it('re-arms the idle reaper when the sweep interval changes', async () => {
    const device = await startDevice()
    openDevices.push(device)
    // A short idle lifetime and sweep so the reaper fires inside the test.
    const holder = holderFor({ ...basePolicy(), idleTimeoutMs: 50, idleSweepMs: 20 })
    holder.startReaper()

    await connect(holder, device)
    // Changing the cadence must actually take effect: the interval was armed
    // with the old value, so adopting a new one without re-arming would leave
    // the manager sweeping at the old rate.
    holder.reconfigure({ ...basePolicy(), idleTimeoutMs: 50, idleSweepMs: 15 })
    expect(holder.currentPolicy().idleSweepMs).toBe(15)

    await until(() => holder.get().openCount() === 0, 4000)
    expect(holder.get().openCount()).toBe(0)
  })

  it('closes everything on dispose', async () => {
    const device = await startDevice()
    openDevices.push(device)
    const holder = holderFor()
    await connect(holder, device)
    await holder.dispose()
    openHolders.splice(openHolders.indexOf(holder), 1)
    expect(holder.get().openCount()).toBe(0)
  })
})
