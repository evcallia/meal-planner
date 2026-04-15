import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGroceryList, resetGrocerySessionLoaded } from '../useGroceryList';
import type { GrocerySection } from '../../types';

const pushActionCalls: any[] = [];

vi.mock('../../api/client', () => ({
  getGroceryList: vi.fn(),
  replaceGroceryList: vi.fn(),
  toggleGroceryItem: vi.fn(),
  addGroceryItem: vi.fn(),
  deleteGroceryItem: vi.fn(),
  editGroceryItem: vi.fn(),
  clearGroceryItems: vi.fn(),
  reorderGrocerySections: vi.fn(),
  reorderGroceryItems: vi.fn(),
  renameGrocerySection: vi.fn(),
  moveGroceryItem: vi.fn(),
  deleteItemDefault: vi.fn(() => Promise.resolve()),
  putItemDefault: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../db', () => ({
  generateTempId: vi.fn(() => `temp-${Math.random().toString(36).slice(2)}`),
  queueChange: vi.fn(),
  saveLocalGrocerySections: vi.fn(),
  saveLocalGroceryItems: vi.fn(),
  getLocalGrocerySections: vi.fn(() => Promise.resolve([])),
  getLocalGroceryItems: vi.fn(() => Promise.resolve([])),
  saveLocalGroceryItem: vi.fn(),
  deleteLocalGroceryItem: vi.fn(),
  getPendingChanges: vi.fn(() => Promise.resolve([])),
  saveTempIdMapping: vi.fn(),
  getTempIdMapping: vi.fn(() => Promise.resolve(undefined)),
  isTempId: vi.fn((id: string) => id.startsWith('temp-')),
  getLocalItemDefaults: vi.fn(() => Promise.resolve([])),
  deleteLocalItemDefault: vi.fn(() => Promise.resolve()),
  putLocalItemDefault: vi.fn(() => Promise.resolve()),
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
  getGroceryList,
  addGroceryItem as addGroceryItemAPI,
  deleteGroceryItem as deleteGroceryItemAPI,
  editGroceryItem as editGroceryItemAPI,
  toggleGroceryItem as toggleGroceryItemAPI,
  clearGroceryItems as clearGroceryItemsAPI,
  replaceGroceryList as replaceGroceryListAPI,
  reorderGrocerySections as reorderGrocerySectionsAPI,
  moveGroceryItem as moveGroceryItemAPI,
} from '../../api/client';
import { queueChange, saveLocalGrocerySections, saveLocalGroceryItems, saveLocalGroceryItem, deleteLocalGroceryItem } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetGroceryList = vi.mocked(getGroceryList);
const mockAddAPI = vi.mocked(addGroceryItemAPI);
const mockDeleteAPI = vi.mocked(deleteGroceryItemAPI);
const mockEditAPI = vi.mocked(editGroceryItemAPI);
const mockToggleAPI = vi.mocked(toggleGroceryItemAPI);
const mockClearAPI = vi.mocked(clearGroceryItemsAPI);
const mockReplaceAPI = vi.mocked(replaceGroceryListAPI);
const mockReorderSectionsAPI = vi.mocked(reorderGrocerySectionsAPI);
const mockMoveItemAPI = vi.mocked(moveGroceryItemAPI);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
const mockQueueChange = vi.mocked(queueChange);
const mockSaveLocalSections = vi.mocked(saveLocalGrocerySections);
const mockSaveLocalItems = vi.mocked(saveLocalGroceryItems);
const mockSaveLocalItem = vi.mocked(saveLocalGroceryItem);
const mockDeleteLocalItem = vi.mocked(deleteLocalGroceryItem);

const sampleSections: GrocerySection[] = [
  {
    id: 's1', name: 'Produce', position: 0,
    items: [
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
      { id: 'i2', section_id: 's1', name: 'Apples', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
  {
    id: 's2', name: 'Dairy', position: 1,
    items: [
      { id: 'i3', section_id: 's2', name: 'Milk', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
];

/**
 * Tests for undo/redo operations while offline.
 *
 * Pattern: perform action online (mock API success), then switch to offline
 * via isOnlineRef (by changing useOnlineStatus return), then call undo/redo.
 * Verify that queueChange is called with the correct change type and payload.
 */
describe('useGroceryList offline undo/redo', () => {
  beforeEach(() => {
    resetGrocerySessionLoaded();
    vi.clearAllMocks();
    pushActionCalls.length = 0;
    // Start online for the initial action
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetGroceryList.mockResolvedValue(sampleSections);
  });

  it('addItem undo while offline queues grocery-delete', async () => {
    mockAddAPI.mockResolvedValue({
      id: 'server-1', section_id: 's1', name: 'Grapes', quantity: null,
      checked: false, position: 2, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Add item online
    await act(async () => { await result.current.addItem('s1', 'grapes'); });
    expect(pushActionCalls).toHaveLength(1);

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-delete', '', { id: 'server-1' });
  });

  it('addItem redo while offline queues grocery-add with store_id', async () => {
    mockAddAPI.mockResolvedValue({
      id: 'server-1', section_id: 's1', name: 'Grapes', quantity: null,
      checked: false, position: 2, store_id: 'st1', updated_at: '2026-01-02T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.addItem('s1', 'grapes'); });

    // Undo online first
    mockDeleteAPI.mockResolvedValue({ status: 'ok' });
    await act(async () => { await pushActionCalls[0].undo(); });

    // Switch to offline and redo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].redo(); });

    // resolvedStoreId is captured at addItem call time (null since no existing items had a store),
    // even though the server returned store_id 'st1' — the redo closure uses the original resolvedStoreId
    expect(mockQueueChange).toHaveBeenCalledWith('grocery-add', '', expect.objectContaining({
      sectionId: 's1',
      name: 'Grapes',
      store_id: null,
    }));
  });

  it('deleteItem undo while offline queues grocery-add and restores at original position', async () => {
    mockDeleteAPI.mockResolvedValue({ status: 'ok' });

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Delete item online
    await act(async () => { await result.current.deleteItem('i1'); });
    expect(pushActionCalls).toHaveLength(1);

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-add', '', expect.objectContaining({
      sectionId: 's1',
      name: 'Bananas',
      quantity: '2',
      store_id: null,
    }));

    // Item should be restored in state
    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.some(i => i.name === 'Bananas')).toBe(true);
  });

  it('deleteItem redo while offline queues grocery-delete', async () => {
    mockDeleteAPI.mockResolvedValue({ status: 'ok' });
    mockAddAPI.mockResolvedValue({
      id: 'restored-i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-03T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Delete and undo online
    await act(async () => { await result.current.deleteItem('i1'); });
    await act(async () => { await pushActionCalls[0].undo(); });

    // Switch to offline and redo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].redo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-delete', '', expect.objectContaining({
      id: expect.any(String),
    }));
  });

  it('editItem undo while offline queues grocery-edit', async () => {
    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Green Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Edit online
    await act(async () => { await result.current.editItem('i1', { name: 'green bananas' }); });

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-edit', '', expect.objectContaining({
      id: 'i1',
      name: 'Bananas',
    }));
    const item = result.current.sections[0].items.find(i => i.id === 'i1')!;
    expect(item.name).toBe('Bananas');
  });

  it('toggleItem undo while offline queues grocery-check', async () => {
    mockToggleAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: true, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Toggle online
    await act(async () => { await result.current.toggleItem('i1', true); });

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-check', '', { id: 'i1', checked: false });
  });

  it('clearChecked undo while offline queues grocery-replace and saves to IndexedDB', async () => {
    const sectionsWithChecked: GrocerySection[] = [
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: true, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'i2', section_id: 's1', name: 'Apples', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ];
    mockGetGroceryList.mockResolvedValue(sectionsWithChecked);
    mockClearAPI.mockResolvedValue([]);

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Clear checked online
    await act(async () => { await result.current.clearChecked(); });

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();
    mockSaveLocalSections.mockClear();
    mockSaveLocalItems.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-replace', '', expect.objectContaining({
      sections: expect.any(Array),
    }));
    // Should save to IndexedDB
    expect(mockSaveLocalSections).toHaveBeenCalled();
    expect(mockSaveLocalItems).toHaveBeenCalled();
    // Items should be restored
    expect(result.current.sections[0].items).toHaveLength(2);
  });

  it('clearAll undo while offline queues grocery-replace and saves to IndexedDB', async () => {
    mockClearAPI.mockResolvedValue([]);

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Clear all online
    await act(async () => { await result.current.clearAll(); });
    expect(result.current.sections).toEqual([]);

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();
    mockSaveLocalSections.mockClear();
    mockSaveLocalItems.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-replace', '', expect.objectContaining({
      sections: expect.any(Array),
    }));
    expect(mockSaveLocalSections).toHaveBeenCalled();
    expect(mockSaveLocalItems).toHaveBeenCalled();
    expect(result.current.sections).toHaveLength(2);
  });

  it('mergeList undo while offline queues grocery-replace', async () => {
    mockReplaceAPI.mockResolvedValue([
      ...sampleSections,
      {
        id: 's3', name: 'Bakery', position: 2,
        items: [{ id: 'i4', section_id: 's3', name: 'Bread', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z' }],
      },
    ]);

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Merge online
    await act(async () => {
      await result.current.mergeList([
        { name: 'Bakery', items: [{ name: 'Bread', quantity: '1' }] },
      ]);
    });

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-replace', '', expect.objectContaining({
      sections: expect.any(Array),
    }));
    expect(result.current.sections).toHaveLength(2);
  });

  it('mergeList redo while offline queues grocery-replace and saves to IndexedDB', async () => {
    mockReplaceAPI.mockResolvedValue([
      ...sampleSections,
      {
        id: 's3', name: 'Bakery', position: 2,
        items: [{ id: 'i4', section_id: 's3', name: 'Bread', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z' }],
      },
    ]);

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Merge and undo online
    await act(async () => {
      await result.current.mergeList([
        { name: 'Bakery', items: [{ name: 'Bread', quantity: '1' }] },
      ]);
    });
    mockReplaceAPI.mockResolvedValue(sampleSections);
    await act(async () => { await pushActionCalls[0].undo(); });

    // Switch to offline and redo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();
    mockSaveLocalSections.mockClear();
    mockSaveLocalItems.mockClear();

    await act(async () => { await pushActionCalls[0].redo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-replace', '', expect.objectContaining({
      sections: expect.any(Array),
    }));
    expect(mockSaveLocalSections).toHaveBeenCalled();
    expect(mockSaveLocalItems).toHaveBeenCalled();
  });

  it('reorderSections undo while offline queues grocery-reorder-sections', async () => {
    mockReorderSectionsAPI.mockResolvedValue({ status: 'ok' });

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Reorder online
    await act(async () => { await result.current.reorderSections(0, 1); });
    expect(result.current.sections[0].name).toBe('Dairy');

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-reorder-sections', '', {
      sectionIds: ['s1', 's2'],
    });
    expect(result.current.sections[0].name).toBe('Produce');
  });

  it('moveItem undo while offline queues grocery-move-item', async () => {
    mockMoveItemAPI.mockResolvedValue({
      id: 'i1', section_id: 's2', name: 'Bananas', quantity: '2',
      checked: false, position: 1, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Move online
    await act(async () => { await result.current.moveItem('s1', 0, 's2', 0); });

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-move-item', '', {
      id: 'i1',
      toSectionId: 's1',
      toPosition: 0,
    });
    const produceSection = result.current.sections.find(s => s.id === 's1')!;
    expect(produceSection.items.some(i => i.id === 'i1')).toBe(true);
  });
});
