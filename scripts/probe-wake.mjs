/**
 * Measure how long a real console takes to answer a wake Enter.
 *
 * `wakeOnConnect` sends one bare Enter when a device greets nothing, then waits
 * a second banner window for the prompt. That window is 300ms by default, and
 * whether it is ENOUGH is a property of the hardware, not of the code -- so it
 * has to be measured rather than assumed. A window that expires first makes
 * `open()` return "no prompt", which is exactly the shape a user reads as "the
 * device said nothing on connect".
 *
 * Usage: node scripts/probe-wake.mjs <host:port> [rounds] [quietMs]
 */
import { Socket } from 'node:net'

const target = process.argv[2] ?? '10.133.5.253:10015'
const rounds = Number(process.argv[3] ?? '3')
const [host, portText] = target.split(':')
const port = Number(portText)

const timers = []
function later(fn, ms) {
  const handle = setTimeout(fn, ms)
  timers.push(handle)
  return handle
}
function clearAll() {
  for (const handle of timers) clearTimeout(handle)
  timers.length = 0
}

/** One round: connect, wait `quietMs`, send Enter, and time the prompt. */
function round(index, quietMs) {
  return new Promise((resolve) => {
    const socket = new Socket()
    socket.setEncoding('latin1')
    let phase = 'connecting'
    let sentAt = 0
    let pending = ''
    const result = { index, quietMs, connectMs: 0, promptMs: null, tail: '', wakeEcho: '' }

    const started = Date.now()
    socket.on('connect', () => {
      result.connectMs = Date.now() - started
      phase = 'quiet'
      later(() => {
        phase = 'waking'
        sentAt = Date.now()
        socket.write('\r')
      }, quietMs)
    })
    socket.on('data', (chunk) => {
      pending += chunk
      const tail = pending.slice(-200)
      // The prompt is the bracket pair these devices print: `<HOST>` in the user
      // view, `[HOST]` in the config view.
      const match = tail.match(/[<\[]\s*[\w.\-]+\s*[>\]]\s*$/)
      if (phase === 'waking' && result.promptMs === null && match !== null) {
        result.promptMs = Date.now() - sentAt
        result.wakeEcho = JSON.stringify(pending)
        phase = 'done'
        clearAll()
        socket.destroy()
        resolve(result)
      }
    })
    socket.on('error', (error) => {
      clearAll()
      socket.destroy()
      resolve({ ...result, error: error.message })
    })
    // Generous outer bound: this measures the prompt, and a device that never
    // sends one is a result too (promptMs stays null).
    later(() => {
      result.tail = JSON.stringify(pending.slice(-200))
      clearAll()
      socket.destroy()
      resolve(result)
    }, 6000)
    socket.connect({ host, port })
  })
}

const quiet = Number(process.argv[4] ?? '600')
console.log(`[probe] ${host}:${port} — ${rounds} round(s), ${quiet}ms quiet window before the wake Enter\n`)
for (let index = 1; index <= rounds; index += 1) {
  const result = await round(index, quiet)
  if (result.error !== undefined) {
    console.log(`round ${index}: ERROR ${result.error}`)
    continue
  }
  const verdict = result.promptMs === null
    ? `NO PROMPT within the probe window; tail=${result.tail}`
    : `prompt after ${result.promptMs}ms`
  console.log(`round ${index}: connect ${result.connectMs}ms -> ${verdict}`)
  if (result.wakeEcho !== '') console.log(`          received: ${result.wakeEcho}`)
}
process.exit(0)
