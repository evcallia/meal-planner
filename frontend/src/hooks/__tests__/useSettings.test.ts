import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSettings } from '../useSettings'

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

    expect(result.current.settings).toEqual({
      showItemizedColumn: true,

      showMealIdeas: true,
      compactView: false,
      textScaleStandard: 1,
      textScaleCompact: 1,
      showAllEvents: false,
      showHolidays: true,
      holidayColor: 'red',
    })
    expect(mockLocalStorage.getItem).toHaveBeenCalledWith('meal-planner-settings')
  })

  it('loads settings from localStorage', () => {
    const storedSettings = JSON.stringify({
      showItemizedColumn: false,

      showMealIdeas: false,
      compactView: true,
      textScaleStandard: 1.1,
      textScaleCompact: 0.9,
    })
    mockLocalStorage.getItem.mockReturnValue(storedSettings)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual({
      showItemizedColumn: false,

      showMealIdeas: false,
      compactView: true,
      textScaleStandard: 1.1,
      textScaleCompact: 0.9,
      showAllEvents: false,
      showHolidays: true,
      holidayColor: 'red',
    })
  })

  it('merges stored settings with defaults', () => {
    const storedSettings = JSON.stringify({
      someOldSetting: true, // This would be included in merge
    })
    mockLocalStorage.getItem.mockReturnValue(storedSettings)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual({
      showItemizedColumn: true, // Default value

      showMealIdeas: true,
      compactView: false,
      textScaleStandard: 1,
      textScaleCompact: 1,
      showAllEvents: false,
      showHolidays: true,
      holidayColor: 'red',
      someOldSetting: true, // Merged from storage
    })
  })

  it('handles malformed localStorage data gracefully', () => {
    mockLocalStorage.getItem.mockReturnValue('invalid json')

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual({
      showItemizedColumn: true,

      showMealIdeas: true,
      compactView: false,
      textScaleStandard: 1,
      textScaleCompact: 1,
      showAllEvents: false,
      showHolidays: true,
      holidayColor: 'red',
    })
  })

  it('updates settings and saves to localStorage', () => {
    mockLocalStorage.getItem.mockReturnValue(null)

    const { result } = renderHook(() => useSettings())

    act(() => {
      result.current.updateSettings({ showItemizedColumn: false })
    })

    expect(result.current.settings.showItemizedColumn).toBe(false)
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'meal-planner-settings',
      JSON.stringify({
        showItemizedColumn: false,
  
        showMealIdeas: true,
        compactView: false,
        textScaleStandard: 1,
        textScaleCompact: 1,
        showAllEvents: false,
        showHolidays: true,
      holidayColor: 'red',
      })
    )
  })

  it('allows partial updates', () => {
    const initialSettings = JSON.stringify({
      showItemizedColumn: false,

      showMealIdeas: false,
      compactView: false,
      textScaleStandard: 1,
      textScaleCompact: 1,
    })
    mockLocalStorage.getItem.mockReturnValue(initialSettings)

    const { result } = renderHook(() => useSettings())

    // Verify initial state
    expect(result.current.settings.showItemizedColumn).toBe(false)

    expect(result.current.settings.showMealIdeas).toBe(false)
    expect(result.current.settings.compactView).toBe(false)

    // Update only one setting
    act(() => {
      result.current.updateSettings({ showItemizedColumn: true })
    })

    expect(result.current.settings.showItemizedColumn).toBe(true)
  })
})
