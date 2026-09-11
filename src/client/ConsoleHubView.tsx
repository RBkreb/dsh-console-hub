/**
 * The device console surface: saved views, live consoles, and the terminal.
 *
 * This is a *lightweight text console*, not an emulator. The host already
 * decodes bytes, strips telnet negotiation, and drives automatic paging; all
 * that is left here is to render the decoded text, keep a cursor so no output is
 * read twice, and gate writes behind the fence. That division is deliberate:
 * anything the view could do locally (interpreting control sequences, reflowing
 * a screen) would have to be duplicated in the model's tool path, and the model
 * has no renderer.
 *
 * Polling is the one piece of behaviour that must not live in render: the shell
 * keeps hidden tabs mounted, so the read loop is keyed on `visible` through
 * {@link shouldPoll} and stopped by its effect's cleanup.
 *
 * @module dsh-console-hub/client/ConsoleHubView
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ClientTabPropsLike, ConsoleHub, ConsoleRow, ViewRow } from './hub.ts'
import { shouldPoll } from './poll.ts'
import { uiPrefs } from './prefs.ts'
import { ViewForm } from './ViewForm.tsx'

/** Props the descriptor's component receives (the hub is bound by the factory). */
export type ConsoleHubViewProps = ClientTabPropsLike & { hub: ConsoleHub }

/** The editor's target: a saved view, a fresh one, or nothing (closed). */
type Editing = { kind: 'new' } | { kind: 'edit', viewId: string } | undefined

/** A pending high-risk confirmation, with the token the replay must carry. */
interface PendingConfirm {
  text: string
  confirmationToken: string
  reason: string
}

