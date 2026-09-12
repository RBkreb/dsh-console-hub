/**
 * The console-session half of the API: `console.*`.
 *
 * These methods operate on live sockets, so they are kept apart from the
 * inventory methods in `routes.ts` — this module translates HTTP payloads into
 * `PortManager` calls and turns the manager's domain errors into wire codes.
 *
 * Two translation rules matter:
 *
 * 1. A **failed connect is a result**, not an HTTP error. The entry exists with
 *    `state: 'error'` and a coded `lastError`, because the panel has to render
 *    it and offer a retry.
 * 2. A **wait timeout is a result** too (`matched: false, reason: 'timeout'`),
 *    so a model loop can distinguish "the device said nothing" from "the call
 *    failed".
 *
 * @module dsh-console-hub/console-routes
 */
import { compilePattern, isConsoleEncoding, type ConsoleKind, type PagingMode } from './config-shared.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { HubError, optionalBoolean, optionalNumber, optionalString, readJsonBody, requireString, writeError, writeOk, writeJson } from './wire.ts'
import type { ConsoleView } from './config-shared.ts'
import type { ConsoleHttpRequest, ConsoleHttpResponse, ConsoleWebRoute } from './context-types.ts'
import type { PortManager } from './port-manager.ts'

/** The engine defaults a connect falls back to. */
export interface ConsoleConnectDefaults {
  connectTimeoutMs: number
  encoding: string
  kind: ConsoleKind
  pagingMode: PagingMode
}

/** Everything the console methods need from the host. */
export interface ConsoleSessionApi {
  manager: PortManager
  /** Cap on one request body. */
  requestBodyLimitBytes: number
  /** Non-loopback authorities this deployment serves. */
  trustedHosts: readonly string[]
  /** Whether a session id names a live session. */
  sessionExists(sessionId: string): Promise<boolean>
  /**
   * Resolve one stored view for its owner.
   * @param sessionId - the owning session.
   * @param viewId - the stored view key.
   * @returns the view, or `undefined` when it does not exist.
   */
  viewOf(sessionId: string, viewId: string): Promise<(ConsoleView & { viewId: string }) | undefined>
  /** The plugin's default encoding. */
  defaultEncoding(): string
  /** The plugin's engine defaults. */
  defaults(): ConsoleConnectDefaults
  /**
   * Fence one panel-issued command.
   *
   * The panel's user is already the human in the loop, so the interface path
   * does NOT go through `ctx.approval` (that seam requires an open agent turn,
   * which a sidebar click has none of). What it does require is the returned
   * one-shot token: the panel must present the refusal, get a second explicit
   * confirmation, and replay the call with the token.
   */
  fenceForUser?(request: { sessionId: string, consoleId: string, label: string, text: string }):
    | { risk: 'safe' }
    | { risk: 'high', confirmationToken: string, reason: string }
    /**
     * Refused outright, by a `deny` rule.
     *
     * A separate arm rather than a flavour of `high`, because the two demand
     * opposite handling: `high` mints a token and INVITES a confirmation, while
     * this must never mint one. Folding it into `high` would make a `deny` rule
     * satisfiable by clicking through the very prompt it exists to avoid.
     */
    | { risk: 'denied', reason: string }
  /** Validate a confirmation token minted by {@link fenceForUser}. */
  consumeConfirmation?(sessionId: string, consoleId: string, token: string): boolean
  /**
   * Discard one console's local scrollback, leaving the connection open.
   *
   * Optional so the route still serves a deployment that composes a manager
   * without it; absent means the method reports `not-supported` rather than
   * pretending the clear happened.
   */
  clear?(sessionId: string, consoleId: string): { cursor: number, droppedBytes: number }
}

/** One dispatchable console method. */
type Handler = (payload: unknown) => Promise<unknown>

/** Read the session id every method requires and prove the session exists. */
async function requireSession(api: ConsoleSessionApi, payload: unknown): Promise<string> {
  const sessionId = requireString(payload, 'sessionId')
  if (!(await api.sessionExists(sessionId))) {
    throw new HubError('not-found', `no session "${sessionId}"`, 404)
  }
  return sessionId
}

