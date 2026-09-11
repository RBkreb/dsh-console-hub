/**
 * Red-first suite for `src/tools.ts`: the model-facing `console_*` tools.
 *
 * The registry is a fake that collects definitions, so each tool's schema,
 * canonical value, and agent-session scoping are asserted without a live agent.
 * The sessions themselves are real (in-process TCP servers).
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CONSOLE_TOOL_NAMES, registerConsoleTools } from '../src/tools.ts'
import { PortManager } from '../src/port-manager.ts'
import { DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN } from '../src/config-shared.ts'
import type { ConsoleToolRegistry, ConsoleToolRunContext } from '../src/context-types.ts'
import type { ConsoleView } from '../src/config-shared.ts'
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'

/** A minimal tool definition as the fake registry sees it. */
interface FrozenTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown, render: (args: unknown, value: unknown) => { type: string, text: string }[] }
  execute: (args: unknown, exec: ConsoleToolRunContext) => Promise<unknown>
}

/**
 * A registry stub that validates every definition the way the model sees it.
 *
 * The validation is the point, and it must cover BOTH schemas:
 *
 * - `output.schema`, which `register()` checks. An earlier fake read only
 *   `definition.name`, so all seven tools passed here while the real registry
 *   rejected every one (the `required` spelling was the DSL's, not raw JSON
 *   Schema) and registered nothing.
 * - `parameters`, which `register()` does NOT check but the MODEL API does. A
 *   DSL-spelled parameters object has no top-level `type`, so the provider
 *   rejects the entire tool list -- "got 'type: null'" -- and no conversation can
 *   start at all. Nothing in the harness catches that before the request leaves,
 *   so this fake is the only place it can be caught.
 */
function fakeRegistry(): ConsoleToolRegistry & { tools: Map<string, FrozenTool> } {
  const tools = new Map<string, FrozenTool>()
  return {
    tools,
    register(tool) {
      const frozen = tool as FrozenTool
      // What the runtime enforces at registration...
      assertSupportedJsonSchema(frozen.output.schema)
      // ...and what the PROVIDER enforces on the way to the model, which the
      // runtime does not check at all.
      assertObjectJsonSchema(frozen.parameters)
      tools.set(frozen.name, frozen)
      return () => tools.delete(frozen.name)
    },
  }
}

/** A device that greets and answers each command. */
interface Device {
  port: number
  sockets: Socket[]
  close(): Promise<void>
}

