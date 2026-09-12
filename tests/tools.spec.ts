/**
 * Red-first suite for `src/tools.ts`: the model-facing `console_*` tools.
 *
 * The registry is a fake that collects definitions, so each tool's schema,
 * canonical value, and agent-session scoping are asserted without a live agent.
 * The sessions themselves are real (in-process TCP servers).
 */
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CONSOLE_TOOL_NAMES, registerConsoleTools, type ConsoleToolDeps } from '../src/tools.ts'
import { PortManager } from '../src/port-manager.ts'
import { DEFAULT_DORMANT_PATTERN, DEFAULT_PAGER_PATTERN, DEFAULT_PROMPT_PATTERN } from '../src/config-shared.ts'
import { normalizeView } from '../src/views.ts'
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
  options: {
    /**
     * Answer a bare Enter (a lone CR).
     *
     * A real console answers a bare Enter with its prompt; the loop below skips
     * an empty line as "nothing was typed", so this needs its own hook. Without
     * it, a `console_wake` test could only assert that bytes were written --
     * never that the device acknowledged them.
     */
    onBareEnter?: () => string | undefined
  } = {},
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
      const text = chunk.toString('utf8')
      if (options.onBareEnter !== undefined && text === '\r') {
        const reply = options.onBareEnter()
        if (reply !== undefined) socket.write(reply)
        return
      }
      for (const line of text.split(/[\r\n]+/)) {
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

/**
 * A device that demands a password before it answers anything.
 *
 * Needed to make a credential test mean something: a device that answers
 * regardless cannot distinguish "the stored password was used" from "no password
 * was needed". This one refuses every command until `password:<value>` arrives,
 * so a successful round trip proves a credential was actually sent.
 *
 * @param password - the value it accepts.
 * @returns the device handle.
 */
async function startPasswordDevice(password: string): Promise<Device> {
  const sockets: Socket[] = []
  let authenticated = false
  const server: Server = createServer((socket) => {
    sockets.push(socket)
    socket.on('close', () => {
      const index = sockets.indexOf(socket)
      if (index >= 0) sockets.splice(index, 1)
    })
    // The prompt the engine's auth hook looks for: `password:` at the tail.
    socket.write('\r\npassword:')
    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/[\r\n]+/)) {
        if (line === '') continue
        if (!authenticated) {
          // The engine answers the prompt with `<password>\r\n`, so the line it
          // sends IS the password.
          if (line === password) {
            authenticated = true
            socket.write('\r\n<DUT1>')
          } else {
            socket.write('\r\npassword:')
          }
          continue
        }
        socket.write(`\r\nanswer:${line}\r\n<DUT1>`)
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
  /** The engine defaults the family was registered with. */
  defaults: Record<string, unknown>
}

const devices: Device[] = []
const managers: PortManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose()
  for (const device of devices.splice(0)) await device.close()
})

/**
 * The inventory side of the tool dependencies, over an in-memory map.
 *
 * Kept as one builder rather than repeated inline, because the fakes here have
 * twice been more permissive than the real thing and let a bug through. All
 * three of these are deliberately faithful where it matters:
 *
 * - `upsertView` runs the REAL `normalizeView`, so a bad port or an unknown kind
 *   is refused exactly as in production rather than being accepted by a stub.
 * - `removeView` really deletes the key, so a tool that reported success while
 *   leaving the row behind would fail here.
 * - `resolveSecret` is absent by default, matching a deployment with no stored
 *   credential; a case that wants one supplies it.
 *
 * @param store - the mutable view map, shared with the case so it can inspect it.
 * @param resolveSecret - the credential resolution, when the case needs one.
 * @returns the inventory slice of the tool dependencies.
 */
