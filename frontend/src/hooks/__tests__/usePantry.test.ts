import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePantry } from '../usePantry';

vi.mock('../../api/client', () => ({
  getPantryList: vi.fn(),
  addPantryItem: vi.fn(),
  updatePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
  replacePantryList: vi.fn(),
  clearPantryItems: vi.fn(),
  reorderPantrySections: vi.fn(),
  reorderPantryItems: vi.fn(),
  renamePantrySection: vi.fn(),
}));

vi.mock('../../db', () => ({
  generateTempId: vi.fn(() => `temp-${Date.now()}`),
  isTempId: vi.fn((id: string) => id.startsWith('temp-')),
  queueChange: vi.fn(),
  saveLocalPantryItem: vi.fn(),
  saveLocalPantryItems: vi.fn(),
  getLocalPantryItems: vi.fn(() => Promise.resolve([])),
  getLocalPantrySections: vi.fn(() => Promise.resolve([])),
  saveLocalPantrySections: vi.fn(),
  deleteLocalPantryItem: vi.fn(),
  clearLocalPantryItems: vi.fn(),
}));

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(),
}));

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({ canUndo: false, canRedo: false, pushAction: vi.fn(), undo: vi.fn(), redo: vi.fn() }),
}));

import { getPantryList, addPantryItem, updatePantryItem, deletePantryItem } from '../../api/client';
import { getLocalPantrySections, getLocalPantryItems, saveLocalPantrySections, saveLocalPantryItems } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

describe('usePantry', () => {
  const mockGetPantryList = vi.mocked(getPantryList);
  const mockAddPantryItem = vi.mocked(addPantryItem);
  const mockUpdatePantryItem = vi.mocked(updatePantryItem);
  const mockDeletePantryItem = vi.mocked(deletePantryItem);
  const mockGetLocalPantrySections = vi.mocked(getLocalPantrySections);
  const mockGetLocalPantryItems = vi.mocked(getLocalPantryItems);
  const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetLocalPantrySections.mockResolvedValue([]);
    mockGetLocalPantryItems.mockResolvedValue([]);
  });

  it('loads pantry sections from the server', async () => {
    mockGetPantryList.mockResolvedValueOnce([
      {
        id: 's1', name: 'Fridge', position: 0,
        items: [
          { id: '1', section_id: 's1', name: 'Milk', quantity: 1, position: 0, updated_at: '2026-02-03T10:00:00Z' },
          { id: '2', section_id: 's1', name: 'Eggs', quantity: 12, position: 1, updated_at: '2026-02-03T10:00:00Z' },
        ],
      },
    ]);

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.sections).toHaveLength(1));
    expect(result.current.sections[0].name).toBe('Fridge');
    expect(result.current.sections[0].items).toHaveLength(2);
    expect(result.current.sections[0].items[0].name).toBe('Milk');
  });

  it('adds a pantry item to a section via the API', async () => {
    mockGetPantryList.mockResolvedValueOnce([
      { id: 's1', name: 'General', position: 0, items: [] },
    ]);
    mockAddPantryItem.mockResolvedValue({
      id: 'new-1', section_id: 's1', name: 'Meatballs', quantity: 1, position: 0, updated_at: '2026-02-03T11:00:00Z',
    });

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.sections).toHaveLength(1));

    await act(async () => {
      await result.current.addItem('s1', 'Meatballs', 1);
    });

    await waitFor(() => {
      expect(mockAddPantryItem).toHaveBeenCalledWith('s1', 'Meatballs', 1);
      expect(result.current.sections[0].items).toHaveLength(1);
    });
  });

  it('debounces updates before calling the API', async () => {
    mockGetPantryList.mockResolvedValueOnce([
      {
        id: 's1', name: 'General', position: 0,
        items: [{ id: '1', section_id: 's1', name: 'Milk', quantity: 1, position: 0, updated_at: '2026-02-03T11:00:00Z' }],
      },
    ]);
    mockUpdatePantryItem.mockResolvedValue({
      id: '1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-02-03T11:05:00Z',
    });

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.sections[0]?.items).toHaveLength(1));

    vi.useFakeTimers();

    act(() => {
      result.current.updateItem('1', { quantity: 2 });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockUpdatePantryItem).toHaveBeenCalledWith('1', { name: undefined, quantity: 2 });
    vi.useRealTimers();
  });

  it('removes pantry items via the API', async () => {
    mockGetPantryList.mockResolvedValueOnce([
      {
        id: 's1', name: 'General', position: 0,
        items: [{ id: '1', section_id: 's1', name: 'Bread', quantity: 1, position: 0, updated_at: '2026-02-03T12:00:00Z' }],
      },
    ]);
    mockDeletePantryItem.mockResolvedValue();

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.sections[0]?.items).toHaveLength(1));

    await act(async () => {
      await result.current.removeItem('1');
    });

    await waitFor(() => {
      expect(mockDeletePantryItem).toHaveBeenCalledWith('1');
      expect(result.current.sections[0].items).toHaveLength(0);
    });
  });

  it('refreshes when a realtime pantry update arrives', async () => {
    let callCount = 0;
    mockGetPantryList.mockImplementation(() => {
      callCount++;
      return Promise.resolve(
        callCount > 1
          ? [{ id: 's1', name: 'General', position: 0, items: [{ id: '1', section_id: 's1', name: 'Rice', quantity: 1, position: 0, updated_at: '2026-02-03T13:00:00Z' }] }]
          : [{ id: 's1', name: 'General', position: 0, items: [] }]
      );
    });

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(mockGetPantryList).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.sections[0]?.items).toHaveLength(0));

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: { type: 'pantry.updated' } }));
    });

    await waitFor(() => expect(mockGetPantryList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.sections[0]?.items).toHaveLength(1));
  });
});
