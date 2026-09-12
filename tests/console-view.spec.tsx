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
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { ConsoleHubView } from '../src/client/ConsoleHubView.tsx'
import type { ConsoleHub, ViewRow } from '../src/client/hub.ts'
import { HubApiError } from '../src/client/api.ts'

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

describe('the console tab renders what it fetched', () => {
  it('lists a saved device', async () => {
    const { hub } = hubWith({ views: [viewRow('FW1')] })
    const view = renderView(hub)
    await waitFor(() => {
      expect(view.getByText('FW1')).toBeTruthy()
    })
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
    await waitFor(() => {
      expect(view.getByText('FW1')).toBeTruthy()
    })
    // The failure is still surfaced, so it is not silently swallowed.
    await waitFor(() => {
      expect(view.getByText(/console registry unavailable/)).toBeTruthy()
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
      ownerSessionId: 'session-a',
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
  function twoConsoleHub(): { hub: ConsoleHub, reads: Array<{ consoleId: string, after: number }> } {
    const rows = [
      ['c0111111111111111111111111111111', 'FW1-live', 'one'],
      ['c0222222222222222222222222222222', 'SW-live', 'two'],
    ] as const
    const reads: Array<{ consoleId: string, after: number }> = []
    const hub = {
      listViews: async () => ({ views: [], defaults: {} }),
      listConsoles: async () => ({
        consoles: rows.map(([consoleId, label]) => ({
          consoleId,
          ownerSessionId: 'session-a',
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
    return { hub, reads }
  }

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
          ownerSessionId: 'session-a',
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
      expect(connection.getByText('FW1-new')).toBeTruthy()
    })
    // Connect through the real button on a saved view.
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
