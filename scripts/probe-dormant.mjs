/**
 * Measure what a real console does when it sits IDLE for a long time.
 *
 * A console server that finds a mapped line unused for too long tears the
 * session down on the DEVICE side while leaving the TCP connection open -- a
 * half-close. The device then prints something like
 *
 *     Vty connection is timed out.
 *
 *     Please press ENTER.
 *
 * and stops printing device events until somebody presses a key. Nothing on the
 * socket reports this, so the plugin's `state` stays `open` while the console is
 * actually dormant. This probe measures the three facts an implementation needs:
 *
 * 1. HOW LONG the idle period is before the device says so (is it fixed?).
 * 2. WHAT the marker text actually is, byte for byte (it is matched on later).
 * 3. WHETHER one Enter recovers it, and how fast (does the recovery Enter get
 *    eaten, so a second one is needed?).
 *
 * Discovered here, so the constants and the pattern are measured rather than
 * guessed. Usage:
 *
 *   node scripts/probe-dormant.mjs [host:port] [idleBudgetMs] [postRecoveryMs]
 */
import { Socket } from 'node:net'

const target = process.argv[2] ?? '10.133.5.253:10015'
const idleBudgetMs = Number(process.argv[3] ?? '300000')
const postRecoveryMs = Number(process.argv[4] ?? '30000')
const [host, portText] = target.split(':')
const port = Number(portText)

/** The bracket pairs these devices print: `<HOST>` user view, `[HOST]` config view. */
const PROMPT = /[<[]\s*[\w.\-/]+\s*[>\]]\s*$/

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(...parts) {
  console.log(...parts)
}

/**
 * Connect and run one experiment.
 *
 * The socket stays open and every inbound chunk is timestamped, so "the device
 * said nothing for N seconds" is a recorded fact rather than an inference from a
 * final buffer.
 */
async function run() {
  const socket = new Socket()
  socket.setEncoding('latin1')
  let pending = ''
  const chunks = []
  let closed = false
  let errored = null

  socket.on('data', (chunk) => {
    pending += chunk
    chunks.push({ at: Date.now(), text: chunk })
  })
  socket.on('close', () => { closed = true })
  socket.on('error', (error) => { errored = error.message; closed = true })

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('connect timed out')) }, 8000)
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
    socket.connect({ host, port })
  })
  log(`[probe] connected to ${host}:${port}`)

  // ── Step 1: wake it, so the console is in a known-good state ──────────────
  await sleep(600)
  const wakeSentAt = Date.now()
  socket.write('\r')
  let wokeAt = null
  for (let waited = 0; waited < 3000 && wokeAt === null; waited += 25) {
    await sleep(25)
    if (PROMPT.test(pending)) wokeAt = Date.now()
  }
  log(`[probe] wake Enter answered in ${wokeAt === null ? 'NEVER (>3000ms)' : `${String(wokeAt - wakeSentAt)}ms`}`)
  log(`[probe]   tail=${JSON.stringify(pending.slice(-120))}`)

  // ── Step 2: go idle and watch for the device to half-close ────────────────
  const idleStart = Date.now()
  const markChunkCount = chunks.length
  let dormantAt = null
  let dormantText = null
  log(`[probe] going idle; budget ${idleBudgetMs}ms (${Math.round(idleBudgetMs / 1000)}s)`)

  while (Date.now() - idleStart < idleBudgetMs && !closed) {
    await sleep(200)
    // Only consider bytes that arrived AFTER the idle period began: the wake
    // echo above is not an event.
    const fresh = chunks.slice(markChunkCount).map(entry => entry.text).join('')
    if (dormantAt === null && /timed out|press\s+enter/i.test(fresh)) {
      dormantAt = Date.now()
      dormantText = fresh
      log(`[probe] *** device announced the timeout after ${String(dormantAt - idleStart)}ms idle ***`)
      log(`[probe]   text=${JSON.stringify(fresh)}`)
      break
    }
    if (closed) break
  }

  if (closed) {
    log(`[probe] socket CLOSED during idle after ${String(Date.now() - idleStart)}ms; error=${String(errored)}`)
    log(`[probe]   text=${JSON.stringify(chunks.map(entry => entry.text).join('').slice(-300))}`)
    socket.destroy()
    return
  }
  if (dormantAt === null) {
    log(`[probe] no timeout message within the budget; still open. tail=${JSON.stringify(pending.slice(-200))}`)
    socket.destroy()
    return
  }

  // ── Step 3: does one Enter recover it? ────────────────────────────────────
  const beforeRecovery = chunks.length
  const recoverSentAt = Date.now()
  socket.write('\r')
  let recoveredAt = null
  for (let waited = 0; waited < 5000 && recoveredAt === null; waited += 25) {
    await sleep(25)
    const fresh = chunks.slice(beforeRecovery).map(entry => entry.text).join('')
    if (PROMPT.test(fresh)) recoveredAt = Date.now()
  }
  const recoveryText = chunks.slice(beforeRecovery).map(entry => entry.text).join('')
  log(`[probe] recovery: ${recoveredAt === null ? 'NO PROMPT within 5000ms' : `prompt after ${String(recoveredAt - recoverSentAt)}ms`}`)
  log(`[probe]   received=${JSON.stringify(recoveryText)}`)

  // ── Step 4: is it a real console again? send a command ────────────────────
  const beforeCommand = chunks.length
  const commandSentAt = Date.now()
  socket.write('show version\r')
  await sleep(2500)
  const commandText = chunks.slice(beforeCommand).map(entry => entry.text).join('')
  log(`[probe] after recovery, "show version" received ${String(commandText.length)} chars in 2500ms`)
  log(`[probe]   head=${JSON.stringify(commandText.slice(0, 160))}`)
  log(`[probe]   hasPrompt=${String(PROMPT.test(commandText))}`)
  void commandSentAt

  // ── Step 5: how long until it times out AGAIN (does activity reset it)? ───
  log(`[probe] idling again for ${postRecoveryMs}ms to time the second timeout`)
  const secondStart = Date.now()
  const beforeSecond = chunks.length
  let secondAt = null
  while (Date.now() - secondStart < postRecoveryMs && !closed) {
    await sleep(200)
    const fresh = chunks.slice(beforeSecond).map(entry => entry.text).join('')
    if (/timed out|press\s+enter/i.test(fresh)) {
      secondAt = Date.now()
      log(`[probe] second timeout after ${String(secondAt - secondStart)}ms of idle`)
      break
    }
  }
  if (secondAt === null) {
    log(`[probe] no second timeout within ${postRecoveryMs}ms -> activity RESETS the idle timer`)
  }
  socket.destroy()
}

run().then(() => process.exit(0)).catch((error) => {
  console.error(`[probe] fatal: ${error.message}`)
  process.exit(1)
})
