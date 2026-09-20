// @vitest-environment jsdom
/**
 * The console tab's rendered behaviour.
 *
 * The descriptor tests next door prove the tab is *registered*; these prove it
 * *renders the data it fetched*, which is a different question and the one a
 * user actually sees.
 *
 * The first case is a real defect found in the field: after a successful save
 * the panel showed an empty list, while the device had in fact been written to
 * the settings document (twice, once per save attempt). The cause was the
 * refresh reading both the saved views and the live consoles through one
 * `Promise.all`: the console registry call failing rejected the pair, so
 * `setViews` never ran. A write that persists while its read is discarded is
 * the worst of both worlds -- the user cannot tell whether the save worked.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { ConsoleHubView } from '../src/client/ConsoleHubView.tsx'
import type { ConsoleHub, ViewRow } from '../src/client/hub.ts'
import { HubApiError } from '../src/client/api.ts'
import { MIN_LIST_WIDTH_PX } from '../src/client/prefs.ts'

// The console view shares a module-level prefs singleton and mounts real DOM, so
// each case must start from a clean document; without this, one case's rendered
// tab leaks into the next and the assertions match the previous test's markup.
afterEach(cleanup)

/** One saved view as the API returns it. */
function viewRow(name: string): ViewRow {
  return {
    viewId: 'v-11111111-2222-3333-4444-555555555555',
    view: {
      name,
      host: '10.133.6.253',
      port: 10003,
      kind: 'telnet',
      encoding: '',
      user: '',
      promptPattern: '',
      pagerPattern: '',
      pagingMode: '',
      tags: [],
      notes: '',
      secretConfigured: false,
    },
  }
}

/**
 * A hub whose two list calls can fail independently.
 *
 * @param options - how each read behaves.
 * @returns the hub plus the recorded calls.
 */
function hubWith(options: {
  views?: ViewRow[]
  viewsFail?: Error
  consolesFail?: Error
} = {}): { hub: ConsoleHub, calls: string[] } {
  const calls: string[] = []
  const hub = {
    listViews: async () => {
      calls.push('listViews')
      if (options.viewsFail !== undefined) throw options.viewsFail
      return { views: options.views ?? [], defaults: {} }
    },
    listConsoles: async () => {
      calls.push('listConsoles')
      if (options.consolesFail !== undefined) throw options.consolesFail
      return { consoles: [] }
    },
    // Everything else is unused by these cases; a call is a test failure.
    upsertView: async () => { throw new Error('unexpected upsertView') },
    removeView: async () => { throw new Error('unexpected removeView') },
    setSecret: async () => { throw new Error('unexpected setSecret') },
    clearSecret: async () => { throw new Error('unexpected clearSecret') },
    secretStatus: async () => { throw new Error('unexpected secretStatus') },
    connect: async () => { throw new Error('unexpected connect') },
    fence: async () => { throw new Error('unexpected fence') },
    send: async () => { throw new Error('unexpected send') },
    read: async () => { throw new Error('unexpected read') },
    waitFor: async () => { throw new Error('unexpected waitFor') },
    control: async () => { throw new Error('unexpected control') },
    close: async () => { throw new Error('unexpected close') },
    closeAll: async () => { throw new Error('unexpected closeAll') },
    describe: async () => { throw new Error('unexpected describe') },
    settings: async () => { throw new Error('unexpected settings') },
  } as unknown as ConsoleHub
  return { hub, calls }
}

/** Render the tab with the props the shell hands it. */
function renderView(hub: ConsoleHub, visible = true): ReturnType<typeof render> {
  return render(createElement(ConsoleHubView, {
    hub,
    ctx: {} as never,
    scope: { sessionId: 'session-a' },
    tab: { id: 'dsh-console-hub:consoles', type: 'dsh-console-hub:consoles', title: '设备控制台' },
    visible,
  }))
}

/**
 * Open the device-configuration dialog.
 *
 * The inventory moved into a modal, so a test that inspects saved devices has to
 * open it first. Kept as one helper so a future change to how the dialog opens
 * touches one line rather than every case.
 *
 * @param view - the rendered console tab.
 */
function openConfig(view: ReturnType<typeof renderView>): void {
  fireEvent.click(view.getByText('设备配置'))
}

describe('the console tab renders what it fetched', () => {
  it('lists a saved device inside the configuration dialog', async () => {
    // The inventory is NOT in the column any more -- that is the point of the
    // change: with many devices the inline list squeezed the live consoles. It
    // is reachable behind one button instead.
    const { hub } = hubWith({ views: [viewRow('FW1')] })
    const view = renderView(hub)
    await waitFor(() => {
      expect(view.getByText('设备配置')).toBeTruthy()
    })
    // ...and the column does not render the device before the dialog is opened.
    expect(view.queryByText('FW1')).toBeNull()

    openConfig(view)
    await waitFor(() => {
      expect(view.getByText('FW1')).toBeTruthy()
    })
  })

  it('keeps the saved devices out of the console column', async () => {
    // Many devices must not consume the column: the count is reported, and the
    // device rows themselves are not rendered until asked for.
    const many = ['FW1', 'FW2', 'FW3', 'FW4', 'FW5', 'FW6', 'FW7', 'FW8'].map(name => viewRow(name))
    const { hub } = hubWith({ views: many })
    const view = renderView(hub)
    await waitFor(() => {
      expect(view.getByText(/已连接 \(0\)/)).toBeTruthy()
    })
    for (const row of many) expect(view.queryByText(row.view.name)).toBeNull()
  })

  it('still lists the saved devices when the live-console read fails', async () => {
    // The field bug: the console registry read failed, the pair rejected, and
    // the saved device (already on disk) never reached the screen.
    const { hub, calls } = hubWith({
      views: [viewRow('FW1')],
      consolesFail: new Error('console-hub: console registry unavailable'),
    })
    const view = renderView(hub)

    await waitFor(() => {
      expect(calls).toContain('listConsoles')
    })
    // The saved view must appear even though the OTHER read failed.
    openConfig(view)
    await waitFor(() => {
      expect(view.getByText('FW1')).toBeTruthy()
    })
  })

  it('reports the console-read failure without hiding the inventory', async () => {
    const { hub } = hubWith({
      views: [viewRow('FW1')],
      consolesFail: new Error('console registry unavailable'),
    })
    const view = renderView(hub)
    // The failure is surfaced, so it is not silently swallowed.
    await waitFor(() => {
      expect(view.getByText(/console registry unavailable/)).toBeTruthy()
    })
    // ...and the inventory is still reachable.
    openConfig(view)
    await waitFor(() => {
      expect(view.getByText('FW1')).toBeTruthy()
    })
  })

  it('surfaces a failed inventory read instead of rendering an empty list as success', async () => {
    const { hub } = hubWith({ viewsFail: new Error('inventory unreadable') })
    const view = renderView(hub)
    await waitFor(() => {
      expect(view.getByText(/inventory unreadable/)).toBeTruthy()
    })
  })

  it('does not fetch on mount when the tab is hidden, and fetches when it is shown', async () => {
    // The shell keeps hidden tabs mounted, so a background console tab must not
    // poll the host. The inventory read runs once per visibility change.
    const hidden = hubWith({ views: [viewRow('FW1')] })
    const first = renderView(hidden.hub, false)
    // A hidden tab still mounts; the fetch itself is not the assertion here --
    // only that mounting while hidden must not throw or hang.
    expect(first.container.textContent).toContain('设备配置')
  })
})

