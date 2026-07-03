import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTracker, resetTrackerSessionLoaded } from '../useTracker';
import type { TrackerList, TrackerLog } from '../../types';

// Regression: mark a task done, delete its list, undo the delete (the restore
// reissues every task/log id), then undo the mark-done. The mark-done undo
// must delete the RECREATED log — before the fix it targeted the pre-delete
// log id, which no longer exists, and silently no-oped.

const pushActionCalls: { type: string; undo: () => Promise<void>; redo: () => Promise<void> }[] = [];

vi.mock('../../api/client', () => ({
  getTrackerLists: vi.fn(),
  createTrackerList: vi.fn(),
  restoreTrackerList: vi.fn(),
  updateTrackerList: vi.fn(),
  deleteTrackerList: vi.fn(),
  addTrackerShare: vi.fn(),
  removeTrackerShare: vi.fn(),
  leaveTrackerList: vi.fn(),
  rejoinTrackerList: vi.fn(),
  createTrackerTask: vi.fn(),
  updateTrackerTask: vi.fn(),
  deleteTrackerTask: vi.fn(),
  reorderTrackerTasks: vi.fn(),
  reorderTrackerLists: vi.fn(),
  addTrackerLog: vi.fn(),
  deleteTrackerLog: vi.fn(),
  getTrackerLogs: vi.fn(),
}));

let tempCounter = 0;
vi.mock('../../db', () => ({
  generateTempId: vi.fn(() => `temp-${++tempCounter}`),
  isTempId: (id: string) => id.startsWith('temp-'),
  queueChange: vi.fn(() => Promise.resolve()),
  getPendingChanges: vi.fn(() => Promise.resolve([])),
  removePendingChange: vi.fn(() => Promise.resolve()),
  saveTempIdMapping: vi.fn(() => Promise.resolve()),
  getTempIdMapping: vi.fn(() => Promise.resolve(null)),
  removePendingChangesForTempId: vi.fn(() => Promise.resolve()),
  saveLocalTrackerLists: vi.fn(() => Promise.resolve()),
  getLocalTrackerLists: vi.fn(() => Promise.resolve([])),
  saveLocalTrackerList: vi.fn(() => Promise.resolve()),
  deleteLocalTrackerList: vi.fn(() => Promise.resolve()),
  saveLocalTrackerTasks: vi.fn(() => Promise.resolve()),
  getLocalTrackerTasks: vi.fn(() => Promise.resolve([])),
  saveLocalTrackerTask: vi.fn(() => Promise.resolve()),
  deleteLocalTrackerTask: vi.fn(() => Promise.resolve()),
}));

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({
    canUndo: false,
    canRedo: false,
    pushAction: vi.fn((action: { type: string; undo: () => Promise<void>; redo: () => Promise<void> }) => {
      pushActionCalls.push(action);
    }),
    undo: vi.fn(),
    redo: vi.fn(),
  }),
}));

import {
  getTrackerLists as getTrackerListsAPI,
  addTrackerLog as addTrackerLogAPI,
  deleteTrackerLog as deleteTrackerLogAPI,
  deleteTrackerList as deleteTrackerListAPI,
  restoreTrackerList as restoreTrackerListAPI,
  getTrackerLogs as getTrackerLogsAPI,
} from '../../api/client';
import { queueChange, getPendingChanges, removePendingChange, getLocalTrackerLists, getLocalTrackerTasks } from '../../db';
import { useOnlineStatus } from '../useOnlineStatus';

const DONE_AT = '2026-07-01T12:00:00';

const baseTask = {
  id: 'task-1', list_id: 'list-1', name: 'Vacuum',
  target_interval_days: 7, notes: null, position: 0, archived: false,
  season_start_month: null, season_end_month: null, season_start_day: null, season_end_day: null,
  snooze_until: null, last_done_at: null, last_event_at: null, last_done_by: null,
  last_note: null, total_count: 0, avg_interval_days: null, recent_logs: [] as TrackerLog[],
};

const baseList: TrackerList = {
  id: 'list-1', name: 'Chores', icon: null, color: null, position: 0,
  owner_sub: 'me', owner_name: 'Me', is_owner: true, shared_with: [],
  tasks: [baseTask],
};

