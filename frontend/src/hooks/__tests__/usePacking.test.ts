import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePacking, resetPackingSessionLoaded } from '../usePacking';
import type { PackingList } from '../../types';

vi.mock('../../api/client', () => ({
  getPackingLists: vi.fn(),
  createPackingList: vi.fn(),
  restorePackingList: vi.fn(),
  updatePackingList: vi.fn(),
  deletePackingList: vi.fn(),
  reorderPackingLists: vi.fn(),
  addPackingShare: vi.fn(),
  removePackingShare: vi.fn(),
  leavePackingList: vi.fn(),
  rejoinPackingList: vi.fn(),
  checkAllPackingItems: vi.fn(),
  createPackingSection: vi.fn(),
  renamePackingSection: vi.fn(),
  deletePackingSection: vi.fn(),
  reorderPackingSections: vi.fn(),
  reorderPackingItems: vi.fn(),
  addPackingItem: vi.fn(),
  editPackingItem: vi.fn(),
  deletePackingItem: vi.fn(),
  movePackingItem: vi.fn(),
  createPackingBag: vi.fn(),
  renamePackingBag: vi.fn(),
  deletePackingBag: vi.fn(),
  reorderPackingBags: vi.fn(),
}));

vi.mock('../../db', () => ({
  generateTempId: vi.fn(() => `temp-${Math.random().toString(36).slice(2)}`),
  isTempId: (id: string) => id.startsWith('temp-'),
  queueChange: vi.fn(() => Promise.resolve()),
  saveTempIdMapping: vi.fn(() => Promise.resolve()),
  getTempIdMapping: vi.fn(() => Promise.resolve(undefined)),
  removePendingChangesForTempId: vi.fn(() => Promise.resolve()),
  saveLocalPackingLists: vi.fn(() => Promise.resolve()),
  saveLocalPackingBags: vi.fn(() => Promise.resolve()),
  saveLocalPackingSections: vi.fn(() => Promise.resolve()),
  saveLocalPackingItems: vi.fn(() => Promise.resolve()),
  getLocalPackingLists: vi.fn(() => Promise.resolve([])),
  getLocalPackingBags: vi.fn(() => Promise.resolve([])),
  getLocalPackingSections: vi.fn(() => Promise.resolve([])),
  getLocalPackingItems: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../useOnlineStatus', () => ({ useOnlineStatus: vi.fn() }));

const undoStack: { undo: () => Promise<void> | void; redo: () => Promise<void> | void }[] = [];
vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({
    canUndo: false, canRedo: false, undo: vi.fn(), redo: vi.fn(),
    pushAction: (a: any) => { undoStack.push(a); },
  }),
}));

import {
  getPackingLists,
  addPackingItem as addPackingItemAPI,
  editPackingItem as editPackingItemAPI,
  deletePackingItem as deletePackingItemAPI,
  checkAllPackingItems as checkAllPackingItemsAPI,
  createPackingSection as createPackingSectionAPI,
  createPackingBag as createPackingBagAPI,
  reorderPackingItems as reorderPackingItemsAPI,
} from '../../api/client';
import { queueChange, saveLocalPackingItems } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetLists = vi.mocked(getPackingLists);
const mockAddItem = vi.mocked(addPackingItemAPI);
const mockEditItem = vi.mocked(editPackingItemAPI);
const mockDeleteItem = vi.mocked(deletePackingItemAPI);
const mockCheckAll = vi.mocked(checkAllPackingItemsAPI);
const mockCreateSection = vi.mocked(createPackingSectionAPI);
const mockCreateBag = vi.mocked(createPackingBagAPI);
const mockReorderItems = vi.mocked(reorderPackingItemsAPI);
const mockQueueChange = vi.mocked(queueChange);
const mockSaveItems = vi.mocked(saveLocalPackingItems);
const mockOnline = vi.mocked(useOnlineStatus);