/** Read the console id every session method requires. */
function requireConsoleId(payload: unknown): string {
  return requireString(payload, 'consoleId')
}

/** Validate an optional encoding override. */
function checkedEncoding(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (!isConsoleEncoding(value)) {
    throw new HubError('bad-encoding', `unsupported encoding "${value}"`)
  }
  return value
}

/** Map a manager/domain failure onto the wire. */
function asHubError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) throw new HubError('not-found', message, 404)
  if (/limit|maxConsoles/i.test(message)) throw new HubError('max-consoles', message)
  if (/unsupported encoding/i.test(message)) throw new HubError('bad-encoding', message)
  if (/is (closed|closing|error|connecting)/i.test(message)) throw new HubError('session-gone', message, 409)
  throw new HubError('internal', message, 500)
}

/** The `console.*` methods. */
function consoleHandlers(api: ConsoleSessionApi): Record<string, Handler> {
  const handlers: Record<string, Handler> = {
    async 'console.list'(payload) {
      const sessionId = await requireSession(api, payload)
      return { consoles: api.manager.list(sessionId) }
    },

    async 'console.connect'(payload) {
      const sessionId = await requireSession(api, payload)
      const defaults = api.defaults()
      const viewId = optionalString(payload, 'viewId')
      const host = optionalString(payload, 'host')
      const port = optionalNumber(payload, 'port')
      const password = optionalString(payload, 'password')
      const requestedEncoding = checkedEncoding(optionalString(payload, 'encoding'))
      const requestedKind = optionalString(payload, 'kind')
      const requestedPaging = optionalString(payload, 'pagingMode')

      let target: {
        label: string
        host: string
        port: number
        kind: ConsoleKind
        encoding: string
        user?: string
        promptPattern?: RegExp
        pagerPattern?: RegExp
        pagingMode?: PagingMode
      }

      if (viewId !== undefined) {
        const view = await api.viewOf(sessionId, viewId)
        if (view === undefined) throw new HubError('not-found', `no view "${viewId}"`, 404)
        target = {
          label: view.name,
          host: view.host,
          port: view.port,
          kind: requestedKind === undefined || requestedKind === '' ? view.kind : asKind(requestedKind),
          encoding: requestedEncoding ?? (view.encoding === '' ? api.defaultEncoding() : view.encoding),
          ...view.user === '' ? {} : { user: view.user },
          ...view.promptPattern === '' ? {} : { promptPattern: compileOrReject(view.promptPattern, 'promptPattern') },
          ...view.pagerPattern === '' ? {} : { pagerPattern: compileOrReject(view.pagerPattern, 'pagerPattern') },
          ...view.pagingMode === '' ? {} : { pagingMode: view.pagingMode as PagingMode },
        }
      } else if (host !== undefined && port !== undefined) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new HubError('bad-request', `"port" must be an integer in 1..65535 (got ${String(port)})`)
        }
        target = {
          label: optionalString(payload, 'name') ?? `${host}:${String(port)}`,
          host,
          port,
          kind: requestedKind === undefined || requestedKind === '' ? defaults.kind : asKind(requestedKind),
          encoding: requestedEncoding ?? api.defaultEncoding(),
        }
      } else {
        throw new HubError('bad-request', 'supply either "viewId" or both "host" and "port"')
      }

      const pagingMode = requestedPaging === undefined || requestedPaging === ''
        ? target.pagingMode ?? defaults.pagingMode
        : asPagingMode(requestedPaging)

      let entry
      try {
        entry = await api.manager.connect({
          ownerSessionId: sessionId,
          ...target,
          pagingMode,
          ...password === undefined || password === '' ? {} : { password },
        })
      } catch (error) {
        asHubError(error)
      }
      const detail = api.manager.describe(sessionId, entry.consoleId)
      return {
        ...entry,
        // The banner only exists on the manager's record; a panel that attached
        // after the connect finished still needs to see what the device said.
        banner: api.manager.bannerOf(sessionId, entry.consoleId),
        prompt: detail?.state.prompt ?? null,
        paging: detail?.state.paging ?? { active: false, pagesConsumed: 0, reason: null },
      }
    },

    async 'console.clear'(payload) {
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      // Distinguish "this build cannot clear" from "that console is gone":
      // an absent capability is a deployment fact, and reporting it as
      // not-found would send the caller hunting for a console that is present.
      if (api.clear === undefined) {
        throw new HubError('not-supported', 'this deployment cannot clear a console scrollback', 501)
      }
      let result: { cursor: number, droppedBytes: number }
      try {
        result = api.clear(sessionId, consoleId)
      } catch (error) {
        asHubError(error)
      }
      return { consoleId, cursor: result.cursor, droppedBytes: result.droppedBytes }
    },

    async 'console.describe'(payload) {
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      const detail = api.manager.describe(sessionId, consoleId)
      if (detail === undefined) throw new HubError('not-found', `console "${consoleId}" not found for this session`, 404)
      return { ...detail, banner: api.manager.bannerOf(sessionId, consoleId) }
    },

    async 'console.send'(payload) {
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      // An EMPTY line is a valid send: it presses Enter, which is what wakes a
      // console the device half-closed, what a `--More--` prompt accepts by
      // hand, and what re-prompts a device that swallowed a keystroke. Refusing
      // it here made the one action a stuck console needs the one action the API
      // would not carry. Whitespace is likewise passed through untouched: a
      // single space is the pager's next-page key, so trimming it would send
      // something other than what was asked for.
      const text = optionalString(payload, 'text') ?? ''
      const encoding = checkedEncoding(optionalString(payload, 'encoding'))
      const submit = optionalBoolean(payload, 'submit')
      const submitKey = optionalString(payload, 'submitKey')
      const actor = optionalString(payload, 'actor')
      if (actor !== undefined && !['user', 'model', 'system'].includes(actor)) {
        throw new HubError('bad-request', `"actor" must be user, model, or system (got "${actor}")`)
      }
      // The panel's path fences a high-risk command behind a one-shot
      // confirmation token: the first call refuses and mints the token, the
      // confirmed replay consumes it. A safe command goes straight through, and
      // a `deny` rule is refused BEFORE any token exists.
      const confirmation = optionalString(payload, 'confirmToken')
      if (api.fenceForUser !== undefined || api.consumeConfirmation !== undefined) {
        const fenced = api.fenceForUser?.({
          sessionId,
          consoleId,
          label: api.manager.get(sessionId, consoleId)?.label ?? consoleId,
          text,
        })
        // Checked first and unconditionally: a token must not exist for a denied
        // command, so the confirmed replay can never satisfy one. Consuming a
        // token here would let a `deny` be undone by presenting it.
        if (fenced?.risk === 'denied') {
          throw new HubError('forbidden', fenced.reason, 403)
        }
        if (fenced?.risk === 'high') {
          const valid = confirmation !== undefined
            && api.consumeConfirmation?.(sessionId, consoleId, confirmation) === true
          if (!valid) {
            throw new HubError('forbidden', `high-risk command needs confirmation: ${fenced.reason}`, 403)
          }
        }
      }
      try {
        const entry = await api.manager.send(sessionId, consoleId, text, {
          ...encoding === undefined ? {} : { encoding },
          ...submit === undefined ? {} : { submit },
          ...submitKey === undefined ? {} : { submitKey },
          ...actor === undefined ? {} : { actor: actor as 'user' | 'model' | 'system' },
        })
        const detail = api.manager.describe(sessionId, consoleId)
        return {
          consoleId,
          state: entry.state,
          aborted: false,
          written: detail?.state.bytesWritten ?? 0,
          ...detail?.state.paging === undefined ? {} : { paging: detail.state.paging },
        }
      } catch (error) {
        asHubError(error)
      }
    },

    async 'console.fence'(payload) {
      // Pre-flight, never a write: the panel must be able to learn that a command
      // is high-risk AND receive the token it will replay, before anything
      // reaches the device. `console.send` alone cannot do that — its refusal is
      // a 403 envelope, which carries a message but no token.
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      const text = optionalString(payload, 'text') ?? ''
      // An empty line is fenced like any other: `classifyCommand('')` has no
      // segment to match, so it comes back `safe`, which is correct -- pressing
      // Enter runs no command. Refusing it here would have made the wake
      // keystroke unsendable through the panel's own path while the tool path
      // allowed it.
      const entry = api.manager.get(sessionId, consoleId)
      if (entry === undefined) {
        throw new HubError('not-found', `console "${consoleId}" not found for this session`, 404)
      }
      if (api.fenceForUser === undefined) {
        // No fence composed: nothing can be high-risk, so the panel may send.
        return { risk: 'safe' as const }
      }
      return api.fenceForUser({ sessionId, consoleId, label: entry.label, text })
    },


    async 'console.read'(payload) {
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      const encoding = checkedEncoding(optionalString(payload, 'encoding'))
      const after = optionalNumber(payload, 'after')
      const maxBytes = optionalNumber(payload, 'maxBytes')
      const stripEcho = optionalString(payload, 'stripEcho')
      try {
        return api.manager.read(sessionId, consoleId, {
          ...after === undefined ? {} : { after },
          ...encoding === undefined ? {} : { encoding },
          ...maxBytes === undefined ? {} : { maxBytes },
          ...stripEcho === undefined ? {} : { stripEcho },
        })
      } catch (error) {
        asHubError(error)
      }
    },

    async 'console.waitFor'(payload) {
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      const condition = optionalString(payload, 'for') ?? 'prompt'
      if (!['prompt', 'idle', 'pattern'].includes(condition)) {
        throw new HubError('bad-request', `"for" must be prompt, idle, or pattern (got "${condition}")`)
      }
      const pattern = optionalString(payload, 'pattern')
      if (condition === 'pattern') {
        if (pattern === undefined || pattern === '') throw new HubError('bad-request', '"pattern" is required when "for" is pattern')
        // Compile once here so an uncompilable pattern is a request error rather
        // than a wait that can never match.
        compileOrReject(pattern, 'pattern')
      }
      const timeoutMs = optionalNumber(payload, 'timeoutMs')
      const after = optionalNumber(payload, 'after')
      const idleMs = optionalNumber(payload, 'idleMs')
      try {
        return await api.manager.waitFor(sessionId, consoleId, {
          for: condition as 'prompt' | 'idle' | 'pattern',
          ...pattern === undefined ? {} : { pattern },
          ...timeoutMs === undefined ? {} : { timeoutMs },
          ...after === undefined ? {} : { after },
          ...idleMs === undefined ? {} : { idleMs },
        })
      } catch (error) {
        // The session's own waitFor rejects only for a malformed pattern.
        if (error instanceof HubError) throw error
        throw new HubError('bad-request', error instanceof Error ? error.message : String(error))
      }
    },

    async 'console.wake'(payload) {
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      try {
        const answered = await api.manager.wake(sessionId, consoleId)
        const detail = api.manager.describe(sessionId, consoleId)
        return {
          consoleId,
          answered,
          // The device may still be dormant if it did not answer: reporting
          // `answered: true` without the state would invite a caller to assume a
          // recovery that did not happen.
          dormant: detail?.entry.dormant ?? false,
          dormantText: detail?.entry.dormantText ?? null,
          ...detail?.state.dormancy === undefined ? {} : { dormancy: detail.state.dormancy },
        }
      } catch (error) {
        asHubError(error)
      }
    },

    async 'console.control'(payload) {
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      const action = requireString(payload, 'action')
      // `wake` is a control action rather than only its own method because the
      // panel's pager button and its wake button are the same gesture to a user:
      // "unstall this console". `drain` resumes automatic paging; `wake` presses
      // Enter. Both leave the connection untouched.
      if (action === 'wake') {
        const answered = await api.manager.wake(sessionId, consoleId)
        const after = api.manager.describe(sessionId, consoleId)
        return {
          consoleId,
          state: after?.entry.state ?? 'closed',
          answered,
          dormant: after?.entry.dormant ?? false,
          paging: after?.state.paging,
        }
      }
      if (action !== 'drain') {
        throw new HubError('bad-request', `unknown control action "${action}"`)
      }
      const detail = api.manager.describe(sessionId, consoleId)
      if (detail === undefined) throw new HubError('not-found', `console "${consoleId}" not found for this session`, 404)
      // Discharging a pending pager is what "drain" means: the panel's next-page
      // button and the model both need it.
      api.manager.resumePaging(sessionId, consoleId)
      const after = api.manager.describe(sessionId, consoleId)
      return { consoleId, state: after?.entry.state ?? detail.entry.state, paging: after?.state.paging ?? detail.state.paging }
    },

    async 'console.close'(payload) {
      const sessionId = await requireSession(api, payload)
      const consoleId = requireConsoleId(payload)
      const force = optionalBoolean(payload, 'force')
      try {
        await api.manager.close(sessionId, consoleId, force === undefined ? {} : { force })
      } catch (error) {
        asHubError(error)
      }
      return { closed: true, consoleId }
    },

    async 'console.closeAll'(payload) {
      const sessionId = await requireSession(api, payload)
      const force = optionalBoolean(payload, 'force')
      const owned = api.manager.list(sessionId)
      for (const entry of owned) {
        await api.manager.close(sessionId, entry.consoleId, force === undefined ? { force: true } : { force })
      }
      return { closed: owned.length }
    },
  }
  return handlers
}

