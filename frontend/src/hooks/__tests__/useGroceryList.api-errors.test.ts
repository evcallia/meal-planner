import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGroceryList } from '../useGroceryList';
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
  replaceGroceryList as replaceGroceryListAPI,
  reorderGrocerySections as reorderGrocerySectionsAPI,
  reorderGroceryItems as reorderGroceryItemsAPI,
  renameGrocerySection as renameGrocerySectionAPI,
  moveGroceryItem as moveGroceryItemAPI,
} from '../../api/client';
import { queueChange } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetGroceryList = vi.mocked(getGroceryList);
const mockToggleAPI = vi.mocked(toggleGroceryItemAPI);
const mockAddAPI = vi.mocked(addGroceryItemAPI);
const mockDeleteAPI = vi.mocked(deleteGroceryItemAPI);
const mockEditAPI = vi.mocked(editGroceryItemAPI);
const mockClearAPI = vi.mocked(clearGroceryItemsAPI);
const mockReplaceAPI = vi.mocked(replaceGroceryListAPI);
const mockReorderSectionsAPI = vi.mocked(reorderGrocerySectionsAPI);
const mockReorderItemsAPI = vi.mocked(reorderGroceryItemsAPI);
const mockRenameSectionAPI = vi.mocked(renameGrocerySectionAPI);
const mockMoveItemAPI = vi.mocked(moveGroceryItemAPI);
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
];

describe('useGroceryList - API error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetGroceryList.mockResolvedValue(sampleSections);
  });

  it('toggleItem queues on API error', async () => {
    mockToggleAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggleItem('i1', true);
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-check', '', { id: 'i1', checked: true });
  });

  it('addItem queues on API error', async () => {
    mockAddAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.addItem('s1', 'Grapes');
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-add', '', expect.objectContaining({ sectionId: 's1', name: 'Grapes' }));
  });

  it('deleteItem queues on API error', async () => {
    mockDeleteAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.deleteItem('i1');
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-delete', '', { id: 'i1' });
  });

  it('editItem queues on API error', async () => {
    mockEditAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editItem('i1', { quantity: '5' });
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-edit', '', { id: 'i1', quantity: '5' });
  });

  it('clearChecked queues on API error', async () => {
    mockClearAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Need checked items
    mockGetGroceryList.mockResolvedValue([{
      id: 's1', name: 'Produce', position: 0,
      items: [{ id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: true, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' }],
    }]);

    const { result: result2 } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result2.current.loading).toBe(false));

    await act(async () => { await result2.current.clearChecked(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-clear', '', { mode: 'checked' });
  });

  it('clearAll queues on API error', async () => {
    mockClearAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.clearAll(); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-clear', '', { mode: 'all' });
  });

  it('reorderSections queues on API error', async () => {
    mockReorderSectionsAPI.mockRejectedValue(new Error('fail'));
    mockGetGroceryList.mockResolvedValue([
      ...sampleSections,
      { id: 's2', name: 'Dairy', position: 1, items: [] },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.reorderSections(0, 1); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-reorder-sections', '', expect.objectContaining({ sectionIds: expect.any(Array) }));
  });

  it('renameSection queues on API error', async () => {
    mockRenameSectionAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.renameSection('s1', 'Fruits'); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-rename-section', '', { sectionId: 's1', name: 'Fruits' });
  });

  it('mergeList replaces API queues on error', async () => {
    mockReplaceAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.mergeList([
        { name: 'Bakery', items: [{ name: 'Bread', quantity: '1' }] },
      ]);
    });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-replace', '', expect.objectContaining({ sections: expect.any(Array) }));
  });

  it('moveItem queues on API error', async () => {
    mockMoveItemAPI.mockRejectedValue(new Error('fail'));
    mockGetGroceryList.mockResolvedValue([
      ...sampleSections,
      { id: 's2', name: 'Dairy', position: 1, items: [{ id: 'i3', section_id: 's2', name: 'Milk', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' }] },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.moveItem('s1', 0, 's2', 0); });

    expect(mockQueueChange).toHaveBeenCalledWith('grocery-move-item', '', expect.objectContaining({ id: 'i1', toSectionId: 's2' }));
  });
});
