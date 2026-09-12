/**
 * Structural service faces the two plugin halves consume.
 *
 * DSH's real service types live in `@deepseek-ai/*` packages that the browser
 * bundle must not import at runtime (the client bundle purity gate forbids
 * cross-plugin value imports, and a value-typed import would drag Node types
 * into the client declaration graph). Both halves therefore restate the small
 * slice of each service they actually touch, as type-only structural mirrors —
 * the same approach dsh-better-sidebar uses. Nothing here executes.
 *
 * @module dsh-console-hub/context-types
 */

// The augmentation at the bottom targets this module; the type-only import
// makes the specifier resolvable from this file (it is erased at build time).
import type {} from '@deepseek-ai/cordis'


/** A cordis-like context: only the members this plugin calls. */
export interface Context {
  /** Resolve an optional service by name. */
  get<T = unknown>(name: string): T | undefined
  /**
   * Run `callback` for the lifetime of the listed services, re-running it when
   * they disappear and reappear. Returns a disposer.
   */
  inject(services: readonly string[], callback: (ctx: Context) => void | (() => void)): () => void
  /**
   * Bind one effect to the calling fiber; the returned disposer is invoked on
   * fiber disposal (HMR / disable / teardown). Returns the same disposer value
   * the callback produced, coerced to a plain disposer.
   */
  effect(effect: () => void | (() => void), label?: string): () => void
  /**
   * Resolved services, declared structurally.
   *
   * Cordis hands an `inject`ed service to the callback as a property of the
   * context it passes in, so the injected names must exist here as optional
   * members. They are optional because a context without that seam is exactly
   * the case the host half must survive.
   */
  settings?: ConsoleSettingsService
  webServer?: ConsoleWebServer
  tools?: ConsoleToolRegistry
  systemPrompt?: ConsolePromptRegistry
  /** Plugin logger. */
  logger?: {
    info(message: string, ...args: unknown[]): void
    warn(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
  }
}

// ── Host: HTTP carrier ──────────────────────────────────────────────────────

/** The subset of `node:http`'s IncomingMessage the routes read. */
export interface ConsoleHttpRequest {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

/** The subset of `node:http`'s ServerResponse the routes write. */
export interface ConsoleHttpResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** One named route registration. */
export interface ConsoleWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: ConsoleHttpRequest, res: ConsoleHttpResponse) => void | Promise<void>
}

/** The web-server service face this plugin uses. */
export interface ConsoleWebServer {
  register(route: ConsoleWebRoute): () => void
}

/** The web runtime service face (bind-derived trust list). */
export interface ConsoleWebRuntime {
  trustedHosts: readonly string[]
}

// ── Host: tools ─────────────────────────────────────────────────────────────

/** Execution identity handed to a tool body. */
export interface ConsoleToolRunContext {
  /** The calling agent, when the call has one. */
  agent?: { session: { id: string } }
  /** Opaque call id (approval prompts attach to it). */
  callId: string
  /** Required caller-owned cancellation. */
  signal: AbortSignal
}

/** The tool registry face this plugin uses. */
export interface ConsoleToolRegistry {
  register(tool: unknown): () => void
}

// ── Host: settings ──────────────────────────────────────────────────────────

/** Owner-facing handle for one settings namespace. */
export interface ConsoleSettingsScope<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}

/** One registered namespace as a configuration surface reads it. */
export interface ConsoleSettingsDescriptor {
  ns: string
  value: unknown
  revision: number
  user?: unknown
}

/**
 * The settings seam face this plugin uses.
 *
 * `update` and `replace` are NOT interchangeable, and the difference decides
 * whether a deletion works:
 *
 * - `update` MERGES recursively. Plain objects merge key by key, so no merge can
 *   remove a key -- the ones it would have to remove are exactly the ones it
 *   does not carry. A view map missing a deleted entry comes back still holding
 *   it, the write reports success, and the device stays on disk.
 * - `replace` installs the section WHOLESALE, so an absent key is genuinely
 *   absent. This is the only path that can express a removal.
 */
export interface ConsoleSettingsService {
  register<T>(ns: string, schema: unknown, options?: { base?: Partial<T> }): ConsoleSettingsScope<T>
  describe(options?: { redactSecrets?: boolean }): ConsoleSettingsDescriptor[]
  /** Merge `patch` into the namespace's stored section. Cannot remove a key. */
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  /** Install `section` as the namespace's whole stored section. Can remove keys. */
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
}

// ── Host: credentials ───────────────────────────────────────────────────────

/** A stored record's payload is owned by this plugin. */
export interface ConsoleCredentialRecord {
  kind: 'api-key' | 'grant'
  key?: string
  env?: Readonly<Record<string, string>>
  payload?: unknown
}

/** Presence and writability facts for one reference (never its value). */
export interface ConsoleCredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

/** Presence and writability facts for one record (never its value). */
export interface ConsoleRecordInfo {
  configured: boolean
  kind?: 'api-key' | 'grant'
  writable: boolean
}

