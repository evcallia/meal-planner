import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGroceryList, resetGrocerySessionLoaded } from '../useGroceryList';
import type { GrocerySection } from '../../types';

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
}));

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(),
}));

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({ canUndo: false, canRedo: false, pushAction: vi.fn(), undo: vi.fn(), redo: vi.fn() }),
}));

import {
  getGroceryList,
  toggleGroceryItem as toggleGroceryItemAPI,
  addGroceryItem as addGroceryItemAPI,
  deleteGroceryItem as deleteGroceryItemAPI,
  editGroceryItem as editGroceryItemAPI,
  clearGroceryItems as clearGroceryItemsAPI,
  reorderGrocerySections as reorderGrocerySectionsAPI,
  reorderGroceryItems as reorderGroceryItemsAPI,
  renameGrocerySection as renameGrocerySectionAPI,
  moveGroceryItem as moveGroceryItemAPI,
  replaceGroceryList as replaceGroceryListAPI,
} from '../../api/client';
import { getLocalGrocerySections, getLocalGroceryItems, queueChange } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetGroceryList = vi.mocked(getGroceryList);
const mockToggleAPI = vi.mocked(toggleGroceryItemAPI);
const mockAddAPI = vi.mocked(addGroceryItemAPI);
const mockDeleteAPI = vi.mocked(deleteGroceryItemAPI);
const mockEditAPI = vi.mocked(editGroceryItemAPI);
const mockClearAPI = vi.mocked(clearGroceryItemsAPI);
const mockReorderSectionsAPI = vi.mocked(reorderGrocerySectionsAPI);
const mockReorderItemsAPI = vi.mocked(reorderGroceryItemsAPI);
const mockRenameSectionAPI = vi.mocked(renameGrocerySectionAPI);
const mockMoveItemAPI = vi.mocked(moveGroceryItemAPI);
const mockReplaceAPI = vi.mocked(replaceGroceryListAPI);
const mockGetLocalSections = vi.mocked(getLocalGrocerySections);
const mockGetLocalItems = vi.mocked(getLocalGroceryItems);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
const mockQueueChange = vi.mocked(queueChange);

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