describe('a console that disappears while the panel watches it', () => {
  /**
   * One console, whose `read` fails with the host's `not-found`.
   *
   * This is what a viewer sees when the console is closed from another surface
   * (the model, another tab) or collected by the idle reaper. Reporting it as a
   * banner left a permanent red strip over a console that no longer existed, and
   * the list went on listing it because polling never refreshed the inventory.
   *
   * @returns the hub, the console row, and the call log.
   */
  function vanishingHub(): { hub: ConsoleHub, calls: string[], kill: () => void } {
    const calls: string[] = []
    const row = {
      consoleId: 'c0123456789abcdef0123456789abcdef',
      sessionId: 'session-a',
      label: 'FW1-live',
      host: '10.133.6.253',
      port: 10003,
      kind: 'telnet',
      encoding: 'utf-8',
      secure: false,
      state: 'open',
      lastError: null,
      idleMs: 0,
      createdAt: new Date().toISOString(),
    }
    let live = true
    const hub = {
      listViews: async () => ({ views: [viewRow('FW1')], defaults: {} }),
      listConsoles: async () => {
        calls.push('listConsoles')
        return { consoles: live ? [row] : [] }
      },
      connect: async () => { throw new Error('unexpected connect') },
      fence: async () => ({ risk: 'safe' as const }),
      send: async () => { throw new Error('unexpected send') },
      read: async () => {
        calls.push('read')
        if (!live) throw new HubApiError('not-found', `console "${row.consoleId}" not found for this session`, 404)
        return {
          text: '',
          cursor: 0,
          truncated: false,
          bytes: 0,
          encoding: 'utf-8',
          paging: { active: false, pagesConsumed: 0, reason: null },
        }
      },
      waitFor: async () => { throw new Error('unexpected waitFor') },
      control: async () => { throw new Error('unexpected control') },
      close: async () => { throw new Error('unexpected close') },
      closeAll: async () => { throw new Error('unexpected closeAll') },
      describe: async () => { throw new Error('unexpected describe') },
      settings: async () => { throw new Error('unexpected settings') },
      upsertView: async () => { throw new Error('unexpected upsertView') },
      removeView: async () => { throw new Error('unexpected removeView') },
      setSecret: async () => { throw new Error('unexpected setSecret') },
      clearSecret: async () => { throw new Error('unexpected clearSecret') },
      secretStatus: async () => { throw new Error('unexpected secretStatus') },
    } as unknown as ConsoleHub
    return {
      hub,
      calls,
      /** Mark the console gone, as a close or a reap would. */
      kill: () => {
        live = false
      },
    }
  }

  it('drops it and refreshes instead of showing a permanent error banner', async () => {
    const scene = vanishingHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-live')).toBeTruthy()
    })

    // Select it, which starts the poll.
    view.getByText('FW1-live').click()
    await waitFor(() => {
      expect(scene.calls).toContain('read')
    })

    // The console goes away underneath the panel.
    scene.kill()
    await waitFor(() => {
      // The inventory was re-read, so the list agrees with the host...
      expect(scene.calls.filter(entry => entry === 'listConsoles').length).toBeGreaterThan(1)
    })
    // ...and the host's message is NOT presented as an error the user must dismiss.
    await waitFor(() => {
      expect(view.queryByText(/not found for this session/)).toBeNull()
    })
  })
})

