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
import { HubApiError } from './api.ts'
import { ConsoleBuffers } from './buffer.ts'
import { ConfigModal } from './ConfigModal.tsx'
import type { ClientTabPropsLike, ConsoleHub, ConsoleRow, EngineDefaults, ViewRow } from './hub.ts'
import { shouldPoll } from './poll.ts'
import { uiPrefs } from './prefs.ts'
import { Splitter } from './Splitter.tsx'

/** Props the descriptor's component receives (the hub is bound by the factory). */
export type ConsoleHubViewProps = ClientTabPropsLike & { hub: ConsoleHub }

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

/** Badge colours for one fence action, so a deny is never mistaken for an ask. */
const RULE_COLOR: Record<string, string> = {
  deny: '#e06c75',
  ask: '#e6b800',
  allow: '#7ec699',
}

/**
 * Whether a failure means the console is no longer there.
 *
 * `not-found` covers both "closed from another surface" and "reaped while
 * idle", and `session-gone` covers a session that ended. None of them is an
 * error the user can act on, so they are reconciled rather than reported.
 *
 * @param error - the thrown failure.
 * @returns true when the console should be dropped from the view.
 */
function isGone(error: unknown): boolean {
  return error instanceof HubApiError && (error.code === 'not-found' || error.code === 'session-gone')
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
  // The HOST engine defaults, carried so the controls below can show and change
  // real engine policy. These are not side-card prefs: `wakeOnConnect` is read
  // by the host from its settings document, so showing it here and writing it
  // through `settings.update` is the only arrangement where the switch and the
  // engine agree.
  const [defaults, setDefaults] = useState<EngineDefaults | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [output, setOutput] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Whether the device-configuration dialog is open. The inventory itself lives
  // there now, so this tab's column is free for live consoles.
  const [configOpen, setConfigOpen] = useState(false)
  const [pending, setPending] = useState<PendingConfirm | undefined>(undefined)
  const [paging, setPaging] = useState(false)
  // Whether the device has half-closed the selected console. Mirrors the host's
  // own belief rather than being inferred here: the host sees the marker text.
  const [dormant, setDormant] = useState(false)
  // The keepalive box's in-progress text, or `undefined` when it is showing the
  // host's value. See the input's own note for why it is not fully controlled.
  const [keepaliveDraft, setKeepaliveDraft] = useState<string | undefined>(undefined)
  const [prefs, setPrefs] = useState(() => uiPrefs.get())

  // One buffer per console, held in a ref: a read appends on every tick, and
  // routing that through state for a console the user is not looking at would
  // re-render the whole tab per byte for no visible change. `output` above is
  // the VIEW of whichever buffer is selected, which is the only part React
  // needs to re-render. The cursor lives beside the text it produced, and in a
  // ref for the same reason: it changes on every read, so putting it in the
  // poll effect's dependencies would rebuild the interval after each one.
  const cursorRef = useRef(0)
  const buffersRef = useRef(new ConsoleBuffers())
  /**
   * The live console rows, mirrored into a ref.
   *
   * `select` must read a console's dormancy WITHOUT taking `consoles` as a
   * dependency: it is memoized on `[]` and is a dependency of `connect` and of
   * the selection effect, so rebuilding it on every poll would restart the poll
   * loop each time the list came back.
   */
  const consolesRef = useRef<ConsoleRow[]>([])
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
    if (inventory.status === 'fulfilled') {
      setViews(inventory.value.views)
      // `config.list` already carries the engine defaults, so the controls cost
      // no extra request and stay in step with whatever the host currently has.
      setDefaults(inventory.value.defaults)
    }
    if (live.status === 'fulfilled') {
      setConsoles(live.value.consoles)
      // The list is authoritative for dormancy too: the host re-derives it from
      // the device's own marker on every read. It reaches the banner through
      // `select` (on a switch) and through the read loop (while selected) --
      // deliberately NOT by reading `selected` here, because that would make
      // `refresh` change identity on every switch and restart its own effect.
      consolesRef.current = live.value.consoles
      // Forget consoles that ended elsewhere (closed from another surface, or
      // idle-reaped), so their output does not sit in memory for the life of
      // the tab. Safe to do unconditionally: the host's list is authoritative
      // for what is live, and a console missing from it can never be selected
      // again.
      buffersRef.current.retainOnly(live.value.consoles.map(row => row.consoleId))
    }
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

  /**
   * Select a console and show ITS buffered output.
   *
   * Nothing is cleared and nothing is re-read. The cursor advances only from a
   * real read, so it is already correct for a console the user is returning to;
   * clearing it would re-deliver output already shown, and resetting the text
   * to empty is what produced the `(暂无输出)` flash on every switch.
   *
   * @param consoleId - the console to select.
   */
  const select = useCallback((consoleId: string) => {
    setSelected(consoleId)
    const buffered = buffersRef.current.get(consoleId)
    setOutput(buffered.text)
    setPaging(buffered.paging)
    // Taken from the host's row, not remembered from the last console: a
    // dormancy belongs to ONE console, and carrying it across a switch would
    // banner a healthy console as dormant.
    setDormant(consolesRef.current.find(row => row.consoleId === consoleId)?.dormant === true)
    cursorRef.current = buffered.cursor
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
      // No buffer seeding here. The banner is decoded from the host's own
      // scrollback, so a first read at cursor 0 returns those same bytes --
      // seeding them and then reading would render the banner TWICE. The
      // immediate read that `select` triggers delivers it exactly once. The
      // banner itself is still surfaced through the connect result, which is
      // what the model-facing tool reports.
      // Honour the tab's own setting. The row existed but nothing read it, so
      // turning it off changed nothing: a connect always stole the selection.
      if (prefs.openOnConnect) select(entry.consoleId)
      await refresh()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, refresh, select, prefs.openOnConnect])

  const closeConsole = useCallback(async (consoleId: string, force: boolean) => {
    setBusy(true)
    try {
      await hub.close(sessionId, consoleId, force)
      // A closed console's output is unreachable, so holding it would only leak.
      buffersRef.current.clear(consoleId)
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

  /**
   * Read whatever the device has said since the cursor.
   *
   * A console can disappear while the panel is watching it: the model may close
   * it, or the idle reaper may collect it. The host answers `not-found`, and that
   * is a fact to reconcile rather than an error to display -- showing it as a
   * banner left a permanent red strip over a console that no longer existed, and
   * the list kept listing it because polling never refreshed the inventory.
   * Drop it, refresh, and keep going.
   */
  const readOnce = useCallback(async (consoleId?: string) => {
    // Defaults to the selection, but a caller that just sent a command knows
    // which console it wrote to and passes it explicitly -- so a switch racing
    // the read cannot append one console's output to another's buffer.
    const target = consoleId ?? selected
    if (target === undefined) return
    try {
      const result = await hub.read(sessionId, target, buffersRef.current.get(target).cursor)
      const next = buffersRef.current.append(target, result.text, result.cursor, result.paging.active)
      if (target === selected) {
        // Only the visible console drives React state; the others keep
        // accumulating in the ref and are rendered the moment they are shown.
        setOutput(next.text)
        setPaging(next.paging)
        cursorRef.current = next.cursor
        // The host detects the half-close from the device's own marker, so the
        // panel only has to reflect it. Reported rather than auto-woken here:
        // the host ALREADY answers the marker when `dormantAutoWake` is on, so
        // a second Enter from the panel would be an unsolicited keystroke.
        if (typeof result.dormant === 'boolean') setDormant(result.dormant)
      }
      if (result.paging.active && result.paging.reason === 'max-pages') {
        setStatus('自动翻页达到页数上限，点击“继续翻页”接着读。')
      }
    } catch (failure) {
      if (isGone(failure)) {
        // The console ended elsewhere. Drop its buffer, clear the selection so
        // the poll stops, and re-read the inventory so the list agrees with the
        // host.
        buffersRef.current.clear(target)
        if (target === selected) {
          setSelected(undefined)
          setOutput('')
          setPaging(false)
        }
        setStatus('该控制台已结束（被关闭或已超时回收）。')
        setError(null)
        await refresh()
        return
      }
      setError(messageOf(failure))
    }
  }, [hub, sessionId, selected, refresh])

  // Read IMMEDIATELY on selection change, then let the interval take over.
  //
  // Without this a switch to a console that has never been read shows an empty
  // pane until the next tick -- up to a full poll interval of nothing. Cached
  // consoles are already rendered by `select`, so this only fills in the gap
  // for one that is new (or that grew while the user looked elsewhere).
  useEffect(() => {
    if (selected === undefined) return
    void readOnce(selected)
    // Deliberately keyed on `selected` alone: `readOnce` changes whenever the
    // live selection does, so including it would re-run this on every tick and
    // turn the poll into a double read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  // The read loop. `visible` is part of the condition, not just a dependency:
  // a hidden tab stays mounted in this shell and must not keep polling.
  useEffect(() => {
    if (!shouldPoll({ visible, consoleId: selected })) return undefined
    const timer = setInterval(() => {
      // Read the LIVE selection, not the one captured when the interval was
      // built: `readOnce` defaults to it, so a switch is picked up on the next
      // tick without rebuilding the interval.
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
    if (selected === undefined) return
    // `''` is a legitimate write -- it is the bare Enter that wakes a dormant
    // console -- so nothing is filtered here. Whitespace is deliberately NOT
    // trimmed either: a single space is the pager's next-page key, and sending
    // something other than what was asked for is worse than sending a blank.
    setBusy(true)
    setError(null)
    try {
      await hub.send(sessionId, selected, text, {
        ...confirmationToken === undefined ? {} : { confirmToken: confirmationToken },
      })
      setDraft('')
      setPending(undefined)
      await readOnce(selected)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, selected, readOnce])

  /** Submit the draft: fence it first, then either write or ask. */
  const submit = useCallback(async () => {
    if (selected === undefined) return
    // NOT trimmed and not required to be non-empty. An empty box means "press
    // Enter", and a box holding only spaces means "send those spaces" -- which
    // is what a `--More--` prompt wants. Trimming here silently rewrote the
    // user's input, and refusing an empty draft made the panel unable to wake a
    // dormant console at all.
    const text = draft
    setBusy(true)
    setError(null)
    try {
      const fenced = await hub.fence(sessionId, selected, text)
      if (fenced.risk === 'denied') {
        // A `deny` rule, and the one place the panel must not offer a way
        // forward. There is no token to replay, so showing the usual
        // confirmation card would present a button the host would refuse --
        // and the `confirmHighRisk` pref below must NOT be able to skip it.
        setPending(undefined)
        setError(`已被规则禁止发送：${fenced.reason}`)
        return
      }
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
      await readOnce(selected)
    } catch (failure) {
      setError(messageOf(failure))
    }
  }, [hub, sessionId, selected, readOnce])

  /**
   * Press Enter once on the selected console.
   *
   * The console server tears its session down after a long silence and then
   * prints nothing at all, so this is the only thing that makes a dormant
   * console speak again. It is a bare Enter, never a command: nothing is run.
   *
   * @param announce - whether to report the outcome in the status line. The
   *   automatic path (a detected dormancy) stays quiet, because the panel
   *   already shows the banner and the device's own output follows.
   */
  const wake = useCallback(async (announce = true) => {
    if (selected === undefined) return
    setBusy(true)
    setError(null)
    try {
      const result = await hub.wake(sessionId, selected)
      setDormant(false)
      await readOnce(selected)
      if (!announce) return
      if (result.answered) {
        setStatus('已发送回车，设备已响应。')
      } else if (result.dormant) {
        setStatus('已发送回车，但设备仍未响应；可能需要再试，或该端口被其它会话占用。')
      } else {
        setStatus('已发送回车；唤醒窗口内没有新输出。')
      }
    } catch (failure) {
      if (isGone(failure)) {
        setSelected(undefined)
        await refresh()
      } else {
        setError(messageOf(failure))
      }
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, selected, readOnce, refresh])

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

  /**
   * Empty this console's pane, and the host's copy with it.
   *
   * The host call is what makes it STICK: the local buffer could be emptied
   * without asking anyone, but the next poll would then read the host's
   * still-retained scrollback and paint it straight back. The host returns the
   * cursor that follows the dropped bytes, which is exactly where the next read
   * must resume.
   *
   * The connection is NOT touched: this discards a local record, it does not
   * close, reset or interrupt the device. Clearing a console you are watching
   * is a display decision, so nothing is sent to the hardware.
   */
  const clearOutput = useCallback(async () => {
    if (selected === undefined) return
    setBusy(true)
    setError(null)
    try {
      const result = await hub.clear(sessionId, selected)
      buffersRef.current.clear(selected)
      buffersRef.current.get(selected).cursor = result.cursor
      cursorRef.current = result.cursor
      setOutput('')
      setPaging(false)
      setStatus(`已清空本地显示（${String(result.droppedBytes)} 字节）；连接保持。`)
    } catch (failure) {
      // A console that ended elsewhere is reconciled here too, so the button
      // cannot leave a stale selection behind a permanent red banner.
      if (isGone(failure)) {
        buffersRef.current.clear(selected)
        setSelected(undefined)
        setOutput('')
        await refresh()
      } else {
        setError(messageOf(failure))
      }
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, selected, refresh])

  /**
   * Flip one HOST engine setting.
   *
   * Written through the settings API rather than kept locally: the host is what
   * enforces `wakeOnConnect`, and a purely local switch would show the new
   * value while every future connect still behaved the old way. On failure the
   * displayed defaults are re-read from the host, so the control never keeps a
   * value the engine did not accept.
   *
   * @param key - the settings field to change.
   * @param value - its new value.
   */
  const updateEngineSetting = useCallback(async (key: string, value: unknown) => {
    setBusy(true)
    setError(null)
    try {
      const result = await hub.updateSettings(sessionId, { [key]: value })
      // `settings.update` answers the same `{ revision, defaults }` shape as
      // `settings.get`. It used to answer `{ revision, settings }` while this
      // side declared `defaults` -- so `result.defaults` was `undefined`,
      // `setDefaults(undefined)` cleared the state, and the control vanished
      // until a manual refresh re-read it.
      setDefaults(result.defaults)
      setStatus(`已更新引擎设置：${key} = ${String(value)}`)
    } catch (failure) {
      setError(messageOf(failure))
      // Re-read rather than guess: the write may have been rejected, or may
      // have landed and then failed on the way back.
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [hub, sessionId, refresh])

  const current = consoles.find(row => row.consoleId === selected)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        // The HARNESS code font, not a hardcoded stack: the console shows
        // command output, so it should follow the same code face the rest of the
        // app uses -- and change with it when the user changes theme or the
        // terminal font. `--ds-font-family-code` is the token
        // `dsh-client-ui-theme` defines for exactly this.
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ padding: 8, borderBottom: '1px solid rgba(127,127,127,0.3)' }}>
        {/* The inventory lives in a dialog now: with many devices the inline
            list filled this column and squeezed the live consoles, which are the
            thing being worked with. */}
        {button('设备配置', () => setConfigOpen(true))}
        {button('刷新', () => void refresh())}
        {defaults !== undefined && (
          <label
            title="连接后先发一次回车再等待提示符。某些 console 服务器在收到按键前完全静默，开启后连接即可看到提示符。"
            style={{ marginLeft: 12, opacity: busy ? 0.6 : 1, cursor: 'pointer', fontFamily: 'var(--dsw-font-family, inherit)' }}
          >
            <input
              type="checkbox"
              checked={defaults.wakeOnConnect}
              disabled={busy}
              onChange={event => { void updateEngineSetting('wakeOnConnect', event.target.checked) }}
            />
            {' '}
            连接后自动唤醒
          </label>
        )}
        {defaults !== undefined && (
          <label
            title="设备在长时间没有收到按键后会半关闭这条会话（打印 “Vty connection is timed out. Please press ENTER.”）并从此不再输出。开启后检测到该提示会自动补一个回车；保活则在休眠发生之前就定时补回车。"
            style={{ marginLeft: 12, opacity: busy ? 0.6 : 1, cursor: 'pointer', fontFamily: 'var(--dsw-font-family, inherit)' }}
          >
            <input
              type="checkbox"
              checked={defaults.dormantAutoWake}
              disabled={busy}
              onChange={event => { void updateEngineSetting('dormantAutoWake', event.target.checked) }}
            />
            {' '}
            空闲休眠自动唤醒
          </label>
        )}
        {defaults !== undefined && (
          <label
            title="设备实测在「300 秒没有收到按键」后半关闭会话（它自己发的事件不算）。小于该值时会定时补一个回车，让设备根本不会休眠；填 0 关闭保活。保活不会被计入「有人在使用」，所以遗忘的标签页仍会被回收。"
            style={{ marginLeft: 12, opacity: busy ? 0.6 : 1, fontFamily: 'var(--dsw-font-family, inherit)' }}
          >
            {' '}
            保活（秒）：
            <input
              type="number"
              min={0}
              step={10}
              // Locally editable, committed on blur. A fully controlled input
              // re-renders from the host's value on every poll, so a half-typed
              // number would be overwritten mid-keystroke -- and writing each
              // digit as typed would set 1ms, then 12ms, then 120ms, where a 1ms
              // probe would flood the device with Enters.
              value={keepaliveDraft ?? String(Math.round(defaults.dormantProbeMs / 1000))}
              disabled={busy}
              onChange={event => { setKeepaliveDraft(event.target.value) }}
              onBlur={event => {
                const seconds = Number(event.target.value)
                setKeepaliveDraft(undefined)
                // Seconds in the UI, milliseconds in the document: an operator
                // thinks in seconds, and ignoring an unparseable entry leaves the
                // stored value alone rather than writing NaN.
                if (!Number.isFinite(seconds) || seconds < 0) return
                void updateEngineSetting('dormantProbeMs', Math.round(seconds * 1000))
              }}
              style={{ width: 70, font: 'inherit', padding: '1px 3px' }}
            />
          </label>
        )}
        {defaults !== undefined && (defaults.fenceRules ?? []).length > 0 && (
          <details style={{ marginLeft: 12, fontFamily: 'var(--dsw-font-family, inherit)' }}>
            <summary
              style={{ cursor: 'pointer', opacity: 0.8 }}
              title="高危指令规则：自上而下第一条命中的生效，都没命中才用兜底策略。规则在插件设置里编辑。"
            >
              拦截规则 ({(defaults.fenceRules ?? []).length})
            </summary>
            <ol style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {/* `?? []`: the panel must not crash on a host that does not send
                  this field. An older host, or a partial answer, would otherwise
                  take the whole tab down over a read-only summary. */}
              {(defaults.fenceRules ?? []).map(rule => (
                <li key={rule.id} style={{ marginBottom: 2 }}>
                  <code>{rule.tokens !== '' ? rule.tokens : rule.pattern}</code>
                  {' '}
                  <strong style={{ color: RULE_COLOR[rule.action] ?? 'inherit' }}>
                    {rule.action === 'deny' ? '禁止' : rule.action === 'ask' ? '需确认' : '放行'}
                  </strong>
                  {rule.note !== '' && <span style={{ opacity: 0.7 }}> · {rule.note}</span>}
                </li>
              ))}
            </ol>
            <div style={{ opacity: 0.7, marginTop: 2 }}>
              未命中任何规则时：
              {defaults.approvalMode === 'always' ? '每条命令都要确认' : '直接放行'}
            </div>
          </details>
        )}
      </div>

      <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
        <div
          style={{
            width: prefs.listWidthPx,
            flex: 'none',
            overflow: 'auto',
            // The width is a pixel preference now, so it must never be squeezed
            // by a long label inside it; the splitter owns the size.
            boxSizing: 'border-box',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid rgba(127,127,127,0.3)' }}>
            <strong>已连接 ({consoles.length})</strong>
            {consoles.length > 1 && (
              <div style={{ marginTop: 4 }}>
                {button('全部关闭', () => void hub.closeAll(sessionId, true).then(refresh).catch(f => { setError(messageOf(f)) }))}
              </div>
            )}
          </div>
          {consoles.length === 0 && (
            <p style={{ padding: 8, opacity: 0.6, fontFamily: 'var(--dsw-font-family, inherit)' }}>
              还没有已连接的控制台，先在「设备配置」里连接一台。
            </p>
          )}
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
                {row.dormant === true && (
                  // Marked in the LIST, not just in the pane: a dormant console
                  // answers nothing, so a user scanning several consoles must be
                  // able to see which one needs an Enter without selecting it.
                  <span style={{ marginLeft: 6, color: '#e6b800' }} title={row.dormantText ?? '设备已半关闭该空闲会话'}>
                    ● 休眠
                  </span>
                )}
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

        {/* The divider is draggable: 38% was wrong for both a long label and a
            wide answer, and the split is the user's to set. */}
        <Splitter
          width={prefs.listWidthPx}
          onResize={width => { uiPrefs.set({ listWidthPx: width }) }}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {error !== null && (
            <div style={{ padding: '4px 8px', background: '#5a1d1d', color: '#ffd9d9' }}>
              {error}
              {' '}
              <button type="button" onClick={() => { setError(null) }} style={{ marginLeft: 6 }}>知道了</button>
            </div>
          )}
          {status !== null && <div style={{ padding: '4px 8px', opacity: 0.75 }}>{status}</div>}

          {selected === undefined
            ? (
              <p style={{ padding: 12, opacity: 0.7, fontFamily: 'var(--dsw-font-family, inherit)' }}>
                选择一个已连接的控制台，或从「设备配置」连接一台设备。
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

                  {dormant && (
                    <div style={{ padding: 8, background: '#4a3c14', color: '#ffe9b0' }}>
                      <div>
                        设备已半关闭这条空闲会话（<code>Vty connection is timed out. Please press ENTER.</code>）。
                        此后设备不再打印任何事件，需要按一次回车重新激活。
                      </div>
                      <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                        {button('唤醒（发送回车）', () => void wake(), { disabled: busy })}
                        <span style={{ opacity: 0.75 }}>提示：直接点「发送」并留空输入框，效果相同。</span>
                      </div>
                    </div>
                  )}

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
                    {/*
                      `readOnly`, never `disabled`. Disabling a focused input makes
                      the browser BLUR it, and re-enabling never restores focus --
                      so every send left the user clicking back into the box. The
                      buttons still gate on `busy`, so a second submit cannot be
                      issued; the field merely stays focused. A JSX comment must
                      live in children position, which is why this sits here and
                      not in the attribute list above.
                    */}
                    <input
                      value={draft}
                      onChange={event => { setDraft(event.target.value) }}
                      onKeyDown={event => {
                        if (event.key === 'Enter') void submit()
                      }}
                      placeholder="输入命令后回车；留空发送则只发一个回车（用于唤醒/翻页）"
                      readOnly={busy}
                      // A stable handle for the tests. They used to find this
                      // field by its placeholder text, which meant rewording the
                      // hint broke a focus assertion that has nothing to do with
                      // the hint.
                      data-console-hub-input="command"
                      style={{ flex: 1, font: 'inherit', padding: '4px 6px' }}
                    />
                    {button('发送', () => void submit(), { disabled: busy })}
                    {/*
                      A dedicated Enter button, because "send an empty line" is
                      the recovery gesture for a dormant console and asking the
                      user to click into an empty box and press Enter hides that.
                    */}
                    {button('回车', () => void write(''), { disabled: busy, title: '只发送一个回车，不发送任何命令' })}
                    {button('读取', () => void readOnce())}
                    {button('清空', () => void clearOutput(), { title: '只清空本地显示，不断开连接' })}
                  </div>
                  <div style={{ padding: '0 8px 8px', opacity: 0.6 }}>
                    当前：{current?.label ?? selected} · cursor {cursorRef.current}
                    {current !== undefined ? ` · 空闲 ${String(Math.round(current.idleMs / 1000))}s` : ''}
                  </div>
                </>
              )}
        </div>
      </div>

      {configOpen && (
        <ConfigModal
          views={views}
          busy={busy}
          hub={hub}
          sessionId={sessionId}
          onClose={() => setConfigOpen(false)}
          onConnect={viewId => {
            // Close first: the console is what the user came for, and leaving
            // the dialog over it would hide the very output they just asked for.
            setConfigOpen(false)
            void connect({ viewId })
          }}
          onRemove={rowId => removeView(rowId)}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

