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
}));

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(),
}));

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({ canUndo: false, canRedo: false, pushAction: vi.fn(), undo: vi.fn(), redo: vi.fn() }),
}));

import { queueChange } from '../../db';
import { getLocalPantrySections, getLocalPantryItems } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const mockQueueChange = vi.mocked(queueChange);
const mockGetLocalSections = vi.mocked(getLocalPantrySections);
const mockGetLocalItems = vi.mocked(getLocalPantryItems);
const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

describe('usePantry - offline operations', () => {
  beforeEach(() => {
    resetPantrySessionLoaded();
    vi.clearAllMocks();
    vi.useRealTimers();
    mockUseOnlineStatus.mockReturnValue(false);
    mockGetLocalSections.mockResolvedValue([
      { id: 's1', name: 'Fridge', position: 0 },
      { id: 's2', name: 'Pantry', position: 1 },
    ]);
    mockGetLocalItems.mockResolvedValue([
      { id: '1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-01-01T00:00:00Z' },
      { id: '2', section_id: 's1', name: 'Eggs', quantity: 12, position: 1, updated_at: '2026-01-01T00:00:00Z' },
      { id: '3', section_id: 's2', name: 'Rice', quantity: 1, position: 0, updated_at: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('addItem queues change when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.addItem('s1', 'Butter', 1); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-add', '', expect.objectContaining({ sectionId: 's1', name: 'Butter' }));
  });

  it('clearAll queues change when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.clearAll(); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-replace', '', { sections: [] });
  });

  it('reorderSections queues change when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.reorderSections(0, 1); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-reorder-sections', '', expect.objectContaining({ sectionIds: expect.any(Array) }));
  });

  it('renameSection queues change when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.renameSection('s1', 'Freezer'); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-rename-section', '', { sectionId: 's1', name: 'Freezer' });
  });

  it('reorderItems queues change when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.reorderItems('s1', 0, 1); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-reorder-items', '', expect.objectContaining({ sectionId: 's1' }));
  });

  it('moveItem queues change when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.moveItem('s1', 0, 's2', 0); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-move-item', '', expect.objectContaining({ id: '1', toSectionId: 's2' }));
  });

  it('addSection queues change when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.addSection('Freezer'); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-replace', '', expect.objectContaining({ sections: expect.any(Array) }));
  });

  it('deleteSection queues change when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    await act(async () => { await result.current.deleteSection('s1'); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-replace', '', expect.objectContaining({ sections: expect.any(Array) }));
  });

  it('updateItem debounces and queues when offline', async () => {
    const { result } = renderHook(() => usePantry());
    await waitFor(() => expect(result.current.sections).toHaveLength(2));

    vi.useFakeTimers();

    act(() => { result.current.updateItem('1', { quantity: 5 }); });

    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(mockQueueChange).toHaveBeenCalledWith('pantry-update', '', expect.objectContaining({ id: '1', quantity: 5 }));
    vi.useRealTimers();
  });
});
