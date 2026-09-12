/**
 * Prove or disprove the false-'done' failure of `waitFor({for:'idle'})`.
 *
 * The measurement in `probe-output-gaps.mjs` found the lab firewall emits ~960
 * byte slabs about 1000ms apart. If that is right, an idle wait at the 250ms
 * default must report `matched: true` while the device is still mid-answer --
 * a wait that says "the output stopped" when it did not.
 *
 * This asserts the actual user-visible consequence: send a long command, wait
 * for idle with the default, and check whether the answer was still incomplete.
 * The verdict is the whole point, so it prints the two facts side by side: how
 * much was read at match time, and how much arrives if you keep reading.
 *
 * Usage: node --import ./scripts/test-preload.mjs scripts/probe-idle-falsedone.mjs [host:port] [idleMs]
 */
import { PortManager } from '../src/port-manager.ts'
import {
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_DORMANT_PATTERN,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
} from '../src/config-shared.ts'

const target = process.argv[2] ?? '10.133.6.253:10003'
const idleMs = Number(process.argv[3] ?? '250')
const [host, portText] = target.split(':')
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
  ownerSessionId: 'probe',
  label: 'FALSEDONE',
  host,
  port: Number(portText),
  kind: 'telnet',
  encoding: 'utf-8',
  pagingMode: 'manual',
})
await ports.waitFor('probe', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
await sleep(300)

const command = 'show running-config'
const start = ports.read('probe', entry.consoleId, { after: 0 }).cursor
await ports.send('probe', entry.consoleId, command)

// The wait exactly as a caller uses it: no idleMs, so the 250ms default.
const waited = await ports.waitFor('probe', entry.consoleId, { for: 'idle', timeoutMs: 8000, idleMs })
const atMatch = ports.read('probe', entry.consoleId, { after: start })
console.log(`[falsedone] idle wait (idleMs=${String(idleMs)}) matched=${String(waited.matched)} in ${String(waited.elapsedMs)}ms`)
console.log(`[falsedone] text read at match time: ${String(atMatch.text.length)} chars`)
console.log(`[falsedone]   tail: ${JSON.stringify(atMatch.text.slice(-100))}`)

// Keep reading for a while: whatever arrives now is output the idle wait claimed
// had stopped.
let extra = ''
let cursor = atMatch.cursor
const drainUntil = Date.now() + 6000
let lastGrowth = Date.now()
while (Date.now() < drainUntil && Date.now() - lastGrowth < 1500) {
  const next = ports.read('probe', entry.consoleId, { after: cursor })
  if (next.cursor !== cursor) {
    extra += next.text
    cursor = next.cursor
    lastGrowth = Date.now()
  }
  await sleep(50)
}
console.log(`[falsedone] text that arrived AFTER the match: ${String(extra.length)} chars`)
console.log(`[falsedone]   head: ${JSON.stringify(extra.slice(0, 100))}`)

const falseDone = waited.matched && extra.length > 0
// Three outcomes, not two. `matched` with nothing after it is also a FALSE
// result, just in the other direction: the wait reported "the output stopped"
// and then stopped waiting. It is not the truncation bug, but it is still a wait
// that gave up rather than observing quiet.
const verdict = falseDone
  ? `FALSE 'done' -- matched ${String(waited.elapsedMs)}ms in, then ${String(extra.length)} more chars arrived`
  : waited.matched
    ? `matched genuinely quiet at ${String(waited.elapsedMs)}ms, nothing followed`
    : `no quiet stretch long enough within the budget: the answer kept arriving`
    + ` (${String(extra.length)} chars still coming), so the wait TIMED OUT rather than lying`
console.log(`\n[falsedone] VERDICT: ${verdict}`)
console.log(
  `[falsedone]   (the device answers in ~960-byte slabs about 1000ms apart, so an idle window `
  + `shorter than that MUST match mid-answer)`,
)
await ports.dispose()
process.exit(0)
