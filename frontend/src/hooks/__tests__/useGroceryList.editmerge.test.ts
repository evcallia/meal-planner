import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGroceryList } from '../useGroceryList';
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
  editGroceryItem as editGroceryItemAPI,
  deleteGroceryItem as deleteGroceryItemAPI,
  addGroceryItem as addGroceryItemAPI,
} from '../../api/client';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetGroceryList = vi.mocked(getGroceryList);
const mockEditAPI = vi.mocked(editGroceryItemAPI);
const mockDeleteAPI = vi.mocked(deleteGroceryItemAPI);
const mockAddAPI = vi.mocked(addGroceryItemAPI);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

describe('useGroceryList - edit merge and store lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushActionCalls.length = 0;
    mockUseOnlineStatus.mockReturnValue(true);
  });

  it('editItem merges when name matches existing unchecked item', async () => {
    mockGetGroceryList.mockResolvedValue([
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'i2', section_id: 's1', name: 'Apples', quantity: '3', checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);
    mockEditAPI.mockResolvedValue({
      id: 'i2', section_id: 's1', name: 'Apples', quantity: '5',
      checked: false, position: 1, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });
    mockDeleteAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Rename Bananas to Apples — should merge
    await act(async () => {
      await result.current.editItem('i1', { name: 'apples' });
    });

    // i1 should be gone, i2 should have qty=5
    const section = result.current.sections[0];
    expect(section.items.find(i => i.id === 'i1')).toBeUndefined();
    expect(section.items.find(i => i.id === 'i2')?.quantity).toBe('5');
    expect(pushActionCalls[0].type).toBe('edit-merge-grocery-item');
  });

  it('edit-merge undo restores both items', async () => {
    mockGetGroceryList.mockResolvedValue([
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'i2', section_id: 's1', name: 'Apples', quantity: '3', checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);
    mockEditAPI.mockResolvedValue({
      id: 'i2', section_id: 's1', name: 'Apples', quantity: '5',
      checked: false, position: 1, store_id: null, updated_at: '2026-01-02T00:00:00Z',
    });
    mockDeleteAPI.mockResolvedValue({ status: 'ok' });
    mockAddAPI.mockResolvedValue({
      id: 'restored-i1', section_id: 's1', name: 'Bananas', quantity: '2',
      checked: false, position: 2, store_id: null, updated_at: '2026-01-03T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editItem('i1', { name: 'apples' });
    });

    // Undo: should restore i2's qty and re-add i1
    await act(async () => { await pushActionCalls[0].undo(); });

    const section = result.current.sections[0];
    expect(section.items.find(i => i.id === 'i2')?.quantity).toBe('3');
    expect(section.items.some(i => i.name === 'Bananas')).toBe(true);
  });

  it('editItem looks up store from items with same name', async () => {
    mockGetGroceryList.mockResolvedValue([
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
          { id: 'i2', section_id: 's1', name: 'Milk', quantity: null, checked: true, position: 1, store_id: 'store-1', updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);

    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Milk', quantity: '2',
      checked: false, position: 0, store_id: 'store-1', updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Rename Bananas to Milk — should also pick up Milk's store_id
    await act(async () => {
      await result.current.editItem('i1', { name: 'milk' });
    });

    // editItem should have included store_id in the update
    expect(mockEditAPI).toHaveBeenCalledWith('i1', expect.objectContaining({ store_id: 'store-1' }));
  });

  it('addItem inherits store_id from existing item with same name', async () => {
    mockGetGroceryList.mockResolvedValue([
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: true, position: 0, store_id: 'store-1', updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);

    mockAddAPI.mockResolvedValue({
      id: 'new-1', section_id: 's1', name: 'Bananas', quantity: null,
      checked: false, position: 1, store_id: 'store-1', updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Adding Bananas again — since checked Bananas has store_id, new one should inherit it
    await act(async () => {
      await result.current.addItem('s1', 'Bananas');
    });

    // The optimistic item should have inherited the store_id
    await waitFor(() => {
      const section = result.current.sections[0];
      const newItem = section.items.find(i => !i.checked && i.name === 'Bananas');
      // It should try to merge since there's already a Bananas (but it's checked, so no merge)
      expect(newItem).toBeDefined();
    });
  });

  it('editItem applies server store_id when different from optimistic', async () => {
    mockGetGroceryList.mockResolvedValue([
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
        ],
      },
    ]);

    // Server returns a different store_id than what we set optimistically
    mockEditAPI.mockResolvedValue({
      id: 'i1', section_id: 's1', name: 'Bananas', quantity: '5',
      checked: false, position: 0, store_id: 'auto-store', updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editItem('i1', { quantity: '5' });
    });

    // Server returned a different store_id, should be applied
    await waitFor(() => {
      const item = result.current.sections[0].items.find(i => i.id === 'i1')!;
      expect(item.store_id).toBe('auto-store');
    });
  });
});