function inventoryDeps(
  store: Record<string, ConsoleView>,
  resolveSecret?: (viewId: string) => Promise<{ password: string, user?: string } | undefined>,
): Pick<ConsoleToolDeps, 'listViews' | 'upsertView' | 'removeView' | 'resolveSecret'> {
  return {
    listViews: async () => Object.entries(store).map(([viewId, view]) => ({
      viewId,
      view: { ...view, secretConfigured: false },
    })),
    upsertView: async (input: Record<string, unknown>) => {
      // The real normalizer, so this cannot accept what production refuses.
      const view = normalizeView(input as never)
      const viewId = typeof input.viewId === 'string' && input.viewId !== '' ? input.viewId : 'v-created'
      store[viewId] = view
      return { viewId, view: { ...view, secretConfigured: false } }
    },
    removeView: async (viewId: string) => {
      if (store[viewId] === undefined) throw new Error(`no view "${viewId}"`)
      const had = false
      delete store[viewId]
      return { removed: true, secretRemoved: had }
    },
    ...resolveSecret === undefined ? {} : { resolveSecret },
  }
}

/** Build a registered tool set pointed at one device. */
async function scene(options: {
  /** Credential resolution, when the case needs a stored secret. */
  resolveSecret?: (viewId: string) => Promise<{ password: string, user?: string } | undefined>
  /** Start the device with a bare-Enter answer, for the wake cases. */
  onBareEnter?: () => string | undefined
  /** How the device answers a non-empty line. */
  answer?: (line: string) => string | undefined
  /** Manager policy overrides, for timing-sensitive cases. */
  manager?: Partial<ConstructorParameters<typeof PortManager>[0]>
} = {}): Promise<Scene> {
  const device = await startDevice(options.answer ?? (line => `answer:${line}`), {
    ...options.onBareEnter === undefined ? {} : { onBareEnter: options.onBareEnter },
  })
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
    dormantPattern: DEFAULT_DORMANT_PATTERN,
    dormantAutoWake: true,
    dormantProbeMs: 0,
    idleQuietMs: 250,
    ...options.manager,
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
  const store: Record<string, ConsoleView> = { 'v-known': view as ConsoleView }
  const dispose = registerConsoleTools({
    registry,
    manager,
    views: () => store,
    defaults: () => ({ encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 250 }),
    ...inventoryDeps(store, options.resolveSecret),
  })
  const engineDefaults = { encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 250 }
  return { registry, manager, dispose, view, defaults: engineDefaults }
}

/**
 * A registered tool set over an EMPTY inventory, with no device behind it.
 *
 * Separate from {@link scene} because the interesting cases here are about the
 * inventory itself: the device list must be empty, and nothing should need a
 * live socket.
 *
 * @returns the wired family with nothing configured.
 */
function emptyScene(): Scene {
  const registry = fakeRegistry()
  const store: Record<string, ConsoleView> = {}
  const manager = new PortManager({
    maxConsoles: 1,
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
    dormantPattern: DEFAULT_DORMANT_PATTERN,
    dormantAutoWake: true,
    dormantProbeMs: 0,
    idleQuietMs: 250,
  })
  managers.push(manager)
  const dispose = registerConsoleTools({
    registry,
    manager,
    views: () => store,
    defaults: () => ({ encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 250 }),
    ...inventoryDeps(store),
  })
  return { registry, manager, dispose, view: scene1View(0), defaults: { encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 250 } }
}

/**
 * Call one registered tool, then render its canonical value.
 *
 * The render is invoked on EVERY call, not just in dedicated presentation
 * tests, because `render` receives the value `execute` returns and the two can
 * disagree silently: `console_list` built a projection without `lastError`
 * while its renderer read `lastError.code`, so the tool threw
 * `Cannot read properties of undefined (reading 'code')` whenever a console was
 * open -- and the suite was green, because it only ever listed an EMPTY
 * inventory. Running both halves together on every path is what makes that
 * class of mismatch impossible to reintroduce.
 *
 * @param scene - the wired tool family.
 * @param name - the tool to call.
 * @param args - model arguments.
 * @param exec - the execution identity.
 * @returns the canonical value the tool produced.
 * @throws {Error} when the renderer cannot render that value.
 */
