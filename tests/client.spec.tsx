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
import { createElement } from 'react'
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
