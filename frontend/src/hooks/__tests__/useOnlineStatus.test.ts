import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useOnlineStatus } from '../useOnlineStatus'

vi.mock('../../authEvents', () => ({
  emitAuthFailure: vi.fn(),
  onAuthFailure: vi.fn(() => vi.fn()),
  AUTH_FAILURE_EVENT: 'meal-planner-auth-failure',
}))

// Mock navigator.onLine
Object.defineProperty(navigator, 'onLine', {
  writable: true,
  value: true,
})

const mockFetch = vi.fn()
global.fetch = mockFetch

describe('useOnlineStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigator.onLine = true
    mockFetch.mockResolvedValue({ ok: true })
  })

  it('returns initial online status', async () => {
    const { result } = renderHook(() => useOnlineStatus())
    
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('returns initial offline status', async () => {
    navigator.onLine = false
    
    const { result } = renderHook(() => useOnlineStatus())
    
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('updates status when going online', async () => {
    navigator.onLine = false
    const { result } = renderHook(() => useOnlineStatus())
    
    await waitFor(() => expect(result.current).toBe(false))
    
    // Simulate going online
    navigator.onLine = true
    
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('updates status when going offline', async () => {
    navigator.onLine = true
    const { result } = renderHook(() => useOnlineStatus())
    
    await waitFor(() => expect(result.current).toBe(true))
    
    // Simulate going offline
    navigator.onLine = false
    
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('adds and removes event listeners properly', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    
    const { unmount } = renderHook(() => useOnlineStatus())
    
    expect(addEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function))
    expect(addEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function))
    
    unmount()
    
    expect(removeEventListenerSpy).toHaveBeenCalledWith('online', expect.any(Function))
    expect(removeEventListenerSpy).toHaveBeenCalledWith('offline', expect.any(Function))
    
    addEventListenerSpy.mockRestore()
    removeEventListenerSpy.mockRestore()
  })

  it('handles rapid online/offline changes', async () => {
    const { result } = renderHook(() => useOnlineStatus())
    
    // Start online
    await waitFor(() => expect(result.current).toBe(true))
    
    // Go offline
    navigator.onLine = false
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    await waitFor(() => expect(result.current).toBe(false))
    
    // Go back online quickly
    navigator.onLine = true
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(result.current).toBe(true))
    
    // Go offline again
    navigator.onLine = false
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('maintains consistent state across multiple instances', async () => {
    const { result: result1 } = renderHook(() => useOnlineStatus())
    const { result: result2 } = renderHook(() => useOnlineStatus())
    
    await waitFor(() => expect(result1.current).toBe(result2.current))
    
    // Change status
    navigator.onLine = false
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    
    await waitFor(() => expect(result1.current).toBe(false))
    await waitFor(() => expect(result2.current).toBe(false))
    expect(result1.current).toBe(result2.current)
  })
})
