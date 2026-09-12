/**
 * Measure the WORST inter-slab gap for a long answer, repeatedly.
 *
 * `probe-output-gaps.mjs` found ~1000ms gaps and I set the idle window to
 * 1500ms on that basis. A live test then matched an idle wait mid-answer anyway,
 * which means some gap EXCEEDS the window -- so a single measurement was not
 * enough to set a default. This runs the same command several times and reports
 * the worst gap across all of them, which is the number the default has to clear.
 *
 * Usage: node --import ./scripts/test-preload.mjs scripts/probe-gap-spread.mjs [host:port] [rounds] [command]
 */
import { PortManager } from '../src/port-manager.ts'
import {
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_DORMANT_PATTERN,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
} from '../src/config-shared.ts'

const target = process.argv[2] ?? '10.133.6.253:10003'
const rounds = Number(process.argv[3] ?? '5')
const command = process.argv[4] ?? 'show running-config'
const [host, portText] = target.split(':')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ports = new PortManager({
  maxConsoles: 2,
  scrollbackLimitBytes: 4 * 1024 * 1024,
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
  label: 'SPREAD',
  host,
  port: Number(portText),
  kind: 'telnet',
  encoding: 'utf-8',
  pagingMode: 'manual',
})
await ports.waitFor('probe', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
await sleep(500)

console.log(`[spread] ${host}:${portText}, "${command}", ${String(rounds)} round(s)\n`)
const allMaxGaps = []
for (let round = 1; round <= rounds; round += 1) {
  const start = ports.read('probe', entry.consoleId, { after: 0 }).cursor
  await ports.send('probe', entry.consoleId, command)
  // Sample the arrival of every growth event, then stop once the device has been
  // quiet for longer than any plausible gap.
  const arrivals = []
  let cursor = start
  let lastGrowth = Date.now()
  const began = Date.now()
  while (Date.now() - lastGrowth < 4000 && Date.now() - began < 40_000) {
    const now = ports.read('probe', entry.consoleId, { after: cursor })
    if (now.cursor !== cursor) {
      arrivals.push(Date.now())
      cursor = now.cursor
      lastGrowth = Date.now()
    }
    await sleep(2)
  }
  const gaps = []
  for (let index = 1; index < arrivals.length; index += 1) gaps.push(arrivals[index] - arrivals[index - 1])
  const sorted = [...gaps].sort((left, right) => right - left)
  const worst = sorted[0] ?? 0
  allMaxGaps.push(worst)
  console.log(
    `[spread] round ${String(round)}: ${String(arrivals.length)} slab(s), ${String(cursor - start)} bytes, `
    + `span ${String((arrivals.at(-1) ?? began) - (arrivals[0] ?? began))}ms, worst gap ${String(worst)}ms`,
  )
  console.log(`[spread]          top gaps: ${sorted.slice(0, 5).map(gap => `${String(gap)}ms`).join(', ')}`)
}

const worstOverall = Math.max(...allMaxGaps)
console.log(`\n[spread] worst gap per round: ${allMaxGaps.map(gap => `${String(gap)}ms`).join(', ')}`)
console.log(`[spread] WORST OVERALL = ${String(worstOverall)}ms`)
console.log(
  `[spread] => an idleQuietMs at or below ${String(worstOverall)}ms can match MID-ANSWER on this device; `
  + `the shipped default is ${String(DEFAULT_CONSOLE_HUB_SETTINGS.idleQuietMs)}ms`,
)
await ports.dispose()
process.exit(0)
