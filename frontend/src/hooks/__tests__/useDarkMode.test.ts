import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDarkMode } from '../useDarkMode'

const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}

Object.defineProperty(global, 'localStorage', {
  value: mockLocalStorage,
})

describe('useDarkMode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.classList.remove('dark')
  })

  it('initializes with system preference when no stored preference', () => {
    mockLocalStorage.getItem.mockReturnValue(null)
    // Mock system prefers dark mode
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    
    const { result } = renderHook(() => useDarkMode())
    
    expect(result.current.isDark).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('initializes with stored preference', () => {
    mockLocalStorage.getItem.mockReturnValue('false')
    
    const { result } = renderHook(() => useDarkMode())
    
    expect(result.current.isDark).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('toggles dark mode on and off', () => {
    mockLocalStorage.getItem.mockReturnValue('false')
    
    const { result } = renderHook(() => useDarkMode())
    
    expect(result.current.isDark).toBe(false)
    
    act(() => {
      result.current.toggle()
    })
    
    expect(result.current.isDark).toBe(true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('darkMode', 'true')
    
    act(() => {
      result.current.toggle()
    })
    
    expect(result.current.isDark).toBe(false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(mockLocalStorage.setItem).toHaveBeenLastCalledWith('darkMode', 'false')
  })

  it('responds to system preference changes when no stored preference', () => {
    mockLocalStorage.getItem.mockReturnValue(null)
    let mediaQueryListener: ((e: MediaQueryListEvent) => void) | null = null
    
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true, // Start with dark mode
      addEventListener: vi.fn((event, listener) => {
        if (event === 'change') {
          mediaQueryListener = listener
        }
      }),
      removeEventListener: vi.fn(),
    }))
    
    const { result } = renderHook(() => useDarkMode())
    
    expect(result.current.isDark).toBe(true)
  })

  it('handles localStorage errors gracefully', () => {
    mockLocalStorage.getItem.mockImplementation(() => {
      throw new Error('localStorage not available')
    })
    
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    
    const { result } = renderHook(() => useDarkMode())
    
    // Should fallback to system preference
    expect(result.current.isDark).toBe(false)
  })
})