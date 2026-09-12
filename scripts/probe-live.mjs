/**
 * Manual probe: what does the plugin's OWN engine see on a real device?
 *
 * Answers the questions the live suite's assertions depend on, without guessing:
 * the connect banner, whether a prompt appears unprompted, and what a command
 * round trip actually returns.
 *
 * Usage: node --import ./scripts/test-preload.mjs scripts/probe-live.mjs <host:port> [command]
 */
import { PortManager } from '../src/port-manager.ts'
import { DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN } from '../src/config-shared.ts'

const target = process.argv[2] ?? '10.133.6.253:10003'
const command = process.argv[3] ?? 'show version'
const [host, portText] = target.split(':')

const ports = new PortManager({
  maxConsoles: 2,
  scrollbackLimitBytes: 256 * 1024,
  outputLimitBytes: 64 * 1024,
  connectTimeoutMs: 8000,
  readTimeoutMs: 8000,
  idleTimeoutMs: 60_000,
  idleSweepMs: 15_000,
  pagingMode: 'manual',
  pagingMaxPages: 50,
  pagingQuietMs: 120,
  promptPattern: DEFAULT_PROMPT_PATTERN,
  pagerPattern: DEFAULT_PAGER_PATTERN,
})

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

try {
  const entry = await ports.connect({
    sessionId: 'probe',
    label: 'probe',
    host,
    port: Number(portText),
    kind: 'telnet',
    encoding: 'utf-8',
    pagingMode: 'manual',
  })
  console.log('[probe] state:', entry.state, 'lastError:', entry.lastError)
  console.log('[probe] banner:', JSON.stringify(ports.bannerOf('probe', entry.consoleId)))

  // Does a prompt appear if we simply wait, with nothing sent?
  await sleep(1500)
  const idleRead = ports.read('probe', entry.consoleId, {})
  console.log('[probe] after 1.5s idle, text:', JSON.stringify(idleRead.text))
  console.log('[probe] prompt:', JSON.stringify(ports.describe('probe', entry.consoleId)?.state.prompt ?? null))

  // Does an explicit newline provoke a prompt?
  await ports.send('probe', entry.consoleId, '', { submit: true })
  const afterEnter = await ports.waitFor('probe', entry.consoleId, { for: 'prompt', timeoutMs: 4000 })
  console.log('[probe] prompt after bare Enter:', afterEnter.matched, JSON.stringify(afterEnter.matchedText ?? null))
  const enterRead = ports.read('probe', entry.consoleId, {})
  console.log('[probe] text after Enter:', JSON.stringify(enterRead.text))

  // The real round trip.
  await ports.send('probe', entry.consoleId, command)
  await sleep(2500)
  const answer = ports.read('probe', entry.consoleId, {})
  console.log('[probe] answer bytes:', answer.bytes, 'encoding:', answer.encoding)
  console.log('[probe] answer text:', JSON.stringify(answer.text))
} finally {
  await ports.dispose()
}
