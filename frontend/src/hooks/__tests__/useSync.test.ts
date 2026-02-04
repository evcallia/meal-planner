import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSync } from '../useSync';

// Mock dependencies
vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn()
}));

vi.mock('../../db', () => ({
  getPendingChanges: vi.fn(),
  removePendingChange: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  updateNotes: vi.fn(),
  toggleItemized: vi.fn(),
}));

import { useOnlineStatus } from '../useOnlineStatus';
import { getPendingChanges, removePendingChange } from '../../db';
import { updateNotes, toggleItemized } from '../../api/client';

describe('useSync', () => {
  const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
  const mockGetPendingChanges = vi.mocked(getPendingChanges);
  const mockRemovePendingChange = vi.mocked(removePendingChange);
  const mockUpdateNotes = vi.mocked(updateNotes);
  const mockToggleItemized = vi.mocked(toggleItemized);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPendingChanges.mockResolvedValue([]);
  });

  it('should initialize with offline status when not online', () => {
    mockUseOnlineStatus.mockReturnValue(false);

    const { result } = renderHook(() => useSync());

    expect(result.current.status).toBe('offline');
    expect(result.current.pendingCount).toBe(0);
  });

  it('should initialize with online status when online', () => {
    mockUseOnlineStatus.mockReturnValue(true);

    const { result } = renderHook(() => useSync());

    expect(result.current.status).toBe('online');
    expect(result.current.pendingCount).toBe(0);
  });

  it('should sync notes changes when online', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    
    const mockChanges = [
      {
        id: 1,
        type: 'notes' as const,
        date: '2024-01-01',
        payload: { notes: 'Test notes' },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);
    mockUpdateNotes.mockResolvedValue({
      id: '123',
      date: '2024-01-01',
      notes: 'Test notes'
    });

    const { result } = renderHook(() => useSync());

    await waitFor(() => {
      expect(mockUpdateNotes).toHaveBeenCalledWith('2024-01-01', 'Test notes');
      expect(mockRemovePendingChange).toHaveBeenCalledWith(1);
    });
  });

  it('should sync itemized changes when online', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    
    const mockChanges = [
      {
        id: 2,
        type: 'itemized' as const,
        date: '2024-01-01',
        payload: { lineIndex: 0, itemized: true },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);
    mockToggleItemized.mockResolvedValue({
      id: '456',
      line_index: 0,
      itemized: true
    });

    const { result } = renderHook(() => useSync());

    await waitFor(() => {
      expect(mockToggleItemized).toHaveBeenCalledWith('2024-01-01', 0, true);
      expect(mockRemovePendingChange).toHaveBeenCalledWith(2);
    });
  });

  it('should handle sync errors gracefully', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    
    const mockChanges = [
      {
        id: 3,
        type: 'notes' as const,
        date: '2024-01-01',
        payload: { notes: 'Test notes' },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);
    mockUpdateNotes.mockRejectedValue(new Error('Sync failed'));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useSync());

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to sync change:', expect.any(Error));
    });

    consoleErrorSpy.mockRestore();
  });

  it('should not sync when offline', async () => {
    mockUseOnlineStatus.mockReturnValue(false);
    
    const mockChanges = [
      {
        id: 4,
        type: 'notes' as const,
        date: '2024-01-01',
        payload: { notes: 'Test notes' },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);

    const { result } = renderHook(() => useSync());

    await waitFor(() => {
      expect(mockUpdateNotes).not.toHaveBeenCalled();
      expect(result.current.status).toBe('offline');
    });
  });

  it('should update pending count during sync', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    
    const mockChanges = [
      {
        id: 1,
        type: 'notes' as const,
        date: '2024-01-01',
        payload: { notes: 'Test notes' },
        createdAt: Date.now()
      },
      {
        id: 2,
        type: 'itemized' as const,
        date: '2024-01-02',
        payload: { lineIndex: 0, itemized: true },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);
    mockUpdateNotes.mockResolvedValue({
      id: '123',
      date: '2024-01-01',
      notes: 'Test notes'
    });
    mockToggleItemized.mockResolvedValue({
      id: '456',
      line_index: 0,
      itemized: true
    });

    const { result } = renderHook(() => useSync());

    await waitFor(() => {
      expect(result.current.status).toBe('online');
      expect(result.current.pendingCount).toBe(0);
    });
  });
});
