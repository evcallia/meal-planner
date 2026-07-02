import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { StatusChip, StatusToast } from '../StatusBar'
import type { ConnectionStatus } from '../../types'

describe('StatusChip', () => {
  it('renders nothing when online', () => {
    const { container } = render(<StatusChip status="online" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when auth-required (owned by the re-auth modal)', () => {
    const { container } = render(<StatusChip status="auth-required" />)
    expect(container.firstChild).toBeNull()
  })

  it('shows an Offline chip', () => {
    render(<StatusChip status="offline" />)
    expect(screen.getByText('Offline')).toBeInTheDocument()
  })

  it('shows a Syncing chip with a spinner', () => {
    const { container } = render(<StatusChip status="syncing" />)
    expect(screen.getByText('Syncing')).toBeInTheDocument()
    expect(container.querySelector('svg.animate-spin')).toBeTruthy()
  })

  it('shows the pending count when syncing', () => {
    render(<StatusChip status="syncing" pendingCount={3} />)
    expect(screen.getByText('Syncing 3')).toBeInTheDocument()
  })

  it('appends the queued count to the offline chip', () => {
    render(<StatusChip status="offline" pendingCount={2} />)
    expect(screen.getByText('Offline · 2')).toBeInTheDocument()
  })
})

describe('StatusToast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('renders nothing on initial mount (no status change yet)', () => {
    const { container } = render(<StatusToast status="online" pendingCount={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows an offline toast when transitioning online → offline', () => {
    const { rerender } = render(<StatusToast status="online" pendingCount={0} />)
    rerender(<StatusToast status="offline" pendingCount={0} />)
    expect(screen.getByText(/you're offline/i)).toBeInTheDocument()
  })

  it('shows a syncing toast with a pluralized pending count', () => {
    const { rerender } = render(<StatusToast status="offline" pendingCount={0} />)
    rerender(<StatusToast status="syncing" pendingCount={3} />)
    expect(screen.getByText('Syncing 3 changes…')).toBeInTheDocument()

    rerender(<StatusToast status="online" pendingCount={0} />)
    rerender(<StatusToast status="syncing" pendingCount={1} />)
    expect(screen.getByText('Syncing 1 change…')).toBeInTheDocument()
  })

  it('shows "Back online" only when returning from offline/syncing', () => {
    const { rerender, container } = render(<StatusToast status="syncing" pendingCount={1} />)
    rerender(<StatusToast status="online" pendingCount={0} />)
    expect(screen.getByText('Back online')).toBeInTheDocument()

    // auth-required → online should not announce "Back online"
    rerender(<StatusToast status="auth-required" pendingCount={0} />)
    act(() => { vi.advanceTimersByTime(3000) })
    rerender(<StatusToast status="online" pendingCount={0} />)
    expect(container.firstChild).toBeNull()
  })

  it('auto-dismisses after 3s', () => {
    const { rerender, container } = render(<StatusToast status="online" pendingCount={0} />)
    rerender(<StatusToast status="offline" pendingCount={0} />)
    expect(container.firstChild).not.toBeNull()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(container.firstChild).toBeNull()
  })
})