/** Start a device with a configurable answer. */
async function startDevice(
  answer: (line: string) => string | undefined = line => `answer:${line}`,
): Promise<Device> {
  const sockets: Socket[] = []
  const server: Server = createServer((socket) => {
    sockets.push(socket)
    socket.on('close', () => {
      const index = sockets.indexOf(socket)
      if (index >= 0) sockets.splice(index, 1)
    })
    socket.write('<DUT1>')
    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/[\r\n]+/)) {
        if (line === '') continue
        const reply = answer(line)
        if (reply !== undefined) socket.write(`\r\n${reply}\r\n<DUT1>`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    sockets,
    async close() {
      for (const socket of sockets.splice(0)) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Exec context for one call, scoped to a session. */
function execFor(sessionId = 'session-a'): ConsoleToolRunContext {
  return {
    agent: { session: { id: sessionId } },
    callId: `call-${sessionId}`,
    signal: new AbortController().signal,
  }
}

/** The dependencies a tool registration needs. */
interface Scene {
  registry: ReturnType<typeof fakeRegistry>
  manager: PortManager
  dispose: () => void
  view: { viewId: string, name: string, host: string, port: number, kind: 'raw', encoding: string, user: string, promptPattern: string, pagerPattern: string, pagingMode: string, tags: string[], notes: string }
}

const devices: Device[] = []
const managers: PortManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose()
  for (const device of devices.splice(0)) await device.close()
})

/** Build a registered tool set pointed at one device. */
async function scene(): Promise<Scene> {
  const device = await startDevice()
  devices.push(device)
  const manager = new PortManager({
    maxConsoles: 3,
    scrollbackLimitBytes: 8192,
    outputLimitBytes: 4096,
    connectTimeoutMs: 1000,
    readTimeoutMs: 200,
    idleTimeoutMs: 60_000,
    idleSweepMs: 1000,
    pagingMode: 'manual',
    pagingMaxPages: 5,
    pagingQuietMs: 20,
    promptPattern: DEFAULT_PROMPT_PATTERN,
    pagerPattern: DEFAULT_PAGER_PATTERN,
  })
  managers.push(manager)
  const registry = fakeRegistry()
  const view = {
    viewId: 'v-known',
    name: 'FW1',
    host: '127.0.0.1',
    port: device.port,
    kind: 'raw' as const,
    encoding: 'utf-8',
    user: '',
    promptPattern: '',
    pagerPattern: '',
    pagingMode: '',
    tags: [],
    notes: '',
  }
  const dispose = registerConsoleTools({
    registry,
    manager,
    views: () => ({ 'v-known': view as ConsoleView }),
    defaults: () => ({ encoding: 'utf-8', kind: 'raw', pagingMode: 'manual' }),
  })
  return { registry, manager, dispose, view }
}

/** Call one registered tool and return its canonical value. */
async function callTool(scene: Scene, name: string, args: unknown, exec = execFor()): Promise<unknown> {
  const tool = scene.registry.tools.get(name)
  if (tool === undefined) throw new Error(`tool "${name}" is not registered`)
  return tool.execute(args, exec)
}

describe('console tool registration', () => {
  it('registers the whole model-facing family', async () => {
    const scene1 = await scene()
    expect([...scene1.registry.tools.keys()].sort()).toEqual([...CONSOLE_TOOL_NAMES].sort())
    for (const name of CONSOLE_TOOL_NAMES) {
      const tool = scene1.registry.tools.get(name)
      expect(tool?.description.length).toBeGreaterThan(20)
      expect(tool?.output.schema).toBeDefined()
    }
  })

  it('unregisters every tool through its disposer', async () => {
    const scene1 = await scene()
    scene1.dispose()
    expect(scene1.registry.tools.size).toBe(0)
  })

  it('never exposes a sessionId parameter: the agent session is the scope', async () => {
    const scene1 = await scene()
    for (const tool of scene1.registry.tools.values()) {
      expect(Object.keys(tool.parameters)).not.toContain('sessionId')
    }
  })

  it('uses only the supported output-schema vocabulary', async () => {
    const scene1 = await scene()
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'pattern' || key === 'format') throw new Error(`unsupported schema keyword "${key}"`)
        walk(value)
      }
    }
    for (const tool of scene1.registry.tools.values()) walk(tool.output.schema)
  })
})

describe('console_connect / console_list / console_describe', () => {
  it('connects to a stored view and reports where it landed', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as {
      consoleId: string, state: string, label: string, host: string, port: number, secure: boolean
    }
    expect(opened.state).toBe('open')
    expect(opened.label).toBe('FW1')
    expect(opened.host).toBe('127.0.0.1')
    expect(opened.port).toBe(scene1.view.port)
    expect(opened.secure).toBe(false)

    const listed = await callTool(scene1, 'console_list', {}) as {
      consoles: { consoleId: string, label: string, state: string }[]
    }
    expect(listed.consoles).toHaveLength(1)
    expect(listed.consoles[0]?.consoleId).toBe(opened.consoleId)
  })

  it('scopes consoles to the calling agent session', async () => {
    const scene1 = await scene()
    await callTool(scene1, 'console_connect', { viewId: 'v-known' })
    const mine = await callTool(scene1, 'console_list', {}) as { consoles: unknown[] }
    expect(mine.consoles).toHaveLength(1)
    const theirs = await callTool(scene1, 'console_list', {}, execFor('session-b')) as { consoles: unknown[] }
    expect(theirs.consoles).toHaveLength(0)
  })

  it('connects to an explicit endpoint when no view is named', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', {
      host: '127.0.0.1',
      port: scene1.view.port,
      kind: 'raw',
      label: 'ad-hoc',
    }) as { state: string, label: string }
    expect(opened.state).toBe('open')
    expect(opened.label).toBe('ad-hoc')
  })

  it('refuses a connect with neither a view nor an endpoint', async () => {
    const scene1 = await scene()
    await expect(callTool(scene1, 'console_connect', {})).rejects.toThrow(/view|host|port/i)
  })

  it('never returns a password in any tool result', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', {
      host: '127.0.0.1',
      port: scene1.view.port,
      kind: 'raw',
      password: 'super-secret',
    }) as { secure: boolean }
    expect(opened.secure).toBe(true)
    expect(JSON.stringify(opened)).not.toContain('super-secret')
  })

  it('describes one console with its audit trail', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    await callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: 'show version' })
    const described = await callTool(scene1, 'console_describe', { consoleId: opened.consoleId }) as {
      consoleId: string, state: string, audit: { action: string }[]
    }
    expect(described.consoleId).toBe(opened.consoleId)
    expect(described.audit.some(entry => entry.action === 'send')).toBe(true)
  })

  it('refuses another session console', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    await expect(callTool(scene1, 'console_describe', { consoleId: opened.consoleId }, execFor('session-b')))
      .rejects.toThrow(/not found/i)
  })
})

