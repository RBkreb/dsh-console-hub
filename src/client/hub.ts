/**
 * The browser half's view-model layer: the tab descriptor it registers, the
 * typed calls the views make, and the one polling decision that must not live
 * inside render.
 *
 * The structural types here describe the slice of `ctx.betterSidebar` this
 * plugin consumes. They are declared locally rather than imported from
 * `dsh-better-sidebar` because the bundle may value-import only `react`; a
 * type-only import would be erased, but keeping the contract local also keeps
 * the client declaration graph free of any DSH package.
 *
 * @module dsh-console-hub/client/hub
 */
import { createElement } from 'react'
import type { ApiClient } from './api.ts'
import { ConsoleHubView } from './ConsoleHubView.tsx'
import { ConsoleSettingsPanel } from './SettingsPanel.tsx'

/** The tab type this plugin registers. */
export const CONSOLE_TAB_ID = 'dsh-console-hub:consoles'

/** The descriptor order, placed after the built-in terminal (40) and browser (50). */
export const CONSOLE_TAB_ORDER = 45

/** One registered tab instance as the shell hands it to a component. */
export interface ClientTabLike {
  id: string
  type: string
  title: string
  path?: string
  meta?: unknown
}

/** The session scope every surface is keyed by. */
export interface ClientScopeLike {
  sessionId: string
  cwd?: string
}

/**
 * The client context a tab's shell-level code receives.
 *
 * `get` is a plain service lookup rather than a generic: at the one call site
 * that uses it the name is a literal, so a generic signature buys no safety
 * while making every structural fake and mirror a variance error.
 */
export interface ClientContextLike {
  get(name: string): unknown
  effect?(effect: () => void | (() => void), label?: string): () => void
  inject?(services: readonly string[], callback: (ctx: ClientContextLike) => void | (() => void)): () => void
}

/** The props the shell hands a registered tab component. */
export interface ClientTabPropsLike {
  ctx: ClientContextLike
  scope: ClientScopeLike
  tab: ClientTabLike
  visible: boolean
  onReferenceFile?: (path: string, isDir: boolean) => void
  onOpenFile?: (path: string) => void
}

/** A declarative settings row (the subset this plugin declares). */
export interface ClientSettingRow {
  key: string
  title: string | (() => string)
  desc?: string | (() => string)
  type?: 'switch' | 'text' | 'number' | 'select'
  min?: number
  max?: number
  unit?: string
  options?: readonly { value: string | number | boolean, title: string | (() => string) }[]
}

/** Props a settings renderer receives. */
export interface ClientSettingsProps {
  pluginSettings: Record<string, unknown>
  updatePluginSetting(key: string, value: unknown): void
  close(): void
}

/** The tab descriptor this plugin registers. */
export interface ClientTabDescriptor {
  id: string
  title: string | (() => string)
  description?: string | (() => string)
  order: number
  single: boolean
  /** Present so a test can pin the tab as type-open rather than a file tab. */
  hidden?: boolean
  dedupeKey: (tab: ClientTabLike) => string
  settings: {
    pluginToggles: readonly ClientSettingRow[]
    render: (props: ClientSettingsProps) => unknown
  }
  component: (props: ClientTabPropsLike) => unknown
}

/** The `ctx.betterSidebar` slice this plugin uses. */
export interface BetterSidebarLike {
  readonly version: string
  readonly features: readonly string[]
  registerTab(descriptor: ClientTabDescriptor): () => void
  openTab(seed: { type: string, title?: string, id?: string }, scope?: ClientScopeLike): void
  updateTab(tabId: string, patch: { title?: string, path?: string, meta?: unknown }): void
  closeTab(tabId: string, scope?: ClientScopeLike): void
}

// ── Wire shapes ─────────────────────────────────────────────────────────────

/** One device view as the API returns it (never a credential value). */
export interface ViewRow {
  viewId: string
  view: {
    name: string
    host: string
    port: number
    kind: string
    encoding: string
    user: string
    promptPattern: string
    pagerPattern: string
    pagingMode: string
    tags: string[]
    notes: string
    secretConfigured: boolean
    secretSource?: string
    secretWritable?: boolean
  }
}

