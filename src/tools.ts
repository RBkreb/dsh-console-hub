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
import type { ConsoleViewRedacted } from './views.ts'
import { isConsoleEncoding } from './config-shared.ts'
import type { ConsoleEntry, PortManager } from './port-manager.ts'

/**
 * The tool names this plugin contributes, in registration order.
 *
 * The two listing tools are separate on purpose. `console_list` answers "what am
 * I connected to right now" and `console_list_views` answers "what is
 * configured"; one tool that returned both would leave the model guessing which
 * half applied to a given handle, and an id from the wrong half fails on the
 * next call. A stored view is not a console: it has no state, no idle time, and
 * cannot be read from until it is connected.
 */
export const CONSOLE_TOOL_NAMES = [
  'console_list',
  'console_list_views',
  'console_connect',
  'console_send',
  'console_wake',
  'console_read',
  'console_wait_for',
  'console_close',
  'console_describe',
  'console_clear',
  'console_upsert_view',
  'console_remove_view',
] as const

/** One model-facing tool name. */
export type ConsoleToolName = typeof CONSOLE_TOOL_NAMES[number]

/** Engine defaults a tool call falls back to. */
export interface ConsoleToolDefaults {
  encoding: string
  kind: 'telnet' | 'raw'
  pagingMode: 'auto-more' | 'auto-quit' | 'auto-interrupt' | 'manual'
  /**
   * Quiet window that satisfies `for: "idle"` (ms), so the tool's DESCRIPTION
   * can state the number that is actually in force rather than a hardcoded one.
   *
   * A deployment that tuned `idleQuietMs` would otherwise be described to the
   * model by a stale figure, and the model would reason about a wait it is not
   * getting.
   */
  idleQuietMs: number
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
   * The stored views as a configuration surface reads them: redacted, sorted,
   * and carrying their credential facts.
   */
  listViews(): Promise<Array<{ viewId: string, view: ConsoleViewRedacted }>>
  /**
   * Create or update one stored device.
   *
   * Supplied by the host rather than reached through `views()`, because a write
   * has to go through the settings seam's `replace` (a merge cannot delete a
   * key) and has to run the schema, pattern, and secret guards.
   */
  upsertView(input: Record<string, unknown>): Promise<{ viewId: string, view: ConsoleViewRedacted }>
  /** Remove one stored device and its credential. */
  removeView(viewId: string): Promise<{ removed: boolean, secretRemoved: boolean }>
  /**
   * The credential to use for a stored view, when one is configured.
   *
   * Separate from `views()` because a VALUE is involved: the view carries only
   * the fact that a credential exists. The host resolves it at connect time, so
   * the secret reaches the socket and nowhere else.
   */
  resolveSecret?(viewId: string): Promise<{ password: string, user?: string } | undefined>
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
  /** Whether the device half-closed this idle console. */
  dormant?: boolean
  /** The marker text that proved it. */
  dormantText?: string
}

/**
 * One stored view as `console_list_views` reports it.
 *
 * Declared separately from `ConsoleView` for the same reason `ConsoleListRow` is:
 * the tool returns a PROJECTION, and typing the renderer against the projection
 * is what turns a field mismatch into a compile error instead of a crash.
 */
interface ViewListRow {
  viewId: string
  name: string
  host: string
  port: number
  kind: string
  encoding: string
  user: string
  tags: string[]
  notes: string
  secretConfigured: boolean
}

