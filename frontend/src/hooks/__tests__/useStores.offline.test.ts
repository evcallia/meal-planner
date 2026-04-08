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
import { queueChange, saveLocalStores } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetStoresAPI = vi.mocked(getStoresAPI);
const mockCreateStoreAPI = vi.mocked(createStoreAPI);
const mockUpdateStoreAPI = vi.mocked(updateStoreAPI);
const mockDeleteStoreAPI = vi.mocked(deleteStoreAPI);
const mockReorderStoresAPI = vi.mocked(reorderStoresAPI);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
const mockQueueChange = vi.mocked(queueChange);
const mockSaveLocalStores = vi.mocked(saveLocalStores);

const sampleStores: Store[] = [
  { id: 'st1', name: 'Costco', position: 0 },
  { id: 'st2', name: "Trader Joe's", position: 1 },
];

describe('useStores - offline operations', () => {
  beforeEach(() => {
    resetStoresSessionLoaded();
    vi.clearAllMocks();
    pushActionCalls.length = 0;
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetStoresAPI.mockResolvedValue(sampleStores);
  });

  it('createStore while offline creates temp store and queues store-create', async () => {
    // Start with stores loaded from API when briefly online, then go offline
    mockUseOnlineStatus.mockReturnValue(false);

    const { result } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.createStore('Whole Foods'); });

    expect(mockQueueChange).toHaveBeenCalledWith('store-create', '', expect.objectContaining({
      name: 'Whole Foods',
      tempId: expect.any(String),
    }));
    // Should have added the store to local state
    expect(result.current.stores.some(s => s.name === 'Whole Foods')).toBe(true);
  });

  it('renameStore while offline queues store-rename', async () => {
    // Load stores from API first (online)
    mockUseOnlineStatus.mockReturnValue(true);
    const { result, rerender } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Switch to offline
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await result.current.renameStore('st1', 'New Costco'); });

    expect(mockQueueChange).toHaveBeenCalledWith('store-rename', '', { storeId: 'st1', name: 'New Costco' });
    expect(result.current.stores[0].name).toBe('New Costco');
  });

  it('removeStore while offline queues store-delete', async () => {
    // Load stores from API first (online)
    mockUseOnlineStatus.mockReturnValue(true);
    const { result, rerender } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Switch to offline
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await result.current.removeStore('st1'); });

    expect(mockQueueChange).toHaveBeenCalledWith('store-delete', '', { name: 'Costco' });
    expect(result.current.stores).toHaveLength(1);
    expect(result.current.stores[0].id).toBe('st2');
  });

  it('reorderStores while offline queues store-reorder', async () => {
    // Load stores from API first (online)
    mockUseOnlineStatus.mockReturnValue(true);
    const { result, rerender } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Switch to offline
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await result.current.reorderStores(0, 1); });

    expect(mockQueueChange).toHaveBeenCalledWith('store-reorder', '', expect.objectContaining({
      storeIds: expect.any(Array),
    }));
    expect(result.current.stores[0].name).toBe("Trader Joe's");
    expect(result.current.stores[1].name).toBe('Costco');
  });
});

describe('useStores - offline undo/redo', () => {
  beforeEach(() => {
    resetStoresSessionLoaded();
    vi.clearAllMocks();
    pushActionCalls.length = 0;
    // Start online for the initial action
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetStoresAPI.mockResolvedValue(sampleStores);
  });

  it('renameStore undo while offline queues store-rename', async () => {
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1', name: 'New Costco', position: 0 });

    const { result, rerender } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Rename online
    await act(async () => { await result.current.renameStore('st1', 'New Costco'); });
    expect(result.current.stores[0].name).toBe('New Costco');

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('store-rename', '', { storeId: 'st1', name: 'Costco' });
    expect(result.current.stores[0].name).toBe('Costco');
  });

  it('renameStore redo while offline queues store-rename', async () => {
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1', name: 'New Costco', position: 0 });

    const { result, rerender } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Rename and undo online
    await act(async () => { await result.current.renameStore('st1', 'New Costco'); });
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1', name: 'Costco', position: 0 });
    await act(async () => { await pushActionCalls[0].undo(); });

    // Switch to offline and redo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].redo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('store-rename', '', { storeId: 'st1', name: 'New Costco' });
    expect(result.current.stores[0].name).toBe('New Costco');
  });

  it('removeStore undo while offline restores store locally', async () => {
    mockDeleteStoreAPI.mockResolvedValue({ status: 'ok' });

    const { result, rerender } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Remove online
    await act(async () => { await result.current.removeStore('st1'); });
    expect(result.current.stores).toHaveLength(1);

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockSaveLocalStores.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    // Store should be restored in local state
    expect(result.current.stores).toHaveLength(2);
    expect(result.current.stores.some(s => s.name === 'Costco')).toBe(true);
    // Should save to local stores
    expect(mockSaveLocalStores).toHaveBeenCalled();
  });

  it('removeStore redo while offline queues store-delete', async () => {
    mockDeleteStoreAPI.mockResolvedValue({ status: 'ok' });
    mockCreateStoreAPI.mockResolvedValue({ id: 'st1-new', name: 'Costco', position: 0 });
    mockUpdateStoreAPI.mockResolvedValue({ id: 'st1-new', name: 'Costco', position: 0 });

    const { result, rerender } = renderHook(() => useStores());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Remove and undo online
    await act(async () => { await result.current.removeStore('st1'); });
    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.stores).toHaveLength(2);

    // Switch to offline and redo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].redo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('store-delete', '', { name: 'Costco' });
    expect(result.current.stores.find(s => s.name.toLowerCase() === 'costco')).toBeUndefined();
  });
});
