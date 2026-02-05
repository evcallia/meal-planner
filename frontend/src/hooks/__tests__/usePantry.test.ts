import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePantry } from '../usePantry';

vi.mock('../../api/client', () => ({
  getPantryItems: vi.fn(),
  createPantryItem: vi.fn(),
  updatePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
}));

vi.mock('../../db', () => ({
  generateTempId: vi.fn(() => `temp-${Date.now()}`),
  isTempId: vi.fn((id: string) => id.startsWith('temp-')),
  queueChange: vi.fn(),
  saveLocalPantryItem: vi.fn(),
  getLocalPantryItems: vi.fn(() => Promise.resolve([])),
  deleteLocalPantryItem: vi.fn(),
  clearLocalPantryItems: vi.fn(),
}));

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(),
}));

import { getPantryItems, createPantryItem, updatePantryItem, deletePantryItem } from '../../api/client';
import { getLocalPantryItems, clearLocalPantryItems, saveLocalPantryItem } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

describe('usePantry', () => {
  const mockGetPantryItems = vi.mocked(getPantryItems);
  const mockCreatePantryItem = vi.mocked(createPantryItem);
  const mockUpdatePantryItem = vi.mocked(updatePantryItem);
  const mockDeletePantryItem = vi.mocked(deletePantryItem);
  const mockGetLocalPantryItems = vi.mocked(getLocalPantryItems);
  const mockClearLocalPantryItems = vi.mocked(clearLocalPantryItems);
  const mockSaveLocalPantryItem = vi.mocked(saveLocalPantryItem);
  const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
  const storage = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockUseOnlineStatus.mockReturnValue(true);
    storage.clear();
    mockGetLocalPantryItems.mockResolvedValue([]);
    mockClearLocalPantryItems.mockResolvedValue(undefined);
    mockSaveLocalPantryItem.mockResolvedValue(undefined);
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => storage.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      storage.set(key, String(value));
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      storage.delete(key);
    });
    vi.mocked(localStorage.clear).mockImplementation(() => {
      storage.clear();
    });
    localStorage.clear();
  });

  it('loads pantry items from the server and sorts by name', async () => {
    mockGetPantryItems.mockResolvedValueOnce([
      { id: '2', name: 'Tomatoes', quantity: 1, updated_at: '2026-02-03T10:00:00Z' },
      { id: '1', name: 'Apples', quantity: 2, updated_at: '2026-02-03T09:00:00Z' },
    ]);

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.items[0].name).toBe('Apples');
    expect(result.current.items[1].name).toBe('Tomatoes');
  });

  it('adds a pantry item via the API and refreshes the list', async () => {
    mockGetPantryItems
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: '1', name: 'Meatballs', quantity: 1, updated_at: '2026-02-03T11:00:00Z' }]);
    mockCreatePantryItem.mockResolvedValue({ id: '1', name: 'Meatballs', quantity: 1, updated_at: '2026-02-03T11:00:00Z' });

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.items).toHaveLength(0));

    await act(async () => {
      result.current.addItem({ name: 'Meatballs', quantity: 1 });
    });

    await waitFor(() => {
      expect(mockCreatePantryItem).toHaveBeenCalledWith({ name: 'Meatballs', quantity: 1 });
      expect(result.current.items).toHaveLength(1);
    });
  });

  it('debounces updates before calling the API', async () => {
    mockGetPantryItems
      .mockResolvedValueOnce([{ id: '1', name: 'Milk', quantity: 1, updated_at: '2026-02-03T11:00:00Z' }])
      .mockResolvedValueOnce([{ id: '1', name: 'Milk', quantity: 2, updated_at: '2026-02-03T11:05:00Z' }]);
    mockUpdatePantryItem.mockResolvedValue({ id: '1', name: 'Milk', quantity: 2, updated_at: '2026-02-03T11:05:00Z' });

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.items).toHaveLength(1));

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
    mockGetPantryItems
      .mockResolvedValueOnce([
        { id: '1', name: 'Bread', quantity: 1, updated_at: '2026-02-03T12:00:00Z' },
      ])
      .mockResolvedValueOnce([]);
    mockDeletePantryItem.mockResolvedValue();

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await act(async () => {
      result.current.removeItem('1');
    });

    await waitFor(() => {
      expect(mockDeletePantryItem).toHaveBeenCalledWith('1');
    });
  });

  it('refreshes when a realtime pantry update arrives', async () => {
    let shouldReturnUpdated = false;
    mockGetPantryItems.mockImplementation(() => Promise.resolve(
      shouldReturnUpdated
        ? [{ id: '1', name: 'Rice', quantity: 1, updated_at: '2026-02-03T13:00:00Z' }]
        : []
    ));

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(mockGetPantryItems).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.items).toHaveLength(0));

    shouldReturnUpdated = true;
    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: { type: 'pantry.updated' } }));
    });

    await waitFor(() => expect(mockGetPantryItems).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
  });

  it('hydrates from local storage only on the first load', async () => {
    localStorage.setItem('meal-planner-pantry', JSON.stringify([
      { id: 'local-1', name: 'Pasta', quantity: 1, updated_at: '2026-02-03T08:00:00Z' },
    ]));
    let created = false;
    mockCreatePantryItem.mockImplementation(async () => {
      created = true;
      return { id: 'server-1', name: 'Pasta', quantity: 1, updated_at: '2026-02-03T08:00:00Z' };
    });
    mockGetPantryItems.mockImplementation(() => Promise.resolve(
      created
        ? [{ id: 'server-1', name: 'Pasta', quantity: 1, updated_at: '2026-02-03T08:00:00Z' }]
        : []
    ));

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(mockCreatePantryItem).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    localStorage.setItem('meal-planner-pantry', JSON.stringify([
      { id: 'local-1', name: 'Pasta', quantity: 1, updated_at: '2026-02-03T08:00:00Z' },
    ]));

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: { type: 'pantry.updated' } }));
    });

    await waitFor(() => expect(mockGetPantryItems).toHaveBeenCalledTimes(3));
    expect(mockCreatePantryItem).toHaveBeenCalledTimes(1);
  });
});