/** Read an error into a display string. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One toolbar button. */
function button(
  label: string,
  onClick: () => void,
  options: { disabled?: boolean, title?: string, danger?: boolean } = {},
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
 * Render the console tab.
 * @param props - the shell's tab props plus the bound hub.
 * @returns the view element.
 */
export function ConsoleHubView(props: ConsoleHubViewProps): ReactElement {
  const { hub, scope, visible } = props
  const sessionId = scope.sessionId

  const [views, setViews] = useState<ViewRow[]>([])
  const [consoles, setConsoles] = useState<ConsoleRow[]>([])
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [output, setOutput] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Editing>(undefined)
  const [pending, setPending] = useState<PendingConfirm | undefined>(undefined)
  const [paging, setPaging] = useState(false)
  const [prefs, setPrefs] = useState(() => uiPrefs.get())

  // The cursor lives in a ref, not state: it changes on every read, and putting
  // it in the poll effect's dependencies would tear down and rebuild the
  // interval after each one.
  const cursorRef = useRef(0)
  const outputRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => uiPrefs.subscribe(setPrefs), [])

  /**
   * Reload the saved views and the live consoles.
   *
   * The two reads are settled INDEPENDENTLY on purpose. They come from
   * different halves of the API (the settings document vs the live session
   * registry), so one failing says nothing about the other -- and a shared
   * `Promise.all` made the console registry's failure discard a perfectly good
   * inventory read. The visible effect was the worst possible one: a device was
   * saved to disk, and the list stayed empty, so the user could not tell whether
   * the save had worked.
   */
  const refresh = useCallback(async () => {
    const [inventory, live] = await Promise.allSettled([
      hub.listViews(sessionId),
      hub.listConsoles(sessionId),
    ])
    if (inventory.status === 'fulfilled') setViews(inventory.value.views)
    if (live.status === 'fulfilled') setConsoles(live.value.consoles)
    // Report whichever failed, so a broken read is never mistaken for an empty
    // result -- but only after the successful half has been applied.
    const failures: string[] = []
    if (inventory.status === 'rejected') failures.push(messageOf(inventory.reason))
    if (live.status === 'rejected') failures.push(messageOf(live.reason))
    setError(failures.length === 0 ? null : failures.join('\n'))
  }, [hub, sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Select a console and restart the read cursor for it. */
  const select = useCallback((consoleId: string) => {
    setSelected(consoleId)
    setOutput('')
    setPaging(false)
    cursorRef.current = 0
  }, [])

  /** Connect one saved view, or an ad-hoc host/port. */
  const connect = useCallback(async (input: { viewId?: string, host?: string, port?: number, kind?: string }) => {
    setBusy(true)
    setError(null)
    try {
      const entry = await hub.connect(sessionId, input)
      setStatus(`${entry.label} (${entry.host}:${String(entry.port)}) ${entry.state}`)
      // The banner is the device's own words on connect — for a console that
      // lands straight at a prompt it is the only thing that proves the link.
      setConsoles(current => [
        ...current.filter(row => row.consoleId !== entry.consoleId),
        {
          consoleId: entry.consoleId,
          ownerSessionId: sessionId,
          label: entry.label,
          host: entry.host,
          port: entry.port,
          kind: input.kind ?? 'telnet',
          encoding: 'utf-8',
          secure: entry.secure,
          state: entry.state,
          lastError: entry.lastError,
          idleMs: 0,
          createdAt: new Date().toISOString(),
        },
      ])
      // A failed connect is a result, not an exception: render it rather than
      // throwing the banner away.
      if (entry.lastError !== null) setError(`${entry.lastError.code}: ${entry.lastError.message}`)
      select(entry.consoleId)
      if (entry.banner !== '') setOutput(entry.banner)
      await refresh()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, refresh, select])

  const closeConsole = useCallback(async (consoleId: string, force: boolean) => {
    setBusy(true)
    try {
      await hub.close(sessionId, consoleId, force)
      if (selected === consoleId) {
        setSelected(undefined)
        setOutput('')
      }
      await refresh()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, selected, refresh])

  /** Read whatever the device has said since the cursor. */
  const readOnce = useCallback(async () => {
    if (selected === undefined) return
    try {
      const result = await hub.read(sessionId, selected, cursorRef.current)
      cursorRef.current = result.cursor
      if (result.text !== '') setOutput(previous => previous + result.text)
      setPaging(result.paging.active)
      if (result.paging.active && result.paging.reason === 'max-pages') {
        setStatus('自动翻页达到页数上限，点击“继续翻页”接着读。')
      }
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [hub, sessionId, selected])

  // The read loop. `visible` is part of the condition, not just a dependency:
  // a hidden tab stays mounted in this shell and must not keep polling.
  useEffect(() => {
    if (!shouldPoll({ visible, consoleId: selected })) return undefined
    const timer = setInterval(() => {
      void readOnce()
    }, prefs.pollIntervalMs)
    return () => {
      clearInterval(timer)
    }
  }, [visible, selected, prefs.pollIntervalMs, readOnce])

  // Keep the newest output in view unless the user has scrolled up to read.
  useEffect(() => {
    const node = outputRef.current
    if (node === null) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distanceFromBottom < 40) node.scrollTop = node.scrollHeight
  }, [output])

  /** Write one command, asking first when the fence says it is high-risk. */
  const write = useCallback(async (text: string, confirmationToken?: string) => {
    if (selected === undefined || text === '') return
    setBusy(true)
    setError(null)
    try {
      await hub.send(sessionId, selected, text, {
        ...confirmationToken === undefined ? {} : { confirmToken: confirmationToken },
      })
      setDraft('')
      setPending(undefined)
      await readOnce()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, selected, readOnce])

  /** Submit the draft: fence it first, then either write or ask. */
  const submit = useCallback(async () => {
    if (selected === undefined) return
    const text = draft.trim()
    if (text === '') return
    setBusy(true)
    setError(null)
    try {
      const fenced = await hub.fence(sessionId, selected, text)
      if (fenced.risk === 'high') {
        // The host refuses the write until it sees the token, so the choice here
        // is only whether to ASK first — never whether to carry the token.
        if (prefs.confirmHighRisk) {
          setPending({ text, confirmationToken: fenced.confirmationToken, reason: fenced.reason })
          return
        }
        await write(text, fenced.confirmationToken)
        return
      }
      await write(text)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, selected, draft, prefs.confirmHighRisk, write])

  /** Discharge a waiting pager so reading continues. */
  const resumePaging = useCallback(async () => {
    if (selected === undefined) return
    try {
      await hub.control(sessionId, selected, 'drain')
      setPaging(false)
      await readOnce()
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [hub, sessionId, selected, readOnce])

  /** Delete one saved view (and, on the host, its stored credential). */
  const removeView = useCallback(async (viewId: string) => {
    setBusy(true)
    try {
      await hub.removeView(sessionId, viewId)
      await refresh()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, refresh])

  const current = consoles.find(row => row.consoleId === selected)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', font: '13px/1.5 ui-monospace, monospace' }}>
      <div style={{ padding: 8, borderBottom: '1px solid rgba(127,127,127,0.3)' }}>
        <strong>设备配置</strong>
        {' '}
        {button('新建', () => setEditing({ kind: 'new' }))}
        {button('刷新', () => void refresh())}
      </div>

      <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
        <div style={{ width: '38%', minWidth: 220, overflow: 'auto', borderRight: '1px solid rgba(127,127,127,0.3)' }}>
          {views.length === 0 && <p style={{ padding: 8, opacity: 0.6 }}>还没有保存的设备，先「新建」一个。</p>}
          {views.map(row => (
            <div key={row.viewId} style={{ padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,0.2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <strong style={{ flex: 1 }}>{row.view.name}</strong>
                {row.view.secretConfigured ? '🔑' : '—'}
              </div>
              <div style={{ opacity: 0.7 }}>
                {row.view.kind} · {row.view.host}:{row.view.port} · {row.view.encoding}
              </div>
              {row.view.tags.length > 0 && <div style={{ opacity: 0.6 }}>#{row.view.tags.join(' #')}</div>}
              <div style={{ marginTop: 4 }}>
                {button('连接', () => void connect({ viewId: row.viewId }), { disabled: busy })}
                {button('编辑', () => setEditing({ kind: 'edit', viewId: row.viewId }))}
                {button('删除', () => void removeView(row.viewId), { danger: true, disabled: busy })}
              </div>
            </div>
          ))}

          <div style={{ padding: 8, borderTop: '1px solid rgba(127,127,127,0.3)' }}>
            <strong>已连接 ({consoles.length})</strong>
            {consoles.length > 1 && (
              <div style={{ marginTop: 4 }}>
                {button('全部关闭', () => void hub.closeAll(sessionId, true).then(refresh).catch(f => { setError(messageOf(f)) }))}
              </div>
            )}
          </div>
          {consoles.map(row => (
            <div
              key={row.consoleId}
              style={{
                padding: '6px 8px',
                cursor: 'pointer',
                background: row.consoleId === selected ? 'rgba(127,127,127,0.2)' : undefined,
                borderBottom: '1px solid rgba(127,127,127,0.2)',
              }}
            >
              <div onClick={() => { select(row.consoleId) }}>
                <strong>{row.label}</strong>
                {' '}
                <span style={{ opacity: 0.7 }}>{row.state}</span>
              </div>
              {row.lastError !== null && (
                <div style={{ color: '#c0392b' }}>{row.lastError.code}: {row.lastError.message}</div>
              )}
              <div style={{ marginTop: 4 }}>
                {button('关闭', () => void closeConsole(row.consoleId, false), { disabled: busy })}
                {button('强制关闭', () => void closeConsole(row.consoleId, true), { disabled: busy, danger: true })}
              </div>
            </div>
          ))}
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {error !== null && (
            <div style={{ padding: '4px 8px', background: '#5a1d1d', color: '#ffd9d9' }}>
              {error}
              {' '}
              <button type="button" onClick={() => { setError(null) }} style={{ marginLeft: 6 }}>知道了</button>
            </div>
          )}
          {status !== null && <div style={{ padding: '4px 8px', opacity: 0.75 }}>{status}</div>}

          {editing !== undefined
            ? (
              <ViewForm
                hub={hub}
                sessionId={sessionId}
                viewId={editing.kind === 'edit' ? editing.viewId : undefined}
                initial={editing.kind === 'edit'
                  ? views.find(row => row.viewId === editing.viewId)?.view
                  : undefined}
                onDone={async () => {
                  setEditing(undefined)
                  await refresh()
                }}
                onCancel={() => { setEditing(undefined) }}
              />
            )
            : selected === undefined
              ? (
                <p style={{ padding: 12, opacity: 0.7 }}>
                  选择一个已连接的控制台，或在上方连接一台设备。
                </p>
              )
              : (
                <>
                  <pre
                    ref={outputRef}
                    style={{
                      flex: 1,
                      margin: 0,
                      padding: 8,
                      overflow: 'auto',
                      whiteSpace: prefs.wrapOutput ? 'pre-wrap' : 'pre',
                      wordBreak: prefs.wrapOutput ? 'break-all' : undefined,
                    }}
                  >
                    {output === '' ? '(暂无输出)' : output}
                  </pre>

                  {paging && (
                    <div style={{ padding: 4 }}>
                      {button('继续翻页', () => void resumePaging())}
                    </div>
                  )}

                  {pending !== undefined && (
                    <div style={{ padding: 8, background: '#5a4a1d', color: '#fff6d9' }}>
                      <div>高危指令，确认后发送：<code>{pending.text}</code></div>
                      <div style={{ opacity: 0.85 }}>{pending.reason}</div>
                      <div style={{ marginTop: 6 }}>
                        {button('确认发送', () => void write(pending.text, pending.confirmationToken), { disabled: busy, danger: true })}
                        {button('取消', () => { setPending(undefined) })}
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', padding: 8, gap: 6 }}>
                    <input
                      value={draft}
                      onChange={event => { setDraft(event.target.value) }}
                      onKeyDown={event => {
                        if (event.key === 'Enter') void submit()
                      }}
                      placeholder="输入命令后回车（不发换行前请留空）"
                      disabled={busy}
                      style={{ flex: 1, font: 'inherit', padding: '4px 6px' }}
                    />
                    {button('发送', () => void submit(), { disabled: busy })}
                    {button('读取', () => void readOnce())}
                  </div>
                  <div style={{ padding: '0 8px 8px', opacity: 0.6 }}>
                    当前：{current?.label ?? selected} · cursor {cursorRef.current}
                    {current !== undefined ? ` · 已收 ${String(current.idleMs)}ms 无活动` : ''}
                  </div>
                </>
              )}
        </div>
      </div>
    </div>
  )
}

