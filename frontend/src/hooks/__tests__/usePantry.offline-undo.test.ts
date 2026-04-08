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
  getPantryList,
  addPantryItem as addPantryItemAPI,
  deletePantryItem as deletePantryItemAPI,
  replacePantryList as replacePantryListAPI,
  clearPantryItems as clearPantryItemsAPI,
  reorderPantrySections as reorderPantrySectionsAPI,
  movePantryItem as movePantryItemAPI,
} from '../../api/client';
import { queueChange, saveLocalPantrySections, saveLocalPantryItems, saveLocalPantryItem, deleteLocalPantryItem } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetPantryList = vi.mocked(getPantryList);
const mockAddAPI = vi.mocked(addPantryItemAPI);
const mockDeleteAPI = vi.mocked(deletePantryItemAPI);
const mockReplaceAPI = vi.mocked(replacePantryListAPI);
const mockClearAPI = vi.mocked(clearPantryItemsAPI);
const mockReorderSectionsAPI = vi.mocked(reorderPantrySectionsAPI);
const mockMovePantryItemAPI = vi.mocked(movePantryItemAPI);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
const mockQueueChange = vi.mocked(queueChange);
const mockSaveLocalSections = vi.mocked(saveLocalPantrySections);
const mockSaveLocalItems = vi.mocked(saveLocalPantryItems);
const mockSaveLocalItem = vi.mocked(saveLocalPantryItem);
const mockDeleteLocalItem = vi.mocked(deleteLocalPantryItem);

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

/**
 * Tests for undo/redo operations while offline.
 *
 * Pattern: perform action online (mock API success), then switch to offline
 * via isOnlineRef (by changing useOnlineStatus return), then call undo/redo.
 * Verify that queueChange is called with the correct change type and payload.
 */
describe('usePantry offline undo/redo', () => {
  beforeEach(() => {
    resetPantrySessionLoaded();
    vi.clearAllMocks();
    vi.useRealTimers();
    pushActionCalls.length = 0;
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetPantryList.mockResolvedValue(sampleSections);
  });

  it('addItem undo while offline queues pantry-delete', async () => {
    mockAddAPI.mockResolvedValue({
      id: 'server-1', section_id: 's1', name: 'Butter', quantity: 1, position: 2, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    // Add item online
    await act(async () => { await result.current.addItem('s1', 'Butter', 1); });

    await waitFor(() => {
      const section = result.current.sections.find(s => s.id === 's1')!;
      expect(section.items.some(i => i.name === 'Butter')).toBe(true);
    });

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-delete', '', { id: 'server-1' });
    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.find(i => i.name === 'Butter')).toBeUndefined();
  });

  it('addItem redo while offline queues pantry-add', async () => {
    mockAddAPI.mockResolvedValue({
      id: 'server-1', section_id: 's1', name: 'Butter', quantity: 1, position: 2, updated_at: '2026-01-02T00:00:00Z',
    });
    mockDeleteAPI.mockResolvedValue();

    const { result, rerender } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    // Add and undo online
    await act(async () => { await result.current.addItem('s1', 'Butter', 1); });
    await act(async () => { await pushActionCalls[0].undo(); });

    // Switch to offline and redo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].redo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-add', '', expect.objectContaining({
      sectionId: 's1',
      name: 'Butter',
      quantity: 1,
    }));
  });

  it('removeItem undo while offline queues pantry-add and restores position', async () => {
    mockDeleteAPI.mockResolvedValue();

    const { result, rerender } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    // Remove item online
    await act(async () => { await result.current.removeItem('1'); });
    expect(pushActionCalls[0].type).toBe('delete-pantry-item');

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-add', '', expect.objectContaining({
      sectionId: 's1',
      name: 'Milk',
      quantity: 2,
    }));
    // Item should be restored in state
    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items.some(i => i.name === 'Milk')).toBe(true);
  });

  it('removeItem redo while offline queues pantry-delete', async () => {
    mockDeleteAPI.mockResolvedValue();
    mockAddAPI.mockResolvedValue({
      id: 'restored-1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-01-03T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    // Remove and undo online
    await act(async () => { await result.current.removeItem('1'); });
    await act(async () => { await pushActionCalls[0].undo(); });

    // Switch to offline and redo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].redo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-delete', '', expect.objectContaining({
      id: expect.any(String),
    }));
  });

  it('clearAll undo while offline queues pantry-replace and saves to IndexedDB', async () => {
    mockClearAPI.mockResolvedValue([]);

    const { result, rerender } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

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

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-replace', '', expect.objectContaining({
      sections: expect.any(Array),
    }));
    expect(mockSaveLocalSections).toHaveBeenCalled();
    expect(mockSaveLocalItems).toHaveBeenCalled();
    expect(result.current.sections).toHaveLength(2);
  });

  it('clearAll redo while offline queues pantry-replace', async () => {
    mockClearAPI.mockResolvedValue([]);
    mockReplaceAPI.mockResolvedValue(sampleSections);

    const { result, rerender } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    // Clear and undo online
    await act(async () => { await result.current.clearAll(); });
    await act(async () => { await pushActionCalls[0].undo(); });

    // Switch to offline and redo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].redo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-replace', '', { sections: [] });
    expect(result.current.sections).toEqual([]);
  });

  it('reorderSections undo while offline queues pantry-reorder-sections', async () => {
    mockReorderSectionsAPI.mockResolvedValue({ status: 'ok' });

    const { result, rerender } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    // Reorder online
    await act(async () => { await result.current.reorderSections(0, 1); });
    expect(result.current.sections[0].name).toBe('Pantry');

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-reorder-sections', '', {
      sectionIds: ['s1', 's2'],
    });
    expect(result.current.sections[0].name).toBe('Fridge');
  });

  it('moveItem undo while offline queues pantry-move-item', async () => {
    mockMovePantryItemAPI.mockResolvedValue({
      id: '1', section_id: 's2', name: 'Milk', quantity: 2, position: 1, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result, rerender } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    // Move online
    await act(async () => { await result.current.moveItem('s1', 0, 's2', 0); });

    const pantrySection = result.current.sections.find(s => s.id === 's2')!;
    expect(pantrySection.items.some(i => i.id === '1')).toBe(true);

    // Switch to offline and undo
    mockUseOnlineStatus.mockReturnValue(false);
    rerender();
    mockQueueChange.mockClear();

    await act(async () => { await pushActionCalls[0].undo(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-move-item', '', {
      id: '1',
      toSectionId: 's1',
      toPosition: 0,
    });
    const fridgeSection = result.current.sections.find(s => s.id === 's1')!;
    expect(fridgeSection.items.some(i => i.id === '1')).toBe(true);
  });
});