describe('switching between two consoles', () => {
  /**
   * Two consoles, each answering reads from its own script.
   *
   * The reported symptom: switching consoles flashed `(暂无输出)` and then
   * waited for the next poll tick to re-show output that had ALREADY been read,
   * because one shared string held either console's text and `select` cleared
   * it. The read cursor was reset to 0 at the same time, which is why the pane
   * had to fetch anything at all on the way back.
   *
   * @returns the hub plus what was read, per console.
   */
  function twoConsoleHub(): {
    hub: ConsoleHub
    reads: Array<{ consoleId: string, after: number }>
    closes: string[]
  } {
    const rows = [
      ['c0111111111111111111111111111111', 'FW1-live', 'one'],
      ['c0222222222222222222222222222222', 'SW-live', 'two'],
    ] as const
    const reads: Array<{ consoleId: string, after: number }> = []
    const closes: string[] = []
    const hub = {
      listViews: async () => ({ views: [], defaults: {} }),
      listConsoles: async () => ({
        consoles: rows.map(([consoleId, label]) => ({
          consoleId,
          openedBy: 'session-a',
          label,
          host: '10.133.6.253',
          port: 10003,
          kind: 'telnet',
          encoding: 'utf-8',
          secure: false,
          state: 'open',
          lastError: null,
          idleMs: 0,
          createdAt: new Date().toISOString(),
        })),
      }),
      read: async (_sessionId: string, consoleId: string, after: number) => {
        reads.push({ consoleId, after })
        // Each console emits its own first chunk, then nothing: a second read at
        // the same cursor must return no text, exactly like a real device.
        const text = after === 0 ? `output-from-${consoleId.slice(2, 3)}` : ''
        return {
          text,
          cursor: after === 0 ? text.length : after,
          truncated: false,
          bytes: text.length,
          encoding: 'utf-8',
          paging: { active: false, pagesConsumed: 0, reason: null },
        }
      },
      connect: async () => { throw new Error('unexpected connect') },
      fence: async () => ({ risk: 'safe' as const }),
      send: async () => { throw new Error('unexpected send') },
      waitFor: async () => { throw new Error('unexpected waitFor') },
      control: async () => { throw new Error('unexpected control') },
      close: async (_sessionId: string, consoleId: string) => {
        closes.push(consoleId)
        return { closed: true }
      },
      closeAll: async () => { throw new Error('unexpected closeAll') },
      describe: async () => { throw new Error('unexpected describe') },
      settings: async () => { throw new Error('unexpected settings') },
      upsertView: async () => { throw new Error('unexpected upsertView') },
      removeView: async () => { throw new Error('unexpected removeView') },
      setSecret: async () => { throw new Error('unexpected setSecret') },
      clearSecret: async () => { throw new Error('unexpected clearSecret') },
      secretStatus: async () => { throw new Error('unexpected secretStatus') },
    } as unknown as ConsoleHub
    return { hub, reads, closes }
  }

  it('selects a console from ANYWHERE on its card, not just the label line', async () => {
    // The reported bug: the click handler sat on the label line while the CARD
    // showed `cursor: pointer`, so the padding, the error line and the gaps
    // between them all looked clickable and did nothing. A card is one control,
    // so the assertion is that the card ELEMENT itself carries the handler.
    const scene = twoConsoleHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('SW-live')).toBeTruthy()
    })

    // Click the card element, not the text inside it.
    const card = view.getByText('SW-live').closest('[role="button"]')
    expect(card).not.toBeNull()
    fireEvent.click(card as HTMLElement)

    await waitFor(() => {
      expect(view.getByText(/output-from-2/)).toBeTruthy()
    })
  })

  it('selects a console with the keyboard, since the card is a control', async () => {
    // A large click target that only responds to a mouse is a regression for
    // anyone using the keyboard, so the card is focusable and takes Enter/Space.
    const scene = twoConsoleHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('SW-live')).toBeTruthy()
    })
    const card = view.getByText('SW-live').closest('[role="button"]') as HTMLElement
    expect(card.tabIndex).toBe(0)

    fireEvent.keyDown(card, { key: 'Enter' })
    await waitFor(() => {
      expect(view.getByText(/output-from-2/)).toBeTruthy()
    })

    // Space selects too, and must not scroll the panel.
    fireEvent.keyDown(card, { key: ' ' })
    await waitFor(() => {
      expect(card.getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('does NOT select a console when its own 关闭 button is clicked', async () => {
    // The card now selects, so the buttons inside it have to stop there: closing
    // a console would otherwise select it on the way out, leaving the pane
    // pointing at something that no longer exists.
    const scene = twoConsoleHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('SW-live')).toBeTruthy()
    })

    const card = view.getByText('SW-live').closest('[role="button"]') as HTMLElement
    expect(card.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(within(card).getByText('关闭'))

    await waitFor(() => {
      expect(scene.closes).toEqual(['c0222222222222222222222222222222'])
    })
    // Still not selected, and never read.
    expect(card.getAttribute('aria-pressed')).toBe('false')
    expect(scene.reads.some(entry => entry.consoleId === 'c0222222222222222222222222222222')).toBe(false)
  })

  it('shows the other console output synchronously on switch, with no empty flash', async () => {
    const scene = twoConsoleHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-live')).toBeTruthy()
    })

    // Read console one, and let its text land.
    view.getByText('FW1-live').click()
    await waitFor(() => {
      expect(view.getByText(/output-from-1/)).toBeTruthy()
    })

    // Switch to the second and read it.
    view.getByText('SW-live').click()
    await waitFor(() => {
      expect(view.getByText(/output-from-2/)).toBeTruthy()
    })

    // Now switch BACK, and assert SYNCHRONOUSLY -- the click's own render must
    // already carry console one's text.
    //
    // This is the whole assertion. `waitFor` cannot detect the reported defect:
    // the flash of `(暂无输出)` lasted only until the next read landed, so an
    // async assertion passes whether the text came from a buffer or from a
    // fresh re-fetch. Only the render immediately after the click distinguishes
    // the two, and that is what the user actually saw.
    //
    // `fireEvent` rather than the raw `.click()` the other cases use: it wraps
    // the dispatch in `act`, so React has flushed the click's update by the time
    // this returns. A raw click leaves the previous render in place, which would
    // fail here for a reason that has nothing to do with the buffer.
    fireEvent.click(view.getByText('FW1-live'))
    expect(view.getByText(/output-from-1/)).toBeTruthy()
    expect(view.queryByText('(暂无输出)')).toBeNull()

    // The cursor must not rewind: one read from 0 per console, ever. A reset to
    // 0 would re-deliver output already shown.
    const rewound = scene.reads.filter(read => read.after === 0)
    expect(rewound).toHaveLength(2)
  })

  it('shows the connect banner exactly once, not once per source', async () => {
    // The defect this pins: after connecting, the panel seeded its buffer with
    // the banner AND then read from cursor 0 -- and the host decodes that banner
    // from the very same scrollback, so the first read returned it again and the
    // device's opening words appeared TWICE. One of the two sources had to go;
    // the read is the one that survives, because it also carries anything the
    // device said after the banner.
    const calls: string[] = []
    const banner = 'BANNER-MARKER'
    const hub = {
      // A saved view, so the row's 连接 button exists to drive the connect.
      listViews: async () => ({
        views: [{
          viewId: 'v-11111111-2222-3333-4444-555555555555',
          view: {
            name: 'FW1-saved',
            host: '10.133.6.253',
            port: 10003,
            kind: 'telnet',
            encoding: '',
            user: '',
            promptPattern: '',
            pagerPattern: '',
            pagingMode: '',
            tags: [],
            notes: '',
            secretConfigured: false,
          },
        }],
        defaults: {},
      }),
      listConsoles: async () => ({
        consoles: [{
          consoleId: 'c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          sessionId: 'session-a',
          label: 'FW1-new',
          host: '10.133.6.253',
          port: 10003,
          kind: 'telnet',
          encoding: 'utf-8',
          secure: false,
          state: 'open',
          lastError: null,
          idleMs: 0,
          createdAt: new Date().toISOString(),
        }],
      }),
      // The host answers a read at 0 with the banner bytes; a later read has
      // nothing left to give.
      read: async (_sessionId: string, _consoleId: string, after: number) => {
        calls.push(`read@${String(after)}`)
        const text = after === 0 ? banner : ''
        return {
          text,
          cursor: after === 0 ? banner.length : after,
          truncated: false,
          bytes: text.length,
          encoding: 'utf-8',
          paging: { active: false, pagesConsumed: 0, reason: null },
        }
      },
      connect: async () => ({
        consoleId: 'c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        state: 'open',
        label: 'FW1-new',
        host: '10.133.6.253',
        port: 10003,
        secure: false,
        banner,
        prompt: null,
        lastError: null,
      }),
    } as unknown as ConsoleHub

    const connection = renderView(hub)
    await waitFor(() => {
      expect(connection.getByText('设备配置')).toBeTruthy()
    })
    // The saved view and its 连接 button live in the dialog now.
    openConfig(connection)
    await waitFor(() => {
      expect(connection.getByText('FW1-saved')).toBeTruthy()
    })
    fireEvent.click(connection.getByText('连接'))

    // Wait until the read has delivered its copy, then count the occurrences.
    await waitFor(() => {
      expect(calls).toContain('read@0')
    })
    await waitFor(() => {
      const occurrences = connection.container.textContent?.split(banner).length ?? 0
      // split() yields one more piece than there are occurrences.
      expect(occurrences - 1).toBe(1)
    })
  })
})

