/**
 * The fence-rule editor: a large text box in the side card's settings popup.
 *
 * It sits directly under the declarative rows (output wrap, refresh interval,
 * high-risk confirmation) because that is where an operator looks for the
 * console's policy, and it is rendered through the descriptor's
 * `settings.render`, which the shell appends AFTER the row list.
 *
 * Two things about it are not obvious and both are deliberate:
 *
 * 1. **It saves to the HOST settings document, not to the side card's prefs.**
 *    The rows beside it persist into `pluginSettings[<tab id>]`, which is the
 *    browser's own blob; the fence is enforced by the host process, so a rule
 *    written there would be a rule that does nothing. This component therefore
 *    goes through the plugin's API (`settings.update`) and shows the host's own
 *    validation error when a write is refused.
 *
 * 2. **It renders ONLY the editor.** The shell's `settings.render` is additive
 *    (rows first, panel after), so re-rendering the four rows here would show
 *    every control twice -- which is what a previous version of this plugin did.
 *
 * @module dsh-console-hub/client/FenceRulesEditor
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ConsoleHub } from './hub.ts'
import {
  assignRuleIds,
  formatFenceRules,
  parseFenceRules,
  PATTERN_PREFIX,
} from './fence-text.ts'

/** Props the descriptor's `settings.render` hands over, narrowed to what is used. */
export interface FenceRulesEditorProps {
  /** The typed API surface, so the editor can reach the HOST settings. */
  hub: ConsoleHub
  /**
   * The active session id, or `undefined` when the popup is open with no
   * session.
   *
   * The plugin's API is session-scoped (every method proves the session exists),
   * so without one there is nothing to address the settings document with. The
   * editor is disabled rather than silently saving into the void.
   */
  sessionId: string | undefined
}

/** How one save ended, for the status line. */
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved', count: number }
  | { kind: 'invalid', errors: Array<{ line: number, message: string }> }
  | { kind: 'failed', message: string }

/** The placeholder that documents the format without shipping a real rule. */
const PLACEHOLDER = [
  '# 每行一条规则，自上而下第一条命中生效；未命中的用兜底策略。',
  '# 格式：<deny|ask|allow> <匹配器>   # 说明（可选）',
  '#   匹配器：词序列，按「词前缀」匹配（设备 CLI 接受省略输入）',
  `#           ${PATTERN_PREFIX} 开头表示原始正则，锚定在命令开头`,
  'ask configuration rollback   # 用保存的配置覆盖运行配置',
  'ask reboot|restart|reload    # 重启设备',
].join('\n')

