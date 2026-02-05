import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMealIdeas } from '../useMealIdeas';

vi.mock('../../api/client', () => ({
  getMealIdeas: vi.fn(),
  createMealIdea: vi.fn(),
  updateMealIdea: vi.fn(),
  deleteMealIdea: vi.fn(),
}));

vi.mock('../../db', () => ({
  generateTempId: vi.fn(() => `temp-${Date.now()}`),
  isTempId: vi.fn((id: string) => id.startsWith('temp-')),
  queueChange: vi.fn(),
  saveLocalMealIdea: vi.fn(),
  getLocalMealIdeas: vi.fn(() => Promise.resolve([])),
  deleteLocalMealIdea: vi.fn(),
  clearLocalMealIdeas: vi.fn(),
}));

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(),
}));

import { getMealIdeas, createMealIdea, updateMealIdea, deleteMealIdea } from '../../api/client';
import { getLocalMealIdeas, clearLocalMealIdeas, saveLocalMealIdea } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

describe('useMealIdeas', () => {
  const mockGetMealIdeas = vi.mocked(getMealIdeas);
  const mockCreateMealIdea = vi.mocked(createMealIdea);
  const mockUpdateMealIdea = vi.mocked(updateMealIdea);
  const mockDeleteMealIdea = vi.mocked(deleteMealIdea);
  const mockGetLocalMealIdeas = vi.mocked(getLocalMealIdeas);
  const mockClearLocalMealIdeas = vi.mocked(clearLocalMealIdeas);
  const mockSaveLocalMealIdea = vi.mocked(saveLocalMealIdea);
  const mockUseOnlineStatus = vi.mocked(useOnlineStatus);
  const storage = new Map<string, string>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockUseOnlineStatus.mockReturnValue(true);
    storage.clear();
    mockGetLocalMealIdeas.mockResolvedValue([]);
    mockClearLocalMealIdeas.mockResolvedValue(undefined);
    mockSaveLocalMealIdea.mockResolvedValue(undefined);
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => storage.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      storage.set(key, String(value));
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      storage.delete(key);
    });
    vi.mocked(localStorage.clear).mockImplementation(() => {
      storage.clear();
    });
    localStorage.clear();
  });

  it('loads meal ideas from the server and sorts by updated time', async () => {
    mockGetMealIdeas.mockResolvedValueOnce([
      { id: '1', title: 'Older', updated_at: '2026-02-03T10:00:00Z' },
      { id: '2', title: 'Newer', updated_at: '2026-02-03T12:00:00Z' },
    ]);

    const { result } = renderHook(() => useMealIdeas());

    await waitFor(() => expect(result.current.ideas).toHaveLength(2));
    expect(result.current.ideas[0].title).toBe('Newer');
    expect(result.current.ideas[1].title).toBe('Older');
  });

  it('adds a meal idea via the API and refreshes the list', async () => {
    mockGetMealIdeas
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: '1', title: 'Salmon Bites', updated_at: '2026-02-03T12:30:00Z' }]);
    mockCreateMealIdea.mockResolvedValue({ id: '1', title: 'Salmon Bites', updated_at: '2026-02-03T12:30:00Z' });

    const { result } = renderHook(() => useMealIdeas());

    await waitFor(() => expect(result.current.ideas).toHaveLength(0));

    await act(async () => {
      result.current.addIdea({ title: 'Salmon Bites' });
    });

    await waitFor(() => {
      expect(mockCreateMealIdea).toHaveBeenCalledWith({ title: 'Salmon Bites' });
      expect(result.current.ideas).toHaveLength(1);
    });
  });

  it('debounces updates before calling the API', async () => {
    mockGetMealIdeas
      .mockResolvedValueOnce([{ id: '1', title: 'Idea', updated_at: '2026-02-03T10:00:00Z' }])
      .mockResolvedValueOnce([{ id: '1', title: 'Updated', updated_at: '2026-02-03T10:05:00Z' }]);
    mockUpdateMealIdea.mockResolvedValue({ id: '1', title: 'Updated', updated_at: '2026-02-03T10:05:00Z' });

    const { result } = renderHook(() => useMealIdeas());

    await waitFor(() => expect(result.current.ideas).toHaveLength(1));

    vi.useFakeTimers();

    act(() => {
      result.current.updateIdea('1', { title: 'Updated' });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(mockUpdateMealIdea).toHaveBeenCalledWith('1', { title: 'Updated' });
    vi.useRealTimers();
  });

  it('removes meal ideas via the API', async () => {
    mockGetMealIdeas
      .mockResolvedValueOnce([
        { id: '1', title: 'Idea', updated_at: '2026-02-03T12:00:00Z' },
      ])
      .mockResolvedValueOnce([]);
    mockDeleteMealIdea.mockResolvedValue();

    const { result } = renderHook(() => useMealIdeas());

    await waitFor(() => expect(result.current.ideas).toHaveLength(1));

    await act(async () => {
      result.current.removeIdea('1');
    });

    await waitFor(() => {
      expect(mockDeleteMealIdea).toHaveBeenCalledWith('1');
    });
  });

  it('refreshes when a realtime meal-ideas update arrives', async () => {
    let shouldReturnUpdated = false;
    mockGetMealIdeas.mockImplementation(() => Promise.resolve(
      shouldReturnUpdated
        ? [{ id: '1', title: 'Tacos', updated_at: '2026-02-03T13:30:00Z' }]
        : []
    ));

    const { result } = renderHook(() => useMealIdeas());

    await waitFor(() => expect(mockGetMealIdeas).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.ideas).toHaveLength(0));

    shouldReturnUpdated = true;
    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: { type: 'meal-ideas.updated' } }));
    });

    await waitFor(() => expect(mockGetMealIdeas).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.ideas).toHaveLength(1));
  });

  it('hydrates from local storage only on the first load', async () => {
    localStorage.setItem('meal-planner-meal-ideas', JSON.stringify([
      { id: 'local-1', title: 'Local Idea', updated_at: '2026-02-03T09:00:00Z' },
    ]));
    let created = false;
    mockCreateMealIdea.mockImplementation(async () => {
      created = true;
      return { id: 'server-1', title: 'Local Idea', updated_at: '2026-02-03T09:00:00Z' };
    });
    mockGetMealIdeas.mockImplementation(() => Promise.resolve(
      created
        ? [{ id: 'server-1', title: 'Local Idea', updated_at: '2026-02-03T09:00:00Z' }]
        : []
    ));

    const { result } = renderHook(() => useMealIdeas());

    await waitFor(() => expect(mockCreateMealIdea).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.ideas).toHaveLength(1));

    localStorage.setItem('meal-planner-meal-ideas', JSON.stringify([
      { id: 'local-1', title: 'Local Idea', updated_at: '2026-02-03T09:00:00Z' },
    ]));

    act(() => {
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: { type: 'meal-ideas.updated' } }));
    });

    await waitFor(() => expect(mockGetMealIdeas).toHaveBeenCalledTimes(3));
    expect(mockCreateMealIdea).toHaveBeenCalledTimes(1);
  });
});