describe('the input keeps focus across a send', () => {
  /**
   * One console that answers a read, so a send can be observed end to end.
   *
   * The reported annoyance: after every command the field lost focus and had to
   * be clicked again. The cause was `disabled={busy}` on the input -- the
   * browser blurs a focused element the moment it is disabled, and re-enabling
   * never restores focus. `readOnly` keeps the buttons gated without the blur.
   *
   * @returns the hub plus the sends it saw.
   */
  function sendingHub(): { hub: ConsoleHub & { send: ConsoleHub['send'] }, sends: string[] } {
    const sends: string[] = []
    const hub = {
      listViews: async () => ({ views: [], defaults: {} }),
      listConsoles: async () => ({
        consoles: [{
          consoleId: 'c0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          sessionId: 'session-a',
          label: 'FW1-focus',
          host: '10.133.6.253',
          port: 10003,
          kind: 'telnet',
          encoding: 'utf-8',
          secure: false,
          state: 'open',
          lastError: null,
          idleMs: 0,
          createdAt: new Date().toISOString(),
        }],
      }),
      fence: async () => ({ risk: 'safe' as const }),
      send: async (_sessionId: string, _consoleId: string, text: string) => {
        sends.push(text)
        return { consoleId: 'c0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', state: 'open', written: text.length }
      },
      read: async () => ({
        text: '',
        cursor: 0,
        truncated: false,
        bytes: 0,
        encoding: 'utf-8',
        paging: { active: false, pagesConsumed: 0, reason: null },
      }),
      closeAll: async () => ({ closed: 0 }),
      clear: async () => ({ consoleId: 'c0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', cursor: 0, droppedBytes: 0 }),
    } as unknown as ConsoleHub
    return { hub, sends }
  }

  it('refuses a DENIED command and never offers a confirmation', async () => {
    // The panel's half of the hard block. A `deny` rule must not be reachable by
    // clicking through a prompt: there is no token, so the usual confirmation
    // card would present a button the host would refuse -- and with the
    // `confirmHighRisk` pref OFF the panel used to send straight through, which
    // for a deny would have been a silent bypass.
    const scene = sendingHub()
    scene.hub.fence = async () => ({ risk: 'denied' as const, reason: '被规则 "never-erase" 禁止' })

    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-focus')).toBeTruthy()
    })
    fireEvent.click(view.getByText('FW1-focus'))
    const input = await waitFor(() => {
      const node = view.container.querySelector('[data-console-hub-input="command"]')
      if (node === null) throw new Error('input not rendered')
      return node as HTMLInputElement
    })
    fireEvent.change(input, { target: { value: 'erase startup-config' } })
    fireEvent.click(view.getByText('发送'))

    await waitFor(() => {
      expect(view.getByText(/已被规则禁止发送/)).toBeTruthy()
    })
    // THE assertions: nothing was written, and no confirmation was offered.
    expect(scene.sends).toEqual([])
    expect(view.queryByText('确认发送')).toBeNull()
  })

  it('still asks before a high-risk command, and sends it only once confirmed', async () => {
    // The ask path must keep working: the deny handling above must not have
    // turned every fence into a refusal.
    const scene = sendingHub()
    scene.hub.fence = async () => ({
      risk: 'high' as const,
      confirmationToken: 'ct-1',
      reason: 'replaces the running configuration',
    })

    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-focus')).toBeTruthy()
    })
    fireEvent.click(view.getByText('FW1-focus'))
    const input = await waitFor(() => {
      const node = view.container.querySelector('[data-console-hub-input="command"]')
      if (node === null) throw new Error('input not rendered')
      return node as HTMLInputElement
    })
    fireEvent.change(input, { target: { value: 'configuration rollback replace BasicConfig' } })
    fireEvent.click(view.getByText('发送'))

    await waitFor(() => {
      expect(view.getByText('确认发送')).toBeTruthy()
    })
    // Not written yet: the token has not been replayed.
    expect(scene.sends).toEqual([])
    fireEvent.click(view.getByText('确认发送'))
    await waitFor(() => {
      expect(scene.sends).toEqual(['configuration rollback replace BasicConfig'])
    })
  })

  it('stays enabled and focused while a send is in flight', async () => {
    // The assertion has to happen DURING the busy window, not after it. Busy is
    // true only while the send is pending, and that is exactly when the old
    // `disabled={busy}` blurred the field -- an assertion taken after the send
    // resolves sees an enabled input either way and proves nothing. (Measured:
    // with `disabled={busy}` restored, an after-the-fact check still passed.)
    const scene = sendingHub()
    let releaseSend: (() => void) | undefined
    const held = new Promise<void>((resolve) => { releaseSend = resolve })
    scene.hub.send = (async (sessionId: string, consoleId: string, text: string) => {
      scene.sends.push(text)
      await held
      return { consoleId, state: 'open', written: text.length }
    }) as unknown as typeof scene.hub.send

    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-focus')).toBeTruthy()
    })
    fireEvent.click(view.getByText('FW1-focus'))

    const input = view.container.querySelector('[data-console-hub-input="command"]') as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.change(input, { target: { value: 'show version' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(scene.sends).toContain('show version')
    })

    // Now the send is pending and `busy` is true. A `disabled` field would be
    // non-editable here -- and in a real browser it would also have just lost
    // focus, which is the annoyance that was reported.
    expect(input.disabled).toBe(false)
    expect(document.activeElement).toBe(input)

    releaseSend?.()
    await waitFor(() => {
      expect(document.activeElement).toBe(input)
    })
  })
})