/** Render one stored view as a line. */
function viewRowLine(row: ViewListRow): string {
  const secret = row.secretConfigured ? ' key' : ''
  const user = row.user === '' ? '' : ` user=${row.user}`
  const tags = row.tags.length === 0 ? '' : ` #${row.tags.join(' #')}`
  return `${handle(row.viewId)}  ${row.name}  ${row.host}:${String(row.port)}  ${row.kind}${user}${secret}${tags}`
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
  // Dormancy is loud in the rendering, not a quiet extra field: a caller reading
  // this list must understand that a `open` console here will answer nothing
  // until Enter is pressed.
  const dormant = row.dormant === true ? '  DORMANT (device half-closed it; console_wake to press Enter)' : ''
  return `${handle(row.consoleId)}  ${row.label}  ${row.host}:${String(row.port)}  ${row.kind}  `
    + `${row.state}${error}  idle ${String(Math.round(row.idleMs / 1000))}s${dormant}`
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
  /** Set when the caller named a stored view, so its credential can be resolved. */
  viewId?: string
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
      viewId,
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
 * The stored credential for a view, when the deployment resolves one.
 *
 * Returns `undefined` for an ad-hoc endpoint (there is nothing stored to look
 * up) and for a view with no credential. A resolution failure is treated as "no
 * credential" rather than as a connect failure: a device needing no login must
 * still connect, and a login prompt is what would reveal the credential was
 * actually needed.
 *
 * @param deps - the tool dependencies.
 * @param viewId - the stored view, or `undefined` for an ad-hoc connect.
 * @returns the credential to use, or `undefined`.
 */
async function storedSecret(
  deps: ConsoleToolDeps,
  viewId: string | undefined,
): Promise<{ password: string, user?: string } | undefined> {
  if (viewId === undefined || deps.resolveSecret === undefined) return undefined
  try {
    return await deps.resolveSecret(viewId)
  } catch {
    // Fail closed to "no credential": the connect proceeds unauthenticated
    // rather than the whole call failing on a store that could not be read.
    return undefined
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
      'List the device consoles this session has CONNECTED (open right now). Each row carries the handle to pass to '
      + 'console_send / console_read / console_close, plus its label, address, transport, state and idle time. '
      + 'A row marked `dormant: true` is still open but the DEVICE half-closed it after sitting idle: it will print '
      + 'nothing until someone presses Enter, so wake it with console_wake before expecting any output. '
      + 'This does NOT list configured-but-unconnected devices -- call console_list_views for those, then '
      + 'console_connect with the viewId it returns.',
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
            dormant: { type: 'boolean' },
            dormantText: { type: 'string' },
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
        // A dormant console is `open` and answers nothing until Enter is pressed,
        // so a list that reported only the state would be actively misleading.
        dormant: entry.dormant,
        ...entry.dormantText === null ? {} : { dormantText: entry.dormantText },
      }))
      return { consoles }
    },
  })

  register({
    name: 'console_list_views',
    description:
      'List the SAVED device configurations (the inventory), whether or not they are connected. Each row carries the '
      + 'viewId to pass to console_connect, the device address and transport, and whether a login credential is '
      + 'stored for it. Use this to find a device you were told to work on, then console_connect by viewId -- do not '
      + 'connect by host and port when a saved view exists, because only the view carries its credential and its '
      + 'prompt/paging rules.',
    parameters: parameterSchemaSpecToJsonSchema({}),
    output: {
      schema: outputSchema({
        views: {
          type: 'array',
          items: outputSchema({
            viewId: { type: 'string' },
            name: { type: 'string' },
            host: { type: 'string' },
            port: { type: 'number' },
            kind: { type: 'string' },
            encoding: { type: 'string' },
            user: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
            secretConfigured: { type: 'boolean' },
          }, ['viewId', 'name', 'host', 'port', 'kind', 'secretConfigured']),
        },
      }, ['views']),
      render: (_args: unknown, value: unknown) => {
        const views = (value as { views: ViewListRow[] }).views
        if (views.length === 0) {
          return text('No saved device configurations. Create one with console_upsert_view (name, host, port).')
        }
        return text(views.map(viewRowLine).join('\n'))
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const rows = await deps.listViews()
      const views: ViewListRow[] = rows.map(({ viewId, view }) => ({
        viewId,
        name: view.name,
        host: view.host,
        port: view.port,
        kind: view.kind,
        encoding: view.encoding,
        user: view.user,
        tags: [...view.tags],
        notes: view.notes,
        secretConfigured: view.secretConfigured,
      }))
      return { views }
    },
  })

  register({
    name: 'console_upsert_view',
    description:
      'Create or update a saved device configuration. Omit `viewId` to create one (the new id is returned), or pass '
      + 'an existing `viewId` to change that device. Only the fields you supply change on an update; on a create, '
      + '`name`, `host` and `port` are required. '
      + 'A `password` is written to the credential store, never to the configuration document, and is never read '
      + 'back. Connecting the view later resolves it automatically.',
    parameters: parameterSchemaSpecToJsonSchema({
      viewId: { type: 'string', description: 'Existing view to update; omit to create a new one.' },
      name: { type: 'string', description: 'Short human-readable device name (required on create).' },
      host: { type: 'string', description: 'Console-server address (required on create).' },
      port: { type: 'number', description: 'Mapped console port 1-65535 (required on create).' },
      kind: { type: 'string', enum: ['telnet', 'raw'], description: 'Transport; telnet strips option negotiation.' },
      encoding: { type: 'string', description: 'Device encoding override; empty uses the plugin default.' },
      user: { type: 'string', description: 'Login user, when the device wants one.' },
      promptPattern: { type: 'string', description: 'Per-device prompt regex override; empty uses the plugin default.' },
      pagerPattern: { type: 'string', description: 'Per-device pager regex override; empty uses the plugin default.' },
      pagingMode: { type: 'string', enum: ['auto-more', 'auto-quit', 'auto-interrupt', 'manual'], description: 'Per-device paging mode override.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Free-form labels, for finding devices later.' },
      notes: { type: 'string', description: 'Free-form note (never a credential).' },
      password: {
        type: 'string',
        description: 'Login password, stored in the credential store. Write-only: it can never be read back.',
      },
    }),
    output: {
      schema: outputSchema({
        viewId: { type: 'string' },
        created: { type: 'boolean' },
        name: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        kind: { type: 'string' },
        secretConfigured: { type: 'boolean' },
      }, ['viewId', 'created', 'name', 'host', 'port', 'kind', 'secretConfigured']),
      render: (_args: unknown, value: unknown) => {
        const result = value as {
          viewId: string
          created: boolean
          name: string
          host: string
          port: number
          secretConfigured: boolean
        }
        return text(
          `${result.created ? 'Created' : 'Updated'} ${handle(result.viewId)} "${result.name}" `
          + `${result.host}:${String(result.port)}`
          + `${result.secretConfigured ? ' (credential stored)' : ' (no credential stored)'}. `
          + `Connect it with console_connect viewId=${handle(result.viewId)}.`,
        )
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const viewId = optionalText(parsed.viewId, 'viewId')
      // `created` is decided from the inventory BEFORE the write, because an
      // upsert with a supplied id cannot tell creation from update afterwards.
      const known = viewId !== undefined && deps.views()[viewId] !== undefined
      const result = await deps.upsertView(parsed)
      return {
        viewId: result.viewId,
        created: !known,
        name: result.view.name,
        host: result.view.host,
        port: result.view.port,
        kind: result.view.kind,
        secretConfigured: result.view.secretConfigured,
      }
    },
  })

  register({
    name: 'console_remove_view',
    description:
      'Delete a saved device configuration, along with any credential stored for it. This is the configuration, not '
      + 'a live console: use console_close for a connection that is open. Removing a device that is currently '
      + 'connected does NOT close that console, so close it first when you mean to disconnect as well.',
    parameters: parameterSchemaSpecToJsonSchema({
      viewId: { type: 'string', required: true, description: 'The stored view to delete.' },
    }),
    output: {
      schema: outputSchema({
        viewId: { type: 'string' },
        removed: { type: 'boolean' },
        secretRemoved: { type: 'boolean' },
      }, ['viewId', 'removed', 'secretRemoved']),
      render: (_args: unknown, value: unknown) => {
        const result = value as { viewId: string, removed: boolean, secretRemoved: boolean }
        return text(
          `Removed the saved configuration ${handle(result.viewId)}`
          + `${result.secretRemoved ? ' and its stored credential' : ''}.`,
        )
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const viewId = optionalText(parsed.viewId, 'viewId')
      if (viewId === undefined) throw new Error('"viewId" is required')
      const result = await deps.removeView(viewId)
      return { viewId, removed: result.removed, secretRemoved: result.secretRemoved }
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
      const explicit = optionalText(parsed.password, 'password')
      // A stored credential is what makes connecting by `viewId` worth doing, so
      // it is resolved HERE rather than left to the caller. An explicit password
      // wins: it is the ad-hoc override for a device whose stored value is stale.
      //
      // This path was documented ("Prefer a stored credential on the view") long
      // before it existed -- `resolveSecret` was written and never called, so a
      // device with a saved password still needed the password passed in. The
      // value reaches the socket and is never returned.
      const stored = explicit === undefined || explicit === '' ? await storedSecret(deps, target.viewId) : undefined
      const password = explicit === undefined || explicit === '' ? stored?.password : explicit

      const entry = await deps.manager.connect({
        ownerSessionId: sessionId,
        ...target,
        // A view with a stored user supplies it when no explicit password came
        // with one; an explicit password always pairs with the caller's user.
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
      + 'what Enter means for this device. '
      + 'An EMPTY `text` is allowed and presses Enter alone, which is how a console the device half-closed is woken; '
      + 'whitespace is passed through byte for byte, because a single space is a pager\'s next-page key. '
      + 'High-risk commands (entering configuration mode, restarting) are refused unless the user approves them.',
    parameters: parameterSchemaSpecToJsonSchema({
      consoleId: CONSOLE_ID,
      text: {
        type: 'string',
        description: 'The line to send (no trailing newline). Omit or leave empty to press Enter alone.',
      },
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
        dormant: { type: 'boolean' },
      }, ['consoleId', 'state', 'written']),
      render: (_args: unknown, value: unknown) => {
        const result = value as { consoleId: string, state: string, pagingActive?: boolean, dormant?: boolean }
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
      // Deliberately allows `''` and any whitespace: an empty line presses Enter
      // (the wake keystroke), and a single space is a pager's next-page key. Only
      // a WRONG TYPE is refused.
      if (command !== undefined && command !== null && typeof command !== 'string') {
        throw new Error('"text" must be a string')
      }
      const line = typeof command === 'string' ? command : ''

      // The guard runs before anything reaches the wire, so a fenced command
      // cannot be written even by a direct tool call.
      await deps.guard?.({ exec, sessionId, consoleId, text: line })

      const encoding = checkedEncoding(parsed.encoding)
      const submit = parsed.submit
      if (submit !== undefined && typeof submit !== 'boolean') throw new Error('"submit" must be a boolean')
      const submitKey = optionalText(parsed.submitKey, 'submitKey')
      const entry = await deps.manager.send(sessionId, consoleId, line, {
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
        // Reported because a send does not by itself wake a dormant console: the
        // bytes go out, the device ignores them, and the next read is empty.
        ...detail?.state.dormancy === undefined ? {} : { dormant: detail.state.dormancy.dormant },
      }
    },
  })

  register({
    name: 'console_wake',
    description:
      'Press Enter once on a device console, to wake a console the DEVICE half-closed after sitting idle. '
      + 'A remote console times out its own session after a long silence and announces it ("Vty connection is timed '
      + 'out. Please press ENTER."), after which it prints no device events and answers no command until a key '
      + 'arrives. The TCP connection stays up throughout, so nothing about the console looks broken from outside. '
      + 'The plugin detects that marker and answers it automatically; call this when a console reports '
      + '`dormant: true` (console_list, console_read) or `dormantBlocked: true` (console_wait_for), or after a long '
      + 'pause when the console has gone quiet. It sends exactly one Enter, never a command, and reports whether the '
      + 'device answered. `console_send` with an empty `text` does the same thing.',
    parameters: parameterSchemaSpecToJsonSchema({
      consoleId: CONSOLE_ID,
    }),
    output: {
      schema: outputSchema({
        consoleId: { type: 'string' },
        answered: { type: 'boolean' },
        dormant: { type: 'boolean' },
        state: { type: 'string' },
      }, ['consoleId', 'answered', 'dormant', 'state']),
      render: (_args: unknown, value: unknown) => {
        const result = value as { consoleId: string, answered: boolean, dormant: boolean, state: string }
        if (result.answered) {
          return text(
            `Pressed Enter on ${result.consoleId}; the device answered, so the console is live again. `
            + 'Read the output that arrived, then send the command you were trying.',
          )
        }
        if (result.dormant) {
          return text(
            `Pressed Enter on ${result.consoleId} but the device still says nothing, so it is still dormant. `
            + 'It may need longer, or the console server may be holding the port for another session.',
          )
        }
        return text(
          `Pressed Enter on ${result.consoleId}; no new output arrived inside the wake window `
          + `(console state ${result.state}). A console that answers nothing to Enter may simply have nothing to say.`,
        )
      },
    },
    execute: async (args: unknown, exec: ConsoleToolRunContext) => {
      assertLive(exec)
      const sessionId = sessionIdOf(exec)
      const parsed = (args ?? {}) as Record<string, unknown>
      const consoleId = parsed.consoleId
      if (typeof consoleId !== 'string' || consoleId === '') throw new Error('"consoleId" is required')
      // Deliberately NOT behind the high-risk fence: a bare Enter runs no
      // command. Putting the recovery keystroke behind an approval prompt would
      // make an idle console harder to recover than it is to disturb.
      const answered = await deps.manager.wake(sessionId, consoleId)
      const detail = deps.manager.describe(sessionId, consoleId)
      return {
        consoleId,
        answered,
        dormant: detail?.entry.dormant ?? false,
        state: detail?.entry.state ?? 'closed',
      }
    },
  })

  register({
    name: 'console_read',
    description:
      'Read console output received since a cursor. Pass the `cursor` from the previous call as `after` so no output '
      + 'is read twice; the first call uses `after: 0`. Returns the decoded text, the next cursor, whether the answer '
      + 'was truncated at the output cap, and the device prompt if one is at the tail. '
      + 'Use `stripEcho` to drop the command line the device echoed back. '
      + 'If `dormant` is true the device half-closed this console after sitting idle and will not print anything '
      + 'until someone presses Enter: call console_wake, or console_send with an empty `text`.',
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
        dormant: { type: 'boolean' },
      }, ['text', 'cursor', 'truncated', 'bytes', 'encoding', 'pagingActive']),
      render: (_args: unknown, value: unknown) => {
        const result = value as {
          text: string
          cursor: number
          truncated: boolean
          prompt?: string
          pagingActive: boolean
          dormant?: boolean
        }
        const notes: string[] = []
        if (result.truncated) notes.push('truncated at the output cap; read again from the returned cursor')
        if (result.prompt !== undefined) notes.push(`prompt ${result.prompt}`)
        if (result.pagingActive) notes.push('a pager prompt is waiting')
        if (result.dormant === true) {
          notes.push('the device half-closed this idle console; press Enter with console_wake to wake it')
        }
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
        dormant: read.dormant,
      }
    },
  })

  register({
    name: 'console_wait_for',
    description:
      'Wait until a device console produces what you are waiting for, then return. Use `for: "prompt"` (default) to '
      + 'wait until the CLI prompt comes back -- that is the reliable "the command finished" signal. Use '
      + '`for: "pattern"` with a regular expression to wait for a specific line. '
      + 'Use `for: "idle"` to wait for the output to STOP, which is a heuristic and NOT a completion signal. It means, '
      + `exactly: some output arrived, and then no further bytes arrived for a whole quiet window (\`idleMs\`, default ${String(deps.defaults().idleQuietMs)}ms). `
      + 'Two consequences: a console where NOTHING arrives never satisfies it and times out instead, and a device that '
      + 'pauses longer than the quiet window mid-answer makes it match EARLY. The default sits above the measured pause '
      + 'of the lab devices (~1000ms between output slabs); raise `idleMs` for a slower device. Prefer `for: "prompt"` '
      + 'whenever the device prints a prompt, and treat an idle match as "probably done", then confirm by reading. '
      + 'This is the right way to wait for a command to finish — do not poll console_read in a loop. A timeout is a '
      + 'normal result (matched: false, reason: "timeout"), not an error, so read the output that did arrive. When the '
      + 'wait fails because the device half-closed an idle console (`dormantBlocked`), the console cannot answer until '
      + 'you press Enter with console_wake — waiting again will change nothing.',
    parameters: parameterSchemaSpecToJsonSchema({
      consoleId: CONSOLE_ID,
      for: { type: 'string', enum: ['prompt', 'idle', 'pattern'], description: 'What to wait for (default prompt).' },
      pattern: { type: 'string', description: 'Regular expression, required when `for` is "pattern".' },
      timeoutMs: { type: 'number', description: 'Budget in milliseconds; defaults to the plugin read timeout.' },
      after: { type: 'number', description: 'Cursor the wait starts from (your last read cursor).' },
      idleMs: {
        type: 'number',
        description: 'How long output must be silent to satisfy `for: "idle"` (default '
          + `${String(deps.defaults().idleQuietMs)}ms). Raise it for a device that paces long answers slowly, or an `
          + 'idle wait will match between two slabs of the same answer.',
      },
    }),
    output: {
      schema: outputSchema({
        matched: { type: 'boolean' },
        reason: { type: 'string' },
        matchedText: { type: 'string' },
        cursor: { type: 'number' },
        elapsedMs: { type: 'number' },
        dormant: { type: 'boolean' },
        dormantBlocked: { type: 'boolean' },
      }, ['matched', 'reason', 'cursor', 'elapsedMs']),
      render: (_args: unknown, value: unknown) => {
        const result = value as {
          matched: boolean
          reason: string
          matchedText?: string
          elapsedMs: number
          dormant?: boolean
          dormantBlocked?: boolean
        }
        if (result.matched) {
          const what = result.matchedText === undefined
            // An idle match says the output went quiet, which is NOT proof the
            // command finished. Saying "done" here would invite a caller to read
            // a half-delivered answer; the wording keeps it a probability.
            ? 'the output went quiet (an idle match is a heuristic, not proof the command finished)'
            : `saw ${result.matchedText}`
          const dormantNote = result.dormant === true
            ? ' The device then half-closed this idle console; wake it with console_wake before the next command.'
            : ''
          const confirm = result.matchedText === undefined
            ? ' Read the output to confirm it is complete, or wait for the prompt instead when the device prints one.'
            : ''
          return text(`Waited ${String(result.elapsedMs)}ms and ${what}.${confirm}${dormantNote}`)
        }
        if (result.reason === 'closed') return text('The console closed while waiting.')
        if (result.dormantBlocked === true) {
          return text(
            `Waited ${String(result.elapsedMs)}ms and nothing matched: the device half-closed this idle console and `
            + 'will print nothing until someone presses Enter. Wake it with console_wake (or console_send with an '
            + 'empty text), then wait again.',
          )
        }
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
        dormant: waited.dormant,
        ...waited.dormantBlocked === true ? { dormantBlocked: true } : {},
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