describe('console_send / console_read / console_wait_for', () => {
  it('runs the full command cycle', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }

    const sent = await callTool(scene1, 'console_send', {
      consoleId: opened.consoleId,
      text: 'show version',
    }) as { consoleId: string, state: string, written: number }
    expect(sent.state).toBe('open')
    expect(sent.written).toBeGreaterThan(0)

    const waited = await callTool(scene1, 'console_wait_for', {
      consoleId: opened.consoleId,
      for: 'pattern',
      pattern: 'answer:show version',
      timeoutMs: 2000,
    }) as { matched: boolean, matchedText?: string, elapsedMs: number }
    expect(waited.matched).toBe(true)

    const read = await callTool(scene1, 'console_read', { consoleId: opened.consoleId, after: 0 }) as {
      text: string, cursor: number, truncated: boolean, encoding: string
    }
    expect(read.text).toContain('answer:show version')
    expect(read.cursor).toBeGreaterThan(0)
    expect(read.encoding).toBe('utf-8')

    const again = await callTool(scene1, 'console_read', { consoleId: opened.consoleId, after: read.cursor }) as {
      text: string
    }
    expect(again.text).toBe('')
  })

  it('reports a wait timeout as a value, not a throw', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const waited = await callTool(scene1, 'console_wait_for', {
      consoleId: opened.consoleId,
      for: 'pattern',
      pattern: 'NEVER-APPEARS',
      timeoutMs: 80,
    }) as { matched: boolean, reason: string }
    expect(waited.matched).toBe(false)
    expect(waited.reason).toBe('timeout')
  })

  it('waits for the prompt by default', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    // The greeting already ended in a prompt, so the wait matches at once.
    const waited = await callTool(scene1, 'console_wait_for', {
      consoleId: opened.consoleId,
      timeoutMs: 500,
    }) as { matched: boolean, matchedText?: string }
    expect(waited.matched).toBe(true)
    expect(waited.matchedText).toBe('<DUT1>')
  })

  it('filters the echo through console_read when asked', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    await callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: 'show version' })
    await callTool(scene1, 'console_wait_for', {
      consoleId: opened.consoleId,
      for: 'pattern',
      pattern: 'answer:',
      timeoutMs: 2000,
    })
    const read = await callTool(scene1, 'console_read', {
      consoleId: opened.consoleId,
      after: 0,
      stripEcho: 'show version',
    }) as { text: string }
    expect(read.text).toContain('answer:show version')
  })

  it('honours a per-call encoding override', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const read = await callTool(scene1, 'console_read', {
      consoleId: opened.consoleId,
      after: 0,
      encoding: 'gbk',
    }) as { encoding: string }
    expect(read.encoding).toBe('gbk')
    await expect(callTool(scene1, 'console_read', {
      consoleId: opened.consoleId,
      encoding: 'rot13',
    })).rejects.toThrow(/rot13/)
  })

  it('reports a send to a closed console as an error, and lets the model recover', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    await callTool(scene1, 'console_close', { consoleId: opened.consoleId, force: true })
    await expect(callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: 'x' }))
      .rejects.toThrow(/not found/i)
    // The list is the recovery path: it must not throw.
    const listed = await callTool(scene1, 'console_list', {}) as { consoles: unknown[] }
    expect(listed.consoles).toEqual([])
  })

  it('bounds a large read and says so', async () => {
    const device = await startDevice(line => (line === 'flood' ? 'X'.repeat(5000) : `answer:${line}`))
    devices.push(device)
    const manager = new PortManager({
      maxConsoles: 2,
      scrollbackLimitBytes: 64 * 1024,
      outputLimitBytes: 128,
      connectTimeoutMs: 1000,
      readTimeoutMs: 200,
      idleTimeoutMs: 60_000,
      idleSweepMs: 1000,
      pagingMode: 'manual',
      pagingMaxPages: 5,
      pagingQuietMs: 20,
      promptPattern: DEFAULT_PROMPT_PATTERN,
      pagerPattern: DEFAULT_PAGER_PATTERN,
    })
    managers.push(manager)
    const registry = fakeRegistry()
    registerConsoleTools({
      registry,
      manager,
      views: () => ({}),
      defaults: () => ({ encoding: 'utf-8', kind: 'raw', pagingMode: 'manual' }),
    })
    const local: Scene = { registry, manager, dispose: () => {}, view: scene1View(device.port) }
    const opened = await callTool(local, 'console_connect', {
      host: '127.0.0.1',
      port: device.port,
      kind: 'raw',
    }) as { consoleId: string }
    await callTool(local, 'console_send', { consoleId: opened.consoleId, text: 'flood' })
    await callTool(local, 'console_wait_for', {
      consoleId: opened.consoleId,
      for: 'pattern',
      pattern: 'answer:flood',
      timeoutMs: 2000,
    })
    const read = await callTool(local, 'console_read', { consoleId: opened.consoleId, after: 0 }) as {
      truncated: boolean, text: string
    }
    expect(read.truncated).toBe(true)
    expect(Buffer.byteLength(read.text, 'utf8')).toBeLessThanOrEqual(128)
  })
})

