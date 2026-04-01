import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSettings, DEFAULT_SETTINGS } from '../useSettings'

// Mock the API client
vi.mock('../../api/client', () => ({
  getSettings: vi.fn().mockRejectedValue(new Error('offline')),
  putSettings: vi.fn().mockRejectedValue(new Error('offline')),
  SOURCE_ID: 'test-source',
}))

// Mock useOnlineStatus
vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn().mockReturnValue(false),
}))

// Mock localStorage
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}

Object.defineProperty(global, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
})

describe('useSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns default settings when localStorage is empty', () => {
    mockLocalStorage.getItem.mockReturnValue(null)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('migrates old localStorage format (no updated_at wrapper)', () => {
    // Old format: just the settings object
    const oldFormat = JSON.stringify({
      showItemizedColumn: false,
      compactView: true,
    })
    mockLocalStorage.getItem.mockReturnValue(oldFormat)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings.showItemizedColumn).toBe(false)
    expect(result.current.settings.compactView).toBe(true)
    // Defaults should be merged in
    expect(result.current.settings.showHolidays).toBe(true)
  })

  it('loads new localStorage format with updated_at', () => {
    const newFormat = JSON.stringify({
      settings: { compactView: true, calendarColor: 'blue' },
      updated_at: '2026-04-01T12:00:00.000Z',
    })
    mockLocalStorage.getItem.mockReturnValue(newFormat)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings.compactView).toBe(true)
    expect(result.current.settings.calendarColor).toBe('blue')
    // Defaults merged
    expect(result.current.settings.showMealIdeas).toBe(true)
  })

  it('handles malformed localStorage data gracefully', () => {
    mockLocalStorage.getItem.mockReturnValue('invalid json')

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('updates settings and saves to localStorage in new format', () => {
    mockLocalStorage.getItem.mockReturnValue(null)

    const { result } = renderHook(() => useSettings())

    act(() => {
      result.current.updateSettings({ showItemizedColumn: false })
    })

    expect(result.current.settings.showItemizedColumn).toBe(false)
    // Verify localStorage was called with the new wrapped format
    const lastCall = mockLocalStorage.setItem.mock.calls.find(
      (call: [string, string]) => call[0] === 'meal-planner-settings'
    )
    expect(lastCall).toBeTruthy()
    const stored = JSON.parse(lastCall![1])
    expect(stored.settings.showItemizedColumn).toBe(false)
    expect(stored.updated_at).toBeTruthy()
  })

  it('allows partial updates', () => {
    mockLocalStorage.getItem.mockReturnValue(null)

    const { result } = renderHook(() => useSettings())

    act(() => {
      result.current.updateSettings({ compactView: true })
    })

    expect(result.current.settings.compactView).toBe(true)
    // Other settings unchanged
    expect(result.current.settings.showItemizedColumn).toBe(true)
    expect(result.current.settings.showMealIdeas).toBe(true)
  })
})
