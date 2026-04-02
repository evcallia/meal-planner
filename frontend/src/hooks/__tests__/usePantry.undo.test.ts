import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePantry, resetPantrySessionLoaded } from '../usePantry';

const pushActionCalls: any[] = [];

vi.mock('../../api/client', () => ({
  getPantryList: vi.fn(),
  addPantryItem: vi.fn(),
  updatePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
  replacePantryList: vi.fn(),
  clearPantryItems: vi.fn(),
  reorderPantrySections: vi.fn(),
  reorderPantryItems: vi.fn(),
  renamePantrySection: vi.fn(),
  movePantryItem: vi.fn(),
  createPantrySection: vi.fn(),
  deletePantrySection: vi.fn(),
}));

vi.mock('../../db', () => ({
  generateTempId: vi.fn(() => `temp-${Math.random().toString(36).slice(2)}`),
  queueChange: vi.fn(),
  saveLocalPantryItem: vi.fn(),
  saveLocalPantryItems: vi.fn(),
  getLocalPantryItems: vi.fn(() => Promise.resolve([])),
  getLocalPantrySections: vi.fn(() => Promise.resolve([])),
  saveLocalPantrySections: vi.fn(),
  deleteLocalPantryItem: vi.fn(),
  clearLocalPantryItems: vi.fn(),
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
  getPantryList,
  addPantryItem as addPantryItemAPI,
  deletePantryItem as deletePantryItemAPI,
  replacePantryList as replacePantryListAPI,
  clearPantryItems as clearPantryItemsAPI,
  reorderPantrySections as reorderPantrySectionsAPI,
  reorderPantryItems as reorderPantryItemsAPI,
  renamePantrySection as renamePantrySectionAPI,
  movePantryItem as movePantryItemAPI,
  createPantrySection as createPantrySectionAPI,
  deletePantrySection as deletePantrySectionAPI,
} from '../../api/client';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetPantryList = vi.mocked(getPantryList);
const mockAddAPI = vi.mocked(addPantryItemAPI);
const mockDeleteAPI = vi.mocked(deletePantryItemAPI);
const mockReplaceAPI = vi.mocked(replacePantryListAPI);
const mockClearAPI = vi.mocked(clearPantryItemsAPI);
const mockReorderSectionsAPI = vi.mocked(reorderPantrySectionsAPI);
const mockReorderItemsAPI = vi.mocked(reorderPantryItemsAPI);
const mockRenameSectionAPI = vi.mocked(renamePantrySectionAPI);
const mockMovePantryItemAPI = vi.mocked(movePantryItemAPI);
const mockCreateSectionAPI = vi.mocked(createPantrySectionAPI);
const mockDeleteSectionAPI = vi.mocked(deletePantrySectionAPI);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

const sampleSections = [
  {
    id: 's1', name: 'Fridge', position: 0,
    items: [
      { id: '1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-01-01T00:00:00Z' },
      { id: '2', section_id: 's1', name: 'Eggs', quantity: 12, position: 1, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
  {
    id: 's2', name: 'Pantry', position: 1,
    items: [
      { id: '3', section_id: 's2', name: 'Rice', quantity: 1, position: 0, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
];

describe('usePantry undo/redo', () => {
  beforeEach(() => {
    resetPantrySessionLoaded();
    vi.clearAllMocks();
    vi.useRealTimers();
    pushActionCalls.length = 0;
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetPantryList.mockResolvedValue(sampleSections);
  });

  it('addItem undo removes the added item', async () => {
    mockAddAPI.mockResolvedValue({
      id: 'server-1', section_id: 's1', name: 'Butter', quantity: 1, position: 2, updated_at: '2026-01-02T00:00:00Z',
    });
    mockDeleteAPI.mockResolvedValue();

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.addItem('s1', 'Butter', 1); });

    await waitFor(() => {
      const section = result.current.sections.find(s => s.id === 's1')!;
      expect(section.items.some(i => i.name === 'Butter')).toBe(true);
    });

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.find(i => i.name === 'Butter')).toBeUndefined();
  });

  it('removeItem undo restores the item', async () => {
    mockDeleteAPI.mockResolvedValue();
    mockAddAPI.mockResolvedValue({
      id: 'restored-1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-01-03T00:00:00Z',
    });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.removeItem('1'); });
    expect(pushActionCalls[0].type).toBe('delete-pantry-item');

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.some(i => i.name === 'Milk')).toBe(true);
  });

  it('clearAll undo restores sections', async () => {
    mockClearAPI.mockResolvedValue([]);
    mockReplaceAPI.mockResolvedValue(sampleSections);

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.clearAll(); });
    expect(result.current.sections).toEqual([]);

    // Undo
    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections).toHaveLength(2);
  });

  it('clearAll redo clears again', async () => {
    mockClearAPI.mockResolvedValue([]);
    mockReplaceAPI.mockResolvedValue(sampleSections);

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.clearAll(); });
    await act(async () => { await pushActionCalls[0].undo(); });
    await act(async () => { await pushActionCalls[0].redo(); });
    expect(result.current.sections).toEqual([]);
  });

  it('reorderSections undo restores order', async () => {
    mockReorderSectionsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.reorderSections(0, 1); });
    expect(result.current.sections[0].name).toBe('Pantry');

    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections[0].name).toBe('Fridge');
  });

  it('reorderItems undo restores order', async () => {
    mockReorderItemsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.reorderItems('s1', 0, 1); });
    expect(result.current.sections[0].items[0].name).toBe('Eggs');

    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections[0].items[0].name).toBe('Milk');
  });

  it('renameSection undo restores original name', async () => {
    mockRenameSectionAPI.mockResolvedValue({ id: 's1', name: 'Freezer', position: 0, items: [] });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.renameSection('s1', 'Freezer'); });
    expect(result.current.sections[0].name).toBe('Freezer');

    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections[0].name).toBe('Fridge');
  });

  it('addSection undo removes the section', async () => {
    mockCreateSectionAPI.mockResolvedValue({ id: 'server-s3', name: 'Freezer', position: 2, items: [] });
    mockDeleteSectionAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.addSection('Freezer'); });
    await waitFor(() => expect(result.current.sections).toHaveLength(3));

    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections).toHaveLength(2);
  });

  it('deleteSection undo restores the section at original position', async () => {
    mockDeleteSectionAPI.mockResolvedValue({ status: 'ok' });
    mockCreateSectionAPI.mockResolvedValue({ id: 'restored-s1', name: 'Fridge', position: 0, items: [] });
    mockAddAPI.mockImplementation(async (_sectionId, name, quantity) => ({
      id: `restored-${name}`, section_id: 'restored-s1', name, quantity, position: 0, updated_at: '2026-01-03T00:00:00Z',
    }));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    // Capture original order: s1 (Fridge) at index 0, s2 (Pantry) at index 1
    expect(result.current.sections[0].id).toBe('s1');
    expect(result.current.sections[1].id).toBe('s2');

    // Delete first section
    await act(async () => { await result.current.deleteSection('s1'); });
    expect(result.current.sections).toHaveLength(1);
    expect(result.current.sections[0].id).toBe('s2');

    // Undo — should restore at index 0, not append to end
    await act(async () => { await pushActionCalls[0].undo(); });
    expect(result.current.sections).toHaveLength(2);
    expect(result.current.sections[0].name).toBe('Fridge');
    expect(result.current.sections[1].id).toBe('s2');
  });

  it('moveItem undo moves item back', async () => {
    mockMovePantryItemAPI.mockResolvedValue({
      id: '1', section_id: 's2', name: 'Milk', quantity: 2, position: 1, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.moveItem('s1', 0, 's2', 0); });

    const pantrySection = result.current.sections.find(s => s.id === 's2')!;
    expect(pantrySection.items.some(i => i.id === '1')).toBe(true);

    await act(async () => { await pushActionCalls[0].undo(); });
    const fridgeSection = result.current.sections.find(s => s.id === 's1')!;
    expect(fridgeSection.items.some(i => i.id === '1')).toBe(true);
  });
});
