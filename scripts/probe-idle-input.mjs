/**
 * Establish what the device's idle timer actually keys on.
 *
 * The keepalive design assumed "idle" meant no traffic in either direction. A
 * real firewall disproved the easy version of that: it streams device events
 * continuously (~950 bytes / 500ms) and yet still announced
 * "Vty connection is timed out" after 300s during the earlier probe. If that is
 * right, the device's timer counts INPUT (keystrokes) only, and a keepalive that
 * resets on inbound output would never fire on precisely the device that needs
 * it most.
 *
 * This measures it directly: connect, send NOTHING after the initial wake, count
 * the bytes the device sends, and watch for the marker. The answer decides what
 * the keepalive clock must be driven by.
 *
 * Usage: node scripts/probe-idle-input.mjs [host:port] [budgetMs]
 */
import { Socket } from 'node:net'

const target = process.argv[2] ?? '10.133.6.253:10003'
const budgetMs = Number(process.argv[3] ?? '360000')
const [host, portText] = target.split(':')
const port = Number(portText)

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const socket = new Socket()
socket.setEncoding('latin1')
let received = 0
let pending = ''
let markerAt = null
let closedAt = null
let errored = null

socket.on('data', (chunk) => {
  received += chunk.length
  pending += chunk
  if (markerAt === null && /timed out|press\s+enter/i.test(pending.slice(-400))) {
    markerAt = Date.now()
  }
})
socket.on('close', () => { closedAt = Date.now() })
socket.on('error', (error) => { errored = error.message })

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('connect timed out')) }, 8000)
  socket.once('connect', () => { clearTimeout(timer); resolve() })
  socket.once('error', (error) => { clearTimeout(timer); reject(error) })
  socket.connect({ host, port })
})

// One wake Enter, the way a real connect does it, then TOTAL silence on the wire.
await sleep(600)
socket.write('\r')
await sleep(500)
console.log(`[idle-input] woke the device; bytes received so far: ${String(received)}`)
console.log('[idle-input] now sending NOTHING at all; watching for the marker')

const started = Date.now()
let lastReport = 0
while (Date.now() - started < budgetMs && markerAt === null && closedAt === null) {
  await sleep(500)
  const elapsed = Date.now() - started
  if (elapsed - lastReport >= 30_000) {
    lastReport = elapsed
    console.log(
      `[idle-input] t=${String(Math.round(elapsed / 1000)).padStart(4)}s `
      + `bytesReceived=${String(received)} (device is ${received > 0 ? 'TALKING' : 'silent'})`,
    )
  }
}
socket.destroy()

const verdict = markerAt !== null
  ? `marker after ${String(Math.round((markerAt - started) / 1000))}s of INPUT silence`
  : closedAt !== null
    ? `socket CLOSED after ${String(Math.round((closedAt - started) / 1000))}s`
    : `no marker within ${String(Math.round(budgetMs / 1000))}s`
console.log(`[idle-input] RESULT: ${verdict}`)
console.log(`[idle-input] bytes received during the idle period: ${String(received)}`)
console.log(
  `[idle-input] => the device's idle timer is driven by ${received > 0
    ? 'INPUT ONLY (it kept sending output while still timing the session out)'
    : 'either direction (it went quiet before timing out)'}`,
)
if (errored !== null) console.log(`[idle-input] socket error: ${errored}`)
process.exit(0)
