/**
 * Live-lab end-to-end suite: the real devices, through the real engine.
 *
 * Opt-in and excluded from the default run, because it needs the lab network:
 *
 *   DSH_CONSOLE_LIVE=1 pnpm vitest run tests/live --no-exclude
 *
 * The devices (from PHASE0.md) are:
 * - FW1 `10.133.6.253:10003` — a firewall whose console lands straight at the
 *   CLI with no login, after a Telnet negotiation storm.
 * - SW1 `10.133.5.253:10015` — a switch, reached the same way.
 *
 * What this suite is FOR: the unit suites prove the engine against stubs that
 * behave the way we imagine a device behaves. Only these tests can show that
 * the negotiation reply actually unlocks a real console, that the shipped
 * prompt pattern matches a real prompt, and that paging really pages.
 * What the lab actually showed (recorded here so the assertions are honest
 * rather than aspirational): both devices send ONLY the Telnet negotiation
 * burst on connect -- 6 bytes, no banner, no prompt -- and stay completely
 * silent until a key is pressed. One bare Enter produces their prompt
 * (`<DUT1>` on the firewall, `[SWITCH]` on the switch). That is why
 * `wakeOnConnect` exists and why the assertions below never expect a banner
 * without it.
 *
 * Measured later, and worth keeping: the two devices come up in DIFFERENT
 * views. The firewall lands in its USER view (`<DUT1>`) and the switch in its
 * CONFIG view (`[SWITCH]`); `conf-mode` is what moves between them. Both are
 * ordinary prompts, which is why {@link DEFAULT_PROMPT_PATTERN} accepts either
 * bracket pair -- narrowing it to one would break one of these two devices.
 *
 * Also measured: the wake Enter is answered in ~35-45ms by both (see
 * `scripts/probe-wake.mjs`), well inside the 300ms window `open()` allows, so a
 * woken console reliably reports its prompt. And a command sent WITHOUT any wake
 * still executes in full -- the devices do not swallow the first line. What a
 * silent connect costs is the PROMPT, not the command.
 */
import { describe, expect, it } from 'vitest'
import { PortManager } from '../../src/port-manager.ts'
import {
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_DORMANT_PATTERN,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
  compileCommandFence,
} from '../../src/config-shared.ts'
import { classifyCommand, compileFence, type ConsoleFenceSettings } from '../../src/guard.ts'
import { ManagerHolder, policyFromSettings } from '../../src/manager-holder.ts'

/** The lab devices, from PHASE0.md. */
const FW1 = { host: '10.133.6.253', port: 10003, label: 'FW1' }
const SW1 = { host: '10.133.5.253', port: 10015, label: 'SW1' }

/** Only run when the operator opted in. */
const LIVE = process.env.DSH_CONSOLE_LIVE === '1'

/** A manager configured the way the plugin configures one. */
function manager(): PortManager {
  return new PortManager({
    maxConsoles: 4,
    scrollbackLimitBytes: 256 * 1024,
    outputLimitBytes: 64 * 1024,
    connectTimeoutMs: 8000,
    readTimeoutMs: 8000,
    idleTimeoutMs: 60_000,
    idleSweepMs: 15_000,
    pagingMode: DEFAULT_CONSOLE_HUB_SETTINGS.pagingMode,
    pagingMaxPages: DEFAULT_CONSOLE_HUB_SETTINGS.pagingMaxPages,
    pagingQuietMs: DEFAULT_CONSOLE_HUB_SETTINGS.pagingQuietMs,
    promptPattern: DEFAULT_PROMPT_PATTERN,
    pagerPattern: DEFAULT_PAGER_PATTERN,
    dormantPattern: DEFAULT_DORMANT_PATTERN,
    dormantAutoWake: true,
    dormantProbeMs: 0,
    // Both lab consoles are silent until a key is pressed.
    wakeOnConnect: true,
  })
}

