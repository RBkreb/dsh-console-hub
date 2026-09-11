/**
 * The device-view editor: create or update one saved console target.
 *
 * Two rules the form obeys, both because the host enforces them:
 *
 * 1. **The password is written, never read.** The form shows whether a credential
 *    is configured and lets the user replace or clear it; it never receives the
 *    value back from the host, so it has nothing to render or leak.
 * 2. **An empty field means "use the engine default".** Blank patterns and a
 *    blank encoding are sent as empty strings, and the host resolves them to its
 *    own defaults at connect time. Repeating the defaults here would make the
 *    panel disagree with the engine after any settings change.
 *
 * @module dsh-console-hub/client/ViewForm
 */
import { useState, type ReactElement } from 'react'
import {
  CONSOLE_ENCODINGS,
  CONSOLE_KINDS,
  PAGING_MODES,
  DEFAULT_CONSOLE_VIEW,
  DEFAULT_PROMPT_PATTERN,
} from '../config-shared.ts'
import type { ConsoleHub, ViewRow } from './hub.ts'

/** Props for {@link ViewForm}. */
export interface ViewFormProps {
  hub: ConsoleHub
  sessionId: string
  /** The view being edited, or `undefined` when creating one. */
  viewId?: string
  /** The current values when editing (never carries a secret). */
  initial?: ViewRow['view']
  onDone(): void | Promise<void>
  onCancel(): void
}

/** The form's own field state; strings throughout, because inputs are text. */
interface FormState {
  name: string
  host: string
  port: string
  kind: string
  encoding: string
  user: string
  password: string
  promptPattern: string
  pagerPattern: string
  pagingMode: string
  tags: string
  notes: string
}

/** Seed the form from a stored view, falling back to the shared defaults. */
function initialState(initial: ViewRow['view'] | undefined, viewId: string | undefined): FormState {
  return {
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: initial === undefined ? '' : String(initial.port),
    kind: initial?.kind ?? DEFAULT_CONSOLE_VIEW.kind,
    encoding: initial?.encoding ?? '',
    user: initial?.user ?? '',
    // Never prefilled: the host does not return the value, and a placeholder
    // would tempt a caller into treating a masked field as the real password.
    password: '',
    promptPattern: initial?.promptPattern ?? '',
    pagerPattern: initial?.pagerPattern ?? '',
    pagingMode: initial?.pagingMode ?? '',
    tags: initial?.tags.join(', ') ?? '',
    notes: initial?.notes ?? '',
  }
}

/** One labelled text input. */
function input(
  label: string,
  value: string,
  onChange: (next: string) => void,
  options: { type?: string, placeholder?: string, hint?: string } = {},
): ReactElement {
  return (
    <label style={{ display: 'block', margin: '8px 0' }}>
      <div style={{ fontWeight: 600 }}>{label}</div>
      <input
        type={options.type ?? 'text'}
        value={value}
        placeholder={options.placeholder ?? ''}
        onChange={event => { onChange(event.target.value) }}
        style={{ width: '100%', font: 'inherit', padding: '3px 5px', boxSizing: 'border-box' }}
      />
      {options.hint !== undefined && (
        <div style={{ opacity: 0.6, fontSize: '0.85em' }}>{options.hint}</div>
      )}
    </label>
  )
}

