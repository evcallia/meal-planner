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
  isTempId: vi.fn(),
  saveTempIdMapping: vi.fn(),
  getTempIdMapping: vi.fn(),
  deleteLocalPantryItem: vi.fn(),
  saveLocalPantryItem: vi.fn(),
  deleteLocalMealIdea: vi.fn(),
  saveLocalMealIdea: vi.fn(),
  updateLocalHiddenEventId: vi.fn(),
  deleteLocalHiddenEvent: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  updateNotes: vi.fn(),
  toggleItemized: vi.fn(),
  createPantryItem: vi.fn(),
  updatePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
  createMealIdea: vi.fn(),
  updateMealIdea: vi.fn(),
  deleteMealIdea: vi.fn(),
  hideCalendarEvent: vi.fn(),
  unhideCalendarEvent: vi.fn(),
}));

import { useOnlineStatus } from '../useOnlineStatus';
import {
  getPendingChanges,
  removePendingChange,
  isTempId,
  saveTempIdMapping,
  getTempIdMapping,
  deleteLocalPantryItem,
  saveLocalPantryItem,
  deleteLocalMealIdea,
  saveLocalMealIdea,
  updateLocalHiddenEventId,
  deleteLocalHiddenEvent,
} from '../../db';
import {
  updateNotes,
  toggleItemized,
  createPantryItem,
  updatePantryItem,
  deletePantryItem,
  createMealIdea,
  updateMealIdea,
  deleteMealIdea,
  hideCalendarEvent,
  unhideCalendarEvent,
} from '../../api/client';

