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
      showPantry: true,
      showMealIdeas: true,
      compactView: false,
    })
    expect(mockLocalStorage.getItem).toHaveBeenCalledWith('meal-planner-settings')
  })

  it('loads settings from localStorage', () => {
    const storedSettings = JSON.stringify({
      showItemizedColumn: false,
      showPantry: false,
      showMealIdeas: false,
      compactView: true,
    })
    mockLocalStorage.getItem.mockReturnValue(storedSettings)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual({
      showItemizedColumn: false,
      showPantry: false,
      showMealIdeas: false,
      compactView: true,
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
      showPantry: true,
      showMealIdeas: true,
      compactView: false,
      someOldSetting: true, // Merged from storage
    })
  })

  it('handles malformed localStorage data gracefully', () => {
    mockLocalStorage.getItem.mockReturnValue('invalid json')

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual({
      showItemizedColumn: true,
      showPantry: true,
      showMealIdeas: true,
      compactView: false,
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
      JSON.stringify({ showItemizedColumn: false, showPantry: true, showMealIdeas: true, compactView: false })
    )
  })

  it('allows partial updates', () => {
    const initialSettings = JSON.stringify({
      showItemizedColumn: false,
      showPantry: false,
      showMealIdeas: false,
      compactView: false,
    })
    mockLocalStorage.getItem.mockReturnValue(initialSettings)

    const { result } = renderHook(() => useSettings())

    // Verify initial state
    expect(result.current.settings.showItemizedColumn).toBe(false)
    expect(result.current.settings.showPantry).toBe(false)
    expect(result.current.settings.showMealIdeas).toBe(false)
    expect(result.current.settings.compactView).toBe(false)

    // Update only one setting
    act(() => {
      result.current.updateSettings({ showItemizedColumn: true })
    })

    expect(result.current.settings.showItemizedColumn).toBe(true)
  })
})
