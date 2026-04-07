import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStores, resetStoresSessionLoaded } from '../useStores';
import type { Store } from '../../types';

const pushActionCalls: any[] = [];

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
  queueChange: vi.fn(),
  generateTempId: vi.fn(() => `temp-${Date.now()}`),
  getPendingChanges: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(),
}));

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({
    canUndo: false,
    canRedo: false,
    pushAction: vi.fn((action: any) => { pushActionCalls.push(action); }),
    undo: vi.fn(),
    redo: vi.fn(),
  }),
}));

import {
  getStores as getStoresAPI,
  createStore as createStoreAPI,
  updateStore as updateStoreAPI,
  deleteStore as deleteStoreAPI,
  reorderStores as reorderStoresAPI,
} from '../../api/client';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetStoresAPI = vi.mocked(getStoresAPI);
const mockCreateStoreAPI = vi.mocked(createStoreAPI);
const mockUpdateStoreAPI = vi.mocked(updateStoreAPI);
const mockDeleteStoreAPI = vi.mocked(deleteStoreAPI);
const mockReorderStoresAPI = vi.mocked(reorderStoresAPI);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

const sampleStores: Store[] = [
  { id: 'st1', name: 'Costco', position: 0 },
  { id: 'st2', name: "Trader Joe's", position: 1 },
];

describe('useStores undo/redo', () => {
  beforeEach(() => {
    resetStoresSessionLoaded();
    vi.clearAllMocks();
    pushActionCalls.length = 0;
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetStoresAPI.mockResolvedValue(sampleStores);
  });

  it('renameStore undo restores original name', async () => {
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1', name: 'New Costco', position: 0 });
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores); // initial load

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.renameStore('st1', 'New Costco'); });
    expect(result.current.stores[0].name).toBe('New Costco');
    expect(pushActionCalls[0].type).toBe('rename-store');

    // Undo
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1', name: 'Costco', position: 0 });
    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.stores[0].name).toBe('Costco');
  });

  it('renameStore redo re-applies the rename', async () => {
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1', name: 'New Costco', position: 0 });
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores);     // initial load

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.renameStore('st1', 'New Costco'); });
    await act(async () => { await pushActionCalls[0].undo(); });
    await act(async () => { await pushActionCalls[0].redo(); });
    expect(result.current.stores[0].name).toBe('New Costco');
  });

  it('removeStore undo re-creates the store', async () => {
    mockDeleteStoreAPI.mockResolvedValue({ status: 'ok' });
    mockCreateStoreAPI.mockResolvedValue({ id: 'st1-new', name: 'Costco', position: 0 });
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1-new', name: 'Costco', position: 0 });
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores);    // initial load

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.removeStore('st1'); });
    expect(result.current.stores).toHaveLength(1);
    expect(pushActionCalls[0].type).toBe('delete-store');

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.stores).toHaveLength(2);
  });

  it('removeStore redo removes the store from local state', async () => {
    mockDeleteStoreAPI.mockResolvedValue({ status: 'ok' });
    mockCreateStoreAPI.mockResolvedValue({ id: 'st1-new', name: 'Costco', position: 0 });
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1-new', name: 'Costco', position: 0 });
    const undoneStores = [{ id: 'st1-new', name: 'Costco', position: 0 }, sampleStores[1]];
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores);      // initial load
    mockGetStoresAPI.mockResolvedValue(undoneStores);           // redo's getStores call to find match

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.removeStore('st1'); });
    expect(result.current.stores).toHaveLength(1);

    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.stores).toHaveLength(2);

    // Redo: the redo function fetches current stores from API, finds the match, and deletes
    mockDeleteStoreAPI.mockResolvedValue({ status: 'ok' });
    await act(async () => { await pushActionCalls[0].redo(); });

    // Redo filters by name (case insensitive) from local state
    expect(result.current.stores.find(s => s.name.toLowerCase() === 'costco')).toBeUndefined();
  });

  it('removeStore with grocery items nulls out store_id via callback', async () => {
    mockDeleteStoreAPI.mockResolvedValue({ status: 'ok' });
    mockGetStoresAPI.mockResolvedValueOnce(sampleStores);    // initial load

    const onItemsStoreChanged = vi.fn();
    const grocerySections = [
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: 'st1', updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ];

    const { result } = renderHook(() => useStores({
      grocerySections,
      onItemsStoreChanged,
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.removeStore('st1'); });

    expect(onItemsStoreChanged).toHaveBeenCalledWith(['i1'], null);
  });

  it('renameStore does nothing when name unchanged', async () => {
    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.renameStore('st1', 'Costco'); });

    expect(mockUpdateStoreAPI).not.toHaveBeenCalled();
  });
});