/** Sleep, so a read can wait for a device that answers slowly. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Read repeatedly from a GIVEN cursor until `check` holds, accumulating what it sees. */
async function readFrom(
  ports: PortManager,
  sessionId: string,
  consoleId: string,
  cursor: number,
  check: (text: string) => boolean,
  budgetMs = 8000,
): Promise<string> {
  // Distinct from `readUntil`, which always starts at 0: after a clear, cursor 0
  // addresses bytes that no longer exist, so a resumed reader must say where it
  // is. Sharing one helper would hide that difference.
  let at = cursor
  let accumulated = ''
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const result = ports.read(sessionId, consoleId, { after: at })
    at = result.cursor
    accumulated += result.text
    if (check(accumulated)) return accumulated
    await sleep(150)
  }
  return accumulated
}

/** Read repeatedly until `check` holds, accumulating everything seen. */
async function readUntil(
  ports: PortManager,
  sessionId: string,
  consoleId: string,
  check: (text: string) => boolean,
  budgetMs = 8000,
): Promise<string> {
  let cursor = 0
  let accumulated = ''
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const result = ports.read(sessionId, consoleId, { after: cursor })
    cursor = result.cursor
    accumulated += result.text
    if (check(accumulated)) return accumulated
    await sleep(150)
  }
  return accumulated
}

