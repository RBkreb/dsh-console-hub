/**
 * The console view's UI preferences.
 *
 * These are presentation choices (wrap, poll cadence, confirm-everything), not
 * engine policy: the engine's defaults live in the host settings document and
 * are enforced there. Keeping them in one subscribable store lets the settings
 * panel be the only writer while the tab reads the live value, without either
 * half reaching into the sidebar's private prefs plumbing.
 *
 * The keys are the settings rows' keys verbatim, so nothing has to translate
 * between the declared rows and the values the view reads.
 *
 * @module dsh-console-hub/client/prefs
 */

/** The UI-level preferences of the console tab. */
export interface ConsoleUiPrefs {
  /** Select a console as soon as it connects. */
  openOnConnect: boolean
  /** Wrap long output lines instead of scrolling horizontally. */
  wrapOutput: boolean
  /** How often the view reads new output, in milliseconds. */
  pollIntervalMs: number
  /** Ask for a second confirmation before any command is written. */
  confirmHighRisk: boolean
  /** Width of the connected-console list column, in pixels. */
  listWidthPx: number
}

/** The prefs used until the settings panel states otherwise. */
export const DEFAULT_UI_PREFS: ConsoleUiPrefs = {
  openOnConnect: true,
  wrapOutput: true,
  pollIntervalMs: 500,
  confirmHighRisk: true,
  listWidthPx: 260,
}

/** Bounds the settings row and the view agree on. */
export const MIN_POLL_INTERVAL_MS = 200
export const MAX_POLL_INTERVAL_MS = 5000

/**
 * Bounds on the console-list column, in pixels.
 *
 * The minimum keeps a device label and its buttons legible; the maximum leaves
 * the console itself usable in a narrow panel. Both are enforced by the splitter
 * and by {@link normalizeListWidth}, so a stored value from an older build can
 * never produce an unusable layout.
 */
export const MIN_LIST_WIDTH_PX = 160
export const MAX_LIST_WIDTH_PX = 640

/**
 * Clamp a list width into the supported range.
 * @param value - the requested width in pixels.
 * @returns the clamped integer width.
 */
export function normalizeListWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_PREFS.listWidthPx
  return Math.min(MAX_LIST_WIDTH_PX, Math.max(MIN_LIST_WIDTH_PX, Math.round(value)))
}

/** A read/write handle on the live prefs. */
export interface PrefsStore {
  get(): ConsoleUiPrefs
  set(patch: Partial<ConsoleUiPrefs>): void
  subscribe(listener: (prefs: ConsoleUiPrefs) => void): () => void
}

/**
 * Clamp a poll interval into the range the view can honour.
 * @param value - the requested interval in milliseconds.
 * @returns the clamped integer interval.
 */
export function normalizePollInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_PREFS.pollIntervalMs
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.round(value)))
}

/** Coerce one incoming value onto a preference, falling back to the current one. */
function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Build a prefs store.
 * @param initial - starting values (each field falls back to its default).
 * @returns the store.
 */
export function createPrefsStore(initial: Partial<ConsoleUiPrefs> = {}): PrefsStore {
  let current: ConsoleUiPrefs = {
    openOnConnect: booleanOf(initial.openOnConnect, DEFAULT_UI_PREFS.openOnConnect),
    wrapOutput: booleanOf(initial.wrapOutput, DEFAULT_UI_PREFS.wrapOutput),
    pollIntervalMs: normalizePollInterval(initial.pollIntervalMs),
    confirmHighRisk: booleanOf(initial.confirmHighRisk, DEFAULT_UI_PREFS.confirmHighRisk),
    listWidthPx: initial.listWidthPx === undefined
      ? DEFAULT_UI_PREFS.listWidthPx
      : normalizeListWidth(initial.listWidthPx),
  }
  const listeners = new Set<(prefs: ConsoleUiPrefs) => void>()
  return {
    get: () => current,
    set(patch) {
      const next: ConsoleUiPrefs = {
        openOnConnect: booleanOf(patch.openOnConnect, current.openOnConnect),
        wrapOutput: booleanOf(patch.wrapOutput, current.wrapOutput),
        pollIntervalMs: patch.pollIntervalMs === undefined
          ? current.pollIntervalMs
          : normalizePollInterval(patch.pollIntervalMs),
        confirmHighRisk: booleanOf(patch.confirmHighRisk, current.confirmHighRisk),
        listWidthPx: patch.listWidthPx === undefined
          ? current.listWidthPx
          : normalizeListWidth(patch.listWidthPx),
      }
      // An unchanged write must not wake every subscriber. This matters most for
      // `listWidthPx`: a drag calls `set` on every pointer move, and re-rendering
      // the whole tab for a width that did not change would make the drag
      // stutter.
      if (next.openOnConnect === current.openOnConnect
        && next.wrapOutput === current.wrapOutput
        && next.pollIntervalMs === current.pollIntervalMs
        && next.confirmHighRisk === current.confirmHighRisk
        && next.listWidthPx === current.listWidthPx) return
      current = next
      for (const listener of listeners) listener(current)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Read the prefs out of the shell's opaque per-plugin settings bag. */
export function prefsFromSettings(settings: Record<string, unknown>): Partial<ConsoleUiPrefs> {
  const patch: Partial<ConsoleUiPrefs> = {}
  if (typeof settings.openOnConnect === 'boolean') patch.openOnConnect = settings.openOnConnect
  if (typeof settings.wrapOutput === 'boolean') patch.wrapOutput = settings.wrapOutput
  if (typeof settings.pollIntervalMs === 'number') patch.pollIntervalMs = settings.pollIntervalMs
  if (typeof settings.confirmHighRisk === 'boolean') patch.confirmHighRisk = settings.confirmHighRisk
  if (typeof settings.listWidthPx === 'number') patch.listWidthPx = settings.listWidthPx
  return patch
}

/**
 * The one live prefs store this plugin's surfaces share.
 *
 * The settings panel is the only writer (the shell hands it
 * `updatePluginSetting`), and the console tab is a reader; a module-level
 * singleton is what lets the two meet without the tab receiving prefs it has no
 * prop for.
 */
export const uiPrefs: PrefsStore = createPrefsStore()
