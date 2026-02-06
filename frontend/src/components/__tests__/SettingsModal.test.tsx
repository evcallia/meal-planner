import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { SettingsModal } from '../SettingsModal'
import type { Settings } from '../../hooks/useSettings'

vi.mock('../../api/client', () => ({
  getCalendarCacheStatus: vi.fn(() => Promise.resolve({ is_refreshing: false, last_refresh: null })),
  refreshCalendarCache: vi.fn(() => Promise.resolve()),
  getHiddenCalendarEvents: vi.fn(() => Promise.resolve([])),
  unhideCalendarEvent: vi.fn(() => Promise.resolve({ status: 'ok' })),
}))

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}))

vi.mock('../../db', () => ({
  getLocalHiddenEvents: vi.fn(() => Promise.resolve([])),
  saveLocalHiddenEvent: vi.fn(),
  saveLocalHiddenEvents: vi.fn(),
  clearLocalHiddenEvents: vi.fn(),
  deleteLocalHiddenEvent: vi.fn(),
  queueChange: vi.fn(),
  getPendingChanges: vi.fn(() => Promise.resolve([])),
  removePendingChange: vi.fn(),
  getCalendarCacheTimestamp: vi.fn(() => Promise.resolve(null)),
}))

import { getCalendarCacheStatus, refreshCalendarCache, getHiddenCalendarEvents, unhideCalendarEvent } from '../../api/client'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import {
  getLocalHiddenEvents,
  saveLocalHiddenEvent,
  deleteLocalHiddenEvent,
  queueChange,
  getPendingChanges,
  removePendingChange,
} from '../../db'

