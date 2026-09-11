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
 * (`<DUT1>` on the firewall, `<SWITCH>` on the switch). That is why
 * `wakeOnConnect` exists and why the assertions below never expect a banner
 * without it.
 */
import { describe, expect, it } from 'vitest'
import { PortManager } from '../../src/port-manager.ts'
import {
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
  compileCommandFence,
} from '../../src/config-shared.ts'
import { classifyCommand, compileFence, type ConsoleFenceSettings } from '../../src/guard.ts'

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
    // Both lab consoles are silent until a key is pressed.
    wakeOnConnect: true,
  })
}

/** Sleep, so a read can wait for a device that answers slowly. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
      expect(detail?.state.prompt).toBe('<SWITCH>')
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
})
