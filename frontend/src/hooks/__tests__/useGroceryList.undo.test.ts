import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGroceryList, resetGrocerySessionLoaded } from '../useGroceryList';
import type { GrocerySection } from '../../types';

// Capture pushAction calls to test undo/redo
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

describe('useGroceryList undo/redo', () => {
  beforeEach(() => {
    resetGrocerySessionLoaded();
    vi.clearAllMocks();
    pushActionCalls.length = 0;
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetGroceryList.mockResolvedValue(sampleSections);
  });

  it('toggleItem undo reverses the toggle', async () => {
    mockToggleAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: true, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggleItem('i1', true);
    });

    expect(pushActionCalls).toHaveLength(1);
    expect(pushActionCalls[0].type).toBe('check-grocery-item');

    // Call undo
    mockToggleAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-03T00:00:00Z',
    });
    await act(async () => {
      await pushActionCalls[0].undo();
    });

    const item = result.current.sections[0].items.find(i => i.id === 'i1')!;
    expect(item.checked).toBe(false);
  });

  it('toggleItem redo re-applies the toggle', async () => {
    mockToggleAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: true, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggleItem('i1', true);
    });

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    // Redo
    await act(async () => { await pushActionCalls[0].redo(); });

    const item = result.current.sections[0].items.find(i => i.id === 'i1')!;
    expect(item.checked).toBe(true);
  });

  it('deleteItem undo restores the item', async () => {
    mockDeleteAPI.mockResolvedValue({ status: 'ok' });
    mockAddAPI.mockResolvedValue({
      id: 'restored-i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-03T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.deleteItem('i1');
    });

    expect(pushActionCalls).toHaveLength(1);
    expect(pushActionCalls[0].type).toBe('delete-grocery-item');

    // Undo should restore
    await act(async () => {
      await pushActionCalls[0].undo();
    });

    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.some(i => i.name === 'Bananas')).toBe(true);
  });

  it('deleteItem redo deletes again', async () => {
    mockDeleteAPI.mockResolvedValue({ status: 'ok' });
    mockAddAPI.mockResolvedValue({
      id: 'restored-i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-03T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.deleteItem('i1'); });
    await act(async () => { await pushActionCalls[0].undo(); });

    mockDeleteAPI.mockResolvedValue({ status: 'ok' });
    await act(async () => { await pushActionCalls[0].redo(); });

    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.find(i => i.name === 'Bananas')).toBeUndefined();
  });

  it('editItem undo reverses the edit', async () => {
    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Green Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editItem('i1', { name: 'green bananas' });
    });

    expect(pushActionCalls[0].type).toBe('edit-grocery-item');

    // Undo
    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-03T00:00:00Z',
    });
    await act(async () => { await pushActionCalls[0].undo(); });

    const item = result.current.sections[0].items.find(i => i.id === 'i1')!;
    expect(item.name).toBe('Bananas');
  });

  it('editItem redo re-applies the edit', async () => {
    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Green Bananas', quantity: '2',
      checked: false, position: 0, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.editItem('i1', { name: 'green bananas' }); });
    await act(async () => { await pushActionCalls[0].undo(); });
    await act(async () => { await pushActionCalls[0].redo(); });

    const item = result.current.sections[0].items.find(i => i.id === 'i1')!;
    expect(item.name).toBe('Green Bananas');
  });

  it('clearChecked undo restores checked items', async () => {
    mockGetGroceryList.mockResolvedValue([
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: true, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'i2', section_id: 's1', name: 'Apples', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);
    mockClearAPI.mockResolvedValue([]);
    mockReplaceAPI.mockResolvedValue([
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: true, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'i2', section_id: 's1', name: 'Apples', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.clearChecked(); });
    expect(pushActionCalls[0].type).toBe('clear-checked-grocery');

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections[0].items).toHaveLength(2);
  });

  it('clearAll undo restores all items', async () => {
    mockClearAPI.mockResolvedValue([]);
    mockReplaceAPI.mockResolvedValue(sampleSections);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.clearAll(); });
    expect(result.current.sections).toEqual([]);
    expect(pushActionCalls[0].type).toBe('clear-all-grocery');

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections).toHaveLength(2);
  });

  it('clearAll redo clears again', async () => {
    mockClearAPI.mockResolvedValue([]);
    mockReplaceAPI.mockResolvedValue(sampleSections);

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.clearAll(); });
    await act(async () => { await pushActionCalls[0].undo(); });
    await act(async () => { await pushActionCalls[0].redo(); });
    expect(result.current.sections).toEqual([]);
  });

  it('reorderSections undo restores original order', async () => {
    mockReorderSectionsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.reorderSections(0, 1); });
    expect(result.current.sections[0].name).toBe('Dairy');

    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections[0].name).toBe('Produce');
  });

  it('reorderSections redo re-applies the reorder', async () => {
    mockReorderSectionsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.reorderSections(0, 1); });
    await act(async () => { await pushActionCalls[0].undo(); });
    await act(async () => { await pushActionCalls[0].redo(); });
    expect(result.current.sections[0].name).toBe('Dairy');
  });

  it('renameSection undo restores original name', async () => {
    mockRenameSectionAPI.mockResolvedValue({ id: 's1', name: 'Fruits', position: 0, items: [] });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.renameSection('s1', 'Fruits'); });
    expect(result.current.sections[0].name).toBe('Fruits');

    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections[0].name).toBe('Produce');
  });

  it('reorderItems undo restores original order', async () => {
    mockReorderItemsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.reorderItems('s1', 0, 1); });
    expect(result.current.sections[0].items[0].name).toBe('Apples');

    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections[0].items[0].name).toBe('Bananas');
  });

  it('moveItem undo moves item back', async () => {
    mockMoveItemAPI.mockResolvedValue({
      id: 'i1', section_id: 's2', name: 'Bananas', quantity: '2',
      checked: false, position: 1, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.moveItem('s1', 0, 's2', 0); });

    const dairySection = result.current.sections.find(s => s.id === 's2')!;
    expect(dairySection.items.some(i => i.id === 'i1')).toBe(true);

    await act(async () => { await pushActionCalls[0].undo(); });
    const produceSection = result.current.sections.find(s => s.id === 's1')!;
    expect(produceSection.items.some(i => i.id === 'i1')).toBe(true);
  });

  it('addItem undo removes the added item', async () => {
    mockAddAPI.mockResolvedValue({
      id: 'server-1', section_id: 's1', name: 'Grapes', quantity: null,
      checked: false, position: 2, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });
    mockDeleteAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.addItem('s1', 'grapes'); });

    await waitFor(() => {
      const section = result.current.sections.find(s => s.id === 's1')!;
      expect(section.items.some(i => i.name === 'Grapes')).toBe(true);
    });

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.find(i => i.name === 'Grapes')).toBeUndefined();
  });

  it('mergeList undo restores previous state', async () => {
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

    await waitFor(() => expect(result.current.sections.length).toBeGreaterThanOrEqual(2));

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections).toHaveLength(2); // Back to original 2
  });
});
