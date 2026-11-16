import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, useLocation, type RouteObject } from 'react-router-dom'
import { useState, type ReactNode } from 'react'
import { sessionListFailed, useTodosOpenIntent } from '../use-layout-tab-openers'

/* The `?open=todos` link, on a data router: its navigations are asynchronous, so a drop of the intent that
 * raced another move would show here (a MemoryRouter would hide it). */

function Where() {
  const location = useLocation()
  return <span data-testid="where">{location.pathname}{location.search}</span>
}

function mount(entry: string, ui: ReactNode) {
  const routes: RouteObject[] = [{ path: '*', element: <>{ui}<Where /></> }]
  const router = createMemoryRouter(routes, { initialEntries: [entry] })
  render(<RouterProvider router={router} />)
  return router
}

function Intent({ open, ready, failed }: { open: () => boolean; ready: boolean; failed?: boolean }) {
  useTodosOpenIntent(open, ready, failed)
  return null
}

const where = () => screen.getByTestId('where').textContent
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe('the Todos tab link', () => {
  it('opens the tab once the layout is ready, then leaves the address without it, by a replace', async () => {
    const open = vi.fn(() => false)
    const router = mount('/?session=s1&open=todos', <Intent open={open} ready />)
    await waitFor(() => expect(where()).toBe('/?session=s1'))
    expect(open).toHaveBeenCalledTimes(1)
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('waits for the layout, and leaves the link in the address until it has opened the tab', async () => {
    const open = vi.fn(() => false)
    const router = mount('/?open=todos', <Intent open={open} ready={false} />)
    await settle()
    expect(open).not.toHaveBeenCalled()
    expect(router.state.location.search).toBe('?open=todos')
  })

  it('drops the link from the address, opening nothing, when the session list failed and the layout can never be ready', async () => {
    const open = vi.fn(() => false)
    const router = mount('/?session=s1&open=todos&view=x', <Intent open={open} ready={false} failed />)
    await waitFor(() => expect(where()).toBe('/?session=s1&view=x'))
    expect(router.state.location.search).not.toContain('open=')
    expect(open).not.toHaveBeenCalled()
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('drops the link when the session list fails only after the link was held waiting for the layout', async () => {
    const open = vi.fn(() => false)
    let fail: () => void = () => {}
    function Late() {
      const [failed, setFailed] = useState(false)
      fail = () => setFailed(true)
      return <Intent open={open} ready={false} failed={failed} />
    }
    const router = mount('/?open=todos', <Late />)
    await settle()
    expect(router.state.location.search).toBe('?open=todos')
    act(() => fail())
    await waitFor(() => expect(where()).toBe('/'))
    expect(open).not.toHaveBeenCalled()
  })

  it('opens the tab, and does not drop the link, when the layout is ready although the query errored (a stale error holding a list)', async () => {
    // The page passes `failed` only when the query holds no list (sessionListFailed), so a stale-error query that
    // still hydrates the layout reaches the hook as ready and not failed.
    const stale = { isError: true, data: [{ id: 's1' }] }
    expect(sessionListFailed(stale)).toBe(false)
    const open = vi.fn(() => true)
    const router = mount('/?open=todos', <Intent open={open} ready failed={sessionListFailed(stale)} />)
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    await settle()
    // The opener moved the route itself: the hook writes nothing over it.
    expect(router.state.location.search).toBe('?open=todos')
  })

  it('keeps the link while a stale-error query holding a list has not yet hydrated the layout', async () => {
    const open = vi.fn(() => false)
    const router = mount('/?open=todos', <Intent open={open} ready={false} failed={sessionListFailed({ isError: true, data: [{ id: 's1' }] })} />)
    await settle()
    expect(open).not.toHaveBeenCalled()
    expect(router.state.location.search).toBe('?open=todos')
  })
})
