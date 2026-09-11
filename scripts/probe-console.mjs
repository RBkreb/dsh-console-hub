/**
 * Manual probe: read what a real console actually emits on connect.
 *
 * Kept as a developer tool (not a test) because its output is nondeterministic
 * and its purpose is discovery — learning the real prompt/pager text before
 * writing assertions about it.
 *
 * Usage: node scripts/probe-console.mjs <host:port> [seconds]
 */
import { connect } from 'node:net'

const target = process.argv[2] ?? '10.133.6.253:10003'
const seconds = Number(process.argv[3] ?? '4')
const [host, portText] = target.split(':')
const port = Number(portText)

const socket = connect({ host, port })
let received = 0
const chunks = []

socket.setEncoding('latin1')
socket.on('connect', () => console.error(`[probe] connected to ${host}:${port}`))
socket.on('data', (chunk) => {
  received += chunk.length
  chunks.push(chunk)
})
socket.on('error', (error) => {
  console.error(`[probe] socket error: ${error.message}`)
})
socket.on('close', () => console.error('[probe] closed'))

setTimeout(() => {
  const raw = chunks.join('')
  // Show the bytes as an escaped byte string: control bytes are the whole
  // point of this probe, so they must stay visible.
  const escaped = raw.replace(/[\x00-\x1f\x7f-\xff]/g, ch =>
    `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
  console.log('--- bytes received:', received, '---')
  console.log(escaped)
  console.log('--- end ---')
  socket.destroy()
  process.exit(0)
}, seconds * 1000)