const buildList = (): PackingList => ({
  id: 'l1', name: 'Paris', icon: null, color: 'blue', position: 0,
  owner_sub: 'me', owner_name: 'Me', is_owner: true, shared_with: [],
  bags: [{ id: 'bag1', list_id: 'l1', name: 'Carry On', position: 0 }],
  sections: [{
    id: 's1', list_id: 'l1', name: 'Clothes', position: 0,
    items: [
      { id: 'i1', section_id: 's1', name: 'Boots', quantity: null, checked: false, position: 0, bag_id: 'bag1', updated_at: '2026-01-01T00:00:00' },
      { id: 'i2', section_id: 's1', name: 'Poles', quantity: null, checked: false, position: 1, bag_id: null, updated_at: '2026-01-01T00:00:00' },
      { id: 'i3', section_id: 's1', name: 'Helmet', quantity: null, checked: false, position: 2, bag_id: null, updated_at: '2026-01-01T00:00:00' },
    ],
  }],
});

async function renderLoaded() {
  const hook = renderHook(() => usePacking());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(hook.result.current.lists).toHaveLength(1));
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
  undoStack.length = 0;
  resetPackingSessionLoaded();
  mockOnline.mockReturnValue(true);
  mockGetLists.mockResolvedValue([buildList()]);
});

describe('usePacking loading', () => {
  it('loads lists from the API and sorts sections/items', async () => {
    const { result } = await renderLoaded();
    expect(result.current.lists[0].name).toBe('Paris');
    expect(result.current.lists[0].sections[0].items.map(i => i.id)).toEqual(['i1', 'i2', 'i3']);
  });
});