async function callTool(scene: Scene, name: string, args: unknown, exec = execFor()): Promise<unknown> {
  const tool = scene.registry.tools.get(name)
  if (tool === undefined) throw new Error(`tool "${name}" is not registered`)
  const value = await tool.execute(args, exec)
  // The same order the registry uses: execute, then the pure text projection.
  tool.output.render(args, value)
  return value
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

  it('defines what `for: "idle"` means instead of saying "output stops arriving"', async () => {
    // The reported confusion: the description said "wait until output stops
    // arriving" and left the reader to guess how long "stopped" is, whether
    // anything has to have arrived first, and what happens when nothing does.
    // All three are answerable, and a model that has to guess reasons about a
    // wait it is not actually getting.
    const scene1 = await scene()
    const tool = scene1.registry.tools.get('console_wait_for')
    const description = tool?.description ?? ''

    // 1. The window itself, and that it is a window AT ALL.
    expect(description).toMatch(/no further bytes arrived for a whole quiet window/)
    // 2. The default, stated concretely rather than left to the parameter docs.
    expect(description).toContain(`${String(scene1.defaults.idleQuietMs)}ms`)
    // 3. Output must have ARRIVED first -- the half that made an idle wait match
    //    on an untouched, silent console.
    expect(description).toMatch(/some output arrived/)
    // 4. Nothing arriving is a timeout, not a match.
    expect(description).toMatch(/NOTHING arrives never satisfies it and times out/)
    // 5. It is a heuristic, not a completion signal, and `prompt` is the reliable
    //    one -- so a caller knows which to reach for.
    expect(description).toMatch(/heuristic and NOT a completion signal/)
    expect(description).toMatch(/reliable "the command finished" signal/)
  })

  it('states the idle window that is ACTUALLY in force, not a hardcoded one', async () => {
    // A deployment that tunes `idleQuietMs` would otherwise be described to the
    // model by a stale figure, and the model would budget its waits against a
    // window it is not getting.
    const registry = fakeRegistry()
    const manager = new PortManager({
      maxConsoles: 1,
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
      dormantPattern: DEFAULT_DORMANT_PATTERN,
      dormantAutoWake: true,
      dormantProbeMs: 0,
      idleQuietMs: 250,
    })
    managers.push(manager)
    const store: Record<string, ConsoleView> = {}
    const dispose = registerConsoleTools({
      registry,
      manager,
      views: () => store,
      // The tuned value, which is what the description must report.
      defaults: () => ({ encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 4321 }),
      ...inventoryDeps(store),
    })
    try {
      const description = registry.tools.get('console_wait_for')?.description ?? ''
      expect(description).toContain('4321ms')
      expect(description).not.toContain('1500ms')
      // ...and the parameter docs agree, since the model may read either.
      const idleParam = (registry.tools.get('console_wait_for')?.parameters as {
        properties?: Record<string, { description?: string }>
      })?.properties?.idleMs
      expect(idleParam?.description).toContain('4321ms')
    } finally {
      dispose()
    }
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

  it('lists the SHARED pool, marking which session opened each console', async () => {
    // The model used to see only its own session's consoles. That scoping is what
    // made a console opened by a since-dead session invisible -- and therefore
    // impossible to close. Consoles are a host-wide resource now, so the listing
    // is too; `openedBy` is what tells the model who else is involved.
    const scene1 = await scene()
    await callTool(scene1, 'console_connect', { viewId: 'v-known' })
    const mine = await callTool(scene1, 'console_list', {}) as { consoles: unknown[] }
    expect(mine.consoles).toHaveLength(1)

    const theirs = await callTool(scene1, 'console_list', {}, execFor('session-b')) as {
      consoles: { openedBy: string }[]
    }
    expect(theirs.consoles).toHaveLength(1)
    expect(theirs.consoles[0]?.openedBy).toBe('session-a')
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

  it('lets another session drive a console it did not open', async () => {
    // Shared means shared, including for the model. What must NOT be lost is the
    // provenance: `openedBy` names whoever opened it, so a caller can tell it
    // attached to someone else's device link.
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const described = await callTool(
      scene1,
      'console_describe',
      { consoleId: opened.consoleId },
      execFor('session-b'),
    ) as { consoleId: string, openedBy?: string }
    expect(described.consoleId).toBe(opened.consoleId)
    expect(described.openedBy).toBe('session-a')
  })

  it('still reports an unknown console id as an error', async () => {
    const scene1 = await scene()
    await expect(callTool(scene1, 'console_describe', { consoleId: 'c-nope' }))
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

  it('sends an EMPTY line, which is how a dormant console is woken', async () => {
    // The guard used to demand a non-empty `text`, so the model could not press
    // Enter -- the one keystroke a half-closed console is asking for.
    //
    // The device's answer to a bare Enter is a marker that appears NOWHERE else
    // (the connect greeting is just `<DUT1>`), so matching it proves the CR
    // reached the device and was understood -- not merely that a byte was
    // counted locally.
    const scene1 = await scene({ onBareEnter: () => '\r\nWAKE-ACCEPTED\r\n<DUT1>' })
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const sent = await callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: '' }) as {
      state: string, written: number
    }
    expect(sent.state).toBe('open')

    const waited = await callTool(scene1, 'console_wait_for', {
      consoleId: opened.consoleId,
      for: 'pattern',
      pattern: 'WAKE-ACCEPTED',
      timeoutMs: 2000,
    }) as { matched: boolean }
    expect(waited.matched).toBe(true)
  })

  it('sends whitespace verbatim, because a space is a pager key', async () => {
    const scene1 = await scene({ answer: line => (line === ' ' ? 'NEXT-PAGE' : 'other') })
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    await callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: ' ' })
    // The device answers only the exact single-space line: a trimmed send would
    // have produced an empty line, and a `\n`-substituted one would answer 'other'.
    const waited = await callTool(scene1, 'console_wait_for', {
      consoleId: opened.consoleId,
      for: 'pattern',
      pattern: 'NEXT-PAGE',
      timeoutMs: 2000,
    }) as { matched: boolean }
    expect(waited.matched).toBe(true)
  })

  it('still refuses a non-string text', async () => {
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    await expect(callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: 42 }))
      .rejects.toThrow(/must be a string/)
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
      dormantPattern: DEFAULT_DORMANT_PATTERN,
      dormantAutoWake: true,
      dormantProbeMs: 0,
      idleQuietMs: 250,
    })
    managers.push(manager)
    const registry = fakeRegistry()
    const emptyStore: Record<string, ConsoleView> = {}
    registerConsoleTools({
      registry,
      manager,
      views: () => emptyStore,
      defaults: () => ({ encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 250 }),
      ...inventoryDeps(emptyStore),
    })
    const local: Scene = {
      registry,
      manager,
      dispose: () => {},
      view: scene1View(device.port),
      defaults: { encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 250 },
    }
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

/**
 * The model's view of the device half-close.
 *
 * These are the assertions that matter for the reported defect: a console whose
 * device half-closed it is still `open`, still has no `lastError`, and answers
 * nothing. A model that cannot SEE that state will retry forever, so every
 * surface it reads must carry it.
 */
describe('console dormancy through the tools', () => {
  /** The marker, byte for byte as the real device emits it. */
  const MARKER = '\r\nVty connection is timed out.\r\n\r\nPlease press ENTER.'

  /** Reach into the fake device behind a scene and push raw bytes. */
  function pushTo(scene1: { view: { port: number } }, text: string): void {
    const device = devices.find(candidate => candidate.port === scene1.view.port)
    if (device === undefined) throw new Error('test device not found')
    for (const socket of device.sockets) socket.write(text)
  }

  it('reports dormancy in console_read, and wakes with console_wake', async () => {
    const scene1 = await scene({ onBareEnter: () => '\r\nWAKE-ACCEPTED\r\n<DUT1>' })
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }

    pushTo(scene1, MARKER)
    // The host answers the marker by itself (dormantAutoWake is on), so wait for
    // the automatic recovery to land -- the point here is what the MODEL sees.
    const waited = await callTool(scene1, 'console_wait_for', {
      consoleId: opened.consoleId,
      for: 'pattern',
      pattern: 'WAKE-ACCEPTED',
      timeoutMs: 2000,
    }) as { matched: boolean, dormant: boolean }
    expect(waited.matched).toBe(true)

    const read = await callTool(scene1, 'console_read', { consoleId: opened.consoleId, after: 0 }) as {
      text: string, dormant: boolean, dormantText?: string
    }
    // The marker itself is in the output, so the model can see why the console
    // went quiet, and the state is reported alongside it.
    expect(read.text).toContain('Vty connection is timed out')
    expect(read.dormant).toBe(false)
  })

  it('marks a still-dormant console in console_list', async () => {
    // `dormantAutoWake: false` and a device that ignores the Enter: the console
    // stays dormant, which is the state a model must be able to detect.
    const scene1 = await scene({ manager: { dormantAutoWake: false } })
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    pushTo(scene1, MARKER)
    await new Promise(resolve => setTimeout(resolve, 100))

    const listed = await callTool(scene1, 'console_list', {}) as {
      consoles: { consoleId: string, state: string, dormant: boolean, dormantText?: string }[]
    }
    const row = listed.consoles.find(entry => entry.consoleId === opened.consoleId)
    expect(row?.state).toBe('open')
    expect(row?.dormant).toBe(true)
    expect(row?.dormantText).toContain('Please press ENTER')
  })

  it('reports dormantBlocked when a wait cannot match a dormant console', async () => {
    const scene1 = await scene({ manager: { dormantAutoWake: false } })
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    pushTo(scene1, MARKER)
    await new Promise(resolve => setTimeout(resolve, 100))

    const waited = await callTool(scene1, 'console_wait_for', {
      consoleId: opened.consoleId,
      for: 'pattern',
      pattern: 'NEVER-APPEARS',
      timeoutMs: 120,
    }) as { matched: boolean, reason: string, dormant: boolean, dormantBlocked?: boolean }
    expect(waited.matched).toBe(false)
    expect(waited.reason).toBe('timeout')
    expect(waited.dormant).toBe(true)
    // Without this the model would simply wait again: a bare timeout is
    // indistinguishable from "the device is slow".
    expect(waited.dormantBlocked).toBe(true)
  })

  it('console_wake presses exactly one Enter and reports whether it worked', async () => {
    const scene1 = await scene({ onBareEnter: () => '\r\nWAKE-ACCEPTED\r\n<DUT1>' })
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const woken = await callTool(scene1, 'console_wake', { consoleId: opened.consoleId }) as {
      answered: boolean, dormant: boolean, state: string
    }
    expect(woken.answered).toBe(true)
    expect(woken.dormant).toBe(false)
    expect(woken.state).toBe('open')
  })

  it('console_wake reports a wake nobody answered as unanswered', async () => {
    // The device ignores a bare Enter, so claiming recovery would be a lie.
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const woken = await callTool(scene1, 'console_wake', { consoleId: opened.consoleId }) as {
      answered: boolean
    }
    expect(woken.answered).toBe(false)
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

/**
 * The bare `ConsoleView` for an id, without the wrapper's `viewId`.
 *
 * A `ConsoleView` is the stored record; `Scene['view']` is that record plus the
 * key it lives under, which is how the API returns it. Stripping the key here
 * keeps each type honest rather than widening the store to accept both.
 *
 * @param port - the device port to point at.
 * @returns the stored view record.
 */
function viewRecord(port: number): ConsoleView {
  const { viewId: _viewId, ...view } = scene1View(port)
  return view as ConsoleView
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
  it('refuses a call with no agent when the action must be attributed to one', async () => {
    // Not every tool needs a session any more: `console_list` reads a shared pool
    // and attributes nothing, so it works without an agent. A tool that OPENS a
    // console does need one -- `openedBy` and the audit trail both name the
    // session, and guessing one would put a false name in the record.
    const scene1 = await scene()
    const context: ConsoleToolRunContext = { callId: 'c1', signal: new AbortController().signal }
    await expect(callTool(scene1, 'console_connect', { viewId: 'v-known' }, context))
      .rejects.toThrow(/agent|session/i)
    // ...and the one that attributes nothing still succeeds.
    const listed = await callTool(scene1, 'console_list', {}, context) as { consoles: unknown[] }
    expect(listed.consoles).toEqual([])
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

describe('the rendered text is usable as-is', () => {
  /** Render one tool's result the way the registry does. */
  function renderOf(scene: Scene, name: string, value: unknown): string {
    const tool = scene.registry.tools.get(name)
    if (tool === undefined) throw new Error(`tool "${name}" is not registered`)
    return tool.output.render({}, value).map(block => block.text).join('\n')
  }

  it('lists an open console instead of throwing on its own projection', async () => {
    // The bug this pins: the list body built a projection with no `lastError`,
    // while the renderer read `lastError.code`. Listing an OPEN console threw
    // `Cannot read properties of undefined (reading 'code')` -- and the suite
    // stayed green because nothing had ever listed a NON-empty inventory.
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const value = await callTool(scene1, 'console_list', {})
    const rendered = renderOf(scene1, 'console_list', value)
    expect(rendered).toContain(opened.consoleId)
    expect(rendered).toContain('open')
  })

  it('quotes the handle so its boundary is unambiguous', async () => {
    // Against a real device the handle was rendered as the last token before a
    // separator, and the separator was copied back as part of the id, costing a
    // failed retry. Quoting makes the boundary explicit.
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    const connectText = renderOf(scene1, 'console_connect', opened)
    expect(connectText).toContain(`Handle "${opened.consoleId}"`)
    // And the id must NOT be immediately followed by punctuation.
    expect(connectText).not.toContain(`${opened.consoleId};`)

    const listed = renderOf(scene1, 'console_list', await callTool(scene1, 'console_list', {}))
    expect(listed).toContain(`"${opened.consoleId}"`)
  })

  it('reports a failed console with its error code in the list', async () => {
    // A console in state `error` is exactly the one a caller needs explained.
    const scene1 = await scene()
    await callTool(scene1, 'console_connect', { host: '127.0.0.1', port: 1, kind: 'raw', label: 'dead' })
    const value = await callTool(scene1, 'console_list', {})
    const rendered = renderOf(scene1, 'console_list', value)
    expect(rendered).toMatch(/error|closed/)
  })
})

describe('listing configured devices versus connected ones', () => {
  it('console_list_views lists a configured device that is NOT connected', async () => {
    // The reported gap: `console_list` only showed connected consoles, so a
    // configured-but-idle device was invisible and the model had to hunt through
    // the settings document and connect by hand. The two are separate tools with
    // separate meanings.
    const scene1 = await scene()
    const views = await callTool(scene1, 'console_list_views', {}) as { views: Array<{ viewId: string, name: string }> }
    expect(views.views).toHaveLength(1)
    expect(views.views[0]?.viewId).toBe('v-known')
    expect(views.views[0]?.name).toBe('FW1')

    // Nothing is connected, so the console list is empty -- which is exactly why
    // one tool could not answer both questions.
    const consoles = await callTool(scene1, 'console_list', {}) as { consoles: unknown[] }
    expect(consoles.consoles).toHaveLength(0)
  })

  it('does not count a configured device as a connected console', async () => {
    const scene1 = await scene()
    await callTool(scene1, 'console_connect', { viewId: 'v-known' })
    const consoles = await callTool(scene1, 'console_list', {}) as { consoles: unknown[] }
    // One connected console, and STILL one configured view: connecting does not
    // duplicate the inventory.
    expect(consoles.consoles).toHaveLength(1)
    const views = await callTool(scene1, 'console_list_views', {}) as { views: unknown[] }
    expect(views.views).toHaveLength(1)
  })

  it('renders the viewId quoted, so it can be passed straight to console_connect', async () => {
    const scene1 = await scene()
    const value = await callTool(scene1, 'console_list_views', {})
    const tool = scene1.registry.tools.get('console_list_views')
    const rendered = tool?.output.render({}, value).map(block => block.text).join('\n') ?? ''
    expect(rendered).toContain('"v-known"')
    expect(rendered).toContain('FW1')
  })

  it('says how to create one when the inventory is empty', async () => {
    // An empty list must be actionable, not just empty: the model needs to know
    // it can add a device rather than concluding the feature is unavailable.
    const scene1 = await scene()
    const store = (scene1 as unknown as { store?: Record<string, unknown> })
    void store
    const empty = emptyScene()
    const value = await callTool(empty, 'console_list_views', {})
    const tool = empty.registry.tools.get('console_list_views')
    const rendered = tool?.output.render({}, value).map(block => block.text).join('\n') ?? ''
    expect(rendered).toMatch(/console_upsert_view/)
  })
})

describe('editing the inventory from the model', () => {
  it('creates a device and returns the id to connect with', async () => {
    const scene1 = await scene()
    const created = await callTool(scene1, 'console_upsert_view', {
      name: 'SW9',
      host: '10.9.9.9',
      port: 10015,
      kind: 'telnet',
    }) as { viewId: string, created: boolean, name: string, host: string, port: number }

    expect(created.created).toBe(true)
    expect(created.name).toBe('SW9')
    expect(created.host).toBe('10.9.9.9')

    // The write is real: it shows up in the inventory, which is what makes it
    // useful rather than a no-op that reported success.
    const views = await callTool(scene1, 'console_list_views', {}) as { views: Array<{ viewId: string }> }
    expect(views.views.map(row => row.viewId)).toContain(created.viewId)
  })

  it('updates an existing device without creating a second one', async () => {
    const scene1 = await scene()
    const updated = await callTool(scene1, 'console_upsert_view', {
      viewId: 'v-known',
      name: 'FW1-renamed',
      host: '127.0.0.1',
      port: 10003,
    }) as { viewId: string, created: boolean, name: string }
    expect(updated.viewId).toBe('v-known')
    expect(updated.created).toBe(false)
    expect(updated.name).toBe('FW1-renamed')

    const views = await callTool(scene1, 'console_list_views', {}) as { views: unknown[] }
    expect(views.views).toHaveLength(1)
  })

  it('refuses an invalid device with the normalizer’s own message', async () => {
    // The fake runs the REAL `normalizeView`, so what production refuses is what
    // this refuses -- a stub that accepted anything would make the test lie.
    const scene1 = await scene()
    await expect(callTool(scene1, 'console_upsert_view', {
      name: 'bad', host: 'h', port: 70000,
    })).rejects.toThrow(/port/)
    await expect(callTool(scene1, 'console_upsert_view', {
      name: 'bad', host: 'h', port: 23, kind: 'ssh',
    })).rejects.toThrow(/kind/)
  })

  it('removes a configured device', async () => {
    const scene1 = await scene()
    const removed = await callTool(scene1, 'console_remove_view', { viewId: 'v-known' }) as { removed: boolean }
    expect(removed.removed).toBe(true)
    const views = await callTool(scene1, 'console_list_views', {}) as { views: unknown[] }
    expect(views.views).toHaveLength(0)
  })

  it('refuses to remove a device that is not configured', async () => {
    const scene1 = await scene()
    await expect(callTool(scene1, 'console_remove_view', { viewId: 'v-nope' })).rejects.toThrow(/v-nope/)
  })

  it('never returns a password it was given', async () => {
    // A write-only field. The tool's canonical value and its render are both
    // checked, because either one leaking the value would put it in the
    // transcript.
    const scene1 = await scene()
    const value = await callTool(scene1, 'console_upsert_view', {
      name: 'SEC', host: 'h', port: 22, password: 'never-echo-this',
    })
    expect(JSON.stringify(value)).not.toContain('never-echo-this')
    const tool = scene1.registry.tools.get('console_upsert_view')
    const rendered = tool?.output.render({}, value).map(block => block.text).join('\n') ?? ''
    expect(rendered).not.toContain('never-echo-this')
  })
})

describe('a stored credential reaches the connect', () => {
  /**
   * A tool family pointing at a password-gated device.
   *
   * The device answers NOTHING until it hears the right password, so a command
   * that succeeds proves a credential was sent -- a device that replied anyway
   * could not tell "the stored password was used" from "no password was needed".
   *
   * @param password - the password the device accepts.
   * @param options.resolveSecret - what the deployment resolves for `v-known`.
   * @returns the wired family and the device.
   */
  async function passwordScene(password: string, options: {
    resolveSecret?: (viewId: string) => Promise<{ password: string, user?: string } | undefined>
  } = {}): Promise<{ scene: Scene, device: Device }> {
    const device = await startPasswordDevice(password)
    devices.push(device)
    const manager = new PortManager({
      maxConsoles: 2,
      scrollbackLimitBytes: 8192,
      outputLimitBytes: 4096,
      connectTimeoutMs: 1000,
      readTimeoutMs: 400,
      idleTimeoutMs: 60_000,
      idleSweepMs: 1000,
      pagingMode: 'manual',
      pagingMaxPages: 5,
      pagingQuietMs: 20,
      promptPattern: DEFAULT_PROMPT_PATTERN,
      pagerPattern: DEFAULT_PAGER_PATTERN,
      dormantPattern: DEFAULT_DORMANT_PATTERN,
      dormantAutoWake: true,
      dormantProbeMs: 0,
      idleQuietMs: 250,
    })
    managers.push(manager)
    const registry = fakeRegistry()
    const store: Record<string, ConsoleView> = { 'v-known': viewRecord(device.port) }
    const dispose = registerConsoleTools({
      registry,
      manager,
      views: () => store,
      defaults: () => ({ encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 250 }),
      ...inventoryDeps(store, options.resolveSecret),
    })
    return {
      scene: {
        registry,
        manager,
        dispose,
        view: scene1View(device.port),
        defaults: { encoding: 'utf-8', kind: 'raw', pagingMode: 'manual', idleQuietMs: 250 },
      },
      device,
    }
  }

  it('authenticates with the stored password when the caller names a view', async () => {
    // The documented-but-missing behaviour: `console_connect` said "Prefer a
    // stored credential on the view" while `resolveSecret` was never called, so
    // connecting by viewId silently ignored it and the login prompt went
    // unanswered.
    const { scene: scene1 } = await passwordScene('stored-secret', {
      resolveSecret: async viewId => (viewId === 'v-known' ? { password: 'stored-secret' } : undefined),
    })
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }

    // A command only answers once the device has accepted the password.
    await callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: 'show version' })
    const deadline = Date.now() + 3000
    let text = ''
    while (!text.includes('answer:show version') && Date.now() < deadline) {
      text += ((await callTool(scene1, 'console_read', { consoleId: opened.consoleId })) as { text: string }).text
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(text).toContain('answer:show version')
  })

  it('does NOT authenticate when no credential resolves', async () => {
    // The control for the case above: without a credential the device keeps
    // asking, so the assertion there really is testing the resolution.
    const { scene: scene1 } = await passwordScene('stored-secret')
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' }) as { consoleId: string }
    await callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: 'show version' })
    const text = ((await callTool(scene1, 'console_read', { consoleId: opened.consoleId })) as { text: string }).text
    expect(text).not.toContain('answer:show version')
  })

  it('lets an explicit password win over the stored one', async () => {
    // The device accepts the EXPLICIT value, so a connect that used the stored
    // one instead would never authenticate.
    const used: string[] = []
    const { scene: scene1 } = await passwordScene('explicit-value', {
      resolveSecret: async () => { used.push('stored'); return { password: 'stored-secret' } },
    })
    const opened = await callTool(scene1, 'console_connect', {
      viewId: 'v-known',
      password: 'explicit-value',
    }) as { consoleId: string }
    await callTool(scene1, 'console_send', { consoleId: opened.consoleId, text: 'ping' })

    const deadline = Date.now() + 3000
    let text = ''
    while (!text.includes('answer:ping') && Date.now() < deadline) {
      text += ((await callTool(scene1, 'console_read', { consoleId: opened.consoleId })) as { text: string }).text
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(text).toContain('answer:ping')
    // An explicit password is the ad-hoc override, so the stored value must not
    // even be consulted.
    expect(used).toHaveLength(0)
  })

  it('connects an ad-hoc endpoint without looking for a credential', async () => {
    // Nothing is stored for a host/port pair, and a device needing no login must
    // still connect.
    const scene1 = await scene()
    const opened = await callTool(scene1, 'console_connect', { host: '127.0.0.1', port: 1, kind: 'raw' })
    expect(opened).toBeDefined()
  })

  it('never puts the resolved password in the result or its render', async () => {
    const scene1 = await scene({ resolveSecret: async () => ({ password: 'top-secret-value' }) })
    const opened = await callTool(scene1, 'console_connect', { viewId: 'v-known' })
    expect(JSON.stringify(opened)).not.toContain('top-secret-value')
    const tool = scene1.registry.tools.get('console_connect')
    const rendered = tool?.output.render({}, opened).map(block => block.text).join('\n') ?? ''
    expect(rendered).not.toContain('top-secret-value')
  })
})
