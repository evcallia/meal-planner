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
  saveTempIdMapping: vi.fn(),
  getTempIdMapping: vi.fn(() => Promise.resolve(undefined)),
  isTempId: vi.fn((id: string) => id.startsWith('temp-')),
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
  replaceGroceryList as replaceGroceryListAPI,
  clearGroceryItems as clearGroceryItemsAPI,
  reorderGrocerySections as reorderGrocerySectionsAPI,
  reorderGroceryItems as reorderGroceryItemsAPI,
  renameGrocerySection as renameGrocerySectionAPI,
} from '../../api/client';
import { getLocalGrocerySections, getLocalGroceryItems, queueChange, saveLocalGrocerySections, saveLocalGroceryItems } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetGroceryList = vi.mocked(getGroceryList);
const mockReplaceAPI = vi.mocked(replaceGroceryListAPI);
const mockClearAPI = vi.mocked(clearGroceryItemsAPI);
const mockReorderSectionsAPI = vi.mocked(reorderGrocerySectionsAPI);
const mockReorderItemsAPI = vi.mocked(reorderGroceryItemsAPI);
const mockRenameSectionAPI = vi.mocked(renameGrocerySectionAPI);
const mockGetLocalSections = vi.mocked(getLocalGrocerySections);
const mockGetLocalItems = vi.mocked(getLocalGroceryItems);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
const mockQueueChange = vi.mocked(queueChange);

const sampleSections: GrocerySection[] = [
  {
    id: 's1', name: 'Produce', position: 0,
    items: [
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
];

describe('useGroceryList - offline operations', () => {
  beforeEach(() => {
    resetGrocerySessionLoaded();
    vi.clearAllMocks();
    pushActionCalls.length = 0;
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Produce', position: 0 },
    ]);
    mockGetLocalItems.mockResolvedValue([
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('addItem queues change when offline', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addItem('s1', 'Apples');
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-add', '', expect.objectContaining({ sectionId: 's1', name: 'Apples' }));
  });

  it('deleteItem queues change when offline', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.deleteItem('i1');
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-delete', '', { id: 'i1', name: 'Bananas' });
  });

  it('editItem queues change when offline', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editItem('i1', { name: 'green bananas' });
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-edit', '', expect.objectContaining({ id: 'i1', name: 'Green Bananas' }));
  });

  it('clearChecked queues change when offline', async () => {
    mockGetLocalItems.mockResolvedValue([
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: true, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.clearChecked();
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-clear', '', { mode: 'checked' });
  });

  it('clearAll queues change when offline', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.clearAll();
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-clear', '', { mode: 'all' });
  });

  it('reorderSections queues change when offline', async () => {
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Produce', position: 0 },
      { id: 's2', name: 'Dairy', position: 1 },
    ]);
    mockGetLocalItems.mockResolvedValue([
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
      { id: 'i2', section_id: 's2', name: 'Milk', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.reorderSections(0, 1);
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-reorder-sections', '', expect.objectContaining({ sectionIds: expect.any(Array) }));
  });

  it('renameSection queues change when offline', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.renameSection('s1', 'Fruits');
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-rename-section', '', { sectionId: 's1', name: 'Fruits' });
  });

  it('mergeList queues change when offline', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.mergeList([
        { name: 'Produce', items: [{ name: 'Apples', quantity: null }] },
      ]);
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-replace', '', expect.objectContaining({ sections: expect.any(Array) }));
  });

  it('reorderItems queues change when offline', async () => {
    mockGetLocalItems.mockResolvedValue([
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
      { id: 'i2', section_id: 's1', name: 'Apples', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.reorderItems('s1', 0, 1);
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-reorder-items', '', expect.objectContaining({ sectionId: 's1' }));
  });

  it('moveItem queues change when offline', async () => {
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Produce', position: 0 },
      { id: 's2', name: 'Dairy', position: 1 },
    ]);
    mockGetLocalItems.mockResolvedValue([
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
      { id: 'i2', section_id: 's2', name: 'Milk', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.moveItem('s1', 0, 's2', 0);
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-move-item', '', expect.objectContaining({ id: 'i1', toSectionId: 's2' }));
  });

  it('mergeList into existing section appends items', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.mergeList([
        { name: 'Produce', items: [{ name: 'Apples', quantity: null }, { name: 'Grapes', quantity: '3' }] },
      ]);
    });

    // Should have merged into existing Produce section
    const produce = result.current.sections.find(s => s.name === 'Produce')!;
    expect(produce.items.length).toBeGreaterThanOrEqual(2);
    expect(produce.items.some(i => i.name === 'Apples')).toBe(true);
  });

  it('editItem merges duplicate items in same section', async () => {
    mockGetLocalItems.mockResolvedValue([
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
      { id: 'i2', section_id: 's1', name: 'Apples', quantity: '3', checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Edit Bananas name to Apples - should trigger merge
    await act(async () => {
      await result.current.editItem('i1', { name: 'apples' });
    });

    // Bananas (i1) should be removed, Apples (i2) should have merged quantity
    const produce = result.current.sections.find(s => s.id === 's1')!;
    expect(produce.items.find(i => i.id === 'i1')).toBeUndefined();
    const apples = produce.items.find(i => i.id === 'i2')!;
    expect(apples.quantity).toBe('5'); // 2 + 3
  });
});
