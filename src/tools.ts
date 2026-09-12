/**
 * The model-facing console tools.
 *
 * The scope rule is the whole shape of this module: a tool binds to the CALLING
 * AGENT'S SESSION through `exec.agent.session.id`, so the model never passes a
 * session id and can never reach another session's consoles. Every tool is a
 * thin translation into `PortManager` calls — the session, paging, encoding and
 * ownership behaviour all live below it.
 *
 * Two conventions from the DSH tool contract shape the definitions:
 * - `execute` returns ONE canonical JSON value; `output.render` is a separate
 *   pure text projection, so a caller never parses prose for an id.
 * - `output.schema` stays inside the supported JSON-Schema subset (no `pattern`).
 *
 * @module dsh-console-hub/tools
 */
// The DSL compiler is a VALUE import on purpose: `register()` stores
// `parameters` verbatim and the harness hands it straight to the model API, so
// what gets registered must already be raw JSON Schema. Letting the harness's
// own compiler do that conversion is the only way to be sure the two spellings
// (the authoring DSL vs raw JSON Schema) are not confused -- confusing them is
// exactly the bug this replaced: `parameters` written in the DSL has no
// top-level `type`, and the provider rejects the whole tool list with
// "schema must be a JSON Schema of 'type: \"object\"', got 'type: null'"
// before the model can say anything at all.
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ConsoleToolRegistry, ConsoleToolRunContext } from './context-types.ts'
import type { ConsoleView } from './config-shared.ts'
import { isConsoleEncoding } from './config-shared.ts'
import type { ConsoleEntry, PortManager } from './port-manager.ts'

/** The tool names this plugin contributes, in registration order. */
export const CONSOLE_TOOL_NAMES = [
  'console_list',
  'console_connect',
  'console_send',
  'console_read',
  'console_wait_for',
  'console_close',
  'console_describe',
  'console_clear',
] as const

/** One model-facing tool name. */
export type ConsoleToolName = typeof CONSOLE_TOOL_NAMES[number]

/** Engine defaults a tool call falls back to. */
export interface ConsoleToolDefaults {
  encoding: string
  kind: 'telnet' | 'raw'
  pagingMode: 'auto-more' | 'auto-quit' | 'auto-interrupt' | 'manual'
}

/** Everything the tool family needs from the host. */
export interface ConsoleToolDeps {
  registry: ConsoleToolRegistry
  manager: PortManager
  /** The stored views, keyed by id (a supplier, so a settings change is seen). */
  views(): Record<string, ConsoleView>
  /** The plugin's engine defaults. */
  defaults(): ConsoleToolDefaults
  /**
   * Inspect one outgoing command before it is written.
   *
   * The guard runs INSIDE the tool, so a fenced command never reaches the wire
   * even when the model calls `console_send` directly. It may throw to refuse
   * the call; the throw becomes the call's error result.
   */
  guard?(request: {
    exec: ConsoleToolRunContext
    sessionId: string
    consoleId: string
    text: string
  }): Promise<void>
}

/** The schema fragment every tool shares. */
const CONSOLE_ID = {
  type: 'string',
  required: true,
  description: 'Console handle returned by console_connect or console_list.',
} as const

/**
 * Build an `output.schema` object node.
 *
 * The output contract is a RAW JSON Schema in the harness's enforced subset,
 * which is NOT the same DSL as `parameters`. In particular `required` is a
 * STRING ARRAY on the object node -- writing `required: true` on each property
 * (the `parameters` spelling) is rejected by `assertSupportedJsonSchema`, and
 * a rejected definition makes `register` throw, so the tool silently never
 * appears. This helper makes the two spellings impossible to confuse.
 *
 * @param properties - the declared property schemas.
 * @param required - names that must be present; must be a subset of `properties`.
 * @returns the object-rooted schema node.
 */
function outputSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  for (const name of required) {
    if (!(name in properties)) {
      // A required name with no property is rejected by the subset too, but
      // failing here names the author's mistake instead of the schema's shape.
      throw new Error(`console-hub: output schema requires undeclared property "${name}"`)
    }
  }
  return { type: 'object', additionalProperties: false, properties, required: [...required] }
}

/** Names of the properties marked `required: true` in a `parameters` tree. */
const CONSOLE_REQUIRED = ['consoleId'] as const

