/**
 * Diagnose why the idle keepalive did or did not fire against a real device.
 *
 * The live suite reported `keepalivesSent: 0` after ten idle seconds with a
 * 3s probe window. Rather than guess, this prints the session's own state on a
 * timeline so the timer's behaviour is observed rather than inferred.
 *
 * Usage: node scripts/probe-keepalive.mjs [host:port] [probeMs] [watchMs]
 */
import { PortManager } from '../src/port-manager.ts'
import { DEFAULT_CONSOLE_HUB_SETTINGS, DEFAULT_PROMPT_PATTERN, DEFAULT_PAGER_PATTERN, DEFAULT_DORMANT_PATTERN } from '../src/config-shared.ts'

const target = process.argv[2] ?? '10.133.6.253:10003'
const probeMs = Number(process.argv[3] ?? '3000')
const watchMs = Number(process.argv[4] ?? '12000')
const [host, portText] = target.split(':')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const ports = new PortManager({
  maxConsoles: 4,
  scrollbackLimitBytes: 256 * 1024,
  outputLimitBytes: 64 * 1024,
  connectTimeoutMs: 8000,
  readTimeoutMs: 8000,
  idleTimeoutMs: 60_000,
  idleSweepMs: 15_000,
  pagingMode: 'manual',
  pagingMaxPages: DEFAULT_CONSOLE_HUB_SETTINGS.pagingMaxPages,
  pagingQuietMs: DEFAULT_CONSOLE_HUB_SETTINGS.pagingQuietMs,
  promptPattern: DEFAULT_PROMPT_PATTERN,
  pagerPattern: DEFAULT_PAGER_PATTERN,
  dormantPattern: DEFAULT_DORMANT_PATTERN,
  dormantAutoWake: true,
  dormantProbeMs: probeMs,
  wakeOnConnect: true,
})

const entry = await ports.connect({
  sessionId: 'probe',
  label: 'PROBE',
  host,
  port: Number(portText),
  kind: 'telnet',
  encoding: 'utf-8',
  pagingMode: 'manual',
})
console.log(`[ka] connected: state=${entry.state} probeMs=${String(probeMs)}`)
await ports.waitFor('probe', entry.consoleId, { for: 'prompt', timeoutMs: 8000 })

const started = Date.now()
for (let elapsed = 0; elapsed <= watchMs; elapsed += 500) {
  const detail = ports.describe('probe', entry.consoleId)
  const d = detail?.state.dormancy
  console.log(
    `[ka] t=${String(elapsed).padStart(6)}ms idleMs=${String(detail?.entry.idleMs ?? -1).padStart(6)} `
    + `keepalives=${String(d?.keepalivesSent ?? -1)} wakes=${String(d?.wakesSent ?? -1)} `
    + `dormant=${String(d?.dormant ?? '?')} `
    + `rx=${String(detail?.state.bytesReceived ?? -1)} tx=${String(detail?.state.bytesWritten ?? -1)}`,
  )
  await sleep(500)
}
console.log(`[ka] elapsed ${String(Date.now() - started)}ms`)
await ports.dispose()
process.exit(0)