describe('the engine settings controls', () => {
  /**
   * A hub whose inventory carries engine defaults and whose settings update
   * answers the same shape `settings.get` does.
   *
   * The reported defect: after toggling, the control DISAPPEARED until the
   * refresh button was pressed. `settings.update` answered
   * `{ revision, settings }` while this side read `result.defaults`, so that
   * field was `undefined` and `setDefaults(undefined)` hid the control. The
   * shape of the reply is therefore the thing under test.
   *
   * @returns the hub plus the updates it saw.
   */
  function settingsHub(options: {
    dormantAutoWake?: boolean
    dormantProbeMs?: number
    dormant?: boolean
  } = {}): { hub: ConsoleHub, updates: Array<Record<string, unknown>> } {
    const updates: Array<Record<string, unknown>> = []
    let wake = false
    let autoWake = options.dormantAutoWake ?? true
    let probeMs = options.dormantProbeMs ?? 120_000
    const defaults = (): Record<string, unknown> => ({
      defaultEncoding: 'utf-8',
      defaultKind: 'telnet',
      pagingMode: 'auto-more',
      approvalMode: 'high-risk',
      highRiskPatterns: [],
      fenceRules: [
        { id: 'config-rollback', action: 'ask', tokens: 'configuration rollback', pattern: '', note: 'replaces the running configuration' },
        { id: 'restart', action: 'ask', tokens: 'reboot|restart|reload', pattern: '', note: 'restarts the device' },
      ],
      promptPattern: '.',
      pagerPattern: '--more--',
      dormantPattern: 'please press enter',
      dormantAutoWake: autoWake,
      dormantProbeMs: probeMs,
      wakeOnConnect: wake,
      connectTimeoutMs: 8000,
      readTimeoutMs: 15000,
      idleTimeoutMs: 600000,
      maxConsoles: 16,
      outputLimitBytes: 65536,
      scrollbackLimitBytes: 262144,
      pagingMaxPages: 50,
      pagingQuietMs: 120,
      agentConsoleTools: true,
    })
    const hub = {
      listViews: async () => ({ views: [], defaults: defaults() }),
      listConsoles: async () => ({ consoles: [] }),
      updateSettings: async (_sessionId: string, patch: Record<string, unknown>) => {
        updates.push(patch)
        if (typeof patch.wakeOnConnect === 'boolean') wake = patch.wakeOnConnect
        if (typeof patch.dormantAutoWake === 'boolean') autoWake = patch.dormantAutoWake
        if (typeof patch.dormantProbeMs === 'number') probeMs = patch.dormantProbeMs
        // Exactly what the host answers: the section AND the derived defaults.
        return { revision: 2, settings: {}, defaults: defaults() }
      },
      closeAll: async () => ({ closed: 0 }),
    } as unknown as ConsoleHub
    return { hub, updates }
  }

  it('keeps the wake switch visible after a toggle, showing the new value', async () => {
    const scene = settingsHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByLabelText('连接后自动唤醒')).toBeTruthy()
    })

    const toggle = view.getByLabelText('连接后自动唤醒') as HTMLInputElement
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(scene.updates).toEqual([{ wakeOnConnect: true }])
    })
    // THE assertion: the control is STILL THERE and shows the new state with no
    // refresh. Reading a missing field cleared it and it vanished until the
    // refresh button re-read the inventory.
    await waitFor(() => {
      expect((view.getByLabelText('连接后自动唤醒') as HTMLInputElement).checked).toBe(true)
    })
  })

  it('survives a second toggle, so the control is not a one-shot', async () => {
    const scene = settingsHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByLabelText('连接后自动唤醒')).toBeTruthy()
    })

    fireEvent.click(view.getByLabelText('连接后自动唤醒'))
    await waitFor(() => {
      expect((view.getByLabelText('连接后自动唤醒') as HTMLInputElement).checked).toBe(true)
    })
    // Turning it back off must work from the same control.
    fireEvent.click(view.getByLabelText('连接后自动唤醒'))
    await waitFor(() => {
      expect((view.getByLabelText('连接后自动唤醒') as HTMLInputElement).checked).toBe(false)
    })
    expect(scene.updates).toEqual([{ wakeOnConnect: true }, { wakeOnConnect: false }])
  })

  it('writes the dormancy auto-wake toggle through to the host', async () => {
    const scene = settingsHub({ dormantAutoWake: true })
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByLabelText('空闲休眠自动唤醒')).toBeTruthy()
    })
    fireEvent.click(view.getByLabelText('空闲休眠自动唤醒'))
    await waitFor(() => {
      expect(scene.updates).toEqual([{ dormantAutoWake: false }])
    })
    // The control stays and reflects the new value: this is the same
    // `setDefaults(undefined)` failure mode the wake switch already had.
    expect((view.getByLabelText('空闲休眠自动唤醒') as HTMLInputElement).checked).toBe(false)
  })

  it('says the keepalive is stopped while the master switch is off, and keeps its name', async () => {
    // The two settings are ONE checkbox in the panel: unchecking 空闲休眠自动唤醒
    // stops every automatic Enter, keepalive included. The seconds box keeps
    // displaying its stored value though -- because that value is PRESERVED and
    // resumes the keepalive when the box is re-checked -- so the pairing needs a
    // note or it reads as "the keepalive is still 120s", which is precisely the
    // confusion that produced the bug report.
    const scene = settingsHub({ dormantAutoWake: true, dormantProbeMs: 120_000 })
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByLabelText('空闲休眠自动唤醒')).toBeTruthy()
    })
    // Nothing is claimed while the switch is on.
    expect(view.container.querySelector('[data-console-hub-keepalive-note]')).toBeNull()

    fireEvent.click(view.getByLabelText('空闲休眠自动唤醒'))
    await waitFor(() => {
      expect((view.getByLabelText('空闲休眠自动唤醒') as HTMLInputElement).checked).toBe(false)
    })
    // The note appears, and the seconds box still shows its retained value.
    expect(view.container.querySelector('[data-console-hub-keepalive-note]')).not.toBeNull()
    expect(view.getByDisplayValue('120')).toBeTruthy()
    // And the checkbox is STILL found by its own name: the note must live
    // outside the `<label>`, because text inside one becomes part of the
    // control's accessible name.
    expect(view.getByLabelText('空闲休眠自动唤醒')).toBeTruthy()
  })

  it('edits the keepalive window in SECONDS and writes milliseconds', async () => {
    // The document field is a millisecond count, but an operator thinks in
    // seconds. Converting at the boundary is what keeps the control honest:
    // showing "120000" in the box would be a number nobody can act on.
    const scene = settingsHub({ dormantProbeMs: 120_000 })
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByDisplayValue('120')).toBeTruthy()
    })

    // Committed on blur, not per keystroke: writing every digit as it is typed
    // would set 1ms then 12ms then 120ms, and a 1ms probe would flood the device.
    const box = view.getByDisplayValue('120') as HTMLInputElement
    fireEvent.change(box, { target: { value: '45' } })
    expect(scene.updates).toEqual([])
    fireEvent.blur(box)
    await waitFor(() => {
      expect(scene.updates).toEqual([{ dormantProbeMs: 45_000 }])
    })
  })

  it('allows disabling the keepalive with 0', async () => {
    const scene = settingsHub({ dormantProbeMs: 120_000 })
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByDisplayValue('120')).toBeTruthy()
    })
    const box = view.getByDisplayValue('120') as HTMLInputElement
    fireEvent.change(box, { target: { value: '0' } })
    fireEvent.blur(box)
    await waitFor(() => {
      expect(scene.updates).toEqual([{ dormantProbeMs: 0 }])
    })
  })

  it('keeps the fence rules OUT of the console column', async () => {
    // The rules used to be listed here as a read-only disclosure. They now live
    // in the side card's settings popup, next to the other preferences, where
    // they can actually be EDITED -- one place, not two. This asserts the tab did
    // not keep a second copy, which is the duplication the descriptor's row list
    // and custom panel already caused once.
    const scene = settingsHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByLabelText('连接后自动唤醒')).toBeTruthy()
    })
    expect(view.container.textContent).not.toContain('拦截规则')
  })
})

