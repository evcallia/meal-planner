import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../api/client', () => ({
  getActivity: vi.fn(),
  markActivitySeen: vi.fn(),
}));
vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

import { useActivity } from '../useActivity';
import { getActivity } from '../../api/client';
import { DEFAULT_SETTINGS, Settings } from '../useSettings';

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  notifyGroceryEdits: true,
  notifyListsDue: true,
};

function emit(entry: Record<string, unknown>, actorSub = 'wife-sub') {
  window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
    detail: { type: 'activity.added', payload: { entry, actor_sub: actorSub } },
  }));
}

describe('useActivity live entries', () => {
  beforeEach(() => {
    vi.mocked(getActivity).mockResolvedValue({ entries: [], last_seen: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('appends a fully rendered SSE entry without refetching', async () => {
    const { result } = renderHook(() => useActivity(true, 'my-sub', settings));
    await waitFor(() => expect(getActivity).toHaveBeenCalledTimes(1));

    act(() => {
      emit({ id: 'e1', at: '2026-07-17T10:00:00', actor_name: 'Wife', category: 'grocery', detail: 'added “Milk”' });
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].detail).toBe('added “Milk”');
    expect(result.current.unseenCount).toBe(1);
    // No additional API call was made
    expect(getActivity).toHaveBeenCalledTimes(1);
  });

  it('ignores own edits and duplicates', async () => {
    const { result } = renderHook(() => useActivity(true, 'my-sub', settings));
    await waitFor(() => expect(getActivity).toHaveBeenCalled());

    act(() => {
      emit({ id: 'mine', at: '2026-07-17T10:00:00', actor_name: 'Me', category: 'grocery', detail: 'added “Eggs”' }, 'my-sub');
      emit({ id: 'e1', at: '2026-07-17T10:00:01', actor_name: 'Wife', category: 'grocery', detail: 'added “Milk”' });
      emit({ id: 'e1', at: '2026-07-17T10:00:01', actor_name: 'Wife', category: 'grocery', detail: 'added “Milk”' });
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].id).toBe('e1');
  });

  it('applies the notification cascade to live entries', async () => {
    const { result } = renderHook(() => useActivity(true, 'my-sub', settings));
    await waitFor(() => expect(getActivity).toHaveBeenCalled());

    act(() => {
      // meals is off in these settings
      emit({ id: 'm1', at: '2026-07-17T10:00:00', actor_name: 'Wife', category: 'meals', detail: 'updated meals' });
      // due entry for a muted list
      emit({ id: 'd1', at: '2026-07-17T10:00:01', actor_name: '', category: 'list-due', detail: '“X” is due', list_id: 'muted-list' }, '');
    });
    expect(result.current.entries).toHaveLength(1); // only the due entry (list not muted in settings)

    const muting: Settings = {
      ...settings,
      listNotifyOverrides: { 'muted-list': { due: false } },
    };
    const { result: result2 } = renderHook(() => useActivity(true, 'my-sub', muting));
    await waitFor(() => expect(getActivity).toHaveBeenCalled());
    act(() => {
      emit({ id: 'd2', at: '2026-07-17T10:00:02', actor_name: '', category: 'list-due', detail: '“X” is due', list_id: 'muted-list' }, '');
    });
    expect(result2.current.entries).toHaveLength(0);
  });
});

describe('useActivity resume catch-up', () => {
  beforeEach(() => {
    vi.mocked(getActivity).mockResolvedValue({ entries: [], last_seen: null });
  });

  it('refetches when the app becomes visible again', async () => {
    renderHook(() => useActivity(true, 'my-sub', settings));
    await waitFor(() => expect(getActivity).toHaveBeenCalledTimes(1));

    // Simulate resume: SSE events missed while suspended → visibility reload
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(getActivity).toHaveBeenCalledTimes(2));
  });
});

describe('useActivity SSE reconnect catch-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(getActivity).mockResolvedValue({ entries: [], last_seen: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refetches (debounced) after the SSE stream (re)connects', async () => {
    renderHook(() => useActivity(true, 'my-sub', settings));
    await act(async () => { await Promise.resolve(); });
    expect(getActivity).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('meal-planner-realtime-connected'));
      vi.advanceTimersByTime(5100);
    });
    await act(async () => { await Promise.resolve(); });
    expect(getActivity).toHaveBeenCalledTimes(2);
  });
});
