import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePantry, resetPantrySessionLoaded } from '../usePantry';

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
  getPantryList,
  clearPantryItems as clearPantryItemsAPI,
  reorderPantrySections as reorderPantrySectionsAPI,
  reorderPantryItems as reorderPantryItemsAPI,
  renamePantrySection as renamePantrySectionAPI,
  createPantrySection as createPantrySectionAPI,
  deletePantrySection as deletePantrySectionAPI,
  movePantryItem as movePantryItemAPI,
} from '../../api/client';
import { getLocalPantrySections, getLocalPantryItems, queueChange } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetPantryList = vi.mocked(getPantryList);
const mockClearAPI = vi.mocked(clearPantryItemsAPI);
const mockReorderSectionsAPI = vi.mocked(reorderPantrySectionsAPI);
const mockReorderItemsAPI = vi.mocked(reorderPantryItemsAPI);
const mockRenameSectionAPI = vi.mocked(renamePantrySectionAPI);
const mockCreateSectionAPI = vi.mocked(createPantrySectionAPI);
const mockDeleteSectionAPI = vi.mocked(deletePantrySectionAPI);
const mockMovePantryItemAPI = vi.mocked(movePantryItemAPI);
const mockGetLocalSections = vi.mocked(getLocalPantrySections);
const mockGetLocalItems = vi.mocked(getLocalPantryItems);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
const mockQueueChange = vi.mocked(queueChange);

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

describe('usePantry - additional tests', () => {
  beforeEach(() => {
    resetPantrySessionLoaded();
    vi.clearAllMocks();
    vi.useRealTimers();
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetLocalSections.mockResolvedValue([]);
    mockGetLocalItems.mockResolvedValue([]);
    mockGetPantryList.mockResolvedValue(sampleSections);
  });

  it('clearAll clears sections and calls API', async () => {
    mockClearAPI.mockResolvedValue([]);

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.clearAll();
    });

    expect(result.current.sections).toEqual([]);
    expect(mockClearAPI).toHaveBeenCalledWith('all');
  });

  it('reorderSections swaps section positions', async () => {
    mockReorderSectionsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.reorderSections(0, 1);
    });

    expect(result.current.sections[0].name).toBe('Pantry');
    expect(result.current.sections[1].name).toBe('Fridge');
    expect(mockReorderSectionsAPI).toHaveBeenCalled();
  });

  it('reorderSections does nothing when from === to', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.reorderSections(0, 0);
    });

    expect(mockReorderSectionsAPI).not.toHaveBeenCalled();
  });

  it('reorderItems reorders items within a section', async () => {
    mockReorderItemsAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.reorderItems('s1', 0, 1);
    });

    const section = result.current.sections.find(s => s.id === 's1')!;
    expect(section.items[0].name).toBe('Eggs');
    expect(section.items[1].name).toBe('Milk');
  });

  it('renameSection renames optimistically and calls API', async () => {
    mockRenameSectionAPI.mockResolvedValue({ id: 's1', name: 'Freezer', position: 0, items: [] });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.renameSection('s1', 'Freezer');
    });

    expect(result.current.sections[0].name).toBe('Freezer');
    expect(mockRenameSectionAPI).toHaveBeenCalledWith('s1', 'Freezer');
  });

  it('renameSection does nothing for empty name', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.renameSection('s1', '  ');
    });

    expect(mockRenameSectionAPI).not.toHaveBeenCalled();
  });

  it('addSection creates new section with temp ID', async () => {
    mockCreateSectionAPI.mockResolvedValue({
      id: 'server-s3', name: 'Freezer', position: 2, items: [],
    });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.addSection('Freezer');
    });

    await waitFor(() => {
      expect(result.current.sections).toHaveLength(3);
      expect(result.current.sections[2].name).toBe('Freezer');
    });
  });

  it('deleteSection removes section optimistically', async () => {
    mockDeleteSectionAPI.mockResolvedValue({ status: 'ok' });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.deleteSection('s1');
    });

    expect(result.current.sections).toHaveLength(1);
    expect(result.current.sections[0].name).toBe('Pantry');
  });

  it('adjustQuantity adjusts item quantity by delta', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    act(() => {
      result.current.adjustQuantity('1', 3);
    });

    const section = result.current.sections.find(s => s.id === 's1')!;
    const milk = section.items.find(i => i.id === '1')!;
    expect(milk.quantity).toBe(5); // 2 + 3
  });

  it('adjustQuantity does not go below zero', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    act(() => {
      result.current.adjustQuantity('3', -10);
    });

    const section = result.current.sections.find(s => s.id === 's2')!;
    const rice = section.items.find(i => i.id === '3')!;
    expect(rice.quantity).toBe(0);
  });

  it('moveItem moves item between sections', async () => {
    mockMovePantryItemAPI.mockResolvedValue({
      id: '1', section_id: 's2', name: 'Milk', quantity: 2, position: 1, updated_at: '2026-01-02T00:00:00Z',
    });

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => {
      await result.current.moveItem('s1', 0, 's2', 0);
    });

    const fromSection = result.current.sections.find(s => s.id === 's1')!;
    const toSection = result.current.sections.find(s => s.id === 's2')!;
    expect(fromSection.items.find(i => i.id === '1')).toBeUndefined();
    expect(toSection.items.find(i => i.id === '1')).toBeDefined();
  });

  it('queues changes offline instead of calling API', async () => {
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Fridge', position: 0 },
    ]);
    mockGetLocalItems.mockResolvedValue([
      { id: '1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(1));

    await act(async () => {
      await result.current.removeItem('1');
    });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-delete', '', { id: '1' });
  });

  it('falls back to local storage on API error', async () => {
    mockGetPantryList.mockRejectedValue(new Error('Network error'));
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Cached', position: 0 },
    ]);
    mockGetLocalItems.mockResolvedValue([]);

    const { result } = renderHook(() => usePantry());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sections[0].name).toBe('Cached');
  });
});
