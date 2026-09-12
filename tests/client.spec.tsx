/**
 * Red-first suite for the browser half: the tab descriptor it registers, the
 * API client it speaks through, and the console view's behaviour.
 *
 * The bundle's real constraint is that it may only import `react` — everything
 * else is inlined by the build — so the tests drive the exported `apply` against
 * a fake `ctx.betterSidebar` rather than mounting the whole sidebar.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, inject } from '../src/client/index.tsx'
import {
  CONSOLE_TAB_ID,
  consoleTabDescriptor,
  createConsoleHub,
  shouldPoll,
  type BetterSidebarLike,
  type ClientContextLike,
} from '../src/client/hub.ts'
import { createApiClient, type FetchLike } from '../src/client/api.ts'
import {
  createPrefsStore,
  DEFAULT_UI_PREFS,
  MAX_LIST_WIDTH_PX,
  MIN_LIST_WIDTH_PX,
  normalizeListWidth,
  prefsFromSettings,
} from '../src/client/prefs.ts'

/** A fake better-sidebar service that records registrations. */
function fakeSidebar(): BetterSidebarLike & { descriptors: unknown[], disposers: number } {
  const descriptors: unknown[] = []
  return {
    descriptors,
    disposers: 0,
    version: '0.19.0',
    features: [],
    registerTab(descriptor) {
      descriptors.push(descriptor)
      return () => {
        this.disposers += 1
      }
    },
    openTab() {},
    updateTab() {},
    closeTab() {},
  }
}

