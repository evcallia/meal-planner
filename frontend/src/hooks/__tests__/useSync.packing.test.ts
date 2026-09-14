import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSync, __resetAuthRequiredForTests } from '../useSync';
import type { PendingChange } from '../../db';

// Draining queued Lists-tab (packing) changes: temp ids created offline must be
// rewritten to the server ids recorded when their create synced, and a change
// whose parent create never landed must be dropped rather than retried forever.

vi.mock('../useOnlineStatus', () => ({ useOnlineStatus: vi.fn() }));

vi.mock('../../db', () => ({
  getPendingChanges: vi.fn(),
  removePendingChange: vi.fn(),
  clearPendingChanges: vi.fn(),
  isTempId: (id: string) => typeof id === 'string' && id.startsWith('temp-'),
  saveTempIdMapping: vi.fn(),
  getTempIdMapping: vi.fn(),
  deleteLocalPantryItem: vi.fn(),
  saveLocalPantryItem: vi.fn(),
  deleteLocalGroceryItem: vi.fn(),
  saveLocalGroceryItem: vi.fn(),
  saveLocalGrocerySection: vi.fn(),
  deleteLocalMealIdea: vi.fn(),
  saveLocalMealIdea: vi.fn(),
  updateLocalHiddenEventId: vi.fn(),
  deleteLocalHiddenEvent: vi.fn(),
  db: { pendingChanges: { toArray: vi.fn(), update: vi.fn() } },
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    createPackingList: vi.fn(),
    createPackingSection: vi.fn(),
    addPackingItem: vi.fn(),
    editPackingItem: vi.fn(),
    checkAllPackingItems: vi.fn(),
    createPackingBag: vi.fn(),
    reorderPackingItems: vi.fn(),
  };
});

import { useOnlineStatus } from '../useOnlineStatus';
import { getPendingChanges, removePendingChange, getTempIdMapping, saveTempIdMapping } from '../../db';
import {
  createPackingList, createPackingSection, addPackingItem, editPackingItem,
  checkAllPackingItems, createPackingBag, reorderPackingItems,
} from '../../api/client';

const mockOnline = vi.mocked(useOnlineStatus);
const mockGetPending = vi.mocked(getPendingChanges);
const mockRemovePending = vi.mocked(removePendingChange);
const mockGetMapping = vi.mocked(getTempIdMapping);
const mockSaveMapping = vi.mocked(saveTempIdMapping);

const change = (type: string, payload: unknown, id = 1): PendingChange =>
  ({ id, type: type as PendingChange['type'], date: '', payload, createdAt: Date.now(), attempts: 0 });

// The 5s poll in useSync also calls getPendingChanges, so the queue is only
// served while our own drain is in flight (mirrors setupSyncQueue in
// useSync.test.ts).
async function drain(changes: PendingChange[]) {
  let inSync = false;
  const queue: PendingChange[][] = [changes, []];
  mockGetPending.mockImplementation(() => Promise.resolve(inSync ? (queue.shift() ?? []) : []));
  const { result } = renderHook(() => useSync());
  await act(async () => {
    inSync = true;
    try { await result.current.syncPendingChanges(); } finally { inSync = false; }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAuthRequiredForTests();
  mockOnline.mockReturnValue(true);
  mockGetMapping.mockResolvedValue(undefined);
  mockGetPending.mockResolvedValue([]);
});

describe('useSync — packing changes', () => {
  it('creates a queued list and records its temp→real mapping', async () => {
    vi.mocked(createPackingList).mockResolvedValue({ id: 'real-list' } as any);
    await drain([change('packing-list-create', { tempId: 'temp-l', name: 'Paris', color: 'blue' })]);

    expect(createPackingList).toHaveBeenCalledWith({ name: 'Paris', color: 'blue' });
    expect(mockSaveMapping).toHaveBeenCalledWith('temp-l', 'real-list');
    expect(mockRemovePending).toHaveBeenCalledWith(1);
  });

  it('resolves a temp list id when creating a queued section', async () => {
    mockGetMapping.mockResolvedValue('real-list');
    vi.mocked(createPackingSection).mockResolvedValue({ id: 'real-section' } as any);
    await drain([change('packing-section-create', { tempId: 'temp-s', listId: 'temp-l', name: 'Clothes', position: 0 })]);

    expect(createPackingSection).toHaveBeenCalledWith('real-list', 'Clothes', 0);
    expect(mockSaveMapping).toHaveBeenCalledWith('temp-s', 'real-section');
  });

  it('drops a change whose parent create never synced', async () => {
    mockGetMapping.mockResolvedValue(undefined);
    await drain([change('packing-item-add', { id: 'temp-i', sectionId: 'temp-s', name: 'Socks', quantity: null })]);

    expect(addPackingItem).not.toHaveBeenCalled();
    expect(mockRemovePending).toHaveBeenCalledWith(1);
  });

  it('re-applies the checked flag on a queued add', async () => {
    vi.mocked(addPackingItem).mockResolvedValue({ id: 'real-item' } as any);
    vi.mocked(editPackingItem).mockResolvedValue({} as any);
    await drain([change('packing-item-add', { id: 'temp-i', sectionId: 's1', name: 'Socks', quantity: '2', bag_id: null, checked: true })]);

    expect(addPackingItem).toHaveBeenCalledWith('s1', 'Socks', '2', null);
    expect(editPackingItem).toHaveBeenCalledWith('real-item', { checked: true });
    expect(mockSaveMapping).toHaveBeenCalledWith('temp-i', 'real-item');
  });

  it('sends only the fields a queued edit actually changed', async () => {
    vi.mocked(editPackingItem).mockResolvedValue({} as any);
    await drain([change('packing-item-edit', { id: 'i1', checked: true })]);
    expect(editPackingItem).toHaveBeenCalledWith('i1', { checked: true });
  });

  it('replays a bulk check', async () => {
    vi.mocked(checkAllPackingItems).mockResolvedValue({} as any);
    await drain([change('packing-check-all', { listId: 'l1', checked: false })]);
    expect(checkAllPackingItems).toHaveBeenCalledWith('l1', false);
  });

  it('maps temp ids inside a queued reorder', async () => {
    mockGetMapping.mockImplementation(async (id: string) => (id === 'temp-i' ? 'real-i' : undefined));
    vi.mocked(reorderPackingItems).mockResolvedValue({ status: 'ok' });
    await drain([change('packing-items-reorder', { sectionId: 's1', itemIds: ['i1', 'temp-i'] })]);
    expect(reorderPackingItems).toHaveBeenCalledWith('s1', ['i1', 'real-i']);
  });

  it('creates a queued bag against its resolved list', async () => {
    mockGetMapping.mockResolvedValue('real-list');
    vi.mocked(createPackingBag).mockResolvedValue({ id: 'real-bag' } as any);
    await drain([change('packing-bag-create', { tempId: 'temp-b', listId: 'temp-l', name: 'Carry On', position: 0 })]);
    expect(createPackingBag).toHaveBeenCalledWith('real-list', 'Carry On', 0);
    expect(mockSaveMapping).toHaveBeenCalledWith('temp-b', 'real-bag');
  });
});
