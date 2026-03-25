import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStores } from '../useStores';
import type { Store } from '../../types';

vi.mock('../../api/client', () => ({
  getStores: vi.fn(),
  createStore: vi.fn(),
  updateStore: vi.fn(),
  deleteStore: vi.fn(),
  reorderStores: vi.fn(),
  editGroceryItem: vi.fn(),
}));

vi.mock('../../db', () => ({
  saveLocalStores: vi.fn(),
  getLocalStores: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(),
}));

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({ canUndo: false, canRedo: false, pushAction: vi.fn(), undo: vi.fn(), redo: vi.fn() }),
}));

import {
  getStores as getStoresAPI,
  createStore as createStoreAPI,
  updateStore as updateStoreAPI,
  deleteStore as deleteStoreAPI,
  reorderStores as reorderStoresAPI,
} from '../../api/client';
import { getLocalStores } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetStoresAPI = vi.mocked(getStoresAPI);
const mockCreateStoreAPI = vi.mocked(createStoreAPI);
const mockUpdateStoreAPI = vi.mocked(updateStoreAPI);
const mockDeleteStoreAPI = vi.mocked(deleteStoreAPI);
const mockReorderStoresAPI = vi.mocked(reorderStoresAPI);
const mockGetLocalStores = vi.mocked(getLocalStores);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

const sampleStores: Store[] = [
  { id: 'st1', name: 'Costco', position: 0 },
  { id: 'st2', name: "Trader Joe's", position: 1 },
];

describe('useStores', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetLocalStores.mockResolvedValue([]);
    mockGetStoresAPI.mockResolvedValue(sampleStores);
  });

  it('loads stores from server when online', async () => {
    const { result } = renderHook(() => useStores());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stores).toHaveLength(2);
    expect(result.current.stores[0].name).toBe('Costco');
  });

  it('loads from local storage when offline', async () => {
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetLocalStores.mockResolvedValue([
      { id: 'st1', name: 'Local Store', position: 0 },
    ]);

    const { result } = renderHook(() => useStores());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stores[0].name).toBe('Local Store');
    expect(mockGetStoresAPI).not.toHaveBeenCalled();
  });

  it('falls back to local on API error', async () => {
    mockGetStoresAPI.mockRejectedValue(new Error('fail'));
    mockGetLocalStores.mockResolvedValue([
      { id: 'st1', name: 'Cached', position: 0 },
    ]);

    const { result } = renderHook(() => useStores());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.stores[0].name).toBe('Cached');
  });

  it('createStore calls API and adds to state', async () => {
    const newStore: Store = { id: 'st3', name: 'Whole Foods', position: 2 };
    mockCreateStoreAPI.mockResolvedValue(newStore);
    // After settle, loadStores will re-fetch — return updated list
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores); // initial load
    mockGetStoresAPI.mockResolvedValue([...sampleStores, newStore]);

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let created: Store | null = null;
    await act(async () => {
      created = await result.current.createStore('Whole Foods');
    });

    expect(created).toEqual(newStore);
    expect(result.current.stores).toHaveLength(3);
    expect(mockCreateStoreAPI).toHaveBeenCalledWith('Whole Foods');
  });

  it('createStore returns null on error', async () => {
    mockCreateStoreAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let created: Store | null = null;
    await act(async () => {
      created = await result.current.createStore('Bad Store');
    });

    expect(created).toBeNull();
  });

  it('renameStore optimistically updates name', async () => {
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1', name: 'New Costco', position: 0 });
    // After settle, loadStores will re-fetch — return renamed store
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores); // initial load
    mockGetStoresAPI.mockResolvedValue([{ id: 'st1', name: 'New Costco', position: 0 }, sampleStores[1]]);

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.renameStore('st1', 'New Costco');
    });

    expect(result.current.stores[0].name).toBe('New Costco');
    expect(mockUpdateStoreAPI).toHaveBeenCalledWith('st1', { name: 'New Costco' });
  });

  it('removeStore removes from state and calls API', async () => {
    mockDeleteStoreAPI.mockResolvedValue({ status: 'ok' });
    // After settle, loadStores will re-fetch — return without deleted store
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores); // initial load
    mockGetStoresAPI.mockResolvedValue([sampleStores[1]]);

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.removeStore('st1');
    });

    expect(result.current.stores).toHaveLength(1);
    expect(result.current.stores[0].name).toBe("Trader Joe's");
    expect(mockDeleteStoreAPI).toHaveBeenCalledWith('st1');
  });

  it('reorderStores reorders optimistically', async () => {
    mockReorderStoresAPI.mockResolvedValue({ status: 'ok' });
    // After settle, loadStores will re-fetch — return reordered
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores); // initial load
    mockGetStoresAPI.mockResolvedValue([
      { id: 'st2', name: "Trader Joe's", position: 0 },
      { id: 'st1', name: 'Costco', position: 1 },
    ]);

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.reorderStores(0, 1);
    });

    expect(result.current.stores[0].name).toBe("Trader Joe's");
    expect(result.current.stores[1].name).toBe('Costco');
  });

  it('reloads on realtime stores.updated event', async () => {
    let fetchCount = 0;
    mockGetStoresAPI.mockImplementation(() => {
      fetchCount++;
      return Promise.resolve(sampleStores);
    });

    renderHook(() => useStores());
    await waitFor(() => expect(fetchCount).toBeGreaterThan(0));
    const initial = fetchCount;

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: { type: 'stores.updated' } }));
    });

    await waitFor(() => expect(fetchCount).toBe(initial + 1));
  });
});