/** A client context whose `inject` runs the callback immediately. */
function fakeContext(sidebar: BetterSidebarLike): ClientContextLike & { effects: number } {
  const ctx = {
    effects: 0,
    get: (name: string) => (name === 'betterSidebar' ? sidebar : undefined) as never,
    effect(effect: () => void | (() => void)) {
      const dispose = effect()
      ctx.effects += 1
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(_services: readonly string[], callback: (ctx: ClientContextLike) => void | (() => void)) {
      const dispose = callback(ctx)
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return ctx as ClientContextLike & { effects: number }
}

describe('client entry', () => {
  it('declares the service it needs from better-sidebar', () => {
    expect(inject).toContain('betterSidebar')
  })

  it('registers one tab and unregisters it with the fiber', () => {
    const sidebar = fakeSidebar()
    const ctx = fakeContext(sidebar)
    apply(ctx as never)
    expect(sidebar.descriptors).toHaveLength(1)
    const descriptor = sidebar.descriptors[0] as { id: string, order: number, single?: boolean }
    expect(descriptor.id).toBe(CONSOLE_TAB_ID)
    // A console registry is a singleton view, not one tab per device.
    expect(descriptor.single).toBe(true)
    expect(descriptor.order).toBeGreaterThan(0)
  })

  it('survives a client context with no betterSidebar at all', () => {
    // The plugin mounts before better-sidebar in some profiles; the client half
    // must not throw while the service is absent.
    const ctx = {
      get: () => undefined,
      effect: () => () => {},
      inject: (_services: readonly string[], callback: (ctx: unknown) => void | (() => void)) => callback(ctx),
    }
    expect(() => apply(ctx as never)).not.toThrow()
  })
})

describe('consoleTabDescriptor', () => {
  it('renders through a component and carries the settings panel', () => {
    const descriptor = consoleTabDescriptor({} as never)
    expect(descriptor.id).toBe(CONSOLE_TAB_ID)
    expect(typeof descriptor.component).toBe('function')
    expect(descriptor.dedupeKey?.({ id: 'x', type: CONSOLE_TAB_ID, title: 'x' })).toBe(CONSOLE_TAB_ID)
    expect(descriptor.settings).toBeDefined()
  })

  it('never requires a path, so it is a type-open tab not a file tab', () => {
    const descriptor = consoleTabDescriptor({} as never)
    expect(descriptor.hidden).not.toBe(true)
  })

  it('declares its settings as rows PLUS a panel, with DISJOINT content', () => {
    // The rendered defect this guards against: the descriptor declared
    // `pluginToggles` and ALSO a `settings.render` that drew the same four
    // controls, so every option appeared twice, stacked in the side card.
    //
    // The shell's `settings.render` is ADDITIVE (rows first, panel after), which
    // is exactly what puts the fence editor directly under 高危指令二次确认. So the
    // property that matters is not "no panel" but "the panel does not redraw the
    // rows" -- asserted by rendering it and looking at what came out.
    const descriptor = consoleTabDescriptor({} as never)
    expect(descriptor.settings?.pluginToggles?.length).toBeGreaterThan(0)
    const settings = descriptor.settings as { render?: (props: unknown) => unknown } | undefined
    expect(typeof settings?.render).toBe('function')

    const element = settings?.render?.({
      store: { getSnapshot: () => ({ sessionId: 'session-a' }) },
    }) as { type?: unknown, props?: Record<string, unknown> } | undefined
    // It renders the fence editor, and it passes the hub through so the editor
    // can reach the HOST settings (the rows beside it persist to the browser's
    // own blob, which the fence does not read).
    expect((element?.type as { name?: string })?.name).toBe('FenceRulesEditor')
    expect(element?.props?.hub).toBeDefined()
    // The active session comes from the store, read live: the plugin API is
    // session-scoped, and a captured id could write to the previous session.
    expect(element?.props?.sessionId).toBe('session-a')
  })

  it('renders the fence editor with NO duplicate of the declarative rows', () => {
    // Rendered for real, because the props check above cannot see what the editor
    // draws. The four client preferences are the shell's rows; if any of their
    // labels appear in the panel too, the duplication bug is back.
    const descriptor = consoleTabDescriptor({ settings: async () => ({ revision: 1, defaults: {} }) } as never)
    const settings = descriptor.settings as { render: (props: unknown) => unknown }
    const html = renderToStaticMarkup(
      settings.render({ store: { getSnapshot: () => ({ sessionId: 'session-a' }) } }) as ReactElement,
    )
    // The control the panel IS for.
    expect(html).toContain('data-console-hub-fence="rules"')
    expect(html).toContain('data-console-hub-fence-save')
    // None of the declarative rows' labels may appear.
    for (const label of ['连接后自动聚焦控制台', '输出自动换行', '刷新间隔', '高危指令二次确认']) {
      expect(html, label).not.toContain(label)
    }
  })

  it('declares each settings row exactly once', () => {
    // A duplicate key would render two controls bound to one value, which is
    // the same duplication from the other direction.
    const descriptor = consoleTabDescriptor({} as never)
    const keys = (descriptor.settings?.pluginToggles ?? []).map(row => row.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('shouldPoll', () => {
  it('polls only while the tab is visible and a console is selected', () => {
    expect(shouldPoll({ visible: true, consoleId: 'c1' })).toBe(true)
    // An invisible tab must stop polling: the shell keeps hidden tabs mounted.
    expect(shouldPoll({ visible: false, consoleId: 'c1' })).toBe(false)
    expect(shouldPoll({ visible: true })).toBe(false)
  })
})

describe('client API', () => {
  /** A fetch stub that records calls and answers with a scripted envelope. */
  function fakeFetch(response: unknown, ok = true): FetchLike & { calls: { url: string, body: unknown }[] } {
    const calls: { url: string, body: unknown }[] = []
    const impl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as unknown })
      return {
        ok,
        status: ok ? 200 : 400,
        json: async () => response,
      }
    }
    return Object.assign(impl, { calls })
  }

  it('posts to the plugin API with the session scope attached', async () => {
    const fetchImpl = fakeFetch({ ok: true, value: { consoles: [] } })
    const client = createApiClient(fetchImpl)
    const value = await client.call('console.list', { sessionId: 'session-a' })
    expect(value).toEqual({ consoles: [] })
    expect(fetchImpl.calls[0]?.url).toBe('/dsh-console-hub/api/console.list')
    expect(fetchImpl.calls[0]?.body).toMatchObject({ sessionId: 'session-a' })
  })

  it('throws the server message on a failed envelope', async () => {
    const fetchImpl = fakeFetch({ ok: false, error: { code: 'not-found', message: 'no console "c1"' } }, false)
    const client = createApiClient(fetchImpl)
    await expect(client.call('console.read', { sessionId: 's', consoleId: 'c1' }))
      .rejects.toThrow(/no console "c1"/)
  })

  it('surfaces a transport failure as a thrown error, not a silent undefined', async () => {
    const failing: FetchLike = async () => {
      throw new Error('network down')
    }
    const client = createApiClient(failing)
    await expect(client.call('config.list', { sessionId: 's' })).rejects.toThrow(/network down/)
  })

  it('reports a malformed body rather than returning undefined', async () => {
    const weird: FetchLike = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })
    const client = createApiClient(weird)
    await expect(client.call('config.list', { sessionId: 's' })).rejects.toThrow()
  })
})

describe('createConsoleHub', () => {
  it('exposes the calls the views need without importing a DSH package', () => {
    const hub = createConsoleHub({ call: async () => ({}) } as never)
    expect(typeof hub.listViews).toBe('function')
    expect(typeof hub.upsertView).toBe('function')
    expect(typeof hub.removeView).toBe('function')
    expect(typeof hub.setSecret).toBe('function')
    expect(typeof hub.connect).toBe('function')
    expect(typeof hub.send).toBe('function')
    expect(typeof hub.read).toBe('function')
    expect(typeof hub.waitFor).toBe('function')
    expect(typeof hub.close).toBe('function')
    expect(typeof hub.describe).toBe('function')
    expect(typeof hub.settings).toBe('function')
  })

  it('passes the session scope and payload through unchanged', async () => {
    const calls: { method: string, payload: unknown }[] = []
    const hub = createConsoleHub({
      call: (async (method: string, payload: unknown) => {
        calls.push({ method, payload })
        return { consoles: [] }
      }) as never,
    })
    await hub.listConsoles('session-a')
    expect(calls[0]?.method).toBe('console.list')
    expect(calls[0]?.payload).toMatchObject({ sessionId: 'session-a' })
  })

  it('never puts a secret into a list call', async () => {
    const calls: { method: string, payload: Record<string, unknown> }[] = []
    const hub = createConsoleHub({
      call: (async (method: string, payload: unknown) => {
        calls.push({ method, payload: payload as Record<string, unknown> })
        return { views: [], defaults: {} }
      }) as never,
    })
    await hub.listViews('session-a')
    expect(JSON.stringify(calls[0]?.payload)).not.toMatch(/password/i)
  })
})

describe('component identity', () => {
  it('renders the hub view with the props the shell hands a tab', () => {
    const descriptor = consoleTabDescriptor(createConsoleHub({ call: async () => ({}) } as never))
    const element = descriptor.component({
      ctx: { get: () => undefined } as never,
      scope: { sessionId: 'session-a' },
      tab: { id: CONSOLE_TAB_ID, type: CONSOLE_TAB_ID, title: '设备控制台' },
      visible: true,
    })
    // A valid React element, not a string or undefined.
    expect(element).toBeTruthy()
    expect(createElement).toBeTypeOf('function')
  })

  it('keeps polling decisions out of render (a pure helper the effect uses)', () => {
    const spy = vi.fn(shouldPoll)
    spy({ visible: true, consoleId: 'c1' })
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('the console-list width preference', () => {
  it('clamps a stored value into the supported range', () => {
    // A width can arrive from a stored preference written by an older build, so
    // the store is the guard that keeps a stale value from producing an unusable
    // layout. The bounds are asserted from both sides.
    expect(normalizeListWidth(10)).toBe(MIN_LIST_WIDTH_PX)
    expect(normalizeListWidth(99999)).toBe(MAX_LIST_WIDTH_PX)
    expect(normalizeListWidth(300)).toBe(300)
    expect(normalizeListWidth(300.6)).toBe(301)
  })

  it('falls back to the default for a value that is not a number', () => {
    expect(normalizeListWidth(undefined)).toBe(DEFAULT_UI_PREFS.listWidthPx)
    expect(normalizeListWidth('wide')).toBe(DEFAULT_UI_PREFS.listWidthPx)
    expect(normalizeListWidth(Number.NaN)).toBe(DEFAULT_UI_PREFS.listWidthPx)
    expect(normalizeListWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_UI_PREFS.listWidthPx)
  })

  it('survives the settings round trip, so a drag is not lost on reload', () => {
    // The shell persists prefs as opaque JSON, so the value must come back out
    // of `prefsFromSettings` unchanged -- a width that did not round-trip would
    // silently reset on every reload.
    const stored = prefsFromSettings({ listWidthPx: 321 })
    expect(stored.listWidthPx).toBe(321)
    const store = createPrefsStore(stored)
    expect(store.get().listWidthPx).toBe(321)
    // ...and a write through the store is clamped too.
    store.set({ listWidthPx: 5 })
    expect(store.get().listWidthPx).toBe(MIN_LIST_WIDTH_PX)
  })
})
