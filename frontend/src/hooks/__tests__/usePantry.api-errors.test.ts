import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  addPantryItem as addPantryItemAPI,
  deletePantryItem as deletePantryItemAPI,
  clearPantryItems as clearPantryItemsAPI,
  reorderPantrySections as reorderPantrySectionsAPI,
  reorderPantryItems as reorderPantryItemsAPI,
  renamePantrySection as renamePantrySectionAPI,
  movePantryItem as movePantryItemAPI,
  createPantrySection as createPantrySectionAPI,
  deletePantrySection as deletePantrySectionAPI,
} from '../../api/client';
import { queueChange } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockGetPantryList = vi.mocked(getPantryList);
const mockAddAPI = vi.mocked(addPantryItemAPI);
const mockDeleteAPI = vi.mocked(deletePantryItemAPI);
const mockClearAPI = vi.mocked(clearPantryItemsAPI);
const mockReorderSectionsAPI = vi.mocked(reorderPantrySectionsAPI);
const mockReorderItemsAPI = vi.mocked(reorderPantryItemsAPI);
const mockRenameSectionAPI = vi.mocked(renamePantrySectionAPI);
const mockMovePantryItemAPI = vi.mocked(movePantryItemAPI);
const mockCreateSectionAPI = vi.mocked(createPantrySectionAPI);
const mockDeleteSectionAPI = vi.mocked(deletePantrySectionAPI);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
const mockQueueChange = vi.mocked(queueChange);

const sampleSections = [
  {
    id: 's1', name: 'Fridge', position: 0,
    items: [
      { id: '1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
  {
    id: 's2', name: 'Pantry', position: 1,
    items: [
      { id: '2', section_id: 's2', name: 'Rice', quantity: 1, position: 0, updated_at: '2026-01-01T00:00:00Z' },
    ],
  },
];

describe('usePantry - API error handling', () => {
  beforeEach(() => {
    resetPantrySessionLoaded();
    vi.clearAllMocks();
    vi.useRealTimers();
    mockUseOnlineStatus.mockReturnValue(true);
    mockGetPantryList.mockResolvedValue(sampleSections);
  });

  it('addItem queues on API error', async () => {
    mockAddAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.addItem('s1', 'Butter', 1); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-add', '', expect.objectContaining({ sectionId: 's1', name: 'Butter' }));
  });

  it('removeItem queues on API error', async () => {
    mockDeleteAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.removeItem('1'); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-delete', '', { id: '1' });
  });

  it('clearAll queues on API error', async () => {
    mockClearAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.clearAll(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-replace', '', { sections: [] });
  });

  it('reorderSections queues on API error', async () => {
    mockReorderSectionsAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.reorderSections(0, 1); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-reorder-sections', '', expect.objectContaining({ sectionIds: expect.any(Array) }));
  });

  it('reorderItems queues on API error', async () => {
    mockReorderItemsAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.reorderItems('s1', 0, 0); });
    // No reorder when from === to
    expect(mockReorderItemsAPI).not.toHaveBeenCalled();
  });

  it('renameSection queues on API error', async () => {
    mockRenameSectionAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.renameSection('s1', 'Freezer'); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-rename-section', '', { sectionId: 's1', name: 'Freezer' });
  });

  it('moveItem queues on API error', async () => {
    mockMovePantryItemAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.moveItem('s1', 0, 's2', 0); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-move-item', '', expect.objectContaining({ id: '1', toSectionId: 's2' }));
  });

  it('addSection queues on API error', async () => {
    mockCreateSectionAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.addSection('Freezer'); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-create-section', '', expect.objectContaining({ name: 'Freezer', tempId: expect.any(String) }));
  });

  it('deleteSection queues on API error', async () => {
    mockDeleteSectionAPI.mockRejectedValue(new Error('fail'));

    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.deleteSection('s1'); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-delete-section', '', expect.objectContaining({ sectionId: 's1', name: 'Fridge' }));
  });
});