describe('useSync', () => {
  const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
  const mockGetPendingChanges = vi.mocked(getPendingChanges);
  const mockRemovePendingChange = vi.mocked(removePendingChange);
  const mockUpdateNotes = vi.mocked(updateNotes);
  const mockToggleItemized = vi.mocked(toggleItemized);
  const mockIsTempId = vi.mocked(isTempId);
  const mockSaveTempIdMapping = vi.mocked(saveTempIdMapping);
  const mockGetTempIdMapping = vi.mocked(getTempIdMapping);
  const mockDeleteLocalPantryItem = vi.mocked(deleteLocalPantryItem);
  const mockSaveLocalPantryItem = vi.mocked(saveLocalPantryItem);
  const mockDeleteLocalMealIdea = vi.mocked(deleteLocalMealIdea);
  const mockSaveLocalMealIdea = vi.mocked(saveLocalMealIdea);
  const mockCreatePantryItem = vi.mocked(createPantryItem);
  const mockUpdatePantryItem = vi.mocked(updatePantryItem);
  const mockDeletePantryItem = vi.mocked(deletePantryItem);
  const mockCreateMealIdea = vi.mocked(createMealIdea);
  const mockUpdateMealIdea = vi.mocked(updateMealIdea);
  const mockDeleteMealIdea = vi.mocked(deleteMealIdea);
  const mockUpdateLocalHiddenEventId = vi.mocked(updateLocalHiddenEventId);
  const mockDeleteLocalHiddenEvent = vi.mocked(deleteLocalHiddenEvent);
  const mockHideCalendarEvent = vi.mocked(hideCalendarEvent);
  const mockUnhideCalendarEvent = vi.mocked(unhideCalendarEvent);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPendingChanges.mockResolvedValue([]);
  });

  const setupSyncQueue = (sequence: Array<Array<unknown>>) => {
    let inSync = false;
    const queue = [...sequence];
    mockGetPendingChanges.mockImplementation(() => Promise.resolve(inSync ? (queue.shift() ?? []) : []));
    return async (fn: () => Promise<void>) => {
      inSync = true;
      try {
        await fn();
      } finally {
        inSync = false;
      }
    };
  };

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

    await act(async () => {
      await result.current.syncPendingChanges();
    });

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

  it('syncs pantry add changes and maps temp ids', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);

    const mockChanges = [
      {
        id: 10,
        type: 'pantry-add' as const,
        date: '',
        payload: { id: 'temp-1', name: 'Milk', quantity: 2 },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);
    mockCreatePantryItem.mockResolvedValue({ id: 'real-1', name: 'Milk', quantity: 2, updated_at: '2026-01-01T00:00:00Z' });

    renderHook(() => useSync());

    await waitFor(() => {
      expect(mockCreatePantryItem).toHaveBeenCalledWith({ name: 'Milk', quantity: 2 });
      expect(mockSaveTempIdMapping).toHaveBeenCalledWith('temp-1', 'real-1');
      expect(mockDeleteLocalPantryItem).toHaveBeenCalledWith('temp-1');
      expect(mockSaveLocalPantryItem).toHaveBeenCalled();
      expect(mockRemovePendingChange).toHaveBeenCalledWith(10);
    });
  });

  it('syncs pantry updates with mapped temp ids', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockImplementation((id: string) => id.startsWith('temp-'));
    mockGetTempIdMapping.mockResolvedValue('real-2');
    mockUpdatePantryItem.mockResolvedValue({ id: 'real-2', name: 'Bread', quantity: 2, updated_at: '2026-01-01T00:00:00Z' });

    const mockChanges = [
      {
        id: 21,
        type: 'pantry-update' as const,
        date: '',
        payload: { id: 'temp-2', name: 'Bread', quantity: 2 },
        createdAt: Date.now()
      }
    ];

    const runSync = setupSyncQueue([mockChanges, []]);

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await runSync(() => result.current.syncPendingChanges());
    });

    await waitFor(() => {
      expect(mockUpdatePantryItem).toHaveBeenCalledWith('real-2', { name: 'Bread', quantity: 2 });
      expect(mockRemovePendingChange).toHaveBeenCalledWith(21);
      expect(result.current.status).toBe('online');
    });
  });

  it('skips pantry updates for unresolved temp ids', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue(undefined);

    const mockChanges = [
      {
        id: 11,
        type: 'pantry-update' as const,
        date: '',
        payload: { id: 'temp-2', name: 'Bread' },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);

    renderHook(() => useSync());

    await waitFor(() => {
      expect(mockUpdatePantryItem).not.toHaveBeenCalled();
      expect(mockRemovePendingChange).toHaveBeenCalledWith(11);
    });
    warnSpy.mockRestore();
  });

  it('syncs pantry deletes with mapped temp ids', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue('real-3');
    mockDeletePantryItem.mockResolvedValue();

    const mockChanges = [
      {
        id: 22,
        type: 'pantry-delete' as const,
        date: '',
        payload: { id: 'temp-3' },
        createdAt: Date.now()
      }
    ];

    const runSync = setupSyncQueue([mockChanges, []]);

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await runSync(() => result.current.syncPendingChanges());
    });

    await waitFor(() => {
      expect(mockDeletePantryItem).toHaveBeenCalledWith('real-3');
      expect(mockRemovePendingChange).toHaveBeenCalledWith(22);
      expect(result.current.status).toBe('online');
    });
  });

  it('skips pantry deletes for unresolved temp ids', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue(undefined);

    const mockChanges = [
      {
        id: 23,
        type: 'pantry-delete' as const,
        date: '',
        payload: { id: 'temp-4' },
        createdAt: Date.now()
      }
    ];

    const runSync = setupSyncQueue([mockChanges, []]);

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await runSync(() => result.current.syncPendingChanges());
    });

    await waitFor(() => {
      expect(mockDeletePantryItem).not.toHaveBeenCalled();
      expect(mockRemovePendingChange).toHaveBeenCalledWith(23);
      expect(result.current.status).toBe('online');
    });
    warnSpy.mockRestore();
  });

  it('syncs meal idea adds and maps temp ids', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockCreateMealIdea.mockResolvedValue({ id: 'real-idea-1', title: 'Pasta', updated_at: '2026-01-01T00:00:00Z' });

    const mockChanges = [
      {
        id: 24,
        type: 'meal-idea-add' as const,
        date: '',
        payload: { id: 'temp-idea-1', title: 'Pasta' },
        createdAt: Date.now()
      }
    ];

    const runSync = setupSyncQueue([mockChanges, []]);

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await runSync(() => result.current.syncPendingChanges());
    });

    await waitFor(() => {
      expect(mockCreateMealIdea).toHaveBeenCalledWith({ title: 'Pasta' });
      expect(mockSaveTempIdMapping).toHaveBeenCalledWith('temp-idea-1', 'real-idea-1');
      expect(mockDeleteLocalMealIdea).toHaveBeenCalledWith('temp-idea-1');
      expect(mockSaveLocalMealIdea).toHaveBeenCalled();
      expect(mockRemovePendingChange).toHaveBeenCalledWith(24);
      expect(result.current.status).toBe('online');
    });
  });

  it('syncs meal idea updates with mapped temp ids', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue('real-idea');

    const mockChanges = [
      {
        id: 12,
        type: 'meal-idea-update' as const,
        date: '',
        payload: { id: 'temp-idea', title: 'Tacos' },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);

    renderHook(() => useSync());

    await waitFor(() => {
      expect(mockUpdateMealIdea).toHaveBeenCalledWith('real-idea', { title: 'Tacos' });
      expect(mockRemovePendingChange).toHaveBeenCalledWith(12);
    });
  });

  it('skips meal idea updates for unresolved temp ids', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue(undefined);

    const mockChanges = [
      {
        id: 25,
        type: 'meal-idea-update' as const,
        date: '',
        payload: { id: 'temp-idea-2', title: 'Burgers' },
        createdAt: Date.now()
      }
    ];

    const runSync = setupSyncQueue([mockChanges, []]);

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await runSync(() => result.current.syncPendingChanges());
    });

    await waitFor(() => {
      expect(mockUpdateMealIdea).not.toHaveBeenCalled();
      expect(mockRemovePendingChange).toHaveBeenCalledWith(25);
      expect(result.current.status).toBe('online');
    });
    warnSpy.mockRestore();
  });

  it('skips meal idea deletes for unresolved temp ids', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue(undefined);

    const mockChanges = [
      {
        id: 13,
        type: 'meal-idea-delete' as const,
        date: '',
        payload: { id: 'temp-idea' },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);

    renderHook(() => useSync());

    await waitFor(() => {
      expect(mockDeleteMealIdea).not.toHaveBeenCalled();
      expect(mockRemovePendingChange).toHaveBeenCalledWith(13);
    });
    warnSpy.mockRestore();
  });

  it('syncs meal idea deletes with mapped temp ids', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue('real-idea-2');
    mockDeleteMealIdea.mockResolvedValue();

    const mockChanges = [
      {
        id: 26,
        type: 'meal-idea-delete' as const,
        date: '',
        payload: { id: 'temp-idea-3' },
        createdAt: Date.now()
      }
    ];

    const runSync = setupSyncQueue([mockChanges, []]);

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await runSync(() => result.current.syncPendingChanges());
    });

    await waitFor(() => {
      expect(mockDeleteMealIdea).toHaveBeenCalledWith('real-idea-2');
      expect(mockRemovePendingChange).toHaveBeenCalledWith(26);
      expect(result.current.status).toBe('online');
    });
  });

  it('syncs calendar hide changes when online', async () => {
    mockUseOnlineStatus.mockReturnValue(true);

    const mockChanges = [
      {
        id: 14,
        type: 'calendar-hide' as const,
        date: '2024-01-01',
        payload: {
          tempId: 'temp-hidden-1',
          event_uid: 'uid-1',
          calendar_name: 'Personal',
          title: 'Event',
          start_time: '2024-01-01T10:00:00Z',
          end_time: null,
          all_day: false,
        },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);
    mockIsTempId.mockReturnValue(true);
    mockHideCalendarEvent.mockResolvedValue({
      id: 'hidden-1',
      event_uid: 'uid-1',
      event_date: '2024-01-01',
      calendar_name: 'Personal',
      title: 'Event',
      start_time: '2024-01-01T10:00:00Z',
      end_time: null,
      all_day: false,
    });

    renderHook(() => useSync());

    await waitFor(() => {
      expect(mockHideCalendarEvent).toHaveBeenCalled();
      expect(mockUpdateLocalHiddenEventId).toHaveBeenCalledWith(
        'temp-hidden-1',
        expect.objectContaining({ id: 'hidden-1' }),
      );
      expect(mockRemovePendingChange).toHaveBeenCalledWith(14);
    });
  });

  it('syncs calendar unhide changes when online', async () => {
    mockUseOnlineStatus.mockReturnValue(true);

    const mockChanges = [
      {
        id: 15,
        type: 'calendar-unhide' as const,
        date: '2024-01-02',
        payload: { hiddenId: 'hidden-2' },
        createdAt: Date.now()
      }
    ];

    mockGetPendingChanges.mockResolvedValue(mockChanges);
    mockIsTempId.mockReturnValue(false);

    renderHook(() => useSync());

    await waitFor(() => {
      expect(mockUnhideCalendarEvent).toHaveBeenCalledWith('hidden-2');
      expect(mockDeleteLocalHiddenEvent).toHaveBeenCalledWith('hidden-2');
      expect(mockRemovePendingChange).toHaveBeenCalledWith(15);
    });
  });

  it('syncs calendar unhide changes with mapped temp ids', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue('hidden-3');

    const mockChanges = [
      {
        id: 27,
        type: 'calendar-unhide' as const,
        date: '2024-01-03',
        payload: { hiddenId: 'temp-hidden-3' },
        createdAt: Date.now()
      }
    ];

    const runSync = setupSyncQueue([mockChanges, []]);

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await runSync(() => result.current.syncPendingChanges());
    });

    await waitFor(() => {
      expect(mockUnhideCalendarEvent).toHaveBeenCalledWith('hidden-3');
      expect(mockDeleteLocalHiddenEvent).toHaveBeenCalledWith('hidden-3');
      expect(mockRemovePendingChange).toHaveBeenCalledWith(27);
      expect(result.current.status).toBe('online');
    });
  });

  it('skips calendar unhide for unresolved temp ids', async () => {
    mockUseOnlineStatus.mockReturnValue(true);
    mockIsTempId.mockReturnValue(true);
    mockGetTempIdMapping.mockResolvedValue(undefined);

    const mockChanges = [
      {
        id: 28,
        type: 'calendar-unhide' as const,
        date: '2024-01-04',
        payload: { hiddenId: 'temp-hidden-4' },
        createdAt: Date.now()
      }
    ];

    const runSync = setupSyncQueue([mockChanges, []]);

    const { result } = renderHook(() => useSync());

    await act(async () => {
      await runSync(() => result.current.syncPendingChanges());
    });

    await waitFor(() => {
      expect(mockUnhideCalendarEvent).not.toHaveBeenCalled();
      expect(mockRemovePendingChange).toHaveBeenCalledWith(28);
      expect(result.current.status).toBe('online');
    });
  });
});
