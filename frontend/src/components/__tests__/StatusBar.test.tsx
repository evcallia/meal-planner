import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBar } from '../StatusBar'
import type { ConnectionStatus } from '../../types'

describe('StatusBar', () => {
  it('renders nothing when status is online', () => {
    const { container } = render(
      <StatusBar status="online" pendingCount={0} />
    )
    
    expect(container.firstChild).toBeNull()
  })

  it('shows offline status with correct styling', () => {
    render(<StatusBar status="offline" pendingCount={0} />)
    
    expect(screen.getByText('Offline - Changes saved locally')).toBeInTheDocument()
    
    const container = screen.getByText('Offline - Changes saved locally').parentElement
    expect(container).toHaveClass('bg-orange-500')
  })

  it('shows syncing status with pending count', () => {
    render(<StatusBar status="syncing" pendingCount={3} />)
    
    expect(screen.getByText('Syncing... (3 pending)')).toBeInTheDocument()
    
    const container = screen.getByText('Syncing... (3 pending)').parentElement
    expect(container).toHaveClass('bg-yellow-500')
  })

  it('shows syncing status with zero pending count', () => {
    render(<StatusBar status="syncing" pendingCount={0} />)
    
    expect(screen.getByText('Syncing... (0 pending)')).toBeInTheDocument()
  })

  it('shows syncing status with large pending count', () => {
    render(<StatusBar status="syncing" pendingCount={100} />)
    
    expect(screen.getByText('Syncing... (100 pending)')).toBeInTheDocument()
  })

  it('displays offline icon for offline status', () => {
    render(<StatusBar status="offline" pendingCount={0} />)
    
    const icon = screen.getByText('Offline - Changes saved locally').previousElementSibling
    expect(icon).toBeTruthy()
    expect(icon!.tagName.toLowerCase()).toBe('svg')
  })

  it('displays syncing icon with animation for syncing status', () => {
    render(<StatusBar status="syncing" pendingCount={1} />)
    
    const icon = screen.getByText('Syncing... (1 pending)').previousElementSibling
    expect(icon).toBeTruthy()
    expect(icon!.tagName.toLowerCase()).toBe('svg')
    expect(icon).toHaveClass('animate-spin')
  })

  it('has proper styling classes for both statuses', () => {
    const { rerender } = render(<StatusBar status="offline" pendingCount={0} />)
    
    let container = screen.getByText('Offline - Changes saved locally').parentElement
    expect(container).toHaveClass('text-white', 'px-4', 'py-2', 'flex', 'items-center', 'justify-center', 'gap-2', 'text-sm', 'font-medium')
    
    rerender(<StatusBar status="syncing" pendingCount={1} />)
    
    container = screen.getByText('Syncing... (1 pending)').parentElement
    expect(container).toHaveClass('text-white', 'px-4', 'py-2', 'flex', 'items-center', 'justify-center', 'gap-2', 'text-sm', 'font-medium')
  })

  it('handles edge case statuses gracefully', () => {
    // Test with an unknown status (should default to syncing behavior)
    render(<StatusBar status={'unknown' as ConnectionStatus} pendingCount={5} />)
    
    expect(screen.getByText('Syncing... (5 pending)')).toBeInTheDocument()
  })

  it('handles negative pending count', () => {
    render(<StatusBar status="syncing" pendingCount={-1} />)
    
    expect(screen.getByText('Syncing... (-1 pending)')).toBeInTheDocument()
  })
})