describe('useTracker undo across a list restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushActionCalls.length = 0;
    tempCounter = 0;
    resetTrackerSessionLoaded();
    // clearAllMocks keeps mockResolvedValue implementations — reset the
    // stateful ones so tests don't leak into each other.
    vi.mocked(getPendingChanges).mockResolvedValue([]);
    vi.mocked(getLocalTrackerLists).mockResolvedValue([] as never);
    vi.mocked(getLocalTrackerTasks).mockResolvedValue([] as never);
    vi.mocked(useOnlineStatus).mockReturnValue(true);
  });

  it('mark-done undo deletes the recreated log after delete-list undo reissues ids', async () => {
    vi.mocked(getTrackerListsAPI).mockResolvedValue([baseList]);
    vi.mocked(addTrackerLogAPI).mockResolvedValue({
      id: 'log-1', task_id: 'task-1', done_at: DONE_AT, kind: 'done',
      note: null, created_by_sub: 'me', created_by_name: 'Me',
    } as TrackerLog);
    vi.mocked(deleteTrackerListAPI).mockResolvedValue(undefined as never);
    vi.mocked(deleteTrackerLogAPI).mockResolvedValue(undefined as never);
    // getTrackerLogs: pre-delete snapshot sees the original log id; the
    // post-restore fetch (new task id) sees the recreated one.
    vi.mocked(getTrackerLogsAPI).mockImplementation(async (taskId: string) => {
      if (taskId === 'task-1') {
        return [{ id: 'log-1', task_id: 'task-1', done_at: DONE_AT, kind: 'done', note: null, created_by_sub: 'me', created_by_name: 'Me' }] as TrackerLog[];
      }
      return [{ id: 'log-2', task_id: 'task-2', done_at: DONE_AT, kind: 'done', note: null, created_by_sub: 'me', created_by_name: 'Me' }] as TrackerLog[];
    });
    // The restore reissues list/task/log ids, as the real server does.
    vi.mocked(restoreTrackerListAPI).mockResolvedValue({
      ...baseList,
      id: 'list-2',
      tasks: [{
        ...baseTask, id: 'task-2', list_id: 'list-2', total_count: 1,
        last_done_at: DONE_AT, last_event_at: DONE_AT,
        recent_logs: [{ id: 'log-2', task_id: 'task-2', done_at: DONE_AT, kind: 'done', note: null, created_by_sub: 'me', created_by_name: 'Me' }],
      }],
    } as TrackerList);

    const { result } = renderHook(() => useTracker());
    await waitFor(() => expect(result.current.lists).toHaveLength(1));

    // 1. Mark the task done (undo entry #0).
    await act(async () => {
      result.current.markDone('list-1', 'task-1', DONE_AT, null, { sub: 'me', name: 'Me' });
    });
    await waitFor(() => expect(addTrackerLogAPI).toHaveBeenCalled());

    // 2. Delete the list (undo entry #1).
    await act(async () => {
      await result.current.deleteList('list-1');
    });
    expect(deleteTrackerListAPI).toHaveBeenCalledWith('list-1');
    expect(pushActionCalls.map(a => a.type)).toEqual(['tracker-log-add', 'tracker-list-delete']);

    // 3. Undo the delete — the restore comes back with all-new ids.
    await act(async () => {
      await pushActionCalls[1].undo();
    });
    expect(restoreTrackerListAPI).toHaveBeenCalled();

    // 4. Undo the mark-done — must delete the RECREATED log, not the dead id.
    await act(async () => {
      await pushActionCalls[0].undo();
    });
    expect(deleteTrackerLogAPI).toHaveBeenCalledTimes(1);
    expect(deleteTrackerLogAPI).toHaveBeenCalledWith('log-2');
  });

  it('offline delete + offline undo cancels the queued delete and keeps original ids', async () => {
    vi.mocked(useOnlineStatus).mockReturnValue(false);
    // Offline: the hook hydrates from the local cache, not the API.
    const { tasks: _tasks, ...localList } = baseList;
    vi.mocked(getLocalTrackerLists).mockResolvedValue([localList] as never);
    vi.mocked(getLocalTrackerTasks).mockResolvedValue([baseTask] as never);

    const { result } = renderHook(() => useTracker());
    await waitFor(() => expect(result.current.lists).toHaveLength(1));

    await act(async () => {
      await result.current.deleteList('list-1');
    });
    // Offline: the delete was queued, not sent.
    expect(deleteTrackerListAPI).not.toHaveBeenCalled();
    expect(queueChange).toHaveBeenCalledWith('tracker-list-delete', '', { id: 'list-1' });

    // The queued delete is still pending when the undo runs.
    vi.mocked(getPendingChanges).mockResolvedValue([
      { id: 42, type: 'tracker-list-delete', payload: { id: 'list-1' }, timestamp: 0, entityId: '' } as never,
    ]);
    await act(async () => {
      await pushActionCalls[0].undo();
    });

    // The pending delete was cancelled — server never involved, original ids kept.
    expect(removePendingChange).toHaveBeenCalledWith(42);
    expect(queueChange).not.toHaveBeenCalledWith('tracker-list-restore', '', expect.anything());
    expect(result.current.lists).toHaveLength(1);
    expect(result.current.lists[0].id).toBe('list-1');
    expect(result.current.lists[0].tasks[0].id).toBe('task-1');
  });

  it('offline undo of an already-synced delete queues a full restore', async () => {
    // Delete happens online...
    vi.mocked(useOnlineStatus).mockReturnValue(true);
    vi.mocked(getTrackerListsAPI).mockResolvedValue([baseList]);
    vi.mocked(getTrackerLogsAPI).mockResolvedValue([
      { id: 'log-1', task_id: 'task-1', done_at: DONE_AT, kind: 'done', note: null, created_by_sub: 'me', created_by_name: 'Me' },
    ] as TrackerLog[]);
    vi.mocked(deleteTrackerListAPI).mockResolvedValue(undefined as never);

    const { result, rerender } = renderHook(() => useTracker());
    await waitFor(() => expect(result.current.lists).toHaveLength(1));
    await act(async () => {
      await result.current.deleteList('list-1');
    });
    expect(deleteTrackerListAPI).toHaveBeenCalledWith('list-1');

    // ...then the device goes offline before the undo.
    vi.mocked(useOnlineStatus).mockReturnValue(false);
    rerender();
    await act(async () => {
      await pushActionCalls[0].undo();
    });

    // No pending delete to cancel → a tracker-list-restore change is queued
    // carrying the whole subtree (incl. the snapshotted log).
    expect(restoreTrackerListAPI).not.toHaveBeenCalled();
    const restoreCall = vi.mocked(queueChange).mock.calls.find(c => c[0] === 'tracker-list-restore');
    expect(restoreCall).toBeTruthy();
    const payload = restoreCall![2] as { name: string; tasks: { name: string; logs: { done_at: string }[] }[] };
    expect(payload.name).toBe('Chores');
    expect(payload.tasks[0].name).toBe('Vacuum');
    expect(payload.tasks[0].logs).toEqual([
      { done_at: DONE_AT, kind: 'done', note: null, created_by_sub: 'me' },
    ]);
    // The list is back optimistically (temp ids until sync).
    expect(result.current.lists).toHaveLength(1);
  });
});