/** One labelled select, with an explicit "engine default" option. */
function select(
  label: string,
  value: string,
  options: readonly string[],
  onChange: (next: string) => void,
  hint?: string,
): ReactElement {
  return (
    <label style={{ display: 'block', margin: '8px 0' }}>
      <div style={{ fontWeight: 600 }}>{label}</div>
      <select
        value={value}
        onChange={event => { onChange(event.target.value) }}
        style={{ width: '100%', font: 'inherit', padding: '3px 5px' }}
      >
        <option value="">（用引擎默认）</option>
        {options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
      {hint !== undefined && <div style={{ opacity: 0.6, fontSize: '0.85em' }}>{hint}</div>}
    </label>
  )
}

/**
 * Render the view editor.
 * @param props - the form's dependencies.
 * @returns the form element.
 */
export function ViewForm(props: ViewFormProps): ReactElement {
  const { hub, sessionId, viewId, initial } = props
  const [form, setForm] = useState<FormState>(() => initialState(initial, viewId))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [secretConfigured, setSecretConfigured] = useState(initial?.secretConfigured ?? false)

  /** Patch one field. */
  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm(current => ({ ...current, [key]: value }))
  }

  /** Validate locally, then write through the API. */
  async function save(): Promise<void> {
    setError(null)
    const port = Number(form.port)
    if (form.name.trim() === '') { setError('请填写名称。'); return }
    if (form.host.trim() === '') { setError('请填写主机。'); return }
    if (!Number.isInteger(port) || port < 1 || port > 65535) { setError('端口必须是 1–65535 的整数。'); return }

    setBusy(true)
    try {
      await hub.upsertView(sessionId, {
        ...viewId === undefined ? {} : { viewId },
        name: form.name.trim(),
        host: form.host.trim(),
        port,
        kind: form.kind,
        encoding: form.encoding,
        user: form.user.trim(),
        promptPattern: form.promptPattern.trim(),
        pagerPattern: form.pagerPattern.trim(),
        pagingMode: form.pagingMode,
        notes: form.notes,
        // The password travels beside the view, never inside it; leaving it
        // blank on an edit means "keep what is stored".
        ...form.password === '' ? {} : { password: form.password },
      })
      await props.onDone()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  /** Replace or clear the stored credential for an existing view. */
  async function storeSecret(clear: boolean): Promise<void> {
    if (viewId === undefined) return
    setError(null)
    setBusy(true)
    try {
      if (clear) {
        await hub.clearSecret(sessionId, viewId)
        setSecretConfigured(false)
      } else {
        if (form.password === '') { setError('请先填写密码。'); return }
        await hub.setSecret(sessionId, viewId, form.password, form.user.trim() === '' ? undefined : form.user.trim())
        setSecretConfigured(true)
        set('password', '')
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 10, overflow: 'auto' }}>
      <h3 style={{ marginTop: 0 }}>{viewId === undefined ? '新建设备' : '编辑设备'}</h3>

      {error !== null && <div style={{ color: '#c0392b', marginBottom: 6 }}>{error}</div>}

      {input('名称', form.name, next => { set('name', next) }, { hint: '列表里显示的名字，例如 FW1。' })}
      {input('主机', form.host, next => { set('host', next) })}
      {input('端口', form.port, next => { set('port', next) }, { hint: 'console 映射端口，例如 10003。' })}
      {select('协议', form.kind, CONSOLE_KINDS, next => { set('kind', next) })}
      {select(
        '编码',
        form.encoding,
        CONSOLE_ENCODINGS,
        next => { set('encoding', next) },
        '留空使用插件默认编码；中文设备常见 gbk / gb18030。',
      )}

      {input('登录用户名', form.user, next => { set('user', next) }, { hint: '设备不需要登录时留空。' })}

      <div style={{ margin: '8px 0', padding: 8, border: '1px solid rgba(127,127,127,0.35)' }}>
        <div style={{ fontWeight: 600 }}>密码（存储于 credentials）</div>
        <div style={{ opacity: 0.75 }}>
          当前：{secretConfigured ? '已配置' : '未配置'}
          {initial?.secretSource !== undefined ? `（来源：${initial.secretSource}）` : ''}
        </div>
        <input
          type="password"
          value={form.password}
          placeholder={secretConfigured ? '留空则保持不变' : '输入密码'}
          onChange={event => { set('password', event.target.value) }}
          style={{ width: '100%', font: 'inherit', padding: '3px 5px', boxSizing: 'border-box', marginTop: 4 }}
        />
        <div style={{ opacity: 0.6, fontSize: '0.85em' }}>
          保存时会随配置一起写入；也可以只更新密码：
        </div>
        <div style={{ marginTop: 4 }}>
          <button type="button" disabled={busy || viewId === undefined} onClick={() => void storeSecret(false)}>
            只更新密码
          </button>
          {' '}
          <button type="button" disabled={busy || viewId === undefined} onClick={() => void storeSecret(true)}>
            清除密码
          </button>
        </div>
      </div>

      {input(
        '提示符正则',
        form.promptPattern,
        next => { set('promptPattern', next) },
        { placeholder: DEFAULT_PROMPT_PATTERN, hint: '留空使用插件默认；用于判定“命令已执行完”。' },
      )}
      {input(
        '分页提示正则',
        form.pagerPattern,
        next => { set('pagerPattern', next) },
        { hint: '留空使用插件默认；用于识别 --More-- 一类分页。' },
      )}
      {select('分页处理', form.pagingMode, PAGING_MODES, next => { set('pagingMode', next) }, '留空使用插件默认。')}
      {input('标签', form.tags, next => { set('tags', next) }, { hint: '逗号分隔，便于检索。' })}
      {input('备注', form.notes, next => { set('notes', next) })}

      <div style={{ marginTop: 10 }}>
        <button type="button" disabled={busy} onClick={() => void save()}>保存</button>
        {' '}
        <button type="button" disabled={busy} onClick={props.onCancel}>取消</button>
      </div>
    </div>
  )
}
