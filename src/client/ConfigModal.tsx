/**
 * The device-configuration dialog.
 *
 * Configuration used to live inline in the left column, above the connected
 * consoles. With many saved devices it filled that column, so the thing the user
 * is actually working with — the live consoles — got whatever space was left.
 * Configuration is an occasional activity; the consoles are the point. So the
 * inventory moved into a modal, reachable from one button, and the column
 * belongs to the consoles again.
 *
 * The modal owns its own editing state: choosing 新建 or 编辑 swaps the list for
 * the form in place, so a save returns to the list without closing the dialog.
 *
 * It renders through a portal on `document.body` because the tab is mounted
 * inside the sidebar's own stacking context; an absolutely positioned panel
 * there would be clipped by the sidebar's overflow rather than covering it.
 *
 * @module dsh-console-hub/client/ConfigModal
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ConsoleHub, ViewRow } from './hub.ts'
import { ViewForm } from './ViewForm.tsx'

/** Props for {@link ConfigModal}. */
export interface ConfigModalProps {
  /** The saved devices, as the inventory read returns them. */
  views: ViewRow[]
  /** Whether a host call is in flight (gates the row buttons). */
  busy: boolean
  hub: ConsoleHub
  sessionId: string
  /** Dismiss the dialog. */
  onClose(): void
  /** Connect one saved device and dismiss the dialog. */
  onConnect(viewId: string): void
  /** Delete one saved device. */
  onRemove(viewId: string): void | Promise<void>
  /** Called after a save, so the parent can re-read the inventory. */
  onChanged(): void | Promise<void>
}

/** One small button, matching the tab's own chrome. */
function modalButton(
  label: string,
  onClick: () => void,
  options: { disabled?: boolean, danger?: boolean, title?: string } = {},
): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={options.disabled ?? false}
      title={options.title ?? label}
      style={{
        padding: '2px 8px',
        marginRight: 6,
        cursor: options.disabled === true ? 'not-allowed' : 'pointer',
        color: options.danger === true ? '#c0392b' : undefined,
      }}
    >
      {label}
    </button>
  )
}

/**
 * Render the device-configuration dialog.
 * @param props - the inventory, the API surface, and the callbacks.
 * @returns the portal element.
 */
export function ConfigModal(props: ConfigModalProps): ReactElement {
  const { views, busy, hub, sessionId, onClose, onConnect, onRemove, onChanged } = props
  /** Which form is open inside the dialog: a new device, an edit, or the list. */
  const [editing, setEditing] = useState<{ kind: 'new' } | { kind: 'edit', viewId: string } | undefined>(undefined)

  // Escape closes, as it does for every other dialog in the app. Bound while the
  // modal is mounted so a dismissed dialog leaves no listener behind.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  const save = useCallback(async () => {
    setEditing(undefined)
    await onChanged()
  }, [onChanged])

  const body = editing === undefined
    ? (
      <>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          {modalButton('新建', () => setEditing({ kind: 'new' }))}
          <span style={{ opacity: 0.6, fontSize: '0.85em' }}>
            {views.length === 0 ? '还没有保存的设备' : `共 ${String(views.length)} 台`}
          </span>
        </div>
        {views.length === 0 && (
          <p style={{ opacity: 0.7 }}>点「新建」添加一台设备。密码等敏感信息单独存放，不会写进配置。</p>
        )}
        <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
          {views.map(row => (
            <div
              key={row.viewId}
              style={{ padding: '8px 4px', borderBottom: '1px solid rgba(127,127,127,0.2)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <strong style={{ flex: 1 }}>{row.view.name}</strong>
                <span title={row.view.secretConfigured ? '已配置凭据' : '未配置凭据'}>
                  {row.view.secretConfigured ? '🔑' : '—'}
                </span>
              </div>
              <div style={{ opacity: 0.7, fontSize: '0.9em' }}>
                {row.view.kind} · {row.view.host}:{String(row.view.port)}
                {row.view.encoding === '' ? '' : ` · ${row.view.encoding}`}
              </div>
              {row.view.tags.length > 0 && (
                <div style={{ opacity: 0.6, fontSize: '0.9em' }}>#{row.view.tags.join(' #')}</div>
              )}
              <div style={{ marginTop: 6 }}>
                {modalButton('连接', () => onConnect(row.viewId), { disabled: busy })}
                {modalButton('编辑', () => setEditing({ kind: 'edit', viewId: row.viewId }))}
                {modalButton('删除', () => { void onRemove(row.viewId) }, { danger: true, disabled: busy })}
              </div>
            </div>
          ))}
        </div>
      </>
    )
    : (
      <ViewForm
        hub={hub}
        sessionId={sessionId}
        viewId={editing.kind === 'edit' ? editing.viewId : undefined}
        initial={editing.kind === 'edit'
          ? views.find(row => row.viewId === editing.viewId)?.view
          : undefined}
        onDone={() => { void save() }}
        onCancel={() => { setEditing(undefined) }}
      />
    )

  return createPortal(
    // The backdrop covers the app and closes on a click outside the panel; the
    // panel stops propagation so a click inside never dismisses the dialog.
    <div
      data-console-hub-modal="config"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2100,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设备配置"
        onClick={event => { event.stopPropagation() }}
        style={{
          // The harness UI font: a settings surface is chrome, not console text.
          fontFamily: 'var(--dsw-font-family, system-ui, sans-serif)',
          fontSize: 13,
          background: 'var(--dsw-alias-bg-base, #1f1f1f)',
          color: 'var(--dsw-alias-label-primary, #eee)',
          border: '1px solid rgba(127,127,127,0.35)',
          borderRadius: 8,
          width: 'min(640px, 92vw)',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          padding: 14,
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <strong style={{ flex: 1, fontSize: 14 }}>设备配置</strong>
          {modalButton('关闭', onClose)}
        </div>
        {body}
      </div>
    </div>,
    document.body,
  )
}
