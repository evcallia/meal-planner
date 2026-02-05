import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { SettingsModal } from '../SettingsModal'
import type { Settings } from '../../hooks/useSettings'

vi.mock('../../api/client', () => ({
  getCalendarCacheStatus: vi.fn(() => Promise.resolve({ is_refreshing: false, last_refresh: null })),
  refreshCalendarCache: vi.fn(() => Promise.resolve()),
}))

import { getCalendarCacheStatus, refreshCalendarCache } from '../../api/client'

describe('SettingsModal', () => {
  const defaultSettings: Settings = {
    showItemizedColumn: true,
    showPantry: true,
    showMealIdeas: true,
  }

const defaultProps = {
  settings: defaultSettings,
  onUpdate: vi.fn(),
  onClose: vi.fn(),
}

const renderModal = async (props = defaultProps) => {
  await act(async () => {
    render(<SettingsModal {...props} />)
    await Promise.resolve()
  })
}

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the modal with correct title', async () => {
    await renderModal()
    
    expect(screen.getByText('Settings')).toBeInTheDocument()
  })

  it('displays the current setting state correctly', async () => {
    await renderModal()
    
    const ideasToggle = screen.getByRole('switch', { name: /show future meals/i })
    expect(ideasToggle).toHaveAttribute('aria-checked', 'true')

    const pantryToggle = screen.getByRole('switch', { name: /show pantry/i })
    expect(pantryToggle).toHaveAttribute('aria-checked', 'true')

    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('displays unchecked state when setting is false', async () => {
    const settings: Settings = {
      showItemizedColumn: false,
      showPantry: false,
      showMealIdeas: false,
    }
    
    await renderModal({ ...defaultProps, settings })
    
    const ideasToggle = screen.getByRole('switch', { name: /show future meals/i })
    expect(ideasToggle).toHaveAttribute('aria-checked', 'false')

    const pantryToggle = screen.getByRole('switch', { name: /show pantry/i })
    expect(pantryToggle).toHaveAttribute('aria-checked', 'false')

    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('calls onUpdate when checkbox is toggled', async () => {
    await renderModal()
    
    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    
    fireEvent.click(toggle)
    
    expect(defaultProps.onUpdate).toHaveBeenCalledWith({
      showItemizedColumn: false,
    })
  })

  it('updates pantry visibility when toggled', async () => {
    await renderModal()

    const pantryToggle = screen.getByRole('switch', { name: /show pantry/i })

    fireEvent.click(pantryToggle)

    expect(defaultProps.onUpdate).toHaveBeenCalledWith({
      showPantry: false,
    })
  })

  it('updates future meals visibility when toggled', async () => {
    await renderModal()

    const ideasToggle = screen.getByRole('switch', { name: /show future meals/i })

    fireEvent.click(ideasToggle)

    expect(defaultProps.onUpdate).toHaveBeenCalledWith({
      showMealIdeas: false,
    })
  })

  it('calls onClose when close button is clicked', async () => {
    await renderModal()
    
    const closeButton = screen.getByRole('button', { name: '' }) // The X button has no text
    
    fireEvent.click(closeButton)
    
    expect(defaultProps.onClose).toHaveBeenCalled()
  })

  it('calls onClose when clicking outside the modal', async () => {
    const { fireEvent } = await import('@testing-library/react')
    await renderModal()
    
    // Click on the backdrop (the overlay)
    const backdrop = screen.getByText('Settings').closest('[class*="fixed inset-0"]')
    expect(backdrop).toBeInTheDocument()
    
    fireEvent.click(backdrop!)
    
    expect(defaultProps.onClose).toHaveBeenCalled()
  })

  it('does not close when clicking inside the modal content', async () => {
    const { fireEvent } = await import('@testing-library/react')
    await renderModal()
    
    const modalContent = screen.getByText('Settings').closest('[class*="bg-white"]')
    expect(modalContent).toBeInTheDocument()
    
    fireEvent.click(modalContent!)
    
    expect(defaultProps.onClose).not.toHaveBeenCalled()
  })

  it('has proper accessibility attributes', async () => {
    await renderModal()
    
    const ideasToggle = screen.getByRole('switch', { name: /show future meals/i })
    expect(ideasToggle).toHaveAttribute('aria-checked', 'true')

    const pantryToggle = screen.getByRole('switch', { name: /show pantry/i })
    expect(pantryToggle).toHaveAttribute('aria-checked', 'true')

    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    
    const closeButton = screen.getByRole('button', { name: '' }) // Empty name for X button
    expect(closeButton).toBeInTheDocument()
  })

  it('shows correct description for itemized column setting', async () => {
    await renderModal()
    
    expect(screen.getByText('Show checkboxes to mark meals as added to shopping list')).toBeInTheDocument()
  })

  it('handles keyboard navigation', async () => {
    await renderModal()
    
    const toggle = screen.getByRole('switch', { name: /show itemized column/i })
    const closeButton = screen.getByRole('button', { name: '' }) // Empty name for X button
    
    // Both elements should be focusable
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    
    closeButton.focus()
    expect(document.activeElement).toBe(closeButton)
  })

  it('renders last updated text from cache status', async () => {
    const now = new Date('2026-02-05T12:00:00Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)
    vi.mocked(getCalendarCacheStatus).mockResolvedValueOnce({
      is_refreshing: false,
      last_refresh: now.toISOString(),
    })

    await renderModal()

    expect(screen.getByText(/last updated: just now/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('refreshes calendar cache and shows success message', async () => {
    vi.useFakeTimers()
    vi.mocked(getCalendarCacheStatus)
      .mockResolvedValueOnce({ is_refreshing: false, last_refresh: null })
      .mockResolvedValueOnce({ is_refreshing: false, last_refresh: new Date().toISOString() })

    await renderModal()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /refresh now/i }))
    })

    expect(refreshCalendarCache).toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })

    expect(screen.getByText('Calendar refreshed!')).toBeInTheDocument()

    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
    })

    expect(screen.queryByText('Calendar refreshed!')).not.toBeInTheDocument()

    vi.useRealTimers()
  })

  it('shows error message when refresh fails', async () => {
    vi.mocked(refreshCalendarCache).mockRejectedValueOnce(new Error('Failed'))
    await renderModal()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /refresh now/i }))
    })

    await waitFor(() => {
      expect(screen.getByText('Failed to refresh')).toBeInTheDocument()
    })
  })
})
