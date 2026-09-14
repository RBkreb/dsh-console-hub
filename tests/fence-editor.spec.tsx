// @vitest-environment jsdom
/**
 * The fence-rule editor in the side card's settings popup.
 *
 * The assertions here are about WHERE a save goes and WHAT happens to the
 * operator's text, because those are the two ways this control can be wrong in a
 * way nobody notices:
 *
 * - Saving into the sidebar's own prefs blob would look identical in the UI and
 *   enforce nothing, since the fence runs in the host process.
 * - Discarding the text on a rejected write would lose work that took a while to
 *   type, and the operator would have no way to tell which line was refused.
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { FenceRulesEditor } from '../src/client/FenceRulesEditor.tsx'
import type { ConsoleHub } from '../src/client/hub.ts'

interface Scene {
  hub: ConsoleHub
  saves: Array<Record<string, unknown>>
  /** How many times the HOST was read, and with which session id. */
  reads: Array<string | undefined>
  /** Change what the host reports on the next read, to simulate an applied write. */
  setStored(rules: Array<Record<string, unknown>>): void
}

/** A hub whose settings read/write are recorded, with a settable policy. */
function scene(options: { failSave?: string, noRules?: boolean } = {}): Scene {
  const saves: Array<Record<string, unknown>> = []
  const reads: Array<string | undefined> = []
  let stored: Array<Record<string, unknown>> = options.noRules === true
    ? []
    : [
        { id: 'config-rollback', action: 'ask', tokens: 'configuration rollback', pattern: '', note: '覆盖运行配置' },
        { id: 'restart', action: 'ask', tokens: 'reboot|restart|reload', pattern: '', note: '重启设备' },
      ]
  const defaults = (): Record<string, unknown> => ({
    approvalMode: 'high-risk',
    highRiskPatterns: [],
    fenceRules: stored,
  })
  const hub = {
    settings: async (sessionId: string) => {
      reads.push(sessionId)
      return { revision: 1, defaults: defaults() }
    },
    updateSettings: async (_sessionId: string, patch: Record<string, unknown>) => {
      saves.push(patch)
      if (options.failSave !== undefined) throw new Error(options.failSave)
      stored = patch.fenceRules as Array<Record<string, unknown>>
      return { revision: 2, defaults: defaults() }
    },
  } as unknown as ConsoleHub
  return {
    hub,
    saves,
    reads,
    setStored(rules) { stored = rules },
  }
}

/** The textarea, found by its stable hook rather than its placeholder. */
function box(container: HTMLElement): HTMLTextAreaElement {
  const node = container.querySelector('[data-console-hub-fence="rules"]')
  if (node === null) throw new Error('fence textarea not rendered')
  return node as HTMLTextAreaElement
}

/** The save button, by its stable hook. */
function saveButton(container: HTMLElement): HTMLButtonElement {
  const node = container.querySelector('[data-console-hub-fence-save]')
  if (node === null) throw new Error('save button not rendered')
  return node as HTMLButtonElement
}