/** Narrow a raw string to a console transport or reject it. */
function asKind(value: string): ConsoleKind {
  if (value !== 'telnet' && value !== 'raw') {
    throw new HubError('bad-request', `"kind" must be telnet or raw (got "${value}")`)
  }
  return value
}

/** Narrow a raw string to a paging mode or reject it. */
function asPagingMode(value: string): PagingMode {
  if (!['auto-more', 'auto-quit', 'auto-interrupt', 'manual'].includes(value)) {
    throw new HubError('bad-request', `"pagingMode" must be auto-more, auto-quit, auto-interrupt, or manual (got "${value}")`)
  }
  return value as PagingMode
}

/** Compile a pattern source or reject it as a bad request. */
function compileOrReject(source: string, field: string): RegExp {
  try {
    return compilePattern(source)
  } catch {
    throw new HubError('bad-request', `"${field}" is not a valid regular expression: ${source}`)
  }
}

/**
 * Dispatch one console method.
 * @param api - the console API dependencies.
 * @param method - the path segment after the API prefix.
 * @param payload - the parsed request body.
 * @returns the method's wire value.
 * @throws {HubError} `not-found` when no console method claims the name.
 */
export async function dispatchConsole(
  api: ConsoleSessionApi,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const handler = consoleHandlers(api)[method]
  if (handler === undefined) {
    throw new HubError('not-found', `unknown console-hub API method "${method}"`, 404)
  }
  return handler(payload)
}

/**
 * Build the console half of the API route. It shares the base API's prefix and
 * envelope; the host composes both tables into one handler.
 * @param api - the console API dependencies.
 * @returns the web-server route registration.
 */
export function buildConsoleRoutes(api: ConsoleSessionApi): ConsoleWebRoute {
  return {
    kind: 'prefix',
    path: '/dsh-console-hub/api',
    handler: async (req: ConsoleHttpRequest, res: ConsoleHttpResponse) => {
      if (!isTrustedApiRequest(req, api.trustedHosts)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const prefix = '/dsh-console-hub/api/'
      if (!pathname.startsWith(prefix)) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown console-hub API method' } })
        return
      }
      const method = pathname.slice(prefix.length)
      if (method === '' || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown console-hub API method' } })
        return
      }
      try {
        const payload = await readJsonBody(req, api.requestBodyLimitBytes)
        writeOk(res, await dispatchConsole(api, method, payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }
}