/** The engine defaults a configuration surface shows. */
export interface EngineDefaults {
  defaultEncoding: string
  defaultKind: string
  pagingMode: string
  approvalMode: string
  highRiskPatterns: string[]
  promptPattern: string
  pagerPattern: string
  connectTimeoutMs: number
  readTimeoutMs: number
  idleTimeoutMs: number
  maxConsoles: number
  outputLimitBytes: number
  scrollbackLimitBytes: number
  pagingMaxPages: number
  pagingQuietMs: number
  agentConsoleTools: boolean
}

/** One open console as the API returns it. */
export interface ConsoleRow {
  consoleId: string
  ownerSessionId: string
  label: string
  host: string
  port: number
  kind: string
  encoding: string
  secure: boolean
  state: string
  lastError: { code: string, message: string } | null
  idleMs: number
  createdAt: string
}

/** One `console.read` answer. */
export interface ReadResult {
  text: string
  cursor: number
  truncated: boolean
  bytes: number
  encoding: string
  prompt?: string
  pager?: string
  paging: { active: boolean, pagesConsumed: number, reason: string | null }
}

/** One `console.waitFor` answer. */
export interface WaitResult {
  matched: boolean
  reason: 'matched' | 'timeout' | 'closed'
  matchedText?: string
  cursor: number
  elapsedMs: number
}

/**
 * One `console.fence` answer: whether a command is high-risk, and the one-shot
 * token the panel replays to send it after the human confirms.
 */
export type FenceResult =
  | { risk: 'safe' }
  | { risk: 'high', confirmationToken: string, reason: string }

/** The typed calls the views make. */
export interface ConsoleHub {
  listViews(sessionId: string): Promise<{ views: ViewRow[], defaults: EngineDefaults }>
  upsertView(sessionId: string, input: {
    viewId?: string
    name: string
    host: string
    port: number
    kind: string
    encoding?: string
    user?: string
    promptPattern?: string
    pagerPattern?: string
    pagingMode?: string
    notes?: string
    password?: string
  }): Promise<{ viewId: string, view: ViewRow['view'] }>
  removeView(sessionId: string, viewId: string): Promise<{ removed: boolean, secretRemoved: boolean }>
  setSecret(sessionId: string, viewId: string, password: string, user?: string): Promise<{ configured: boolean }>
  clearSecret(sessionId: string, viewId: string): Promise<{ configured: boolean }>
  secretStatus(sessionId: string, viewId: string): Promise<{ configured: boolean, writable: boolean, source?: string }>
  listConsoles(sessionId: string): Promise<{ consoles: ConsoleRow[] }>
  connect(sessionId: string, input: {
    viewId?: string
    host?: string
    port?: number
    kind?: string
    encoding?: string
    name?: string
  }): Promise<{
    consoleId: string
    state: string
    label: string
    host: string
    port: number
    secure: boolean
    banner: string
    prompt: string | null
    lastError: { code: string, message: string } | null
  }>
  fence(sessionId: string, consoleId: string, text: string): Promise<FenceResult>
  send(sessionId: string, consoleId: string, text: string, options?: {
    submit?: boolean
    submitKey?: string
    confirmToken?: string
  }): Promise<{ consoleId: string, state: string, written: number }>
  read(sessionId: string, consoleId: string, after: number, options?: {
    encoding?: string
    stripEcho?: string
  }): Promise<ReadResult>
  waitFor(sessionId: string, consoleId: string, options: {
    for: 'prompt' | 'idle' | 'pattern'
    pattern?: string
    timeoutMs?: number
    after?: number
    idleMs?: number
  }): Promise<WaitResult>
  control(sessionId: string, consoleId: string, action: 'drain'): Promise<{ paging: { active: boolean } }>
  close(sessionId: string, consoleId: string, force?: boolean): Promise<{ closed: boolean }>
  closeAll(sessionId: string, force?: boolean): Promise<{ closed: number }>
  describe(sessionId: string, consoleId: string): Promise<{
    entry: ConsoleRow
    state: {
      bytesReceived: number
      bytesWritten: number
      prompt: string | null
      paging: { active: boolean, pagesConsumed: number, reason: string | null }
      audit: { at: string, actor: string, action: string, detail: string }[]
    }
    banner: string
  }>
  settings(sessionId: string): Promise<{ revision: number, defaults: EngineDefaults }>
}

/**
 * Build the typed call surface over the raw API client.
 * @param client - the envelope-decoding client.
 * @returns the hub.
 */
