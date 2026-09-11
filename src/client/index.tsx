/**
 * dsh-console-hub — browser half.
 *
 * Registers one sidebar tab through `ctx.betterSidebar` and renders the device
 * console surface (view list, config editor, and the console itself).
 *
 * Two constraints shape this file:
 *
 * 1. **No DSH client package at runtime.** The bundle resolves only through the
 *    shell's frozen module table (`react`, `react/jsx-runtime`); the
 *    `betterSidebar` service shape is mirrored as a local type instead of
 *    imported (see `context-types.ts`).
 * 2. **The tab is registered only while the service exists.** A client plugin
 *    may mount before `dsh-better-sidebar`, so registration is deferred through
 *    `ctx.inject` rather than read off `ctx.betterSidebar` directly. The entry
 *    must not throw when the service is absent — that would take the whole
 *    client plugin down with it.
 *
 * @module dsh-console-hub/client
 */
import { createApiClient } from './api.ts'
import { CONSOLE_TAB_ID, consoleTabDescriptor, createConsoleHub, type BetterSidebarLike } from './hub.ts'
import { prefsFromSettings, uiPrefs } from './prefs.ts'

/** Services required before mounting: the sidebar registry this tab joins. */
export const inject = ['betterSidebar']

/** The one console registry this plugin contributes. */
export { CONSOLE_TAB_ID }

/** The API client, built once per page (it holds no state beyond the prefix). */
const api = createApiClient()

/** The typed call surface the views render through. */
const hub = createConsoleHub(api)

/**
 * Register the console tab for as long as `betterSidebar` is composed.
 *
 * @param ctx - the client context.
 * @returns a disposer that unregisters the tab, or `undefined` when the service
 *   is not available yet (in which case `ctx.inject` retries when it appears).
 */
function mount(ctx: { get<T = unknown>(name: string): T | undefined }): (() => void) | undefined {
  const sidebar = ctx.get<BetterSidebarLike>('betterSidebar')
  if (sidebar === undefined || typeof sidebar.registerTab !== 'function') return undefined
  return sidebar.registerTab(consoleTabDescriptor(hub))
}

/** Client plugin body. */
export function apply(ctx: unknown): void {
  const context = ctx as {
    get<T = unknown>(name: string): T | undefined
    inject(services: readonly string[], callback: (ctx: never) => void | (() => void)): () => void
    effect?(effect: () => void | (() => void), label?: string): () => void
    betterSidebar?: BetterSidebarLike
  }
  // Prefer `inject`: it re-runs the callback when the service is replaced (HMR,
  // profile switch), and its disposer unregisters the tab with the fiber.
  if (typeof context.inject === 'function') {
    context.inject(['betterSidebar'], inner => mount(inner as never))
    return
  }
  mount(context)
}

/**
 * Seed the shared UI prefs from the shell's persisted plugin settings.
 *
 * Exported so the settings panel (which receives the bag as a prop) and this
 * entry agree on how a stored value becomes a preference.
 *
 * @param settings - the shell's opaque per-plugin settings bag.
 */
export function applyStoredPrefs(settings: Record<string, unknown>): void {
  uiPrefs.set(prefsFromSettings(settings))
}