/** The credential seam face this plugin uses. */
export interface ConsoleCredentialProvider {
  resolve(ref: unknown): Promise<{ value: string, source: string } | undefined>
  describe(ref: unknown): Promise<ConsoleCredentialInfo>
  set(ref: unknown, value: string): Promise<void>
  unset(ref: unknown): Promise<void>
  readRecord(key: unknown): Promise<ConsoleCredentialRecord | undefined>
  describeRecord(key: unknown): Promise<ConsoleRecordInfo>
  modifyRecord(
    key: unknown,
    mutate: (current: ConsoleCredentialRecord | undefined) => Promise<ConsoleCredentialRecord | undefined>,
  ): Promise<ConsoleCredentialRecord | undefined>
  deleteRecord(key: unknown): Promise<void>
}

// ── Host: approval ──────────────────────────────────────────────────────────

/** The closed approval vocabulary; callers fail closed on `unavailable`. */
export type ConsoleApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The approval seam face this plugin uses. */
export interface ConsoleApprovalService {
  request(req: {
    agent: unknown
    toolName: string
    callId: string
    reason: string
    signal?: AbortSignal
  }): Promise<ConsoleApprovalOutcome>
}

// ── Host: system prompt ─────────────────────────────────────────────────────

/**
 * The system-prompt registry slice this plugin uses.
 *
 * Only `section` is mirrored: the plugin contributes one ordered text section
 * and reads nothing back, so the rest of the registry is not part of its
 * contract with the harness.
 */
export interface ConsolePromptRegistry {
  /**
   * Register an ordered prompt section in the calling scope.
   * @param section - name, order, and text (or a provider evaluated per assembly).
   * @returns the disposer removing it.
   */
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
  }): () => void
}

// ── Client: better-sidebar ──────────────────────────────────────────────────

/** The client context handed to a registered tab component. */
export interface SidebarClientContext {
  get<T = unknown>(name: string): T | undefined
}

/** Session scope every better-sidebar surface is keyed by. */
export interface SidebarSessionScope {
  sessionId: string
  cwd?: string
}

/** One open tab instance as its component sees it. */
export interface SidebarTab {
  id: string
  type: string
  title: string
  path?: string
  meta?: unknown
  diff?: unknown
}

/** Declarative settings row (the subset this plugin declares). */
export interface SidebarSettingRow {
  key: string
  title: string | (() => string)
  desc?: string | (() => string)
  type?: 'switch' | 'text' | 'number' | 'select'
  min?: number
  max?: number
  placeholder?: string
  unit?: string
  options?: readonly { value: string | number | boolean, title: string | (() => string) }[]
}

/** Declarative settings declaration attached to a tab descriptor. */
export interface SidebarSettingsDeclaration {
  pluginToggles?: readonly SidebarSettingRow[]
  render?: (props: SidebarSettingsRenderProps) => unknown
}

/** Props `settings.render` receives. */
export interface SidebarSettingsRenderProps {
  store: unknown
  service: unknown
  prefs: unknown
  pluginSettings: Record<string, unknown>
  updatePluginSetting(key: string, value: unknown): void
  close(): void
}

/** Props a registered tab component receives. */
export interface SidebarTabComponentProps {
  ctx: SidebarClientContext
  scope: SidebarSessionScope
  tab: SidebarTab
  visible: boolean
  onReferenceFile?: (path: string, isDir: boolean) => void
  onOpenFile?: (path: string) => void
}

/** The tab descriptor this plugin registers. */
export interface SidebarTabDescriptor {
  id: string
  title: string | (() => string)
  description?: string | (() => string)
  icon?: unknown
  order?: number
  hidden?: boolean
  single?: boolean
  dedupeKey?: (tab: SidebarTab) => string | undefined
  settings?: SidebarSettingsDeclaration
  onOpen?: (tab: SidebarTab, scope: SidebarSessionScope) => void
  onClose?: (tab: SidebarTab, scope: SidebarSessionScope) => void
  component: (props: SidebarTabComponentProps) => unknown
}

/** The `ctx.betterSidebar` service face this plugin uses. */
export interface BetterSidebarService {
  readonly version: string
  readonly features: readonly string[]
  registerTab(descriptor: SidebarTabDescriptor): () => void
  openTab(seed: { type: string, title?: string, id?: string, meta?: unknown }, scope?: SidebarSessionScope): void
  updateTab(tabId: string, patch: { title?: string, path?: string, meta?: unknown }): void
  closeTab(tabId: string, scope?: SidebarSessionScope): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host: the browser HTTP carrier the plugin's routes mount on. */
    webServer: ConsoleWebServer
    /** Host: bind-derived trust list for the route fence. */
    webRuntime: ConsoleWebRuntime
    /** Host: the model-facing tool registry. */
    tools: ConsoleToolRegistry
    /** Client: the sidebar registry this plugin registers a tab into. */
    betterSidebar: BetterSidebarService
  }
}