/** A small text renderer (the canonical value is already structured). */
function text(value: string): { type: 'text', text: string }[] {
  return [{ type: 'text', text: value }]
}

/**
 * One console as `console_list` reports it.
 *
 * Declared as its own type, and the renderer below typed against IT rather than
 * against `ConsoleEntry`, because the two are not the same shape. The renderer
 * used to receive the projection while reading the entry's `lastError` field,
 * which the projection does not carry -- so `console_list` threw
 * `Cannot read properties of undefined (reading 'code')` whenever any console
 * was open. Typing the renderer against what the body actually returns makes
 * that mismatch a compile error instead of a crash.
 */
interface ConsoleListRow {
  consoleId: string
  label: string
  host: string
  port: number
  kind: string
  state: string
  secure: boolean
  idleMs: number
  /** Present only when the console recorded a failure. */
  lastErrorCode?: string
}

/** The handle, quoted so its boundary is unambiguous in rendered text. */
function handle(id: string): string {
  // A bare handle at the end of a sentence invites copying the punctuation with
  // it -- against a real device the model did exactly that, and the retry failed
  // with "not found for this session". Quoting is cheaper than that retry.
  return `"${id}"`
}

/** Render one console as a line. */
function consoleRowLine(row: ConsoleListRow): string {
  const error = row.lastErrorCode === undefined ? '' : ` [${row.lastErrorCode}]`
  return `${handle(row.consoleId)}  ${row.label}  ${row.host}:${String(row.port)}  ${row.kind}  `
    + `${row.state}${error}  idle ${String(Math.round(row.idleMs / 1000))}s`
}

/** The calling agent's session id, or a throw that names the missing scope. */
function sessionIdOf(exec: ConsoleToolRunContext): string {
  const sessionId = exec.agent?.session.id
  if (sessionId === undefined) {
    throw new Error('console tools require an initiating agent (no session to scope consoles to)')
  }
  return sessionId
}

/** Refuse before doing work when the caller has already gone away. */
function assertLive(exec: ConsoleToolRunContext): void {
  if (exec.signal.aborted) throw new Error('the console tool call was aborted before it started')
}

/** Validate an optional encoding argument. */
function checkedEncoding(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('"encoding" must be a string')
  if (!isConsoleEncoding(value)) throw new Error(`unsupported encoding "${value}"`)
  return value
}

/** Read an optional string argument. */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`"${field}" must be a string`)
  return value
}

/**
 * Resolve the target of a connect: a stored view, or an explicit endpoint.
 * @param deps - the tool dependencies.
 * @param args - the parsed connect arguments.
 * @returns the descriptor fields a connect needs.
 * @throws {Error} when neither a view nor a complete endpoint was supplied.
 */
function connectTarget(
  deps: ConsoleToolDeps,
  args: Record<string, unknown>,
): {
  label: string
  host: string
  port: number
  kind: 'telnet' | 'raw'
  encoding: string
  user?: string
} {
  const defaults = deps.defaults()
  const viewId = optionalText(args.viewId, 'viewId')
  const host = optionalText(args.host, 'host')
  const rawPort = args.port
  const kind = optionalText(args.kind, 'kind') ?? defaults.kind
  if (kind !== 'telnet' && kind !== 'raw') throw new Error(`"kind" must be telnet or raw (got "${kind}")`)
  const encoding = checkedEncoding(args.encoding) ?? defaults.encoding

  if (viewId !== undefined) {
    const view = deps.views()[viewId]
    if (view === undefined) throw new Error(`no stored view "${viewId}"`)
    return {
      label: view.name,
      host: view.host,
      port: view.port,
      kind,
      encoding: view.encoding === '' ? encoding : view.encoding,
      ...view.user === '' ? {} : { user: view.user },
    }
  }

  if (host === undefined || typeof rawPort !== 'number' || !Number.isInteger(rawPort)) {
    throw new Error('supply either "viewId", or both "host" and an integer "port"')
  }
  if (rawPort < 1 || rawPort > 65535) throw new Error(`"port" must be in 1..65535 (got ${String(rawPort)})`)
  return {
    label: optionalText(args.label, 'label') ?? `${host}:${String(rawPort)}`,
    host,
    port: rawPort,
    kind,
    encoding,
  }
}