describe('the dormancy banner', () => {
  /** A hub with one open console whose dormancy is settable. */
  function dormantHub(): {
    hub: ConsoleHub
    wakes: number
    setDormant(value: boolean): void
  } {
    const state = { dormant: true }
    const counter = { wakes: 0 }
    const row = (): Record<string, unknown> => ({
      consoleId: 'c0ddddddddddddddddddddddddddddddd',
      sessionId: 'session-a',
      label: 'FW1-dormant',
      host: '10.133.6.253',
      port: 10003,
      kind: 'telnet',
      encoding: 'utf-8',
      secure: false,
      state: 'open',
      lastError: null,
      idleMs: 0,
      createdAt: new Date().toISOString(),
      dormant: state.dormant,
      dormantText: state.dormant ? 'Vty connection is timed out. Please press ENTER.' : null,
    })
    const hub = {
      listViews: async () => ({ views: [], defaults: { dormantAutoWake: true, dormantProbeMs: 120_000 } }),
      listConsoles: async () => ({ consoles: [row()] }),
      read: async () => ({
        text: '',
        cursor: 0,
        truncated: false,
        bytes: 0,
        encoding: 'utf-8',
        paging: { active: false, pagesConsumed: 0, reason: null },
        dormant: state.dormant,
        ...state.dormant ? { dormantText: 'Vty connection is timed out. Please press ENTER.' } : {},
      }),
      wake: async () => {
        counter.wakes += 1
        state.dormant = false
        return { consoleId: 'c0ddddddddddddddddddddddddddddddd', answered: true, dormant: false, dormantText: null }
      },
      describe: async () => ({ entry: row(), state: {}, banner: '' }),
      closeAll: async () => ({ closed: 0 }),
    } as unknown as ConsoleHub
    return {
      hub,
      get wakes() { return counter.wakes },
      setDormant(value: boolean) { state.dormant = value },
    } as unknown as { hub: ConsoleHub, wakes: number, setDormant(value: boolean): void }
  }

  it('shows the mark in the list and the banner in the pane', async () => {
    const scene = dormantHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-dormant')).toBeTruthy()
    })
    // The LIST mark matters because a dormant console answers nothing: a user
    // scanning several consoles must see which one needs an Enter without
    // clicking through each of them.
    expect(view.getByText('● 休眠')).toBeTruthy()

    fireEvent.click(view.getByText('FW1-dormant'))
    await waitFor(() => {
      expect(view.getByText('唤醒（发送回车）')).toBeTruthy()
    })
    // The device's own words are shown, not a paraphrase: they are what tells a
    // user this is an idle timeout rather than a broken link.
    expect(view.getByText(/Vty connection is timed out/)).toBeTruthy()
  })

  it('wakes through the button and clears the banner', async () => {
    const scene = dormantHub()
    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('● 休眠')).toBeTruthy()
    })
    fireEvent.click(view.getByText('FW1-dormant'))
    await waitFor(() => {
      expect(view.getByText('唤醒（发送回车）')).toBeTruthy()
    })
    fireEvent.click(view.getByText('唤醒（发送回车）'))
    await waitFor(() => {
      expect(scene.wakes).toBe(1)
    })
    // The banner goes away once the host says the console is live again -- the
    // panel must not keep showing a dormancy the host has cleared.
    await waitFor(() => {
      expect(view.queryByText('唤醒（发送回车）')).toBeNull()
    })
  })

  it('sends an EMPTY line when the draft is empty, instead of refusing', async () => {
    // The reported requirement: an empty box must send one Enter. Before this,
    // `submit` trimmed the draft and returned early on an empty result, so the
    // panel could not perform the very recovery gesture it was showing a button
    // for.
    const sends: Array<{ text: string, submit?: boolean }> = []
    const scene = dormantHub()
    scene.hub.fence = async () => ({ risk: 'safe' })
    scene.hub.send = (async (_s: string, _c: string, text: string, options?: { submit?: boolean }) => {
      sends.push({ text, ...options === undefined ? {} : { submit: options.submit } })
      return { consoleId: 'c0ddddddddddddddddddddddddddddddd', state: 'open', written: 1 }
    }) as unknown as ConsoleHub['send']

    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-dormant')).toBeTruthy()
    })
    fireEvent.click(view.getByText('FW1-dormant'))
    await waitFor(() => {
      expect(view.container.querySelector('[data-console-hub-input="command"]')).not.toBeNull()
    })

    // The draft is empty (never touched). Clicking 发送 must send ''.
    fireEvent.click(view.getByText('发送'))
    await waitFor(() => {
      expect(sends).toEqual([{ text: '' }])
    })
  })

  it('does NOT trim a whitespace-only draft', async () => {
    // A single space is a pager's next-page key. Trimming it would send an empty
    // line instead, silently paging nowhere.
    const sends: string[] = []
    const scene = dormantHub()
    scene.hub.fence = async () => ({ risk: 'safe' })
    scene.hub.send = (async (_s: string, _c: string, text: string) => {
      sends.push(text)
      return { consoleId: 'c0ddddddddddddddddddddddddddddddd', state: 'open', written: 1 }
    }) as unknown as ConsoleHub['send']

    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-dormant')).toBeTruthy()
    })
    fireEvent.click(view.getByText('FW1-dormant'))
    const input = await waitFor(() => {
      const node = view.container.querySelector('[data-console-hub-input="command"]')
      if (node === null) throw new Error('input not rendered')
      return node as HTMLInputElement
    })
    fireEvent.change(input, { target: { value: ' ' } })
    fireEvent.click(view.getByText('发送'))
    await waitFor(() => {
      expect(sends).toEqual([' '])
    })
  })

  it('offers a dedicated Enter button that sends exactly one CR', async () => {
    const sends: string[] = []
    const scene = dormantHub()
    scene.hub.fence = async () => ({ risk: 'safe' })
    scene.hub.send = (async (_s: string, _c: string, text: string) => {
      sends.push(text)
      return { consoleId: 'c0ddddddddddddddddddddddddddddddd', state: 'open', written: 1 }
    }) as unknown as ConsoleHub['send']

    const view = renderView(scene.hub)
    await waitFor(() => {
      expect(view.getByText('FW1-dormant')).toBeTruthy()
    })
    fireEvent.click(view.getByText('FW1-dormant'))
    await waitFor(() => {
      expect(view.getByText('回车')).toBeTruthy()
    })
    fireEvent.click(view.getByText('回车'))
    await waitFor(() => {
      expect(sends).toEqual([''])
    })
  })
})