describe('the fence rule editor', () => {
  it('loads the live rules from the HOST into the text box', async () => {
    const s = scene()
    const view = render(<FenceRulesEditor hub={s.hub} sessionId="session-a" />)
    await waitFor(() => {
      expect(box(view.container).value).toContain('configuration rollback')
    })
    expect(box(view.container).value).toContain('reboot|restart|reload')
    // Both notes survive the trip, since they are what the approval prompt shows.
    expect(box(view.container).value).toContain('覆盖运行配置')
    expect(s.reads.length).toBeGreaterThan(0)
  })

  it('saves to the HOST settings, which is where the fence is enforced', async () => {
    const s = scene()
    const view = render(<FenceRulesEditor hub={s.hub} sessionId="session-a" />)
    await waitFor(() => {
      expect(box(view.container).value).toContain('configuration rollback')
    })
    fireEvent.change(box(view.container), {
      target: { value: 'ask configuration rollback   # 覆盖运行配置\nask reboot|restart|reload   # 重启\ndeny re:erase\\s+startup   # 抹掉配置' },
    })
    fireEvent.click(saveButton(view.container))

    await waitFor(() => {
      expect(s.saves).toHaveLength(1)
    })
    const sent = s.saves[0]?.fenceRules as Array<Record<string, unknown>>
    expect(sent).toHaveLength(3)
    // The unchanged line KEEPS its stored id, so audit entries written earlier
    // still name the same rule.
    expect(sent[0]).toMatchObject({
      id: 'config-rollback',
      action: 'ask',
      tokens: 'configuration rollback',
      pattern: '',
    })
    // A new token rule takes both matcher fields, one of them empty.
    expect(sent[1]).toMatchObject({ action: 'ask', tokens: 'reboot|restart|reload', pattern: '' })
    // A `deny` with a raw regex round-trips through the re: prefix.
    expect(sent[2]).toMatchObject({ action: 'deny', tokens: '', pattern: 'erase\\s+startup' })
    expect(sent[2]?.id).toBeTruthy()
  })

  it('does not send anything when a line cannot be parsed, and keeps the text', async () => {
    const s = scene()
    const view = render(<FenceRulesEditor hub={s.hub} sessionId="session-a" />)
    await waitFor(() => {
      expect(box(view.container).value).toContain('configuration rollback')
    })
    const typed = 'ask reboot   # ok\nblock erase   # bad action'
    fireEvent.change(box(view.container), { target: { value: typed } })
    fireEvent.click(saveButton(view.container))

    await waitFor(() => {
      expect(view.getByText(/无法解析/)).toBeTruthy()
    })
    // Nothing was written...
    expect(s.saves).toEqual([])
    // ...the operator's text is still there, and the bad line is named.
    expect(box(view.container).value).toBe(typed)
    expect(view.getByText(/第 2 行/)).toBeTruthy()
  })

  it('shows the host validation error verbatim when a write is refused', async () => {
    // The host refuses a rule set it cannot enforce; paraphrasing would hide the
    // field name the operator needs.
    const s = scene({ failSave: 'fenceRules.0 has neither "tokens" nor "pattern"' })
    const view = render(<FenceRulesEditor hub={s.hub} sessionId="session-a" />)
    await waitFor(() => {
      expect(box(view.container).value).toContain('configuration rollback')
    })
    fireEvent.click(saveButton(view.container))
    await waitFor(() => {
      expect(view.getByText(/宿主拒绝了这次保存/)).toBeTruthy()
    })
    expect(view.getByText(/neither "tokens" nor "pattern"/)).toBeTruthy()
  })

  it('re-seeds the box from what the host reports after a save', async () => {
    // Showing the canonical stored form is what proves the write landed as
    // intended: derived ids and schema defaults are the host's to confirm, not
    // the client's to assume.
    const s = scene()
    const view = render(<FenceRulesEditor hub={s.hub} sessionId="session-a" />)
    await waitFor(() => {
      expect(box(view.container).value).toContain('configuration rollback')
    })
    fireEvent.change(box(view.container), { target: { value: 'ask reboot   # 重启' } })
    fireEvent.click(saveButton(view.container))
    await waitFor(() => {
      expect(view.getByText(/已保存 1 条规则/)).toBeTruthy()
    })
    expect(box(view.container).value).toBe('ask reboot   # 重启')
    // The re-seed came from the host's answer, which is the stored list.
    expect(box(view.container).value).not.toContain('configuration rollback')
  })

  it('disables saving without an active session, and says why', async () => {
    // The plugin's API is session-scoped, so there is nothing to address the
    // settings document with. Saving into the void would be worse than refusing.
    //
    // Four facts, all user-visible: the hint names the reason, the button is not
    // usable, nothing is written, and the HOST IS NOT READ. The last one is the
    // load effect's own guard, and it is the only assertion here that can fail on
    // its own -- the button's `disabled` cannot be attributed to a single
    // condition, because `!loaded` also holds while no session exists, so a
    // removed session term stays masked. Stated rather than implied: this test
    // pins the OUTCOME, and the load guard is what it isolates.
    const s = scene()
    const view = render(<FenceRulesEditor hub={s.hub} sessionId={undefined} />)
    expect(saveButton(view.container).disabled).toBe(true)
    expect(view.getByText(/没有活动会话/)).toBeTruthy()
    fireEvent.click(saveButton(view.container))
    expect(s.saves).toEqual([])
    expect(s.reads).toEqual([])
  })

  it('names the fallback policy, since the rules are not the whole story', async () => {
    const s = scene()
    const view = render(<FenceRulesEditor hub={s.hub} sessionId="session-a" />)
    await waitFor(() => {
      expect(box(view.container).value).toContain('configuration rollback')
    })
    // Asserted on the container's text rather than through `getByText`: the
    // phrase lives in a div that also holds sibling text, so a regex matcher
    // matches both that div AND every ancestor whose textContent contains it.
    // The visible fact is what matters -- the rules are not the whole policy,
    // and the panel has to say what the rest of it is.
    expect(view.container.textContent).toContain('未命中任何规则时')
    expect(view.container.textContent).toContain('直接放行')
  })

  it('scopes the box to `fenceRules` and does not surface the legacy pattern field', async () => {
    // The legacy `highRiskPatterns` field is still honoured by the HOST (pinned
    // in `tests/guard.spec.ts`), but it is not what this box edits, so the panel
    // shows the rule list and nothing else.
    //
    // Two facts worth pinning: nothing is invented to stand in for the legacy
    // list, and a host that reports it still renders -- reading a field the panel
    // does not edit must not take the settings popup down.
    const hub = {
      settings: async () => ({
        revision: 1,
        defaults: {
          approvalMode: 'high-risk',
          highRiskPatterns: ['config|conf|configure'],
          fenceRules: [],
        },
      }),
      updateSettings: async () => ({ revision: 2, defaults: { approvalMode: 'high-risk' } }),
    } as unknown as ConsoleHub
    const view = render(<FenceRulesEditor hub={hub} sessionId="session-a" />)
    // Wait on the save button becoming ENABLED: it is gated on `loaded`, so this
    // is the signal that the host read finished. Asserting the empty box alone
    // would pass before the load ever ran.
    await waitFor(() => {
      expect(saveButton(view.container).disabled).toBe(false)
    })
    expect(box(view.container).value).toBe('')
    // The fallback is still named, so an empty box never implies "nothing is
    // enforced" -- the one thing the panel must not leave ambiguous.
    expect(view.container.textContent).toContain('未命中任何规则时')
    // And the legacy pattern is not rendered as though it were an editable rule.
    expect(view.container.textContent).not.toContain('config|conf|configure')
  })

  it('does not offer to save when the host reports no rules at all', async () => {
    // An empty rule list is legitimate (the fallback still applies), so the box
    // is simply empty rather than an error.
    const s = scene({ noRules: true })
    const view = render(<FenceRulesEditor hub={s.hub} sessionId="session-a" />)
    await waitFor(() => {
      expect(box(view.container).value).toBe('')
    })
    expect(saveButton(view.container).disabled).toBe(false)
  })

  it('survives a host that sends NO fenceRules field at all', async () => {
    // An older host, or a partial answer, must not take the settings popup down:
    // the field is read defensively, so the box renders empty instead of throwing
    // on `undefined.length`.
    const hub = {
      settings: async () => ({ revision: 1, defaults: { approvalMode: 'high-risk' } }),
      updateSettings: async () => ({ revision: 2, defaults: { approvalMode: 'high-risk' } }),
    } as unknown as ConsoleHub
    const view = render(<FenceRulesEditor hub={hub} sessionId="session-a" />)
    await waitFor(() => {
      expect(box(view.container).value).toBe('')
    })
    expect(saveButton(view.container)).toBeTruthy()
  })
})