describe('SettingsModal', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  const defaultSettings: Settings = {
    showItemizedColumn: true,
    showPantry: true,
    showMealIdeas: true,
    compactView: false,
    textScaleStandard: 1,
    textScaleCompact: 1,
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

const mockGetCalendarCacheStatus = vi.mocked(getCalendarCacheStatus)
const mockGetHiddenCalendarEvents = vi.mocked(getHiddenCalendarEvents)
const mockUnhideCalendarEvent = vi.mocked(unhideCalendarEvent)
const mockUseOnlineStatus = vi.mocked(useOnlineStatus)
const mockGetLocalHiddenEvents = vi.mocked(getLocalHiddenEvents)
const mockSaveLocalHiddenEvent = vi.mocked(saveLocalHiddenEvent)
const mockDeleteLocalHiddenEvent = vi.mocked(deleteLocalHiddenEvent)
const mockQueueChange = vi.mocked(queueChange)
const mockGetPendingChanges = vi.mocked(getPendingChanges)
const mockRemovePendingChange = vi.mocked(removePendingChange)

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.clearAllMocks()
    mockUseOnlineStatus.mockReturnValue(true)
    mockGetHiddenCalendarEvents.mockResolvedValue([])
    mockGetLocalHiddenEvents.mockResolvedValue([])
  })
  afterEach(() => {
    consoleErrorSpy.mockRestore()
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
      compactView: false,
      textScaleStandard: 1,
      textScaleCompact: 1,
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

  it('shows last updated time in minutes, hours, and days', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-05T12:00:00Z'))

    mockGetCalendarCacheStatus.mockResolvedValueOnce({
      is_refreshing: false,
      last_refresh: new Date('2026-02-05T11:50:00Z').toISOString(),
    })
    await renderModal()
    expect(screen.getByText(/last updated: 10 minutes ago/i)).toBeInTheDocument()

    mockGetCalendarCacheStatus.mockResolvedValueOnce({
      is_refreshing: false,
      last_refresh: new Date('2026-02-05T10:00:00Z').toISOString(),
    })
    await renderModal()
    expect(screen.getByText(/last updated: 2 hours ago/i)).toBeInTheDocument()

    mockGetCalendarCacheStatus.mockResolvedValueOnce({
      is_refreshing: false,
      last_refresh: new Date('2026-02-03T12:00:00Z').toISOString(),
    })
    await renderModal()
    expect(screen.getByText(/last updated: 2 days ago/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('loads hidden events from local cache when offline', async () => {
    mockUseOnlineStatus.mockReturnValue(false)
    mockGetLocalHiddenEvents.mockResolvedValueOnce([
      {
        id: 'hidden-1',
        event_uid: 'uid-1',
        event_date: '2024-01-01',
        calendar_name: 'Primary',
        title: 'Hidden event',
        start_time: '2024-01-01T10:00:00Z',
        end_time: null,
        all_day: false,
      },
    ])

    await renderModal()

    expect(screen.getByText('Hidden event')).toBeInTheDocument()
    expect(mockGetHiddenCalendarEvents).not.toHaveBeenCalled()
  })

  it('shows error when hidden events fail to load', async () => {
    mockGetHiddenCalendarEvents.mockRejectedValueOnce(new Error('Boom'))
    await renderModal()

    await waitFor(() => {
      expect(screen.getByText('Failed to load hidden events')).toBeInTheDocument()
    })
  })

  it('updates hidden events list from realtime events', async () => {
    await renderModal()

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
        detail: {
          type: 'calendar.hidden',
          payload: {
            hidden_id: 'hidden-2',
            event_uid: 'uid-2',
            calendar_name: 'Primary',
            title: 'Realtime hidden',
            start_time: '2024-01-02T12:00:00Z',
            end_time: null,
            all_day: false,
          },
        },
      }))
    })

    expect(screen.getByText('Realtime hidden')).toBeInTheDocument()
    expect(mockSaveLocalHiddenEvent).toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
        detail: {
          type: 'calendar.unhidden',
          payload: { hidden_id: 'hidden-2' },
        },
      }))
    })

    expect(screen.queryByText('Realtime hidden')).not.toBeInTheDocument()
    expect(mockDeleteLocalHiddenEvent).toHaveBeenCalledWith('hidden-2')
  })

  it('queues unhide when offline and removes pending hide when present', async () => {
    mockUseOnlineStatus.mockReturnValue(false)
    mockGetLocalHiddenEvents.mockResolvedValueOnce([
      {
        id: 'hidden-3',
        event_uid: 'uid-3',
        event_date: '2024-01-03',
        calendar_name: 'Primary',
        title: 'Offline hidden',
        start_time: '2024-01-03T12:00:00Z',
        end_time: null,
        all_day: false,
      },
    ])
    mockGetPendingChanges.mockResolvedValueOnce([
      { id: 'pending-1', type: 'calendar-hide', payload: { tempId: 'hidden-3' } },
    ])

    await renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Unhide' }))

    await waitFor(() => {
      expect(mockRemovePendingChange).toHaveBeenCalledWith('pending-1')
    })
    expect(mockQueueChange).not.toHaveBeenCalled()
  })

  it('queues unhide when offline and no pending hide exists', async () => {
    mockUseOnlineStatus.mockReturnValue(false)
    mockGetLocalHiddenEvents.mockResolvedValueOnce([
      {
        id: 'hidden-4',
        event_uid: 'uid-4',
        event_date: '2024-01-04',
        calendar_name: 'Primary',
        title: 'Offline hidden 2',
        start_time: '2024-01-04T12:00:00Z',
        end_time: null,
        all_day: false,
      },
    ])
    mockGetPendingChanges.mockResolvedValueOnce([])

    await renderModal()

    fireEvent.click(screen.getByRole('button', { name: 'Unhide' }))

    await waitFor(() => {
      expect(mockQueueChange).toHaveBeenCalledWith('calendar-unhide', '2024-01-04', { hiddenId: 'hidden-4' })
    })
  })

  it('unhides events online and removes from list', async () => {
    mockGetHiddenCalendarEvents.mockResolvedValueOnce([
      {
        id: 'hidden-5',
        event_uid: 'uid-5',
        event_date: '2024-01-05',
        calendar_name: 'Primary',
        title: 'Online hidden',
        start_time: '2024-01-05T12:00:00Z',
        end_time: null,
        all_day: false,
      },
    ])

    await renderModal()
    fireEvent.click(screen.getByRole('button', { name: 'Unhide' }))

    await waitFor(() => {
      expect(mockUnhideCalendarEvent).toHaveBeenCalledWith('hidden-5')
    })

    await waitFor(() => {
      expect(screen.queryByText('Online hidden')).not.toBeInTheDocument()
    })
  })
})