/** The fence-rule text box and its save button. */
export function FenceRulesEditor(props: FenceRulesEditorProps): ReactElement {
  const { hub, sessionId } = props
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [stored, setStored] = useState<{ rules: ReturnType<typeof parseFenceRules>['rules'], approvalMode: string, legacy: string[] }>({
    rules: [],
    approvalMode: 'high-risk',
    legacy: [],
  })
  const [state, setState] = useState<SaveState>({ kind: 'idle' })
  const [loadError, setLoadError] = useState<string | null>(null)

  /** Read the live policy from the HOST, so the box shows what is enforced. */
  const load = useCallback(async () => {
    if (sessionId === undefined) return
    setLoadError(null)
    try {
      const answer = await hub.settings(sessionId)
      const rules = (answer.defaults.fenceRules ?? []).map(rule => ({
        id: rule.id,
        action: rule.action as never,
        tokens: rule.tokens,
        pattern: rule.pattern,
        note: rule.note,
      }))
      setStored({
        rules,
        approvalMode: answer.defaults.approvalMode,
        legacy: answer.defaults.highRiskPatterns ?? [],
      })
      setText(formatFenceRules(rules))
      setLoaded(true)
    } catch (failure) {
      setLoadError(failure instanceof Error ? failure.message : String(failure))
    }
  }, [hub, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  /** Parse, then write to the host, reporting whatever it says. */
  const save = useCallback(async () => {
    if (sessionId === undefined) return
    const parsed = parseFenceRules(text)
    if (parsed.errors.length > 0) {
      // Nothing is sent. The operator's text is left exactly as typed, and each
      // bad line is named, so a typo costs a correction rather than the whole
      // box.
      setState({ kind: 'invalid', errors: parsed.errors.map(entry => ({ line: entry.line, message: entry.message })) })
      return
    }
    setState({ kind: 'saving' })
    try {
      const rules = assignRuleIds(parsed.rules, stored.rules)
      const answer = await hub.updateSettings(sessionId, { fenceRules: rules })
      // Re-seed from the HOST's answer, not from the local text: the schema fills
      // defaults and the id derivation is the host's to confirm, so showing the
      // canonical form is what proves the write landed as intended.
      const fresh = (answer.defaults.fenceRules ?? []).map(rule => ({
        id: rule.id,
        action: rule.action as never,
        tokens: rule.tokens,
        pattern: rule.pattern,
        note: rule.note,
      }))
      setStored(current => ({ ...current, rules: fresh }))
      setText(formatFenceRules(fresh))
      setState({ kind: 'saved', count: fresh.length })
    } catch (failure) {
      // The host validates the rule set and refuses a bad one; its message names
      // the offending field, so it is shown verbatim rather than paraphrased.
      setState({ kind: 'failed', message: failure instanceof Error ? failure.message : String(failure) })
    }
  }, [hub, sessionId, text, stored.rules])

  const disabled = sessionId === undefined || state.kind === 'saving'

  return (
    <div
      style={{
        padding: '8px 10px 10px',
        borderTop: '1px solid rgba(127,127,127,0.3)',
        fontFamily: 'var(--dsw-font-family, inherit)',
      }}
    >
      <div style={{ fontWeight: 600 }}>高危指令拦截规则</div>
      <div style={{ opacity: 0.7, fontSize: '0.9em', margin: '2px 0 6px' }}>
        自上而下第一条命中生效；未命中任何规则时
        {stored.approvalMode === 'always' ? '每条命令都要确认' : '直接放行'}。
      </div>

      {loadError !== null && (
        <div style={{ color: '#e06c75', marginBottom: 6 }}>读取规则失败：{loadError}</div>
      )}

      <textarea
        value={text}
        onChange={event => { setText(event.target.value) }}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        rows={10}
        disabled={disabled}
        data-console-hub-fence="rules"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
          fontSize: 12,
          lineHeight: 1.5,
          padding: '6px 8px',
          resize: 'vertical',
          whiteSpace: 'pre',
        }}
      />

      {state.kind === 'invalid' && (
        <div style={{ color: '#e06c75', marginTop: 6 }}>
          <div>有 {state.errors.length} 行无法解析，未保存：</div>
          <ul style={{ margin: '2px 0 0', paddingLeft: 20 }}>
            {state.errors.map(entry => (
              <li key={entry.line}>第 {entry.line} 行：{entry.message}</li>
            ))}
          </ul>
        </div>
      )}
      {state.kind === 'failed' && (
        <div style={{ color: '#e06c75', marginTop: 6 }}>宿主拒绝了这次保存：{state.message}</div>
      )}
      {state.kind === 'saved' && (
        <div style={{ color: '#7ec699', marginTop: 6 }}>已保存 {state.count} 条规则，宿主已生效。</div>
      )}

      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={disabled || !loaded}
          data-console-hub-fence-save="1"
          style={{ padding: '3px 12px', cursor: disabled ? 'not-allowed' : 'pointer' }}
        >
          {state.kind === 'saving' ? '保存中…' : '保存规则'}
        </button>
        <button type="button" onClick={() => void load()} disabled={disabled} style={{ padding: '3px 12px' }}>
          重新读取
        </button>
        {sessionId === undefined && (
          <span style={{ opacity: 0.7 }}>当前没有活动会话，无法读写宿主设置。</span>
        )}
      </div>
    </div>
  )
}