describe('useGroceryList', () => {
  beforeEach(() => {
    resetGrocerySessionLoaded();
    vi.clearAllMocks();
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetLocalSections.mockResolvedValue([]);
    mockGetLocalItems.mockResolvedValue([]);
    mockGetGroceryList.mockResolvedValue(sampleSections);
  });

  it('loads grocery list from server when online', async () => {
    const { result } = renderHook(() => useGroceryList());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sections).toHaveLength(2);
    expect(result.current.sections[0].name).toBe('Produce');
    expect(result.current.sections[0].items).toHaveLength(2);
  });

  it('loads from local storage when offline', async () => {
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Local', position: 0 },
    ]);
    mockGetLocalItems.mockResolvedValue([
      { id: 'i1', section_id: 's1', name: 'Bread', quantity: null, checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const { result } = renderHook(() => useGroceryList());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sections[0].name).toBe('Local');
    expect(mockGetGroceryList).not.toHaveBeenCalled();
  });

  it('falls back to local storage on API error', async () => {
    mockGetGroceryList.mockRejectedValue(new Error('Network error'));
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Cached', position: 0 },
    ]);
    mockGetLocalItems.mockResolvedValue([]);

    const { result } = renderHook(() => useGroceryList());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sections[0].name).toBe('Cached');
  });

  it('toggleItem optimistically toggles checked state', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockToggleAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: true, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    await act(async () => {
      await result.current.toggleItem('i1', true);
    });

    // Item should be checked and sorted to bottom
    const section = result.current.sections.find(s => s.id === 's1')!;
    const item = section.items.find(i => i.id === 'i1')!;
    expect(item.checked).toBe(true);
    expect(mockToggleAPI).toHaveBeenCalledWith('i1', true);
  });

  it('addItem creates a new item', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockAddAPI.mockResolvedValue({
      id: 'server-1', section_id: 's1', name: 'Grapes', quantity: null,
      checked: false, position: 2, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    await act(async () => {
      await result.current.addItem('s1', 'grapes');
    });

    await waitFor(() => {
      const section = result.current.sections.find(s => s.id === 's1')!;
      expect(section.items.some(i => i.name === 'Grapes')).toBe(true);
    });
    expect(mockAddAPI).toHaveBeenCalledWith('s1', 'Grapes', null, null);
  });

  it('addItem merges duplicate unchecked items by summing quantities', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '5',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    // Bananas already has quantity '2', adding '3' more
    await act(async () => {
      await result.current.addItem('s1', 'Bananas', '3');
    });

    await waitFor(() => {
      const section = result.current.sections.find(s => s.id === 's1')!;
      const bananas = section.items.find(i => i.id === 'i1')!;
      expect(bananas.quantity).toBe('5');
    });
  });

  it('deleteItem removes item optimistically', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockDeleteAPI.mockResolvedValue({ status: 'ok' });

    await act(async () => {
      await result.current.deleteItem('i1');
    });

    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.find(i => i.id === 'i1')).toBeUndefined();
    expect(mockDeleteAPI).toHaveBeenCalledWith('i1');
  });

  it('editItem updates item name with title case', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Green Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    await act(async () => {
      await result.current.editItem('i1', { name: 'green bananas' });
    });

    const section = result.current.sections.find(s => s.id === 's1')!;
    const item = section.items.find(i => i.id === 'i1')!;
    expect(item.name).toBe('Green Bananas');
  });

  it('editItem updates quantity', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '5',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    await act(async () => {
      await result.current.editItem('i1', { quantity: '5' });
    });

    const section = result.current.sections.find(s => s.id === 's1')!;
    const item = section.items.find(i => i.id === 'i1')!;
    expect(item.quantity).toBe('5');
  });

  it('clearChecked removes checked items and empty sections', async () => {
    // Set up with a checked item
    mockGetGroceryList.mockResolvedValue([
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: true, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
      {
        id: 's2', name: 'Dairy', position: 1,
        items: [
          { id: 'i2', section_id: 's2', name: 'Milk', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);

    mockClearAPI.mockResolvedValue([]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.clearChecked();
    });

    // Produce section should be removed (all items were checked)
    expect(result.current.sections).toHaveLength(1);
    expect(result.current.sections[0].name).toBe('Dairy');
  });

  it('clearAll sets sections to empty', async () => {
    mockClearAPI.mockResolvedValue([]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.clearAll();
    });

    expect(result.current.sections).toEqual([]);
  });

  it('reorderSections reorders optimistically', async () => {
    mockReorderSectionsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.reorderSections(0, 1);
    });

    expect(result.current.sections[0].name).toBe('Dairy');
    expect(result.current.sections[1].name).toBe('Produce');
  });

  it('reorderItems reorders items within a section', async () => {
    mockReorderItemsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.reorderItems('s1', 0, 1);
    });

    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items[0].name).toBe('Apples');
    expect(section.items[1].name).toBe('Bananas');
  });

  it('renameSection renames optimistically', async () => {
    mockRenameSectionAPI.mockResolvedValue({
      id: 's1', name: 'Fruits', position: 0, items: [],
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.renameSection('s1', 'Fruits');
    });

    expect(result.current.sections[0].name).toBe('Fruits');
    expect(mockRenameSectionAPI).toHaveBeenCalledWith('s1', 'Fruits');
  });

  it('renameSection does nothing for empty name', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.renameSection('s1', '  ');
    });

    expect(mockRenameSectionAPI).not.toHaveBeenCalled();
  });

  it('moveItem moves item between sections', async () => {
    mockMoveItemAPI.mockResolvedValue({
      id: 'i1', section_id: 's2', name: 'Bananas', quantity: '2',
      checked: false, position: 1, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.moveItem('s1', 0, 's2', 0);
    });

    const fromSection = result.current.sections.find(s => s.id === 's1')!;
    const toSection = result.current.sections.find(s => s.id === 's2')!;
    expect(fromSection.items.find(i => i.id === 'i1')).toBeUndefined();
    expect(toSection.items.find(i => i.id === 'i1')).toBeDefined();
  });

  it('batchUpdateStoreId updates store_id on multiple items', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.batchUpdateStoreId(['i1', 'i3'], 'store-1');
    });

    const item1 = result.current.sections[0].items.find(i => i.id === 'i1')!;
    const item3 = result.current.sections[1].items.find(i => i.id === 'i3')!;
    expect(item1.store_id).toBe('store-1');
    expect(item3.store_id).toBe('store-1');
  });

  it('queues changes when offline', async () => {
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Produce', position: 0 },
    ]);
    mockGetLocalItems.mockResolvedValue([
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggleItem('i1', true);
    });

    expect(mockToggleAPI).not.toHaveBeenCalled();
    expect(mockQueueChange).toHaveBeenCalledWith('grocery-check', '', { id: 'i1', checked: true });
  });

  it('ignores non-grocery realtime events', async () => {
    mockGetGroceryList.mockResolvedValue(sampleSections);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetGroceryList.mockClear();

    // Non-grocery event should not trigger a refetch
    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: { type: 'pantry.updated' } }));
    });

    expect(mockGetGroceryList).not.toHaveBeenCalled();
  });

  it('refreshes on realtime grocery.updated event when no pending mutations', async () => {
    let fetchCount = 0;
    mockGetGroceryList.mockImplementation(() => {
      fetchCount++;
      return Promise.resolve(sampleSections);
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const initialFetchCount = fetchCount;

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: { type: 'grocery.updated' } }));
    });

    await waitFor(() => expect(fetchCount).toBe(initialFetchCount + 1));
  });

  it('mergeList merges parsed sections into existing list', async () => {
    mockReplaceAPI.mockResolvedValue([
      ...sampleSections,
      {
        id: 's3', name: 'Bakery', position: 2,
        items: [{ id: 'i4', section_id: 's3', name: 'Bread', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z' }],
      },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.mergeList([
        { name: 'Bakery', items: [{ name: 'Bread', quantity: '1' }] },
      ]);
    });

    await waitFor(() => {
      expect(result.current.sections.some(s => s.name === 'Bakery')).toBe(true);
    });
    expect(mockReplaceAPI).toHaveBeenCalled();
  });

  it('editItem updates store_id', async () => {
    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: false, position: 0, store_id: 'store-1', updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editItem('i1', { store_id: 'store-1' });
    });

    const item = result.current.sections[0].items.find(i => i.id === 'i1')!;
    expect(item.store_id).toBe('store-1');
  });

  it('dispatches grocery-count-changed event on section changes', async () => {
    const handler = vi.fn();
    window.addEventListener('grocery-count-changed', handler);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(handler).toHaveBeenCalled();
    const lastCall = handler.mock.calls[handler.mock.calls.length - 1][0];
    expect(lastCall.detail).toBe(3); // 3 unchecked items

    window.removeEventListener('grocery-count-changed', handler);
  });
});
