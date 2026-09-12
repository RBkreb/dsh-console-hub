/**
 * Measure the GAPS between output chunks during a real command's answer.
 *
 * This exists because `console_wait_for` with `for: 'idle'` matches on a quiet
 * window (no new bytes for `idleMs`, default 250ms). Whether 250ms is a sane
 * default is a property of the hardware: a device that pauses longer than that
 * in the MIDDLE of a long answer would make an idle wait report "done" while the
 * device is still talking.
 *
 * So this measures the actual distribution of inter-chunk gaps during a real
 * command, at the exact granularity the engine keys on: the ring buffer's
 * absolute write cursor, polled fast. It reports the largest gap and the top
 * few, which is what decides the default.
 *
 * Usage: node --import ./scripts/test-preload.mjs scripts/probe-output-gaps.mjs [host:port] [command]
 */
import { PortManager } from '../src/port-manager.ts'
import {
  DEFAULT_CONSOLE_HUB_SETTINGS,
  DEFAULT_DORMANT_PATTERN,
  DEFAULT_PAGER_PATTERN,
  DEFAULT_PROMPT_PATTERN,
} from '../src/config-shared.ts'

const target = process.argv[2] ?? '10.133.6.253:10003'
const command = process.argv[3] ?? 'show version'
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
  sessionId: 'probe',
  label: 'GAPS',
  host,
  port: Number(portText),
  kind: 'telnet',
  encoding: 'utf-8',
  pagingMode: 'manual',
})
await ports.waitFor('probe', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })
await sleep(300)

/**
 * Poll the ring's write cursor as fast as the event loop allows, recording the
 * arrival time of every growth event. This is the same signal `waitFor` uses.
 */
async function measure(label, budgetMs) {
  // Drain anything already buffered so the measurement is of THIS command.
  const startCursor = ports.read('probe', entry.consoleId, { after: 0 }).cursor
  const arrivals = []
  let cursor = startCursor
  const started = Date.now()
  const before = cursor
  while (Date.now() - started < budgetMs) {
    const now = ports.read('probe', entry.consoleId, { after: cursor })
    if (now.cursor !== cursor) {
      arrivals.push({ at: Date.now(), bytes: now.cursor - cursor, text: now.text })
      cursor = now.cursor
    }
    await sleep(2)
  }
  const total = cursor - before
  if (arrivals.length === 0) {
    console.log(`[gaps] ${label}: NO output arrived in ${String(budgetMs)}ms`)
    return null
  }
  const gaps = []
  for (let index = 1; index < arrivals.length; index += 1) {
    gaps.push(arrivals[index].at - arrivals[index - 1].at)
  }
  const totalMs = arrivals.at(-1).at - arrivals[0].at
  console.log(
    `[gaps] ${label}: ${String(arrivals.length)} chunk(s), ${String(total)} bytes, `
    + `span ${String(totalMs)}ms`,
  )
  // Per-chunk sizes and text heads, so a ~1KB/1s cadence can be told apart from
  // a pager pause: a pager shows `--More--` and then stops ENTIRELY, whereas a
  // size-limited console dribbles fixed-size slabs.
  const preview = arrivals.slice(0, 4).map((arrival) => {
    const head = arrival.text.replace(/[\r\n]+/g, ' ').slice(0, 40)
    return `${String(arrival.bytes)}B:"${head}"`
  })
  console.log(`[gaps]   first chunks: ${preview.join(' | ')}`)
  const sawPager = arrivals.some(arrival => /--\s*more\s*--|more:/i.test(arrival.text))
  console.log(`[gaps]   any pager text mid-stream: ${String(sawPager)}`)
  const sorted = [...gaps].sort((left, right) => right - left)
  console.log(
    `[gaps]   largest gaps: ${sorted.slice(0, 8).map(gap => `${String(gap)}ms`).join(', ')}`
    + `${sorted.length > 8 ? ` (of ${String(sorted.length)} total)` : ''}`,
  )
  // The number that matters: how quiet the device got MID-ANSWER.
  console.log(`[gaps]   MAX GAP = ${String(sorted[0] ?? 0)}ms`)
  return sorted[0] ?? 0
}

console.log(`[gaps] target ${host}:${portText}, command "${command}"`)
console.log(`[gaps] an idle wait with the default idleMs=250 matches after any 250ms quiet stretch\n`)

// Send the command and measure its whole answer.
await ports.send('probe', entry.consoleId, command)
const maxGap = await measure('during answer', 12_000)

// A second, longer command: more pages means more chances to pause mid-answer.
await ports.send('probe', entry.consoleId, 'show running-config')
const maxGap2 = await measure('during a long answer', 20_000)

// And the pathological case for an idle wait: a command that prints NOTHING.
await sleep(500)
const quietStart = ports.read('probe', entry.consoleId, { after: 0 }).cursor
const quietStarted = Date.now()
const quiet = await ports.waitFor('probe', entry.consoleId, { for: 'idle', timeoutMs: 4000 })
const quietElapsed = Date.now() - quietStarted
const quietText = ports.read('probe', entry.consoleId, { after: quietStart }).text
console.log(
  `\n[gaps] idle wait on an ALREADY-QUIET console (nothing sent): `
  + `matched=${String(quiet.matched)} in ${String(quietElapsed)}ms, text="${quietText.trim()}"`,
)
console.log(`[gaps]   => an idle wait does NOT require any output to have arrived`)

console.log(
  `\n[gaps] VERDICT: the device paused up to ${String(Math.max(maxGap ?? 0, maxGap2 ?? 0))}ms `
  + `mid-answer; the default idleMs is 250ms`,
)
await ports.dispose()
process.exit(0)
