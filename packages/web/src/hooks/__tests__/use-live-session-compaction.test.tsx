/**
 * The context meter follows a compaction the gateway reports, with no reload.
 *
 * Wires the real pieces the chat pane wires: the gateway's frames feed
 * `useLiveSession` (the streamed figure, the session record) and
 * `useQueryInvalidation` (the cached usage answer), and their outputs feed the
 * composer's meter. A compaction inside a running turn is the case that needs
 * the `session:compacted` frame: nothing else moves the figure streamed while
 * the summary ran until the turn's first reply.
 */
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayEvent, GatewayEventListener } from '@hundredfold/gateway-events'
import type { ContextUsageWire } from '@/lib/api-context-usage'
import { usageFixture } from '@/components/chat/session-status/__tests__/fixtures'

const getSession = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    getSession: (id: string, options?: unknown) => getSession(id, options),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
  },
}))
const getContextUsage = vi.fn()
vi.mock('@/lib/api-context-usage', () => ({
  contextUsageApi: { getContextUsage: (id: string) => getContextUsage(id), compactSession: vi.fn() },
}))

let listeners = new Set<GatewayEventListener>()
const subscribe = (fn: GatewayEventListener) => {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
const emit = (event: string, payload: Record<string, unknown>) => {
  act(() => { for (const fn of [...listeners]) fn({ event, payload } as GatewayEvent) })
}
vi.mock('@/hooks/use-gateway', () => ({ useGateway: () => ({ subscribe }) }))

import { useLiveSession, __clearLiveSessionSnapshotCacheForTests } from '../use-live-session'
import { useQueryInvalidation } from '../use-query-invalidation'
import { SessionStatusCluster } from '@/components/chat/session-status/session-status-cluster'

const SID = 'sess-1'
const WINDOW = 1_000_000

/** What the gateway would answer right now: the session row and the usage route agree. */
function gatewayHolds(contextTokens: number | null, status: 'idle' | 'running' = 'running') {
  getSession.mockResolvedValue({ id: SID, status, lastContextTokens: contextTokens, messages: [] })
  getContextUsage.mockResolvedValue(usageFixture({ sessionId: SID, contextTokens, contextWindow: WINDOW }) as ContextUsageWire)
}

function Pane() {
  useQueryInvalidation()
  const live = useLiveSession(SID, { subscribe })
  const session = live.session as { status?: string; lastContextTokens?: number | null } | null
  return (
    <SessionStatusCluster
      sessionId={SID}
      loading={live.loading}
      status={session?.status}
      lastContextTokens={session?.lastContextTokens}
      liveContextTokens={live.liveContextTokens}
    />
  )
}

function mountPane() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return render(<Pane />, { wrapper })
}

const ringText = () => screen.getByTestId('context-meter-text').textContent

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
})

beforeEach(() => {
  listeners = new Set()
  getSession.mockReset()
  getContextUsage.mockReset()
  __clearLiveSessionSnapshotCacheForTests()
})

/** A turn is running with the context at 182k: the meter shows the streamed figure. */
async function runningAt182k() {
  gatewayHolds(182_000)
  mountPane()
  await waitFor(() => expect(ringText()).toBe('18%'))
  emit('session:started', { sessionId: SID })
  emit('session:delta', { sessionId: SID, type: 'context', content: '182000' })
  await waitFor(() => expect(ringText()).toBe('18%'))
}

describe('the context meter after a compaction inside a running turn', () => {
  it('shows the size after it as soon as the gateway reports the compaction', async () => {
    await runningAt182k()
    // The compaction finished: the record holds the new size, nothing else has been sent yet.
    gatewayHolds(31_000)
    expect(ringText()).toBe('18%')

    emit('session:compacted', { sessionId: SID, preTokens: 182_000, postTokens: 31_000 })

    await waitFor(() => expect(ringText()).toBe('3%'))
    expect(screen.getByTestId('context-meter').getAttribute('title')).toContain('31k')
  })

  it('stays on the new size when the turn then ends', async () => {
    await runningAt182k()
    gatewayHolds(31_000)
    emit('session:compacted', { sessionId: SID, preTokens: 182_000, postTokens: 31_000 })
    await waitFor(() => expect(ringText()).toBe('3%'))

    gatewayHolds(32_500, 'idle')
    emit('session:completed', { sessionId: SID, result: 'done', error: null })

    await waitFor(() => expect(ringText()).toBe('3%'))
  })

  it('drops the stale figure when the engine reported no size after it', async () => {
    await runningAt182k()
    gatewayHolds(null)

    emit('session:compacted', { sessionId: SID, preTokens: 182_000 })

    await waitFor(() => expect(ringText()).toBe('n/a'))
  })

  it('refetches the usage answer even when no turn of this pane is running', async () => {
    gatewayHolds(182_000, 'idle')
    mountPane()
    await waitFor(() => expect(ringText()).toBe('18%'))
    const before = getContextUsage.mock.calls.length
    gatewayHolds(31_000, 'idle')

    emit('session:compacted', { sessionId: SID, preTokens: 182_000, postTokens: 31_000 })

    await waitFor(() => expect(getContextUsage.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() => expect(ringText()).toBe('3%'))
  })

  it("ignores another session's compaction", async () => {
    await runningAt182k()
    gatewayHolds(31_000)

    emit('session:compacted', { sessionId: 'other-session', postTokens: 31_000 })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(ringText()).toBe('18%')
  })
})