describe('the clear button', () => {
  it('asks the host to clear and empties the pane', async () => {
    const calls: string[] = []
    const hub = {
      listViews: async () => ({ views: [], defaults: {} }),
      listConsoles: async () => ({
        consoles: [{
          consoleId: 'c0ccccccccccccccccccccccccccccccc',
          sessionId: 'session-a',
          label: 'FW1-clear',
          host: '10.133.6.253',
          port: 10003,
          kind: 'telnet',
          encoding: 'utf-8',
          secure: false,
          state: 'open',
          lastError: null,
          idleMs: 0,
          createdAt: new Date().toISOString(),
        }],
      }),
      read: async () => {
        calls.push('read')
        return {
          text: 'NOISE-TO-CLEAR',
          cursor: 14,
          truncated: false,
          bytes: 14,
          encoding: 'utf-8',
          paging: { active: false, pagesConsumed: 0, reason: null },
        }
      },
      clear: async (_sessionId: string, consoleId: string) => {
        calls.push('clear')
        // The host reports the cursor that follows the dropped bytes.
        return { consoleId, cursor: 14, droppedBytes: 14 }
      },
      closeAll: async () => ({ closed: 0 }),
    } as unknown as ConsoleHub

    const view = renderView(hub)
    await waitFor(() => {
      expect(view.getByText('FW1-clear')).toBeTruthy()
    })
    view.getByText('FW1-clear').click()
    await waitFor(() => {
      expect(view.getByText(/NOISE-TO-CLEAR/)).toBeTruthy()
    })

    fireEvent.click(view.getByText('清空'))
    await waitFor(() => {
      expect(calls).toContain('clear')
    })
    // The pane is empty again -- and the button is a real host call, not a
    // local-only clear that the next poll would repaint from the host's copy.
    await waitFor(() => {
      expect(view.queryByText(/NOISE-TO-CLEAR/)).toBeNull()
    })
  })
})