export function createConsoleHub(client: ApiClient): ConsoleHub {
  return {
    listViews: sessionId => client.call('config.list', { sessionId }),
    upsertView: (sessionId, input) => client.call('config.upsert', { sessionId, ...input }),
    removeView: (sessionId, viewId) => client.call('config.remove', { sessionId, viewId }),
    setSecret: (sessionId, viewId, password, user) =>
      client.call('secret.set', { sessionId, viewId, password, ...user === undefined ? {} : { user } }),
    clearSecret: (sessionId, viewId) => client.call('secret.clear', { sessionId, viewId }),
    secretStatus: (sessionId, viewId) => client.call('secret.status', { sessionId, viewId }),
    listConsoles: sessionId => client.call('console.list', { sessionId }),
    connect: (sessionId, input) => client.call('console.connect', { sessionId, ...input }),
    fence: (sessionId, consoleId, text) => client.call('console.fence', { sessionId, consoleId, text }),
    send: (sessionId, consoleId, text, options = {}) =>
      client.call('console.send', { sessionId, consoleId, text, ...options }),
    read: (sessionId, consoleId, after, options = {}) =>
      client.call('console.read', { sessionId, consoleId, after, ...options }),
    waitFor: (sessionId, consoleId, options) => client.call('console.waitFor', { sessionId, consoleId, ...options }),
    control: (sessionId, consoleId, action) => client.call('console.control', { sessionId, consoleId, action }),
    close: (sessionId, consoleId, force) =>
      client.call('console.close', { sessionId, consoleId, ...force === undefined ? {} : { force } }),
    closeAll: (sessionId, force) =>
      client.call('console.closeAll', { sessionId, ...force === undefined ? {} : { force } }),
    describe: (sessionId, consoleId) => client.call('console.describe', { sessionId, consoleId }),
    settings: sessionId => client.call('settings.get', { sessionId }),
  }
}

/**
 * Whether the console view should be polling for new output right now.
 *
 * The shell keeps a hidden tab mounted, so polling must be gated on `visible`
 * rather than on mount — otherwise every device console in every background tab
 * keeps hitting the host.
 *
 * @param state - the tab's visibility and the selected console.
 * @returns true when a poll should be scheduled.
 */
export { shouldPoll } from './poll.ts'

/** The settings rows the side-card panel shows. */
function settingsRows(): readonly ClientSettingRow[] {
  return [
    {
      key: 'openOnConnect',
      title: () => '连接后自动聚焦控制台',
      desc: () => '连接成功后自动切换到该控制台视图。',
      type: 'switch',
    },
    {
      key: 'wrapOutput',
      title: () => '输出自动换行',
      desc: () => '关闭后超长行横向滚动，便于对比列对齐的表格输出。',
      type: 'switch',
    },
    {
      key: 'pollIntervalMs',
      title: () => '刷新间隔',
      desc: () => '控制台读取新输出的间隔；越小越实时，越大越省资源。',
      type: 'number',
      min: 200,
      max: 5000,
      unit: 'ms',
    },
    {
      key: 'confirmHighRisk',
      title: () => '高危指令二次确认',
      desc: () => 'config / restart 一类指令在发送前必须再确认一次。',
      type: 'switch',
    },
  ]
}

/**
 * Build the tab descriptor.
 *
 * The descriptor returns React ELEMENTS rather than calling the components as
 * plain functions: invoking a component directly would run its hooks outside a
 * render pass, which React rejects. `createElement` keeps the boundary intact
 * while still letting the shell decide when to mount.
 *
 * @param hub - the typed API surface the view renders through.
 * @returns the descriptor to register.
 */
export function consoleTabDescriptor(hub: ConsoleHub): ClientTabDescriptor {
  return {
    id: CONSOLE_TAB_ID,
    title: () => '设备控制台',
    description: () => '网络设备 console 映射：连接、收发命令、自动翻页。',
    order: CONSOLE_TAB_ORDER,
    // One console registry per session: opening the tab twice focuses it rather
    // than starting a second poll loop.
    single: true,
    dedupeKey: () => CONSOLE_TAB_ID,
    settings: {
      pluginToggles: settingsRows(),
      render: props => createElement(ConsoleSettingsPanel, props),
    },
    component: props => createElement(ConsoleHubView, { ...props, hub }),
  }
}