describe('checking items', () => {
  it('sinks a checked item to the bottom of its section but leaves position alone', async () => {
    mockEditItem.mockResolvedValue({} as any);
    const { result } = await renderLoaded();

    await act(async () => { await result.current.toggleItem('l1', 'i1', true); });

    const items = result.current.lists[0].sections[0].items;
    expect(items.map(i => i.id)).toEqual(['i2', 'i3', 'i1']);
    expect(items.find(i => i.id === 'i1')!.position).toBe(0);
    expect(mockEditItem).toHaveBeenCalledWith('i1', { checked: true });
  });

  it('puts the item back in its original slot when unchecked', async () => {
    mockEditItem.mockResolvedValue({} as any);
    const { result } = await renderLoaded();

    await act(async () => { await result.current.toggleItem('l1', 'i1', true); });
    await act(async () => { await result.current.toggleItem('l1', 'i1', false); });

    expect(result.current.lists[0].sections[0].items.map(i => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('undoes a check', async () => {
    mockEditItem.mockResolvedValue({} as any);
    const { result } = await renderLoaded();
    await act(async () => { await result.current.toggleItem('l1', 'i1', true); });

    await act(async () => { await undoStack.at(-1)!.undo(); });
    expect(result.current.lists[0].sections[0].items.find(i => i.id === 'i1')!.checked).toBe(false);
  });

  it('queues the toggle when offline', async () => {
    const { result, rerender } = await renderLoaded();
    mockOnline.mockReturnValue(false);
    rerender();
    await act(async () => { await result.current.toggleItem('l1', 'i2', true); });

    expect(mockEditItem).not.toHaveBeenCalled();
    expect(mockQueueChange).toHaveBeenCalledWith('packing-item-edit', '', { id: 'i2', checked: true });
    expect(result.current.lists[0].sections[0].items.find(i => i.id === 'i2')!.checked).toBe(true);
  });
});

describe('check all / uncheck all', () => {
  it('checks everything and restores the prior mix on undo', async () => {
    mockEditItem.mockResolvedValue({} as any);
    mockCheckAll.mockResolvedValue({} as any);
    const list = buildList();
    list.sections[0].items[1].checked = true; // Poles starts packed
    mockGetLists.mockResolvedValue([list]);
    const { result } = await renderLoaded();

    await act(async () => { await result.current.setAllChecked('l1', true); });
    expect(result.current.lists[0].sections[0].items.every(i => i.checked)).toBe(true);
    expect(mockCheckAll).toHaveBeenCalledWith('l1', true);

    await act(async () => { await undoStack.at(-1)!.undo(); });
    const byId = new Map(result.current.lists[0].sections[0].items.map(i => [i.id, i.checked]));
    expect(byId.get('i1')).toBe(false);
    expect(byId.get('i2')).toBe(true);
    expect(byId.get('i3')).toBe(false);
    // Majority was unchecked → bulk-uncheck, then patch the one exception.
    expect(mockCheckAll).toHaveBeenLastCalledWith('l1', false);
    expect(mockEditItem).toHaveBeenCalledWith('i2', { checked: true });
  });

  it('queues a bulk toggle when offline', async () => {
    const { result, rerender } = await renderLoaded();
    mockOnline.mockReturnValue(false);
    rerender();
    await act(async () => { await result.current.setAllChecked('l1', true); });
    expect(mockQueueChange).toHaveBeenCalledWith('packing-check-all', '', { listId: 'l1', checked: true });
  });
});

describe('items', () => {
  it('adds an item and can undo it', async () => {
    mockAddItem.mockResolvedValue({
      id: 'new-1', section_id: 's1', name: 'Socks', quantity: null,
      checked: false, position: 3, bag_id: null, updated_at: '2026-01-02T00:00:00',
    });
    mockDeleteItem.mockResolvedValue({ status: 'deleted' });
    const { result } = await renderLoaded();

    await act(async () => { await result.current.addItem('l1', 's1', 'socks'); });
    expect(mockAddItem).toHaveBeenCalledWith('s1', 'Socks', null, null);
    expect(result.current.lists[0].sections[0].items.map(i => i.name)).toContain('Socks');

    await act(async () => { await undoStack.at(-1)!.undo(); });
    expect(result.current.lists[0].sections[0].items.map(i => i.name)).not.toContain('Socks');
    expect(mockDeleteItem).toHaveBeenCalledWith('new-1');
  });

  it('merges quantities when the same item is added twice', async () => {
    mockEditItem.mockResolvedValue({} as any);
    const { result } = await renderLoaded();
    await act(async () => { await result.current.addItem('l1', 's1', 'Boots', '2'); });

    expect(mockAddItem).not.toHaveBeenCalled();
    expect(mockEditItem).toHaveBeenCalledWith('i1', { quantity: '3' });
  });

  it('restores a deleted item in its original slot', async () => {
    mockDeleteItem.mockResolvedValue({ status: 'deleted' });
    mockAddItem.mockResolvedValue({
      id: 'restored', section_id: 's1', name: 'Poles', quantity: null,
      checked: false, position: 2, bag_id: null, updated_at: '2026-01-02T00:00:00',
    });
    mockReorderItems.mockResolvedValue({ status: 'ok' });
    const { result } = await renderLoaded();

    await act(async () => { await result.current.deleteItem('l1', 'i2'); });
    expect(result.current.lists[0].sections[0].items.map(i => i.id)).toEqual(['i1', 'i3']);

    await act(async () => { await undoStack.at(-1)!.undo(); });
    expect(result.current.lists[0].sections[0].items.map(i => i.name)).toEqual(['Boots', 'Poles', 'Helmet']);
  });

  it('reorders items and syncs the full section order', async () => {
    mockReorderItems.mockResolvedValue({ status: 'ok' });
    const { result } = await renderLoaded();

    await act(async () => { await result.current.reorderItems('l1', 's1', ['i3', 'i1', 'i2']); });
    expect(result.current.lists[0].sections[0].items.map(i => i.id)).toEqual(['i3', 'i1', 'i2']);
    expect(mockReorderItems).toHaveBeenCalledWith('s1', ['i3', 'i1', 'i2']);

    await act(async () => { await undoStack.at(-1)!.undo(); });
    expect(result.current.lists[0].sections[0].items.map(i => i.id)).toEqual(['i1', 'i2', 'i3']);
  });

  it('persists items to IndexedDB on every change', async () => {
    mockEditItem.mockResolvedValue({} as any);
    const { result } = await renderLoaded();
    mockSaveItems.mockClear();
    await act(async () => { await result.current.toggleItem('l1', 'i1', true); });
    await waitFor(() => expect(mockSaveItems).toHaveBeenCalled());
    const saved = mockSaveItems.mock.calls.at(-1)![0];
    expect(saved.find(i => i.id === 'i1')).toMatchObject({ checked: true, position: 0 });
  });
});

describe('bags', () => {
  it('creates a bag and returns it for the chip picker', async () => {
    mockCreateBag.mockResolvedValue({ id: 'bag2', list_id: 'l1', name: 'Toiletry Bag', position: 1 });
    const { result } = await renderLoaded();

    let created: unknown;
    await act(async () => { created = await result.current.createBag('l1', 'Toiletry Bag'); });
    expect(created).toMatchObject({ name: 'Toiletry Bag' });
    expect(result.current.lists[0].bags.map(b => b.name)).toEqual(['Carry On', 'Toiletry Bag']);
  });

  it('reuses an existing bag instead of duplicating it', async () => {
    const { result } = await renderLoaded();
    let created: any;
    await act(async () => { created = await result.current.createBag('l1', 'carry on'); });
    expect(created.id).toBe('bag1');
    expect(mockCreateBag).not.toHaveBeenCalled();
  });
});

describe('sections', () => {
  it('reuses a section with the same name rather than creating a duplicate', async () => {
    const { result } = await renderLoaded();
    let section: any;
    await act(async () => { section = await result.current.createSection('l1', 'clothes'); });
    expect(section.id).toBe('s1');
    expect(mockCreateSection).not.toHaveBeenCalled();
  });

  it('creates a new section when the name is new', async () => {
    mockCreateSection.mockResolvedValue({ id: 's2', list_id: 'l1', name: 'Tech', position: 1, items: [] });
    const { result } = await renderLoaded();
    await act(async () => { await result.current.createSection('l1', 'tech'); });
    expect(mockCreateSection).toHaveBeenCalledWith('l1', 'Tech', 1);
    expect(result.current.lists[0].sections.map(s => s.name)).toEqual(['Clothes', 'Tech']);
  });
});

describe('copying a section to another trip', () => {
  const twoLists = () => {
    const paris = buildList();
    const dolomites: PackingList = {
      ...buildList(), id: 'l2', name: 'Dolomites', position: 1,
      bags: [], sections: [],
    };
    return [paris, dolomites];
  };

  const renderTwo = async () => {
    mockGetLists.mockResolvedValue(twoLists());
    const hook = renderHook(() => usePacking());
    await waitFor(() => expect(hook.result.current.lists).toHaveLength(2));
    return hook;
  };

  beforeEach(() => {
    mockCreateSection.mockImplementation(async (listId: string, name: string, position?: number) =>
      ({ id: `sec-${name}`, list_id: listId, name, position: position ?? 0, items: [] }) as any);
    mockCreateBag.mockImplementation(async (listId: string, name: string, position?: number) =>
      ({ id: `bag-${name}`, list_id: listId, name, position: position ?? 0 }) as any);
    let n = 0;
    mockAddItem.mockImplementation(async (sectionId: string, name: string, quantity: string | null, bagId: string | null) =>
      ({
        id: `item-${++n}`, section_id: sectionId, name, quantity, checked: false,
        position: n, bag_id: bagId, updated_at: '2026-01-02T00:00:00',
      }) as any);
    mockEditItem.mockResolvedValue({} as any);
    mockDeleteItem.mockResolvedValue({ status: 'deleted' });
    mockReorderItems.mockResolvedValue({ status: 'ok' });
  });

  it('copies the section, its items and the bag names into the target trip', async () => {
    const { result } = await renderTwo();
    await act(async () => { await result.current.copySectionToList('l1', 's1', 'l2'); });

    const target = result.current.lists.find(l => l.id === 'l2')!;
    expect(target.sections.map(s => s.name)).toEqual(['Clothes']);
    expect(target.sections[0].items.map(i => i.name)).toEqual(['Boots', 'Poles', 'Helmet']);
    // Bags are per-list, so "Carry On" is recreated in the target and bound.
    expect(target.bags.map(b => b.name)).toEqual(['Carry On']);
    const boots = target.sections[0].items.find(i => i.name === 'Boots')!;
    expect(boots.bag_id).toBe(target.bags[0].id);
    expect(mockCreateBag).toHaveBeenCalledWith('l2', 'Carry On', 0);
  });

  it('copies items unpacked even when the source is packed', async () => {
    const [paris, dolomites] = twoLists();
    paris.sections[0].items.forEach(i => { i.checked = true; });
    mockGetLists.mockResolvedValue([paris, dolomites]);
    const hook = renderHook(() => usePacking());
    await waitFor(() => expect(hook.result.current.lists).toHaveLength(2));

    await act(async () => { await hook.result.current.copySectionToList('l1', 's1', 'l2'); });
    const target = hook.result.current.lists.find(l => l.id === 'l2')!;
    expect(target.sections[0].items.every(i => !i.checked)).toBe(true);
  });

  it('leaves the source trip untouched', async () => {
    const { result } = await renderTwo();
    await act(async () => { await result.current.copySectionToList('l1', 's1', 'l2'); });
    const source = result.current.lists.find(l => l.id === 'l1')!;
    expect(source.sections[0].items.map(i => i.name)).toEqual(['Boots', 'Poles', 'Helmet']);
  });

  it('merges into a same-named section and skips items already there', async () => {
    const [paris, dolomites] = twoLists();
    dolomites.sections = [{
      id: 's2', list_id: 'l2', name: 'Clothes', position: 0,
      items: [{ id: 'x1', section_id: 's2', name: 'Boots', quantity: null, checked: false, position: 0, bag_id: null, updated_at: '2026-01-01T00:00:00' }],
    }];
    mockGetLists.mockResolvedValue([paris, dolomites]);
    const hook = renderHook(() => usePacking());
    await waitFor(() => expect(hook.result.current.lists).toHaveLength(2));

    let res: any;
    await act(async () => { res = await hook.result.current.copySectionToList('l1', 's1', 'l2'); });
    expect(res).toEqual({ copied: 2, skipped: 1 });
    expect(mockCreateSection).not.toHaveBeenCalled();
    const target = hook.result.current.lists.find(l => l.id === 'l2')!;
    expect(target.sections).toHaveLength(1);
    expect(target.sections[0].items.map(i => i.name)).toEqual(['Boots', 'Poles', 'Helmet']);
  });

  it('is a no-op the second time', async () => {
    const { result } = await renderTwo();
    await act(async () => { await result.current.copySectionToList('l1', 's1', 'l2'); });
    let second: any;
    await act(async () => { second = await result.current.copySectionToList('l1', 's1', 'l2'); });
    expect(second).toEqual({ copied: 0, skipped: 3 });
    const target = result.current.lists.find(l => l.id === 'l2')!;
    expect(target.sections[0].items).toHaveLength(3);
  });

  it('undoes the whole copy as a single step', async () => {
    const { result } = await renderTwo();
    const before = undoStack.length;
    await act(async () => { await result.current.copySectionToList('l1', 's1', 'l2'); });
    expect(undoStack.length).toBe(before + 1);

    await act(async () => { await undoStack.at(-1)!.undo(); });
    const target = result.current.lists.find(l => l.id === 'l2')!;
    expect(target.sections).toHaveLength(0);
    expect(target.bags).toHaveLength(0);
    // And the source is still intact.
    expect(result.current.lists.find(l => l.id === 'l1')!.sections[0].items).toHaveLength(3);
  });

  it('redoes the copy after an undo', async () => {
    const { result } = await renderTwo();
    await act(async () => { await result.current.copySectionToList('l1', 's1', 'l2'); });
    await act(async () => { await undoStack.at(-1)!.undo(); });
    await act(async () => { await undoStack.at(-1)!.redo(); });

    const target = result.current.lists.find(l => l.id === 'l2')!;
    expect(target.sections[0].items.map(i => i.name)).toEqual(['Boots', 'Poles', 'Helmet']);
    expect(target.bags.map(b => b.name)).toEqual(['Carry On']);
  });

  it('reuses a bag the target already has instead of duplicating it', async () => {
    const [paris, dolomites] = twoLists();
    dolomites.bags = [{ id: 'existing-bag', list_id: 'l2', name: 'carry on', position: 0 }];
    mockGetLists.mockResolvedValue([paris, dolomites]);
    const hook = renderHook(() => usePacking());
    await waitFor(() => expect(hook.result.current.lists).toHaveLength(2));

    await act(async () => { await hook.result.current.copySectionToList('l1', 's1', 'l2'); });
    expect(mockCreateBag).not.toHaveBeenCalled();
    const target = hook.result.current.lists.find(l => l.id === 'l2')!;
    expect(target.sections[0].items.find(i => i.name === 'Boots')!.bag_id).toBe('existing-bag');
  });

  it('refuses to copy a section onto its own trip', async () => {
    const { result } = await renderTwo();
    let res: any = 'unset';
    await act(async () => { res = await result.current.copySectionToList('l1', 's1', 'l1'); });
    expect(res).toBeNull();
    expect(mockAddItem).not.toHaveBeenCalled();
  });

  it('queues the whole copy when offline', async () => {
    const { result, rerender } = await renderTwo();
    mockOnline.mockReturnValue(false);
    rerender();
    await act(async () => { await result.current.copySectionToList('l1', 's1', 'l2'); });

    expect(mockAddItem).not.toHaveBeenCalled();
    const queued = mockQueueChange.mock.calls.map(c => c[0]);
    expect(queued).toContain('packing-section-create');
    expect(queued).toContain('packing-bag-create');
    expect(queued.filter(t => t === 'packing-item-add')).toHaveLength(3);
    const target = result.current.lists.find(l => l.id === 'l2')!;
    expect(target.sections[0].items).toHaveLength(3);
  });
});

describe('realtime', () => {
  const emit = (payload: unknown) => {
    window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
      detail: { type: 'packing.updated', payload },
    }));
  };

  it('applies an item-updated delta without refetching', async () => {
    const { result } = await renderLoaded();
    mockGetLists.mockClear();

    await act(async () => {
      emit({
        action: 'item-updated', listId: 'l1',
        item: { id: 'i1', section_id: 's1', name: 'Boots', quantity: null, checked: true, position: 0, bag_id: 'bag1', updated_at: '2026-01-03T00:00:00' },
      });
    });

    const items = result.current.lists[0].sections[0].items;
    expect(items.map(i => i.id)).toEqual(['i2', 'i3', 'i1']);
    expect(mockGetLists).not.toHaveBeenCalled();
  });

  it('drops a list another member deleted', async () => {
    const { result } = await renderLoaded();
    await act(async () => { emit({ action: 'list-deleted', listId: 'l1' }); });
    expect(result.current.lists).toHaveLength(0);
  });

  it('falls back to a refetch on an unknown action', async () => {
    const { result } = await renderLoaded();
    mockGetLists.mockClear();
    await act(async () => { emit({ action: 'something-new', listId: 'l1' }); });
    await waitFor(() => expect(mockGetLists).toHaveBeenCalled());
    expect(result.current.lists).toHaveLength(1);
  });
});

describe('item suggestions', () => {
  it('remembers the bag and section an item name usually goes in, across trips', async () => {
    const second: PackingList = {
      ...buildList(),
      id: 'l2', name: 'Dolomites', position: 1,
      bags: [{ id: 'bag9', list_id: 'l2', name: 'Ski Bag', position: 0 }],
      sections: [{
        id: 's9', list_id: 'l2', name: 'Gear', position: 0,
        items: [{ id: 'i9', section_id: 's9', name: 'Goggles', quantity: null, checked: false, position: 0, bag_id: 'bag9', updated_at: '2026-01-01T00:00:00' }],
      }],
    };
    mockGetLists.mockResolvedValue([buildList(), second]);
    const hook = renderHook(() => usePacking());
    await waitFor(() => expect(hook.result.current.lists).toHaveLength(2));

    expect(hook.result.current.itemSuggestions.get('goggles')).toEqual({ bagName: 'Ski Bag', sectionName: 'Gear' });
    expect(hook.result.current.itemSuggestions.get('boots')).toEqual({ bagName: 'Carry On', sectionName: 'Clothes' });
  });
});