/** A view stub for the budget test's scene. */
function scene1View(port: number): Scene['view'] {
  return {
    viewId: 'v-known',
    name: 'FW1',
    host: '127.0.0.1',
    port,
    kind: 'raw',
    encoding: 'utf-8',
    user: '',
    promptPattern: '',
    pagerPattern: '',
    pagingMode: '',
    tags: [],
    notes: '',
  }
}

describe('console_close', () => {
  it('closes one console', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const closed = await callTool(scene1, 'console_close', { consoleId: opened.consoleId }) as {
      consoleId: string, closed: boolean
    }
    expect(closed.closed).toBe(true)
    expect((await callTool(scene1, 'console_list', {}) as { consoles: unknown[] }).consoles).toEqual([])
  })

  it('force-closes and reports the closed console id', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const closed = await callTool(scene1, 'console_close', { consoleId: opened.consoleId, force: true }) as {
      consoleId: string
    }
    expect(closed.consoleId).toBe(opened.consoleId)
  })
})

describe('tool renders', () => {
  it('renders a human-readable projection for each canonical value', async () => {
    const scene1 = await scene()
    const tool = scene1.registry.tools.get('console_connect')
    expect(tool).toBeDefined()
    const rendered = tool?.output.render({ viewId: 'v-known' }, {
      consoleId: 'c1',
      state: 'open',
      label: 'FW1',
      host: '10.0.0.1',
      port: 10003,
      secure: true,
    })
    expect(rendered?.[0]?.type).toBe('text')
    expect(rendered?.[0]?.text).toContain('FW1')
    expect(rendered?.[0]?.text).toContain('10.0.0.1:10003')
    // A renderer must never invent a credential either.
    expect(rendered?.[0]?.text).not.toMatch(/password/i)
  })

  it('renders an empty console list without crashing', async () => {
    const scene1 = await scene()
    const tool = scene1.registry.tools.get('console_list')
    const rendered = tool?.output.render({}, { consoles: [] })
    expect(rendered?.[0]?.text).toMatch(/no .*console/i)
  })
})

describe('agent context', () => {
  it('refuses a call with no agent instead of guessing a session', async () => {
    const scene1 = await scene()
    const context: ConsoleToolRunContext = { callId: 'c1', signal: new AbortController().signal }
    await expect(callTool(scene1, 'console_list', {}, context)).rejects.toThrow(/agent|session/i)
  })

  it('honours an aborted signal before doing any work', async () => {
    const scene1 = await scene()
    const controller = new AbortController()
    controller.abort()
    const context: ConsoleToolRunContext = {
      agent: { session: { id: 'session-a' } },
      callId: 'c1',
      signal: controller.signal,
    }
    await expect(callTool(scene1, 'console_connect', { viewId: 'v-known' }, context)).rejects.toThrow()
  })
})
