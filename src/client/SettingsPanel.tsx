/**
 * The side-card settings panel for the console tab.
 *
 * The shell owns the rows' presentation and persistence; this module only has
 * to (a) turn the shell's opaque per-plugin settings bag into the prefs the tab
 * reads, and (b) render the few controls the panel declares. The rows
 * themselves are declared in `hub.ts` so the description text lives beside the
 * rest of the tab's declaration.
 *
 * @module dsh-console-hub/client/SettingsPanel
 */
import { createElement, useEffect, useState, type ReactElement } from 'react'
import type { ClientSettingsProps } from './hub.ts'
import {
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  normalizePollInterval,
  prefsFromSettings,
  uiPrefs,
} from './prefs.ts'

/** One labelled control row. */
function field(label: string, hint: string, control: ReactElement): ReactElement {
  return createElement('label', { style: { display: 'block', margin: '10px 0' } }, [
    createElement('div', { key: 'label', style: { fontWeight: 600 } }, label),
    control,
    createElement('div', { key: 'hint', style: { opacity: 0.65, fontSize: '0.85em', marginTop: 4 } }, hint),
  ])
}

/**
 * Render the settings panel.
 * @param props - the shell's settings props.
 * @returns the panel element.
 */
export function ConsoleSettingsPanel(props: ClientSettingsProps): ReactElement {
  const [prefs, setPrefs] = useState(() => uiPrefs.get())

  // The shell's bag is the source of truth across reloads: push it into the
  // shared store once on mount so the tab (which has no prefs prop) sees it.
  useEffect(() => {
    const stored = prefsFromSettings(props.pluginSettings ?? {})
    uiPrefs.set(stored)
    setPrefs(uiPrefs.get())
  }, [props.pluginSettings])

  useEffect(() => uiPrefs.subscribe(setPrefs), [])

  /** Write one preference to both the shared store and the shell's persistence. */
  function update(key: keyof typeof prefs, value: unknown): void {
    const next = key === 'pollIntervalMs' ? normalizePollInterval(value) : Boolean(value)
    uiPrefs.set({ [key]: next })
    props.updatePluginSetting(key, next)
    setPrefs(uiPrefs.get())
  }

  return createElement('div', { style: { padding: '4px 2px' } }, [
    field(
      '连接后自动聚焦控制台',
      '连接成功后自动切换到该控制台视图。',
      createElement('input', {
        key: 'openOnConnect',
        type: 'checkbox',
        checked: prefs.openOnConnect,
        onChange: (event: { target: { checked: boolean } }) => update('openOnConnect', event.target.checked),
      }),
    ),
    field(
      '输出自动换行',
      '关闭后超长行横向滚动，便于对比列对齐的表格输出。',
      createElement('input', {
        key: 'wrapOutput',
        type: 'checkbox',
        checked: prefs.wrapOutput,
        onChange: (event: { target: { checked: boolean } }) => update('wrapOutput', event.target.checked),
      }),
    ),
    field(
      '高危指令二次确认',
      '关闭后 config / restart 一类指令在判定为高危时直接下发，不再弹出确认。',
      createElement('input', {
        key: 'confirmHighRisk',
        type: 'checkbox',
        checked: prefs.confirmHighRisk,
        onChange: (event: { target: { checked: boolean } }) => update('confirmHighRisk', event.target.checked),
      }),
    ),
    field(
      '刷新间隔 (ms)',
      `读取新输出的间隔，${String(MIN_POLL_INTERVAL_MS)}–${String(MAX_POLL_INTERVAL_MS)} 毫秒。`,
      createElement('input', {
        key: 'pollIntervalMs',
        type: 'number',
        min: MIN_POLL_INTERVAL_MS,
        max: MAX_POLL_INTERVAL_MS,
        step: 50,
        value: prefs.pollIntervalMs,
        onChange: (event: { target: { value: string } }) => update('pollIntervalMs', Number(event.target.value)),
      }),
    ),
  ])
}