/**
 * Register the console tool family.
 *
 * The caller decides WHEN these are registered (a setting gates the family), so
 * this returns a disposer that unregisters every tool at once.
 *
 * @param deps - the tool dependencies.
 * @returns a disposer that unregisters the whole family.
 */
export function registerConsoleTools(deps: ConsoleToolDeps): () => void {
  const disposers: Array<() => void> = []
  const register = (definition: unknown): void => {
    disposers.push(deps.registry.register(definition))
  }

  register({
    name: 'console_list',
    description:
      'List every device console this session has open. Returns each console\'s handle, label, device address, '
      + 'transport, state, and how long it has been idle. Use it to recover state after a long sequence of calls, '
      + 'or to find a console you forgot to close.',
    parameters: parameterSchemaSpecToJsonSchema({}),
    output: {
      schema: outputSchema({
        consoles: {
          type: 'array',
          items: outputSchema({
            consoleId: { type: 'string' },
            label: { type: 'string' },
            host: { type: 'string' },
            port: { type: 'number' },
            kind: { type: 'string' },
            state: { type: 'string' },
            secure: { type: 'boolean' },
            idleMs: { type: 'number' },
            lastErrorCode: { type: 'string' },
          }, ['consoleId', 'label', 'host', 'port', 'kind', 'state', 'secure', 'idleMs']),
        },
      }, ['consoles']),
      render: (_args: unknown, value: unknown) => {
        const consoles = (value as { consoles: ConsoleListRow[] }).consoles
        if (consoles.length === 0) return text('No device consoles are open in this session.')
        return text(consoles.map(consoleRowLine).join('\n'))
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const consoles: ConsoleListRow[] = deps.manager.list(sessionIdOf(exec)).map(entry => ({
        consoleId: entry.consoleId,
        label: entry.label,
        host: entry.host,
        port: entry.port,
        kind: entry.kind,
        state: entry.state,
        secure: entry.secure,
        idleMs: entry.idleMs,
        // The failure code is why a console needs attention, so the list carries
        // it. Omitted rather than null when there is none: the schema declares an
        // optional string, and an explicit null would violate it.
        ...entry.lastError === null ? {} : { lastErrorCode: entry.lastError.code },
      }))
      return { consoles }
    },
  })

  register({
    name: 'console_connect',
    description:
      'Open a console connection to a network device through its console-server port (telnet or raw TCP). '
      + 'Name a stored view with `viewId`, or pass `host` and `port` directly. '
      + 'Returns a console handle plus what the device said on connect (banner and prompt). '
      + 'A connect that fails is still a result: it reports state "error" with a coded lastError so you can retry '
      + 'or pick a different device. The connection stays open until console_close.',
    parameters: parameterSchemaSpecToJsonSchema({
      viewId: { type: 'string', description: 'Stored device view to connect to (preferred when one exists).' },
      host: { type: 'string', description: 'Console-server address, when no stored view is used.' },
      port: { type: 'number', description: 'Mapped console port, when no stored view is used.' },
      kind: { type: 'string', enum: ['telnet', 'raw'], description: 'Transport; telnet strips option negotiation.' },
      encoding: {
        type: 'string',
        description: 'Character encoding for this console (utf-8, gbk, gb18030, big5, shift_jis, euc-kr, latin1).',
      },
      label: { type: 'string', description: 'Short human-readable label for this console.' },
      password: {
        type: 'string',
        description: 'Login password, used once to answer the device prompt and never stored. '
          + 'Prefer a stored credential on the view; only pass this when the user asks for an ad-hoc connection.',
      },
    }),
    output: {
      schema: outputSchema({
        consoleId: { type: 'string' },
        state: { type: 'string' },
        label: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        secure: { type: 'boolean' },
        banner: { type: 'string' },
        prompt: { type: 'string' },
        lastErrorCode: { type: 'string' },
        lastErrorMessage: { type: 'string' },
      }, ['consoleId', 'state', 'label', 'host', 'port', 'secure', 'banner']),
      render: (_args: unknown, value: unknown) => {
        const result = value as {
          consoleId: string
          state: string
          label: string
          host: string
          port: number
          banner: string
          prompt?: string
          lastErrorCode?: string
        }
        if (result.state === 'open') {
          const prompt = result.prompt === undefined ? '' : `, prompt ${handle(result.prompt)}`
          const banner = result.banner === '' ? '' : `\n--- connect output ---\n${result.banner}`
          // The handle is quoted and labelled, and no separator follows it: a
          // bare trailing handle invites copying the sentence's punctuation into
          // the id, which is exactly what happened against a real device.
          return text(
            `Connected to "${result.label}" (${result.host}:${String(result.port)}). `
            + `Handle ${handle(result.consoleId)}${prompt}.${banner}`,
          )
        }
        return text(
          `Console "${result.label}" (${result.host}:${String(result.port)}) is ${result.state}`
          + `${result.lastErrorCode === undefined ? '' : `: ${result.lastErrorCode}`}. `
          + `Handle ${handle(result.consoleId)} stays listed so it can be closed or retried.`,
        )
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const sessionId = sessionIdOf(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const target = connectTarget(deps, parsed)
      const password = optionalText(parsed.password, 'password')

      const entry = await deps.manager.connect({
        ownerSessionId: sessionId,
        ...target,
        ...password === undefined || password === '' ? {} : { password },
      })
      const detail = deps.manager.describe(sessionId, entry.consoleId)
      return {
        consoleId: entry.consoleId,
        state: entry.state,
        label: entry.label,
        host: entry.host,
        port: entry.port,
        secure: entry.secure,
        banner: deps.manager.bannerOf(sessionId, entry.consoleId),
        ...detail?.state.prompt === null || detail?.state.prompt === undefined
          ? {}
          : { prompt: detail.state.prompt },
        ...entry.lastError === null ? {} : { lastErrorCode: entry.lastError.code, lastErrorMessage: entry.lastError.message },
      }
    },
  })

  register({
    name: 'console_send',
    description:
      'Send one line of input to a device console. The host appends the submit key (Enter by default), so do NOT '
      + 'include a trailing newline. Set `submit: false` to write without pressing Enter, and `submitKey` to override '
      + 'what Enter means for this device. High-risk commands (entering configuration mode, restarting) are refused '
      + 'unless the user approves them.',
    parameters: parameterSchemaSpecToJsonSchema({
      consoleId: CONSOLE_ID,
      text: { type: 'string', required: true, description: 'The line to send (no trailing newline).' },
      submit: { type: 'boolean', description: 'Whether to append the submit key (default true).' },
      submitKey: { type: 'string', description: 'Submit key override; defaults to a carriage return.' },
      encoding: { type: 'string', description: 'Encoding override for this write.' },
    }),
    output: {
      schema: outputSchema({
        consoleId: { type: 'string' },
        state: { type: 'string' },
        written: { type: 'number' },
        pagingActive: { type: 'boolean' },
      }, ['consoleId', 'state', 'written']),
      render: (_args: unknown, value: unknown) => {
        const result = value as { consoleId: string, state: string, pagingActive?: boolean }
        const paging = result.pagingActive === true ? ' A pager prompt is waiting; read the output or send a page key.' : ''
        return text(`Sent to ${result.consoleId} (${result.state}).${paging}`)
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const sessionId = sessionIdOf(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const consoleId = parsed.consoleId
      if (typeof consoleId !== 'string' || consoleId === '') throw new Error('"consoleId" is required')
      const command = parsed.text
      if (typeof command !== 'string' || command === '') throw new Error('"text" is required')

      // The guard runs before anything reaches the wire, so a fenced command
      // cannot be written even by a direct tool call.
      await deps.guard?.({ exec, sessionId, consoleId, text: command })

      const encoding = checkedEncoding(parsed.encoding)
      const submit = parsed.submit
      if (submit !== undefined && typeof submit !== 'boolean') throw new Error('"submit" must be a boolean')
      const submitKey = optionalText(parsed.submitKey, 'submitKey')
      const entry = await deps.manager.send(sessionId, consoleId, command, {
        ...encoding === undefined ? {} : { encoding },
        ...submit === undefined ? {} : { submit },
        ...submitKey === undefined ? {} : { submitKey },
        actor: 'model',
      })
      const detail = deps.manager.describe(sessionId, consoleId)
      return {
        consoleId,
        state: entry.state,
        written: detail?.state.bytesWritten ?? 0,
        ...detail?.state.paging === undefined ? {} : { pagingActive: detail.state.paging.active },
      }
    },
  })

  register({
    name: 'console_read',
    description:
      'Read console output received since a cursor. Pass the `cursor` from the previous call as `after` so no output '
      + 'is read twice; the first call uses `after: 0`. Returns the decoded text, the next cursor, whether the answer '
      + 'was truncated at the output cap, and the device prompt if one is at the tail. '
      + 'Use `stripEcho` to drop the command line the device echoed back.',
    parameters: parameterSchemaSpecToJsonSchema({
      consoleId: CONSOLE_ID,
      after: { type: 'number', description: 'Cursor to read from; omit or 0 for everything still buffered.' },
      encoding: { type: 'string', description: 'Encoding override for this read.' },
      stripEcho: { type: 'string', description: 'A command line to remove from the output (the echo of what you sent).' },
      maxBytes: { type: 'number', description: 'Cap on returned text bytes for this read.' },
    }),
    output: {
      schema: outputSchema({
        text: { type: 'string' },
        cursor: { type: 'number' },
        truncated: { type: 'boolean' },
        bytes: { type: 'number' },
        encoding: { type: 'string' },
        prompt: { type: 'string' },
        pager: { type: 'string' },
        pagingActive: { type: 'boolean' },
      }, ['text', 'cursor', 'truncated', 'bytes', 'encoding', 'pagingActive']),
      render: (_args: unknown, value: unknown) => {
        const result = value as {
          text: string
          cursor: number
          truncated: boolean
          prompt?: string
          pagingActive: boolean
        }
        const notes: string[] = []
        if (result.truncated) notes.push('truncated at the output cap; read again from the returned cursor')
        if (result.prompt !== undefined) notes.push(`prompt ${result.prompt}`)
        if (result.pagingActive) notes.push('a pager prompt is waiting')
        const suffix = notes.length === 0 ? '' : `\n[${notes.join('; ')}]`
        const body = result.text === '' ? '(no new output)' : result.text
        return text(`${body}\n[cursor ${String(result.cursor)}]${suffix}`)
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const sessionId = sessionIdOf(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const consoleId = parsed.consoleId
      if (typeof consoleId !== 'string' || consoleId === '') throw new Error('"consoleId" is required')
      const after = parsed.after
      if (after !== undefined && typeof after !== 'number') throw new Error('"after" must be a number')
      const maxBytes = parsed.maxBytes
      if (maxBytes !== undefined && typeof maxBytes !== 'number') throw new Error('"maxBytes" must be a number')
      const stripEcho = optionalText(parsed.stripEcho, 'stripEcho')
      const encoding = checkedEncoding(parsed.encoding)

      const read = deps.manager.read(sessionId, consoleId, {
        ...after === undefined ? {} : { after },
        ...maxBytes === undefined ? {} : { maxBytes },
        ...stripEcho === undefined ? {} : { stripEcho },
        ...encoding === undefined ? {} : { encoding },
      })
      return {
        text: read.text,
        cursor: read.cursor,
        truncated: read.truncated,
        bytes: read.bytes,
        encoding: read.encoding,
        ...read.prompt === undefined ? {} : { prompt: read.prompt },
        ...read.pager === undefined ? {} : { pager: read.pager },
        pagingActive: read.paging.active,
      }
    },
  })

  register({
    name: 'console_wait_for',
    description:
      'Wait until a device console produces what you are waiting for, then return. Use `for: "prompt"` (default) to '
      + 'wait until the CLI prompt comes back, `for: "pattern"` with a regular expression to wait for a specific line, '
      + 'or `for: "idle"` to wait until output stops arriving. This is the right way to wait for a command to finish — '
      + 'do not poll console_read in a loop. A timeout is a normal result (matched: false, reason: "timeout"), not an '
      + 'error, so read the output that did arrive.',
    parameters: parameterSchemaSpecToJsonSchema({
      consoleId: CONSOLE_ID,
      for: { type: 'string', enum: ['prompt', 'idle', 'pattern'], description: 'What to wait for (default prompt).' },
      pattern: { type: 'string', description: 'Regular expression, required when `for` is "pattern".' },
      timeoutMs: { type: 'number', description: 'Budget in milliseconds; defaults to the plugin read timeout.' },
      after: { type: 'number', description: 'Cursor the wait starts from (your last read cursor).' },
      idleMs: { type: 'number', description: 'Quiet window that satisfies `for: "idle"`.' },
    }),
    output: {
      schema: outputSchema({
        matched: { type: 'boolean' },
        reason: { type: 'string' },
        matchedText: { type: 'string' },
        cursor: { type: 'number' },
        elapsedMs: { type: 'number' },
      }, ['matched', 'reason', 'cursor', 'elapsedMs']),
      render: (_args: unknown, value: unknown) => {
        const result = value as {
          matched: boolean
          reason: string
          matchedText?: string
          elapsedMs: number
        }
        if (result.matched) {
          const what = result.matchedText === undefined ? 'the output went quiet' : `saw ${result.matchedText}`
          return text(`Waited ${String(result.elapsedMs)}ms and ${what}.`)
        }
        if (result.reason === 'closed') return text('The console closed while waiting.')
        return text(
          `Waited ${String(result.elapsedMs)}ms and nothing matched. The device may still be working; `
          + 'read the output, or wait again with a longer timeout.',
        )
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const sessionId = sessionIdOf(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const consoleId = parsed.consoleId
      if (typeof consoleId !== 'string' || consoleId === '') throw new Error('"consoleId" is required')
      const condition = optionalText(parsed.for, 'for') ?? 'prompt'
      if (!['prompt', 'idle', 'pattern'].includes(condition)) {
        throw new Error(`"for" must be prompt, idle, or pattern (got "${condition}")`)
      }
      const pattern = optionalText(parsed.pattern, 'pattern')
      if (condition === 'pattern' && (pattern === undefined || pattern === '')) {
        throw new Error('"pattern" is required when "for" is pattern')
      }
      const timeoutMs = parsed.timeoutMs
      if (timeoutMs !== undefined && typeof timeoutMs !== 'number') throw new Error('"timeoutMs" must be a number')
      const after = parsed.after
      if (after !== undefined && typeof after !== 'number') throw new Error('"after" must be a number')
      const idleMs = parsed.idleMs
      if (idleMs !== undefined && typeof idleMs !== 'number') throw new Error('"idleMs" must be a number')

      const waited = await deps.manager.waitFor(sessionId, consoleId, {
        for: condition as 'prompt' | 'idle' | 'pattern',
        ...pattern === undefined ? {} : { pattern },
        ...timeoutMs === undefined ? {} : { timeoutMs },
        ...after === undefined ? {} : { after },
        ...idleMs === undefined ? {} : { idleMs },
      })
      return {
        matched: waited.matched,
        reason: waited.reason,
        ...waited.matchedText === undefined ? {} : { matchedText: waited.matchedText },
        cursor: waited.cursor,
        elapsedMs: waited.elapsedMs,
      }
    },
  })

  register({
    name: 'console_close',
    description:
      'Close a device console and release its connection to the console-server port. Use `force: true` when the '
      + 'device is not answering a graceful close. Close consoles when you are done with them: an idle console is '
      + 'reaped automatically after the idle window, and it holds a scarce serial port open until then.',
    parameters: parameterSchemaSpecToJsonSchema({
      consoleId: CONSOLE_ID,
      force: { type: 'boolean', description: 'Destroy the socket instead of closing it gracefully.' },
    }),
    output: {
      schema: outputSchema({
        consoleId: { type: 'string' },
        closed: { type: 'boolean' },
      }, ['consoleId', 'closed']),
      render: (_args: unknown, value: unknown) => text(`Closed console ${(value as { consoleId: string }).consoleId}.`),
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const sessionId = sessionIdOf(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const consoleId = parsed.consoleId
      if (typeof consoleId !== 'string' || consoleId === '') throw new Error('"consoleId" is required')
      const force = parsed.force
      if (force !== undefined && typeof force !== 'boolean') throw new Error('"force" must be a boolean')
      await deps.manager.close(sessionId, consoleId, force === undefined ? {} : { force })
      return { consoleId, closed: true }
    },
  })

  register({
    name: 'console_describe',
    description:
      'Show one console in detail: bytes read and written, the prompt last seen, encoding and paging state, and the '
      + 'audit trail of who sent what. Use it to understand what already happened on a console before acting.',
    parameters: parameterSchemaSpecToJsonSchema({ consoleId: CONSOLE_ID }),
    output: {
      schema: outputSchema({
        consoleId: { type: 'string' },
        label: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        kind: { type: 'string' },
        state: { type: 'string' },
        encoding: { type: 'string' },
        idleMs: { type: 'number' },
        bytesReceived: { type: 'number' },
        bytesWritten: { type: 'number' },
        prompt: { type: 'string' },
        pagingActive: { type: 'boolean' },
        pagesConsumed: { type: 'number' },
        lastErrorCode: { type: 'string' },
        audit: {
          type: 'array',
          items: outputSchema({
            at: { type: 'string' },
            actor: { type: 'string' },
            action: { type: 'string' },
            detail: { type: 'string' },
          }, ['at', 'actor', 'action', 'detail']),
        },
      }, [
        'consoleId', 'label', 'host', 'port', 'kind', 'state', 'encoding', 'idleMs',
        'bytesReceived', 'bytesWritten', 'pagingActive', 'pagesConsumed', 'audit',
      ]),
      render: (_args: unknown, value: unknown) => {
        const result = value as {
          consoleId: string
          label: string
          state: string
          bytesReceived: number
          bytesWritten: number
          prompt?: string
          pagesConsumed: number
          audit: { at: string, actor: string, action: string, detail: string }[]
        }
        const head = `${result.consoleId} "${result.label}" state ${result.state}, `
          + `${String(result.bytesReceived)} bytes in / ${String(result.bytesWritten)} out, `
          + `${String(result.pagesConsumed)} pages consumed`
          + `${result.prompt === undefined ? '' : `, prompt ${result.prompt}`}`
        const trail = result.audit.slice(-10).map(entry => `  ${entry.at} ${entry.actor} ${entry.action}: ${entry.detail}`)
        return text([head, ...trail].join('\n'))
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const sessionId = sessionIdOf(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const consoleId = parsed.consoleId
      if (typeof consoleId !== 'string' || consoleId === '') throw new Error('"consoleId" is required')
      const detail = deps.manager.describe(sessionId, consoleId)
      if (detail === undefined) throw new Error(`console "${consoleId}" not found for this session`)
      const { entry, state } = detail
      return {
        consoleId: entry.consoleId,
        label: entry.label,
        host: entry.host,
        port: entry.port,
        kind: entry.kind,
        state: entry.state,
        encoding: entry.encoding,
        idleMs: entry.idleMs,
        bytesReceived: state.bytesReceived,
        bytesWritten: state.bytesWritten,
        ...state.prompt === null ? {} : { prompt: state.prompt },
        pagingActive: state.paging.active,
        pagesConsumed: state.paging.pagesConsumed,
        ...entry.lastError === null ? {} : { lastErrorCode: entry.lastError.code },
        audit: state.audit.map(item => ({
          at: item.at,
          actor: item.actor,
          action: item.action,
          detail: item.detail,
        })),
      }
    },
  })

  register({
    name: 'console_clear',
    description:
      'Discard everything already shown on one console, so the next read starts from a clean pane. '
      + 'The connection is NOT touched: nothing is sent to the device, nothing is closed or reset, and the '
      + 'device\'s own scrollback is unaffected -- only this process\'s copy of the output is dropped. '
      + 'Use it when earlier output is no longer relevant and would otherwise fill the next read.',
    parameters: parameterSchemaSpecToJsonSchema({ consoleId: CONSOLE_ID }),
    output: {
      schema: outputSchema({
        consoleId: { type: 'string' },
        cursor: { type: 'number' },
        droppedBytes: { type: 'number' },
      }, ['consoleId', 'cursor', 'droppedBytes']),
      render: (_args: unknown, value: unknown) => {
        const result = value as { consoleId: string, cursor: number, droppedBytes: number }
        // A reader that kept its old cursor must be told to move: the bytes it
        // was waiting for are gone, and re-reading from there yields nothing.
        return text(
          `Cleared ${String(result.droppedBytes)} byte(s) from console "${result.consoleId}" (local copy only; the `
          + `connection is still open). Read it next with after=${String(result.cursor)}.`,
        )
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const sessionId = sessionIdOf(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const consoleId = parsed.consoleId
      if (typeof consoleId !== 'string' || consoleId === '') throw new Error('"consoleId" is required')
      let result: { cursor: number, droppedBytes: number }
      try {
        result = deps.manager.clear(sessionId, consoleId)
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      return { consoleId, cursor: result.cursor, droppedBytes: result.droppedBytes }
    },
  })

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}