describe('the device configuration dialog', () => {
  /** A hub with one saved device, recording every call it receives. */
  function configHub(): { hub: ConsoleHub, calls: string[] } {
    const calls: string[] = []
    const hub = {
      listViews: async () => ({ views: [viewRow('FW1')], defaults: {} }),
      listConsoles: async () => ({ consoles: [] }),
      removeView: async (_sessionId: string, viewId: string) => {
        calls.push(`remove:${viewId}`)
        return { removed: true, secretRemoved: false }
      },
      connect: async (_sessionId: string, input: { viewId?: string }) => {
        calls.push(`connect:${String(input.viewId)}`)
        return {
          consoleId: 'c0ddddddddddddddddddddddddddddddd',
          state: 'open',
          label: 'FW1',
          host: '10.133.6.253',
          port: 10003,
          secure: false,
          banner: '',
          prompt: null,
          lastError: null,
        }
      },
      closeAll: async () => ({ closed: 0 }),
      fence: async () => ({ risk: 'safe' as const }),
      read: async () => ({
        text: '',
        cursor: 0,
        truncated: false,
        bytes: 0,
        encoding: 'utf-8',
        paging: { active: false, pagesConsumed: 0, reason: null },
      }),
    } as unknown as ConsoleHub
    return { hub, calls }
  }

  it('opens from the button and renders through a portal, not inside the column', async () => {
    const { hub } = configHub()
    const view = renderView(hub)
    await waitFor(() => { expect(view.getByText('设备配置')).toBeTruthy() })
    openConfig(view)

    // The dialog is portalled onto document.body: the tab is mounted inside the
    // sidebar's own stacking context, where an absolutely positioned panel would
    // be clipped by the sidebar's overflow instead of covering it.
    await waitFor(() => {
      expect(document.body.querySelector('[data-console-hub-modal="config"]')).not.toBeNull()
    })
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    // It is NOT inside the tab's own container.
    expect(view.container.querySelector('[data-console-hub-modal="config"]')).toBeNull()
  })

  it('closes on Escape and on a click outside the panel', async () => {
    const { hub } = configHub()
    const view = renderView(hub)
    await waitFor(() => { expect(view.getByText('设备配置')).toBeTruthy() })

    openConfig(view)
    await waitFor(() => {
      expect(document.body.querySelector('[data-console-hub-modal="config"]')).not.toBeNull()
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(document.body.querySelector('[data-console-hub-modal="config"]')).toBeNull()
    })

    // Re-open and dismiss by clicking the backdrop itself.
    openConfig(view)
    await waitFor(() => {
      expect(document.body.querySelector('[data-console-hub-modal="config"]')).not.toBeNull()
    })
    // Re-queried rather than reused: closing unmounted the old node, so the
    // element captured before is no longer the one on screen.
    fireEvent.click(document.body.querySelector('[data-console-hub-modal="config"]') as HTMLElement)
    await waitFor(() => {
      expect(document.body.querySelector('[data-console-hub-modal="config"]')).toBeNull()
    })
  })

  it('does not dismiss when the click is inside the panel', async () => {
    // The panel stops propagation, so working in the dialog cannot close it.
    const { hub } = configHub()
    const view = renderView(hub)
    await waitFor(() => { expect(view.getByText('设备配置')).toBeTruthy() })
    openConfig(view)
    const dialog = await waitFor(() => {
      const found = document.body.querySelector('[role="dialog"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    fireEvent.click(dialog)
    expect(document.body.querySelector('[data-console-hub-modal="config"]')).not.toBeNull()
  })

  it('deletes a device and keeps the dialog open', async () => {
    const { hub, calls } = configHub()
    const view = renderView(hub)
    await waitFor(() => { expect(view.getByText('设备配置')).toBeTruthy() })
    openConfig(view)
    await waitFor(() => { expect(view.getByText('FW1')).toBeTruthy() })

    fireEvent.click(view.getByText('删除'))
    await waitFor(() => {
      expect(calls.some(entry => entry.startsWith('remove:'))).toBe(true)
    })
    // Configuration is a multi-step activity; deleting one device must not
    // dismiss the dialog the user is still working in.
    expect(document.body.querySelector('[data-console-hub-modal="config"]')).not.toBeNull()
  })

  it('swaps to the form on 新建 and returns to the list on cancel', async () => {
    const { hub } = configHub()
    const view = renderView(hub)
    await waitFor(() => { expect(view.getByText('设备配置')).toBeTruthy() })
    openConfig(view)
    await waitFor(() => { expect(view.getByText('FW1')).toBeTruthy() })

    fireEvent.click(view.getByText('新建'))
    // The form replaces the list in place, so the dialog stays open across an
    // edit rather than closing and reopening.
    await waitFor(() => {
      expect(view.queryByText('FW1')).toBeNull()
    })
    await waitFor(() => {
      expect(view.getByText('取消')).toBeTruthy()
    })
    fireEvent.click(view.getByText('取消'))
    await waitFor(() => {
      expect(view.getByText('FW1')).toBeTruthy()
    })
    expect(document.body.querySelector('[data-console-hub-modal="config"]')).not.toBeNull()
  })

  it('closes the dialog when connecting, so the console is not covered', async () => {
    const { hub, calls } = configHub()
    const view = renderView(hub)
    await waitFor(() => { expect(view.getByText('设备配置')).toBeTruthy() })
    openConfig(view)
    await waitFor(() => { expect(view.getByText('FW1')).toBeTruthy() })

    fireEvent.click(view.getByText('连接'))
    await waitFor(() => {
      expect(calls.some(entry => entry.startsWith('connect:'))).toBe(true)
    })
    // The output is what the user asked for; leaving the dialog over it would
    // hide the very thing the connect produced.
    await waitFor(() => {
      expect(document.body.querySelector('[data-console-hub-modal="config"]')).toBeNull()
    })
  })
})

describe('the console tab follows the harness typography', () => {
  it('takes its font from the harness token rather than a hardcoded stack', async () => {
    // The reported request: the console should follow the harness font setting.
    // A literal `ui-monospace, monospace` stack ignores the user's choice, so
    // the root reads the token `dsh-client-ui-theme` defines for code surfaces.
    const { hub } = hubWith({})
    const view = renderView(hub)
    const root = await waitFor(() => {
      const found = view.container.firstElementChild as HTMLElement
      expect(found).toBeTruthy()
      return found
    })
    expect(root.style.fontFamily).toContain('--ds-font-family-code')
  })

  it('uses the harness UI font, not the code font, for chrome text', async () => {
    // Command output is code; labels and buttons are UI. Mixing them is what
    // makes a panel look foreign next to the rest of the app.
    const { hub } = hubWith({})
    const view = renderView(hub)
    await waitFor(() => { expect(view.getByText('设备配置')).toBeTruthy() })
    openConfig(view)
    const dialog = await waitFor(() => {
      const found = document.body.querySelector('[role="dialog"]') as HTMLElement
      expect(found).not.toBeNull()
      return found
    })
    expect(dialog.style.fontFamily).toContain('--dsw-font-family')
  })
})

describe('the resizable divider', () => {
  it('exposes an accessible separator with the current width', async () => {
    const { hub } = hubWith({})
    const view = renderView(hub)
    const separator = await waitFor(() => {
      const found = view.getByRole('separator')
      expect(found).toBeTruthy()
      return found
    })
    expect(separator.getAttribute('aria-orientation')).toBe('vertical')
    // A pointer-only control is unreachable, so it is focusable and resizable
    // from the keyboard.
    expect(separator.getAttribute('tabindex')).toBe('0')
    expect(Number(separator.getAttribute('aria-valuenow'))).toBeGreaterThan(0)
  })

  it('resizes with the arrow keys, clamped to the supported range', async () => {
    const { hub } = hubWith({})
    const view = renderView(hub)
    const separator = await waitFor(() => view.getByRole('separator'))
    const start = Number(separator.getAttribute('aria-valuenow'))

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    await waitFor(() => {
      expect(Number(view.getByRole('separator').getAttribute('aria-valuenow'))).toBeGreaterThan(start)
    })
    fireEvent.keyDown(view.getByRole('separator'), { key: 'ArrowLeft' })
    await waitFor(() => {
      expect(Number(view.getByRole('separator').getAttribute('aria-valuenow'))).toBe(start)
    })

    // The clamp is what keeps a stored or dragged width from producing an
    // unusable layout, so pushing past the minimum must stop there.
    for (let index = 0; index < 40; index += 1) {
      fireEvent.keyDown(view.getByRole('separator'), { key: 'ArrowLeft', shiftKey: true })
    }
    await waitFor(() => {
      expect(Number(view.getByRole('separator').getAttribute('aria-valuenow'))).toBe(MIN_LIST_WIDTH_PX)
    })
  })

  it('follows a pointer drag, so the split is the user to set', async () => {
    const { hub } = hubWith({})
    const view = renderView(hub)
    const separator = await waitFor(() => view.getByRole('separator'))
    const start = Number(separator.getAttribute('aria-valuenow'))

    // jsdom has no layout, so the element has no real geometry to read. Pointer
    // capture is what keeps the drag alive past the handle, and jsdom does not
    // implement it either -- so both are stubbed rather than assumed.
    const captured: number[] = []
    separator.setPointerCapture = (id: number) => { captured.push(id) }
    separator.releasePointerCapture = () => {}

    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 100 })
    expect(captured).toEqual([1])
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 160 })
    await waitFor(() => {
      expect(Number(view.getByRole('separator').getAttribute('aria-valuenow'))).toBe(start + 60)
    })
    fireEvent.pointerUp(separator, { pointerId: 1 })
    // After release the drag is over: a further move must not keep resizing.
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 400 })
    expect(Number(view.getByRole('separator').getAttribute('aria-valuenow'))).toBe(start + 60)
  })
})