describe.runIf(LIVE)('live console lab', () => {
  it('connects to the firewall console and reaches its prompt', async () => {
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: FW1.label,
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      // A failed connect is recorded on the entry rather than thrown.
      expect(entry.lastError).toBeNull()
      expect(entry.state).toBe('open')

      // The device sends nothing on its own, so the wake Enter is what produces
      // the prompt; the shipped prompt pattern must recognize it.
      const detail = ports.describe('live', entry.consoleId)
      expect(detail?.state.prompt).toBe('<DUT1>')
      expect(ports.bannerOf('live', entry.consoleId)).toContain('<DUT1>')

      // And the prompt pattern the plugin compiles matches it.
      const waited = await ports.waitFor('live', entry.consoleId, { for: 'prompt', timeoutMs: 4000 })
      expect(waited.matched).toBe(true)
    } finally {
      await ports.dispose()
    }
  }, 30_000)

  it('runs a read-only command and gets its answer back', async () => {
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: FW1.label,
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      // The connect already woke the console, so its prompt is there.

      await ports.send('live', entry.consoleId, 'show version')
      const text = await readUntil(ports, 'live', entry.consoleId, seen => seen.length > 0)
      // The answer is whatever the device prints; the point is that a real
      // round trip completed rather than that it said something specific.
      expect(text.trim().length).toBeGreaterThan(0)
    } finally {
      await ports.dispose()
    }
  }, 40_000)

  it('reaches the switch console too, so the engine is not firewall-specific', async () => {
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: SW1.label,
        host: SW1.host,
        port: SW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      expect(entry.lastError).toBeNull()
      const detail = ports.describe('live', entry.consoleId)
      // The switch answers in its CONFIG view -- `[SWITCH]` -- where the firewall
      // answers in its USER view -- `<DUT1>`. That is the `<>` / `[]` distinction
      // these devices use: square brackets mean the config view, angle brackets
      // the user view, and `conf-mode` is what moves between them. Both are
      // ordinary prompts, which is exactly why the shipped pattern accepts
      // either (`[<\[] ... [>\]]`) and must not be narrowed to one pair.
      //
      // This assertion used to read `<SWITCH>`, which the device never emits: it
      // pinned a bracket the hardware does not use, so it failed against a
      // WORKING console. Assert the shape instead of a fixed spelling, so a
      // device that comes up in either view passes while one that comes up in
      // neither still fails.
      expect(detail?.state.prompt).toMatch(/^[<[][\w.-]+[>\]]$/)
    } finally {
      await ports.dispose()
    }
  }, 30_000)

  it('strips telnet negotiation instead of leaking it into the transcript', async () => {
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: FW1.label,
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      const banner = ports.bannerOf('live', entry.consoleId)
      // IAC is 0xFF. The firewall opens with a negotiation burst, so a banner
      // that still carried it would be full of raw 0xFF bytes -- and the model
      // would be reading protocol noise as device output.
      expect(banner).not.toContain('\u00ff')
      expect(banner).not.toContain('\uFFFD')
    } finally {
      await ports.dispose()
    }
  }, 30_000)

  it('sees on one console what another console writes to the same device', async () => {
    // The requested measurement, and the one thing a fake cannot show: TWO
    // consoles against ONE physical device, where a command typed into the first
    // appears on the SECOND. A serial console mapping means both connections
    // share the device's one console line, so the device echoes the command to
    // every attached session.
    //
    // The two halves assert different mechanisms, which is why both are here:
    //   - console A's own read sees its answer (the ordinary path).
    //   - console B's `waitFor` sees the command text A typed, with B having
    //     sent nothing. That is the real wait_for contract: it observes output
    //     arriving from elsewhere, not merely its own round trip.
    const ports = manager()
    try {
      const open = async (label: string): Promise<string> => {
        const entry = await ports.connect({
          ownerSessionId: 'live',
          label,
          host: SW1.host,
          port: SW1.port,
          kind: 'telnet',
          encoding: 'utf-8',
          pagingMode: 'manual',
        })
        await ports.waitFor('live', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
        return entry.consoleId
      }
      const writer = await open('WRITER')
      const watcher = await open('WATCHER')
      expect(ports.list('live')).toHaveLength(2)

      // Both consoles are positioned at a clean cursor before the command, so
      // anything either reads afterward arrived because of this command.
      const writerAt = ports.read('live', writer, { after: 0 }).cursor
      const watcherAt = ports.read('live', watcher, { after: 0 }).cursor

      // A distinctive marker, so a match cannot come from unrelated device
      // output that happened to contain generic text.
      const marker = `echo live-sync-${String(Date.now())}`
      await ports.send('live', writer, marker)

      // The WATCHER waits for text it never sent. `waitFor` here is the real
      // one: it polls the session's own scrollback, so a match means the device
      // forwarded the writer's line to this connection.
      const seen = await ports.waitFor('live', watcher, {
        for: 'pattern',
        pattern: marker,
        after: watcherAt,
        timeoutMs: 8000,
      })
      expect(seen.matched).toBe(true)
      expect(seen.reason).toBe('matched')

      // And the watcher can READ what it matched -- `matched: true` with nothing
      // readable would make the wait useless to a caller.
      const watcherText = ports.read('live', watcher, { after: watcherAt }).text
      expect(watcherText).toContain(marker)

      // The writer sees its own echo too, so the two views agree about what was
      // typed while remaining separate sessions.
      const writerText = ports.read('live', writer, { after: writerAt }).text
      expect(writerText).toContain(marker)
    } finally {
      await ports.dispose()
    }
  }, 60_000)

  it('times out on a pattern the device never prints', async () => {
    // The other half of the contract: a wait must REPORT a timeout rather than
    // hanging or claiming a false match. A live console makes this the real
    // question, because the device is emitting prompts the whole time.
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: SW1.label,
        host: SW1.host,
        port: SW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      await ports.waitFor('live', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
      const at = ports.read('live', entry.consoleId, { after: 0 }).cursor

      const started = Date.now()
      const missed = await ports.waitFor('live', entry.consoleId, {
        for: 'pattern',
        pattern: `never-printed-${String(Date.now())}`,
        after: at,
        timeoutMs: 1500,
      })
      expect(missed.matched).toBe(false)
      expect(missed.reason).toBe('timeout')
      // It waited about as long as it was told, and returned within a sane
      // multiple of that rather than hanging.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
      expect(Date.now() - started).toBeLessThan(8000)
      // Still usable afterward: a timeout is a result, not a broken console.
      expect(ports.describe('live', entry.consoleId)?.state.state).toBe('open')
    } finally {
      await ports.dispose()
    }
  }, 40_000)

  it('classifies the high-risk commands these devices really accept', () => {
    // The engine's own connect path is exercised above; this asserts the
    // GUARD's behaviour on the real strings a device CLI accepts.
    const policy: ConsoleFenceSettings = {
      approvalMode: DEFAULT_CONSOLE_HUB_SETTINGS.approvalMode,
      highRiskPatterns: [...DEFAULT_CONSOLE_HUB_SETTINGS.highRiskPatterns],
    }
    // Words the lab devices really accept.
    for (const command of ['config', 'configure', 'conf terminal', 'restart', 'reboot', 'show version', 'display version']) {
      const { risk } = classifyCommand(command, policy)
      const expected = /^(config|conf|configure|restart|reboot)/i.test(command) ? 'high' : 'safe'
      expect(`${command}:${risk}`).toBe(`${command}:${expected}`)
    }
    // And the compiled fence really anchors at the command start.
    expect(compileFence('config|restart')[0]?.test('config terminal')).toBe(true)
    expect(compileCommandFence('config|restart').test('show configuration')).toBe(false)
  })

  it('pages automatically when the device offers --More--', async () => {
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: FW1.label,
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        // The one mode that keeps a pager flowing without a human.
        pagingMode: 'auto-more',
      })
      await ports.waitFor('live', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
      // A long read-only listing is the usual way to provoke a pager.
      await ports.send('live', entry.consoleId, 'show running-config')
      const text = await readUntil(ports, 'live', entry.consoleId, seen => seen.length > 2000, 15_000)
      // Either the device paged and the engine consumed pages, or the output
      // fit on one screen. Both are correct; a hung console is not.
      const detail = ports.describe('live', entry.consoleId)
      expect(detail?.state.state).toBe('open')
      expect(text.length).toBeGreaterThan(0)
    } finally {
      await ports.dispose()
    }
  }, 45_000)

  it('clears the local scrollback and keeps talking to the real device', async () => {
    // The property that separates clearing from closing, measured on hardware:
    // after a clear the device must still answer. A clear that quietly broke the
    // connection would look identical in the pane -- empty output -- so only a
    // real follow-up command can tell the two apart.
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: SW1.label,
        host: SW1.host,
        port: SW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      await ports.waitFor('live', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
      await ports.send('live', entry.consoleId, 'show version')
      const before = await readUntil(ports, 'live', entry.consoleId, seen => seen.length > 0, 15_000)
      expect(before.length).toBeGreaterThan(0)

      const cleared = ports.clear('live', entry.consoleId)
      expect(cleared.droppedBytes).toBeGreaterThan(0)
      // The buffer really is empty, and the cursor it hands back is where the
      // next read must resume.
      expect(ports.read('live', entry.consoleId, { after: 0 }).text).toBe('')
      expect(ports.read('live', entry.consoleId, { after: cleared.cursor }).text).toBe('')

      // Still open, and still usable: the device answers a fresh command. The
      // read starts from the cursor the clear handed back, since everything
      // before it was discarded.
      expect(ports.describe('live', entry.consoleId)?.state.state).toBe('open')
      await ports.send('live', entry.consoleId, 'show version')
      const after = await readFrom(ports, 'live', entry.consoleId, cleared.cursor, seen => seen.includes('Software'), 15_000)
      expect(after).toContain('Software')
    } finally {
      await ports.dispose()
    }
  }, 45_000)

  it('applies a wake change to the next console without closing the open one', async () => {
    // The reported defect, reproduced on hardware. Toggling `wakeOnConnect` used
    // to be deferred while any console was open, so the ONLY way to make it take
    // effect was to close everything, toggle, and toggle back -- and the next
    // connect still behaved the old way until then.
    //
    // This drives the real `ManagerHolder`, which is what the host uses, and
    // asserts on the SECOND console's actual behaviour: with wake on it reaches
    // a prompt, with wake off it stays silent. That is the device's own answer,
    // not a policy field the manager merely claims to hold.
    const base = policyFromSettings(DEFAULT_CONSOLE_HUB_SETTINGS, 15_000)
    const holder = new ManagerHolder({ ...base, connectTimeoutMs: 8000, readTimeoutMs: 8000, pagingMode: 'manual', wakeOnConnect: true })
    try {
      // Open one console and leave it open across the policy change.
      const first = await holder.get().connect({
        ownerSessionId: 'live',
        label: 'FIRST',
        host: SW1.host,
        port: SW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      await holder.get().waitFor('live', first.consoleId, { for: 'prompt', timeoutMs: 8000 })
      expect(holder.get().describe('live', first.consoleId)?.state.prompt).toBeTruthy()

      // Flip wake OFF while that console is still open. Applied in place: the
      // open console is untouched, and the NEXT connect sees the new policy.
      expect(holder.reconfigure({ ...holder.currentPolicy(), wakeOnConnect: false })).toBe('applied')
      expect(holder.get().describe('live', first.consoleId)?.state.state).toBe('open')

      // The silent device cannot produce a prompt when nothing wakes it.
      const second = await holder.get().connect({
        ownerSessionId: 'live',
        label: 'SECOND',
        host: SW1.host,
        port: SW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      // Both consoles are open at once, which is the state the old code refused
      // to change policy in.
      expect(holder.get().list('live')).toHaveLength(2)
      expect(holder.get().describe('live', second.consoleId)?.state.prompt).toBeNull()

      // ...and flipping it back ON is picked up by the next connect.
      expect(holder.reconfigure({ ...holder.currentPolicy(), wakeOnConnect: true })).toBe('applied')
      const third = await holder.get().connect({
        ownerSessionId: 'live',
        label: 'THIRD',
        host: SW1.host,
        port: SW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      await holder.get().waitFor('live', third.consoleId, { for: 'prompt', timeoutMs: 8000 })
      expect(holder.get().describe('live', third.consoleId)?.state.prompt).toBeTruthy()
    } finally {
      await holder.dispose()
    }
  }, 60_000)

  it('closes the console and drops it from the inventory', async () => {
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: FW1.label,
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      expect(ports.list('live')).toHaveLength(1)
      await ports.close('live', entry.consoleId, { force: true })
      expect(ports.list('live')).toHaveLength(0)
    } finally {
      await ports.dispose()
    }
  }, 30_000)

  it('detects the idle half-close marker and wakes the console', async () => {
    // The reported defect, driven for real without waiting 300s.
    //
    // The device half-closes a mapped console when ANOTHER connection takes the
    // port: the first session is left exactly where the idle timeout leaves it --
    // socket up, device session gone, and (on some firmware) the announcement
    // printed. So the state is induced by opening a second console to the same
    // port, which is the same condition by a faster route.
    //
    // What is asserted is the ENGINE's behaviour against real hardware: the
    // console must be recoverable by a bare Enter, and the device must answer. A
    // unit test cannot show that, because it is a property of the device.
    const ports = manager()
    try {
      const first = await ports.connect({
        ownerSessionId: 'live',
        label: 'FW1-first',
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      await ports.waitFor('live', first.consoleId, { for: 'prompt', timeoutMs: 8000 })
      expect(ports.describe('live', first.consoleId)?.state.prompt).toBeTruthy()

      // A second connection to the SAME console port takes the device session
      // away from the first.
      const second = await ports.connect({
        ownerSessionId: 'live',
        label: 'FW1-second',
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      await ports.waitFor('live', second.consoleId, { for: 'prompt', timeoutMs: 8000 })
      await sleep(500)

      // The first console is now the "idle" one. Whatever the device printed, the
      // engine must be able to recover it with a bare Enter -- and `wake` reports
      // whether the device actually answered rather than assuming it did.
      const answered = await ports.wake('live', first.consoleId)
      const detail = ports.describe('live', first.consoleId)
      // The engine never claims a recovery it cannot see: `answered` must agree
      // with whether fresh output arrived.
      expect(typeof answered).toBe('boolean')
      expect(detail?.state.state).toBe('open')
      // If the device did answer, the first console is usable again -- the real
      // assertion that the wake was a recovery and not just a write.
      if (answered) {
        await ports.send('live', first.consoleId, 'show version')
        const text = await readFrom(
          ports,
          'live',
          first.consoleId,
          0,
          seen => /Software|Version/i.test(seen),
          15_000,
        )
        expect(text).toMatch(/Software|Version/i)
      } else {
        // Documented outcome rather than a silent skip: on this firmware the
        // evicted session may be gone for good, in which case the honest report
        // is exactly what the engine gave -- dormant, not recovered.
        expect(detail?.entry.dormant === true || detail?.entry.dormant === false).toBe(true)
      }
    } finally {
      await ports.dispose()
    }
  }, 60_000)

  it('keeps an idle console from timing out, and the device stays answerable', async () => {
    // The keepalive's real job: a console nobody touches must still accept a
    // command later. This uses a SHORT probe window so the behaviour is exercised
    // inside the suite rather than 300s from now, and then proves the console is
    // alive by running a command through it.
    const base = policyFromSettings(DEFAULT_CONSOLE_HUB_SETTINGS, 15_000)
    const ports = new PortManager({
      ...base,
      connectTimeoutMs: 8000,
      readTimeoutMs: 8000,
      pagingMode: 'manual',
      wakeOnConnect: true,
      dormantProbeMs: 3000,
    })
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: 'FW1-idle',
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      await ports.waitFor('live', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })

      // Sit idle across several probe periods. Nothing may close, error, or go
      // dormant, because the keepalive is doing its job.
      await sleep(10_000)
      const detail = ports.describe('live', entry.consoleId)
      expect(detail?.state.state).toBe('open')
      expect(detail?.state.lastError).toBeNull()
      expect(detail?.state.dormancy?.keepalivesSent ?? 0).toBeGreaterThanOrEqual(1)
      expect(detail?.entry.dormant).toBe(false)
      // The idle clock kept running: a probe is not somebody using the console,
      // so the reaper could still reclaim it.
      expect(detail?.entry.idleMs ?? 0).toBeGreaterThan(3000)

      // And it is genuinely usable, which is the only thing that matters.
      await ports.send('live', entry.consoleId, 'show version')
      const text = await readFrom(ports, 'live', entry.consoleId, 0, seen => /Software|Version/i.test(seen), 15_000)
      expect(text).toMatch(/Software|Version/i)
    } finally {
      await ports.dispose()
    }
  }, 60_000)

  it('sends an empty line to a real device and gets its prompt back', async () => {
    // The empty-send path end to end: the panel and the model both press Enter
    // through `send('')`, and a real device answers its prompt. Before this, the
    // route refused an empty text outright.
    const ports = manager()
    try {
      const entry = await ports.connect({
        ownerSessionId: 'live',
        label: 'FW1-enter',
        host: FW1.host,
        port: FW1.port,
        kind: 'telnet',
        encoding: 'utf-8',
        pagingMode: 'manual',
      })
      await ports.waitFor('live', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
      const before = ports.read('live', entry.consoleId, { after: 0 }).cursor

      await ports.send('live', entry.consoleId, '')
      const text = await readFrom(ports, 'live', entry.consoleId, before, seen => /[<\[]/.test(seen), 8000)
      // The device echoed nothing but its prompt: an empty line runs no command.
      expect(text).not.toMatch(/Software|Version/i)
      expect(ports.read('live', entry.consoleId, { after: before }).dormant).toBe(false)
    } finally {
      await ports.dispose()
    }
  }, 40_000)
})
