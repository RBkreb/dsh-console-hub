/**
 * Observe what the SWITCH answers to the one permitted test command.
 *
 * Read-only observation of the device's own output: it connects, sends exactly
 * `configuration rollback replace BasicConfig` (the single command authorized for
 * testing, on the single authorized device), and prints every byte that comes
 * back on a timeline. This exists because the live assertion needs to know what
 * "it responded" looks like on this firmware, instead of guessing a keyword.
 *
 * What it found: the switch echoes the command (~120ms), then takes about 3.2s
 * and returns a bare `<SWITCH>` prompt with NO success or failure text. So "the
 * prompt came back" is the only completion signal available, and an assertion on
 * a word like "success" would have been wrong.
 *
 * Usage: node --import ./scripts/test-preload.mjs scripts/probe-rollback.mjs
 */
import { PortManager } from '../src/port-manager.ts'
import {
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_DORMANT_PATTERN,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
} from '../src/config-shared.ts'

const COMMAND = 'configuration rollback replace BasicConfig'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ports = new PortManager({
  maxConsoles: 2,
  scrollbackLimitBytes: 1024 * 1024,
  outputLimitBytes: 64 * 1024,
  connectTimeoutMs: 8000,
  readTimeoutMs: 8000,
  idleTimeoutMs: 600_000,
  idleSweepMs: 15_000,
  pagingMode: 'manual',
  pagingMaxPages: DEFAULT_CONSOLE_HUB_SETTINGS.pagingMaxPages,
  pagingQuietMs: DEFAULT_CONSOLE_HUB_SETTINGS.pagingQuietMs,
  promptPattern: DEFAULT_PROMPT_PATTERN,
  pagerPattern: DEFAULT_PAGER_PATTERN,
  dormantPattern: DEFAULT_DORMANT_PATTERN,
  dormantAutoWake: true,
  dormantProbeMs: 0,
  wakeOnConnect: true,
})

const entry = await ports.connect({
  sessionId: 'probe',
  label: 'SW',
  host: '10.133.5.253',
  port: 10015,
  kind: 'telnet',
  encoding: 'utf-8',
  pagingMode: 'manual',
})
const opened = await ports.waitFor('probe', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
console.log(`[rollback] connected; prompt=${JSON.stringify(ports.describe('probe', entry.consoleId)?.state.prompt)} matched=${String(opened.matched)}`)
await sleep(300)

const before = ports.read('probe', entry.consoleId, { after: 0 }).cursor
console.log(`[rollback] sending the ONE authorized command: ${COMMAND}`)
await ports.send('probe', entry.consoleId, COMMAND)

// Poll for a while and print every growth event, so the device's own pacing and
// wording are visible rather than summarised.
let cursor = before
const started = Date.now()
let lastGrowth = Date.now()
while (Date.now() - lastGrowth < 4000 && Date.now() - started < 30_000) {
  const read = ports.read('probe', entry.consoleId, { after: cursor })
  if (read.cursor !== cursor) {
    console.log(`[rollback] t=+${String(Date.now() - started)}ms (+${String(read.cursor - cursor)}B) ${JSON.stringify(read.text)}`)
    cursor = read.cursor
    lastGrowth = Date.now()
  }
  await sleep(50)
}

console.log(`[rollback] prompt now=${JSON.stringify(ports.describe('probe', entry.consoleId)?.state.prompt)}`)
const full = ports.read('probe', entry.consoleId, { after: before })
console.log(`[rollback] TOTAL ${String(full.text.length)} chars since the command`)
console.log(`[rollback] contains the command echo: ${String(full.text.includes(COMMAND))}`)
await ports.dispose()
process.exit(0)
