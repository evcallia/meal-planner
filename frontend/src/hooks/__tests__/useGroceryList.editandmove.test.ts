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

vi.mock('../useOnlineStatus', () => ({ useOnlineStatus: vi.fn() }));

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({
    canUndo: false, canRedo: false,
    pushAction: vi.fn(), runAsUndoGroup: vi.fn(), undo: vi.fn(), redo: vi.fn(),
  }),
}));

import {
  getGroceryList,
  editGroceryItem as editGroceryItemAPI,
  moveGroceryItem as moveGroceryItemAPI,
} from '../../api/client';
import { useOnlineStatus } from '../useOnlineStatus';

const sampleSections: GrocerySection[] = [
  {
    id: 's1', name: 'Produce', position: 0,
    items: [
      { id: 'i1', section_id: 's1', name: 'Lemon', quantity: '6', checked: false, position: 0, store_id: null, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
  { id: 's2', name: 'Citrus', position: 1, items: [] },
];

// Committing an inline edit fires the field edit and then the category move,
// back to back without awaiting a render. moveItem builds its entire next
// state from sectionsRef.current and sets it ABSOLUTELY, so if editItem does
// not keep that ref in step, the move writes the pre-rename list back: the
// name change vanished, undo (restoring the pre-move state, which carried the
// old name too) looked like a no-op, and redo appeared to fix it.
describe('useGroceryList — editing a field and changing category together', () => {
  beforeEach(() => {
    resetGrocerySessionLoaded();
    vi.clearAllMocks();
    vi.mocked(useOnlineStatus).mockReturnValue(true);
    vi.mocked(getGroceryList).mockResolvedValue(sampleSections);
    vi.mocked(editGroceryItemAPI).mockResolvedValue(undefined as never);
    vi.mocked(moveGroceryItemAPI).mockResolvedValue(undefined as never);
  });

  it('keeps the new name when the item moves to another section', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editItem('i1', { name: 'Meyer Lemon' });
      await result.current.moveItem('s1', 0, 's2', 0);
    });

    const moved = result.current.sections.find(s => s.id === 's2')!.items;
    expect(moved).toHaveLength(1);
    expect(moved[0].name).toBe('Meyer Lemon');
    expect(result.current.sections.find(s => s.id === 's1')!.items).toHaveLength(0);
  });

  it('still applies a plain edit with no move', async () => {
    const { result } = renderHook(() => useGroceryList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.editItem('i1', { name: 'Meyer Lemon' });
    });

    expect(result.current.sections.find(s => s.id === 's1')!.items[0].name).toBe('Meyer Lemon');
  });
});
