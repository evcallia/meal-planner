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
  deleteItemDefault: vi.fn(() => Promise.resolve()),
  putItemDefault: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../db', () => ({
  generateTempId: vi.fn(() => 'temp-new'),
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

vi.mock('../useOnlineStatus', () => ({ useOnlineStatus: vi.fn() }));

type PushedAction = {
  type: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  highlight?: () => (string | null | undefined)[];
};
const pushed: PushedAction[] = [];

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({
    canUndo: false, canRedo: false,
    pushAction: (action: PushedAction) => { pushed.push(action); },
    runAsUndoGroup: async (_t: string, fn: () => unknown) => { await fn(); },
    undo: vi.fn(), redo: vi.fn(),
  }),
}));

import {
  getGroceryList,
  addGroceryItem as addGroceryItemAPI,
  editGroceryItem as editGroceryItemAPI,
  toggleGroceryItem as toggleGroceryItemAPI,
} from '../../api/client';
import { useOnlineStatus } from '../useOnlineStatus';

const sampleSections: GrocerySection[] = [
  {
    id: 's1', name: 'Produce', position: 0,
    items: [
      { id: 'i1', section_id: 's1', name: 'Lemon', quantity: '6', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
];

const lastAction = (type: string) => {
  const action = [...pushed].reverse().find(a => a.type === type);
  if (!action) throw new Error(`no ${type} action was pushed (saw: ${pushed.map(a => a.type).join(', ')})`);
  return action;
};

// An undo can land on a row anywhere in the list, so every item-level action
// names the row it touches. The name has to be resolved when the undo RUNS,
// not when it was pushed — an item that was deleted and restored comes back
// with a new server id.
describe('useGroceryList — naming the rows an undo touches', () => {
  beforeEach(() => {
    pushed.length = 0;
    resetGrocerySessionLoaded();
    vi.clearAllMocks();
    vi.mocked(useOnlineStatus).mockReturnValue(true);
    vi.mocked(getGroceryList).mockResolvedValue(sampleSections);
    vi.mocked(editGroceryItemAPI).mockResolvedValue(undefined as never);
    vi.mocked(toggleGroceryItemAPI).mockResolvedValue(undefined as never);
    vi.mocked(addGroceryItemAPI).mockResolvedValue({
      id: 'server-9', section_id: 's1', name: 'Pear', quantity: null,
      checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z',
    } as never);
  });

  const setup = async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    return result;
  };

  it('names the edited row', async () => {
    const result = await setup();
    await act(async () => { await result.current.editItem('i1', { name: 'Meyer Lemon' }); });
    expect(lastAction('edit-grocery-item').highlight?.()).toEqual(['i1']);
  });

  it('names the row that was checked off', async () => {
    const result = await setup();
    await act(async () => { await result.current.toggleItem('i1', true); });
    expect(lastAction('check-grocery-item').highlight?.()).toEqual(['i1']);
  });

  it('names the deleted row, so undo points at what came back', async () => {
    const result = await setup();
    await act(async () => { await result.current.deleteItem('i1'); });
    expect(lastAction('delete-grocery-item').highlight?.()).toEqual(['i1']);
  });

  // The id is resolved at call time precisely so this case works: the add
  // starts life as a temp id and becomes a server id once it syncs.
  it('names the added row by its server id, not the temp one', async () => {
    const result = await setup();
    await act(async () => { await result.current.addItem('s1', 'Pear'); });
    expect(lastAction('add-grocery-item').highlight?.()).toEqual(['server-9']);
  });

  it('leaves bulk actions unhighlighted', async () => {
    const result = await setup();
    await act(async () => { await result.current.clearAll(); });
    expect(lastAction('clear-all-grocery').highlight).toBeUndefined();
  });
});

// Adding a name that is already on the list does NOT make a row — it bumps
// the quantity on the existing one. The caller highlights whatever row the
// add landed on, so it has to be told which that was.
describe('useGroceryList — addItem reports the row it landed on', () => {
  beforeEach(() => {
    pushed.length = 0;
    resetGrocerySessionLoaded();
    vi.clearAllMocks();
    vi.mocked(useOnlineStatus).mockReturnValue(true);
    vi.mocked(getGroceryList).mockResolvedValue(sampleSections);
    vi.mocked(editGroceryItemAPI).mockResolvedValue(undefined as never);
    vi.mocked(addGroceryItemAPI).mockResolvedValue({
      id: 'server-9', section_id: 's1', name: 'Pear', quantity: null,
      checked: false, position: 1, store_id: null, updated_at: '2026-01-01T00:00:00Z',
    } as never);
  });

  it('returns the new row’s id', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let id: string | null = null;
    await act(async () => { id = await result.current.addItem('s1', 'Pear'); });
    expect(id).toBe('server-9');
  });

  it('returns the EXISTING row’s id when the name merges into it', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let id: string | null = null;
    await act(async () => { id = await result.current.addItem('s1', 'Lemon'); });
    expect(id).toBe('i1');
    expect(lastAction('merge-grocery-item').highlight?.()).toEqual(['i1']);
  });

  it('returns nothing when the section is gone', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let id: string | null = null;
    await act(async () => { id = await result.current.addItem('no-such-section', 'Pear'); });
    expect(id).toBeNull();
  });
});
