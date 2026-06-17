import { useCallback, useEffect, useRef, useState } from 'react';
import { TrackerList, TrackerTask, TrackerLog } from '../types';
import {
  getTrackerLists,
  createTrackerList,
  restoreTrackerList,
  updateTrackerList,
  deleteTrackerList,
  addTrackerShare,
  removeTrackerShare,
  createTrackerTask,
  updateTrackerTask,
  deleteTrackerTask,
  reorderTrackerTasks,
  reorderTrackerLists,
  addTrackerLog,
  deleteTrackerLog,
  getTrackerLogs,
} from '../api/client';
import { useOnlineStatus } from './useOnlineStatus';
import { useIdRemap } from './useIdRemap';
import { useUndo } from '../contexts/UndoContext';
import { parseServerDate } from '../utils/recency';
import {
  generateTempId,
  isTempId,
  queueChange,
  getPendingChanges,
  saveTempIdMapping,
  getTempIdMapping,
  removePendingChangesForTempId,
  saveLocalTrackerLists,
  getLocalTrackerLists,
  saveLocalTrackerList,
  deleteLocalTrackerList,
  saveLocalTrackerTasks,
  getLocalTrackerTasks,
  saveLocalTrackerTask,
  deleteLocalTrackerTask,
  LocalTrackerList,
  LocalTrackerTask,
} from '../db';

interface TrackerSSEPayload {
  action?: string;
  list?: TrackerList;
  listId?: string;
  task?: TrackerTask;
  taskId?: string;
  position?: number;
  tasks?: { id: string; position: number }[];
}

let trackerSessionLoaded = false;
export function resetTrackerSessionLoaded() { trackerSessionLoaded = false; }
export function markTrackerSessionLoaded() { trackerSessionLoaded = true; }

let _liveTrackerDispatch: React.Dispatch<React.SetStateAction<TrackerList[]>> | null = null;

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;

function toLocalList(list: TrackerList): LocalTrackerList {
  return {
    id: list.id,
    name: list.name,
    icon: list.icon,
    color: list.color,
    position: list.position,
    owner_sub: list.owner_sub,
    owner_name: list.owner_name,
    is_owner: list.is_owner,
    shared_with: list.shared_with,
  };
}

function toLocalTask(task: TrackerTask): LocalTrackerTask {
  return {
    id: task.id,
    list_id: task.list_id,
    name: task.name,
    target_interval_days: task.target_interval_days,
    notes: task.notes,
    position: task.position,
    archived: task.archived,
    season_start_month: task.season_start_month,
    season_end_month: task.season_end_month,
    season_start_day: task.season_start_day,
    season_end_day: task.season_end_day,
    snooze_until: task.snooze_until,
    last_done_at: task.last_done_at,
    last_event_at: task.last_event_at,
    last_done_by: task.last_done_by,
    last_note: task.last_note,
    total_count: task.total_count,
    avg_interval_days: task.avg_interval_days,
  };
}

function fromLocal(lists: LocalTrackerList[], tasks: LocalTrackerTask[]): TrackerList[] {
  return [...lists].sort(byPosition).map(l => ({
    ...l,
    tasks: tasks.filter(t => t.list_id === l.id).sort(byPosition),
  }));
}

/** Compute recency stats from a list of completion timestamps (ISO strings). */
export function computeStats(doneAtList: string[]): { last_done_at: string | null; total_count: number; avg_interval_days: number | null } {
  const times = doneAtList
    .map(d => parseServerDate(d))
    .filter(n => !Number.isNaN(n))
    .sort((a, b) => a - b);
  const total = times.length;
  const last = total > 0 ? new Date(times[total - 1]).toISOString() : null;
  let avg: number | null = null;
  if (total >= 2) {
    let sum = 0;
    for (let i = 1; i < total; i++) sum += (times[i] - times[i - 1]) / 86400000;
    avg = Math.round((sum / (total - 1)) * 10) / 10;
  }
  return { last_done_at: last, total_count: total, avg_interval_days: avg };
}

export function useTracker() {
  const [lists, _setLists] = useState<TrackerList[]>([]);
  _liveTrackerDispatch = _setLists;
  const setLists = useCallback<typeof _setLists>((action) => _liveTrackerDispatch?.(action), []);
  const [loading, setLoading] = useState(true);

  const isOnline = useOnlineStatus();
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;
  const listsRef = useRef(lists);
  listsRef.current = lists;
  const isMountedRef = useRef(true);
  const hasSavedRef = useRef(false);
  const loadTokenRef = useRef(0);
  const optimisticVersionRef = useRef(0);
  const pendingMutationsRef = useRef(0);
  const deferredLoadRef = useRef(false);
  const editingRef = useRef(false);

  const { resolveId, resolveIdAsync, remapId } = useIdRemap();
  const { pushAction } = useUndo();

  const setEditing = useCallback((editing: boolean) => { editingRef.current = editing; }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Persist to IndexedDB whenever state changes (keeps offline cache + SSE deltas durable)
  useEffect(() => {
    if (!hasSavedRef.current) { hasSavedRef.current = true; return; }
    void saveLocalTrackerLists(lists.map(toLocalList)).catch(() => {});
    void saveLocalTrackerTasks(lists.flatMap(l => l.tasks.map(toLocalTask))).catch(() => {});
  }, [lists]);

  // ----- state update helpers -----
  const upsertList = useCallback((list: TrackerList) => {
    setLists(prev => {
      const idx = prev.findIndex(l => l.id === list.id);
      if (idx === -1) return [...prev, list].sort(byPosition);
      const next = [...prev];
      next[idx] = list;
      return next.sort(byPosition);
    });
  }, [setLists]);

  const patchTask = useCallback((listId: string, taskId: string, fn: (t: TrackerTask) => TrackerTask) => {
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, tasks: l.tasks.map(t => t.id === taskId ? fn(t) : t) }));
  }, [setLists]);

  // ----- loading -----
  const loadTracker = useCallback(async (skipApi = false) => {
    const token = ++loadTokenRef.current;
    const fetchVersion = optimisticVersionRef.current;
    try {
      const localLists = await getLocalTrackerLists();
      const localTasks = await getLocalTrackerTasks();
      if (token !== loadTokenRef.current || optimisticVersionRef.current !== fetchVersion) return;
      if (localLists.length > 0) {
        setLists(fromLocal(localLists, localTasks));
        setLoading(false);
      }
    } catch { /* cache miss */ }

    if (!skipApi && isOnlineRef.current) {
      const pending = await getPendingChanges();
      if (pending.some(c => c.type.startsWith('tracker-'))) { setLoading(false); return; }
      try {
        const data = await getTrackerLists();
        if (token !== loadTokenRef.current || optimisticVersionRef.current !== fetchVersion) return;
        if (!editingRef.current) setLists(data);
        await saveLocalTrackerLists(data.map(toLocalList));
        await saveLocalTrackerTasks(data.flatMap(l => l.tasks.map(toLocalTask)));
        trackerSessionLoaded = true;
      } catch { /* keep cache */ }
    }
    setLoading(false);
  }, [setLists]);

  const loadTrackerRef = useRef(loadTracker);
  loadTrackerRef.current = loadTracker;

  const settleMutation = useCallback(() => {
    pendingMutationsRef.current--;
    if (pendingMutationsRef.current === 0 && deferredLoadRef.current) {
      deferredLoadRef.current = false;
      loadTrackerRef.current();
    }
  }, []);

  useEffect(() => {
    loadTracker(trackerSessionLoaded);
  }, [loadTracker]);

  // ----- realtime -----
  const applyRealtimeEvent = useCallback((payload: TrackerSSEPayload) => {
    if (!payload?.action) { loadTrackerRef.current(); return; }
    switch (payload.action) {
      case 'list-added':
      case 'list-updated':
      case 'list-shared':
        if (payload.list) upsertList(payload.list);
        break;
      case 'list-deleted':
        if (payload.listId) setLists(prev => prev.filter(l => l.id !== payload.listId));
        break;
      case 'list-reordered':
        if (payload.listId && payload.position !== undefined) {
          setLists(prev => prev.map(l => l.id === payload.listId ? { ...l, position: payload.position! } : l).sort(byPosition));
        }
        break;
      case 'task-added':
        if (payload.listId && payload.task) {
          setLists(prev => prev.map(l => {
            if (l.id !== payload.listId) return l;
            if (l.tasks.some(t => t.id === payload.task!.id)) return l;
            return { ...l, tasks: [...l.tasks, payload.task!].sort(byPosition) };
          }));
        }
        break;
      case 'task-updated':
      case 'task-logged':
        if (payload.listId && payload.task) {
          setLists(prev => prev.map(l => l.id !== payload.listId ? l : {
            ...l, tasks: l.tasks.map(t => t.id === payload.task!.id ? payload.task! : t),
          }));
        }
        break;
      case 'task-deleted':
        if (payload.listId && payload.taskId) {
          setLists(prev => prev.map(l => l.id !== payload.listId ? l : { ...l, tasks: l.tasks.filter(t => t.id !== payload.taskId) }));
        }
        break;
      case 'tasks-reordered':
        if (payload.listId && payload.tasks) {
          const posMap = new Map(payload.tasks.map(t => [t.id, t.position]));
          setLists(prev => prev.map(l => l.id !== payload.listId ? l : {
            ...l,
            tasks: l.tasks.map(t => { const p = posMap.get(t.id); return p !== undefined ? { ...t, position: p } : t; }).sort(byPosition),
          }));
        }
        break;
    }
  }, [setLists, upsertList]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string; payload?: unknown } | undefined;
      if (detail?.type !== 'tracker.updated') return;
      if (pendingMutationsRef.current > 0) { deferredLoadRef.current = true; return; }
      applyRealtimeEvent(detail.payload as TrackerSSEPayload);
    };
    window.addEventListener('meal-planner-realtime', handler as EventListener);
    return () => window.removeEventListener('meal-planner-realtime', handler as EventListener);
  }, [applyRealtimeEvent]);

  useEffect(() => {
    const handler = () => loadTrackerRef.current();
    window.addEventListener('pending-changes-synced', handler);
    return () => window.removeEventListener('pending-changes-synced', handler);
  }, []);

  // ----- lists CRUD -----
  const createList = useCallback((name: string, icon: string | null = null, color: string | null = null): string => {
    const trimmed = name.trim();
    if (!trimmed) return '';
    const tempId = generateTempId();
    const newList: TrackerList = {
      id: tempId, name: trimmed, icon, color,
      position: listsRef.current.length, owner_sub: '', owner_name: null, is_owner: true, shared_with: [], tasks: [],
    };
    optimisticVersionRef.current++;
    if (isOnlineRef.current) pendingMutationsRef.current++;
    setLists(prev => [...prev, newList]);

    const undoSnapshot = { list: newList, tasks: [] as { task: TrackerTask; logs: TrackerLog[] }[], index: newList.position };
    pushAction({
      type: 'tracker-list-create',
      undo: async () => { await deleteListCore(resolveId(tempId)); },
      redo: async () => { await restoreList(undoSnapshot); },
    });

    void (async () => {
      await saveLocalTrackerList(toLocalList(newList));
      if (isOnlineRef.current) {
        try {
          const created = await createTrackerList({ name: trimmed, icon, color });
          remapId(tempId, created.id);
          await saveTempIdMapping(tempId, created.id);
          setLists(prev => prev.map(l => l.id === tempId ? { ...created } : l));
          await deleteLocalTrackerList(tempId);
          await saveLocalTrackerList(toLocalList(created));
        } catch {
          await queueChange('tracker-list-create', '', { tempId, name: trimmed, icon, color });
        } finally { settleMutation(); }
      } else {
        await queueChange('tracker-list-create', '', { tempId, name: trimmed, icon, color });
      }
    })();
    return tempId;
    // deleteListCore/restoreList referenced only inside undo/redo closures (defined below).
  }, [setLists, remapId, settleMutation, pushAction, resolveId]); // eslint-disable-line react-hooks/exhaustive-deps

  type ListUpdates = { name?: string; icon?: string | null; color?: string | null };
  const updateListCore = useCallback((listId: string, updates: ListUpdates) => {
    optimisticVersionRef.current++;
    setLists(prev => prev.map(l => l.id === listId ? { ...l, ...updates } : l));
    void (async () => {
      const realId = await resolveIdAsync(listId);
      if (isOnlineRef.current && !isTempId(realId)) {
        pendingMutationsRef.current++;
        try { await updateTrackerList(realId, updates); }
        catch { await queueChange('tracker-list-update', '', { id: realId, ...updates }); }
        finally { settleMutation(); }
      } else {
        await queueChange('tracker-list-update', '', { id: realId, ...updates });
      }
    })();
  }, [setLists, resolveIdAsync, settleMutation]);

  const updateList = useCallback((listId: string, updates: ListUpdates) => {
    const prevList = listsRef.current.find(l => l.id === listId);
    const prev: ListUpdates = {};
    if (prevList) for (const k of Object.keys(updates) as (keyof ListUpdates)[]) (prev as Record<string, unknown>)[k] = prevList[k];
    updateListCore(listId, updates);
    pushAction({
      type: 'tracker-list-update',
      undo: async () => { updateListCore(listId, prev); },
      redo: async () => { updateListCore(listId, updates); },
    });
  }, [updateListCore, pushAction]);

  const deleteListCore = useCallback(async (listId: string) => {
    optimisticVersionRef.current++;
    if (isOnlineRef.current) pendingMutationsRef.current++;
    setLists(prev => prev.filter(l => l.id !== listId));
    await deleteLocalTrackerList(listId);
    const realId = await resolveIdAsync(listId);
    if (isTempId(realId)) {
      await removePendingChangesForTempId(listId);
      if (isOnlineRef.current) settleMutation();
      return;
    }
    if (isOnlineRef.current) {
      try { await deleteTrackerList(realId); }
      catch { await queueChange('tracker-list-delete', '', { id: realId }); }
      finally { settleMutation(); }
    } else {
      await queueChange('tracker-list-delete', '', { id: realId });
    }
  }, [setLists, resolveIdAsync, settleMutation]);

  const deleteList = useCallback(async (listId: string) => {
    const list = listsRef.current.find(l => l.id === listId);
    if (!list) return;
    const listIndex = listsRef.current.findIndex(l => l.id === listId);

    // Snapshot the subtree (incl. completion logs) so undo can fully restore it.
    let taskSnapshots: { task: TrackerTask; logs: TrackerLog[] }[] = [];
    if (isOnlineRef.current) {
      taskSnapshots = await Promise.all(list.tasks.map(async (t) => {
        let logs: TrackerLog[] = [];
        try { if (!isTempId(t.id)) logs = await getTrackerLogs(await resolveIdAsync(t.id)); } catch { /* best effort */ }
        return { task: t, logs };
      }));
    } else {
      taskSnapshots = list.tasks.map(t => ({ task: t, logs: [] }));
    }
    const snapshot = { list, tasks: taskSnapshots, index: listIndex };

    pushAction({
      type: 'tracker-list-delete',
      undo: async () => { await restoreList(snapshot); },
      redo: async () => { await deleteListCore(resolveId(listId)); },
    });
    await deleteListCore(listId);
    // restoreList referenced only in the undo closure (defined below).
  }, [pushAction, resolveId, deleteListCore]); // eslint-disable-line react-hooks/exhaustive-deps

  // Recreate a deleted list (used by undo). Re-posts tasks and their logs.
  const restoreList = useCallback(async (snapshot: { list: TrackerList; tasks: { task: TrackerTask; logs: TrackerLog[] }[]; index: number }) => {
    const tempListId = generateTempId();
    const restored: TrackerList = {
      ...snapshot.list, id: tempListId,
      tasks: snapshot.tasks.map(s => ({ ...s.task, id: generateTempId(), list_id: tempListId })),
    };
    optimisticVersionRef.current++;
    if (isOnlineRef.current) pendingMutationsRef.current++;
    setLists(prev => {
      const next = [...prev];
      next.splice(Math.min(snapshot.index, next.length), 0, restored);
      return next;
    });
    remapId(snapshot.list.id, tempListId);
    await saveLocalTrackerList(toLocalList(restored));

    if (isOnlineRef.current) {
      try {
        // Recreate the whole subtree (tasks, logs, shares, position) atomically so
        // it reappears at its original slot in one SSE event — no append-then-move
        // flicker, no due-count churn from tasks/logs streaming in one at a time.
        const finalList = await restoreTrackerList({
          name: snapshot.list.name,
          icon: snapshot.list.icon,
          color: snapshot.list.color,
          position: snapshot.list.position,
          share_subs: snapshot.list.shared_with.map(u => u.sub),
          tasks: snapshot.tasks.map(s => ({
            name: s.task.name,
            target_interval_days: s.task.target_interval_days,
            notes: s.task.notes,
            position: s.task.position,
            season_start_month: s.task.season_start_month,
            season_end_month: s.task.season_end_month,
            season_start_day: s.task.season_start_day,
            season_end_day: s.task.season_end_day,
            logs: s.logs.map(l => ({ done_at: l.done_at, kind: l.kind, note: l.note, created_by_sub: l.created_by_sub })),
          })),
        });
        remapId(tempListId, finalList.id);
        await saveTempIdMapping(tempListId, finalList.id);
        setLists(prev => prev.map(l => l.id === tempListId ? finalList : l));
        await deleteLocalTrackerList(tempListId);
        await saveLocalTrackerList(toLocalList(finalList));
        await saveLocalTrackerTasks(finalList.tasks.map(toLocalTask));
      } catch { /* will resync */ }
      finally { settleMutation(); }
    }
  }, [setLists, remapId, settleMutation]);

  const reorderListsCore = useCallback(async (orderedIds: string[]) => {
    optimisticVersionRef.current++;
    setLists(prev => {
      const map = new Map(prev.map(l => [l.id, l]));
      const reordered = orderedIds.map((id, i) => { const l = map.get(id); return l ? { ...l, position: i } : null; }).filter(Boolean) as TrackerList[];
      return reordered.length === prev.length ? reordered : prev;
    });
    const realIds = await Promise.all(orderedIds.map(id => resolveIdAsync(id)));
    if (isOnlineRef.current) {
      pendingMutationsRef.current++;
      try { await reorderTrackerLists(realIds); }
      catch { await queueChange('tracker-list-reorder', '', { listIds: realIds }); }
      finally { settleMutation(); }
    } else {
      await queueChange('tracker-list-reorder', '', { listIds: realIds });
    }
  }, [setLists, resolveIdAsync, settleMutation]);

  const reorderLists = useCallback(async (orderedIds: string[]) => {
    const prevOrder = listsRef.current.map(l => l.id);
    await reorderListsCore(orderedIds);
    pushAction({
      type: 'tracker-list-reorder',
      undo: async () => { await reorderListsCore(prevOrder); },
      redo: async () => { await reorderListsCore(orderedIds); },
    });
  }, [reorderListsCore, pushAction]);

  // ----- sharing (online only — needs server-side user resolution) -----
  const shareList = useCallback(async (listId: string, identifier: { email?: string; sub?: string }) => {
    const realId = await resolveIdAsync(listId);
    const updated = await addTrackerShare(realId, identifier);
    upsertList(updated);
    return updated;
  }, [resolveIdAsync, upsertList]);

  const unshareList = useCallback(async (listId: string, shareSub: string) => {
    const realId = await resolveIdAsync(listId);
    const updated = await removeTrackerShare(realId, shareSub);
    upsertList(updated);
    return updated;
  }, [resolveIdAsync, upsertList]);

  // ----- tasks CRUD -----
  const createTask = useCallback((listId: string, name: string, targetIntervalDays: number | null = null, notes: string | null = null): string => {
    const trimmed = name.trim();
    if (!trimmed) return '';
    const tempId = generateTempId();
    const list = listsRef.current.find(l => l.id === listId);
    const position = list ? list.tasks.length : 0;
    const newTask: TrackerTask = {
      id: tempId, list_id: listId, name: trimmed, target_interval_days: targetIntervalDays,
      notes, position, archived: false, season_start_month: null, season_end_month: null,
      season_start_day: null, season_end_day: null, snooze_until: null,
      last_done_at: null, last_event_at: null, last_done_by: null, last_note: null, total_count: 0, avg_interval_days: null,
    };
    optimisticVersionRef.current++;
    if (isOnlineRef.current) pendingMutationsRef.current++;
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, tasks: [...l.tasks, newTask] }));

    const undoSnap = { task: newTask, logs: [] as TrackerLog[] };
    pushAction({
      type: 'tracker-task-create',
      undo: async () => { await deleteTaskCore(listId, resolveId(tempId)); },
      redo: async () => { await restoreTask(listId, undoSnap, position); },
    });

    void (async () => {
      await saveLocalTrackerTask(toLocalTask(newTask));
      const realListId = await resolveIdAsync(listId);
      if (isOnlineRef.current && !isTempId(realListId)) {
        try {
          const created = await createTrackerTask({ list_id: realListId, name: trimmed, target_interval_days: targetIntervalDays, notes });
          remapId(tempId, created.id);
          await saveTempIdMapping(tempId, created.id);
          setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, tasks: l.tasks.map(t => t.id === tempId ? created : t) }));
          await deleteLocalTrackerTask(tempId);
          await saveLocalTrackerTask(toLocalTask(created));
        } catch {
          await queueChange('tracker-task-create', '', { tempId, listId: realListId, name: trimmed, target_interval_days: targetIntervalDays, notes });
        } finally { settleMutation(); }
      } else {
        if (isOnlineRef.current) settleMutation();
        await queueChange('tracker-task-create', '', { tempId, listId, name: trimmed, target_interval_days: targetIntervalDays, notes });
      }
    })();
    return tempId;
    // deleteTaskCore/restoreTask referenced only inside undo/redo closures (defined below).
  }, [setLists, resolveIdAsync, remapId, settleMutation, pushAction, resolveId]); // eslint-disable-line react-hooks/exhaustive-deps

  type TaskUpdates = { name?: string; target_interval_days?: number | null; notes?: string | null; archived?: boolean; season_start_month?: number | null; season_end_month?: number | null; season_start_day?: number | null; season_end_day?: number | null };
  const updateTaskCore = useCallback((listId: string, taskId: string, updates: TaskUpdates) => {
    optimisticVersionRef.current++;
    patchTask(listId, taskId, t => ({ ...t, ...updates }));
    void (async () => {
      const realId = await resolveIdAsync(taskId);
      if (isOnlineRef.current && !isTempId(realId)) {
        pendingMutationsRef.current++;
        try { await updateTrackerTask(realId, updates); }
        catch { await queueChange('tracker-task-update', '', { id: realId, ...updates }); }
        finally { settleMutation(); }
      } else {
        await queueChange('tracker-task-update', '', { id: realId, ...updates });
      }
    })();
  }, [patchTask, resolveIdAsync, settleMutation]);

  const updateTask = useCallback((listId: string, taskId: string, updates: TaskUpdates) => {
    const prevTask = listsRef.current.find(l => l.id === listId)?.tasks.find(t => t.id === taskId);
    const prev: TaskUpdates = {};
    if (prevTask) for (const k of Object.keys(updates) as (keyof TaskUpdates)[]) (prev as Record<string, unknown>)[k] = prevTask[k];
    updateTaskCore(listId, taskId, updates);
    pushAction({
      type: 'tracker-task-update',
      undo: async () => { updateTaskCore(listId, taskId, prev); },
      redo: async () => { updateTaskCore(listId, taskId, updates); },
    });
  }, [updateTaskCore, pushAction]);

  const restoreTask = useCallback(async (listId: string, snap: { task: TrackerTask; logs: TrackerLog[] }, index: number) => {
    const tempId = generateTempId();
    const restored: TrackerTask = { ...snap.task, id: tempId, list_id: listId };
    optimisticVersionRef.current++;
    if (isOnlineRef.current) pendingMutationsRef.current++;
    setLists(prev => prev.map(l => {
      if (l.id !== listId) return l;
      const tasks = [...l.tasks];
      tasks.splice(Math.min(index, tasks.length), 0, restored);
      return { ...l, tasks };
    }));
    remapId(snap.task.id, tempId);
    await saveLocalTrackerTask(toLocalTask(restored));

    if (isOnlineRef.current) {
      try {
        const realListId = await resolveIdAsync(listId);
        const created = await createTrackerTask({ list_id: realListId, name: snap.task.name, target_interval_days: snap.task.target_interval_days, notes: snap.task.notes, season_start_month: snap.task.season_start_month, season_end_month: snap.task.season_end_month, season_start_day: snap.task.season_start_day, season_end_day: snap.task.season_end_day });
        remapId(tempId, created.id);
        await saveTempIdMapping(tempId, created.id);
        for (const log of snap.logs) {
          try { await addTrackerLog(created.id, { done_at: log.done_at, note: log.note, created_by_sub: log.created_by_sub }); } catch { /* skip */ }
        }
        const stats = computeStats(snap.logs.map(l => l.done_at));
        const finalTask = { ...created, ...stats };
        setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, tasks: l.tasks.map(t => t.id === tempId ? finalTask : t) }));
        await deleteLocalTrackerTask(tempId);
        await saveLocalTrackerTask(toLocalTask(finalTask));
      } catch { /* resync */ }
      finally { settleMutation(); }
    } else {
      await queueChange('tracker-task-create', '', { tempId, listId, name: snap.task.name, target_interval_days: snap.task.target_interval_days, notes: snap.task.notes });
    }
  }, [setLists, remapId, resolveIdAsync, settleMutation]);

  const deleteTaskCore = useCallback(async (listId: string, taskId: string) => {
    optimisticVersionRef.current++;
    if (isOnlineRef.current) pendingMutationsRef.current++;
    setLists(prev => prev.map(l => l.id !== listId ? l : { ...l, tasks: l.tasks.filter(t => t.id !== taskId) }));
    await deleteLocalTrackerTask(taskId);
    const realId = await resolveIdAsync(taskId);
    if (isTempId(realId)) {
      await removePendingChangesForTempId(taskId);
      if (isOnlineRef.current) settleMutation();
      return;
    }
    if (isOnlineRef.current) {
      try { await deleteTrackerTask(realId); }
      catch { await queueChange('tracker-task-delete', '', { id: realId }); }
      finally { settleMutation(); }
    } else {
      await queueChange('tracker-task-delete', '', { id: realId });
    }
  }, [setLists, resolveIdAsync, settleMutation]);

  const deleteTask = useCallback(async (listId: string, taskId: string) => {
    const list = listsRef.current.find(l => l.id === listId);
    const task = list?.tasks.find(t => t.id === taskId);
    if (!task) return;
    const index = list!.tasks.findIndex(t => t.id === taskId);

    let logs: TrackerLog[] = [];
    if (isOnlineRef.current && !isTempId(taskId)) {
      try { logs = await getTrackerLogs(await resolveIdAsync(taskId)); } catch { /* best effort */ }
    }
    const snap = { task, logs };

    pushAction({
      type: 'tracker-task-delete',
      undo: async () => { await restoreTask(listId, snap, index); },
      redo: async () => { await deleteTaskCore(listId, resolveId(taskId)); },
    });
    await deleteTaskCore(listId, taskId);
  }, [pushAction, resolveId, resolveIdAsync, restoreTask, deleteTaskCore]);

  const reorderTasks = useCallback(async (listId: string, orderedIds: string[]) => {
    optimisticVersionRef.current++;
    setLists(prev => prev.map(l => {
      if (l.id !== listId) return l;
      const map = new Map(l.tasks.map(t => [t.id, t]));
      const reordered = orderedIds.map((id, i) => { const t = map.get(id); return t ? { ...t, position: i } : null; }).filter(Boolean) as TrackerTask[];
      return reordered.length === l.tasks.length ? { ...l, tasks: reordered } : l;
    }));
    const realListId = await resolveIdAsync(listId);
    const realIds = await Promise.all(orderedIds.map(id => resolveIdAsync(id)));
    if (isOnlineRef.current && !isTempId(realListId)) {
      pendingMutationsRef.current++;
      try { await reorderTrackerTasks(realListId, realIds); }
      catch { await queueChange('tracker-task-reorder', '', { listId: realListId, taskIds: realIds }); }
      finally { settleMutation(); }
    } else {
      await queueChange('tracker-task-reorder', '', { listId: realListId, taskIds: realIds });
    }
  }, [setLists, resolveIdAsync, settleMutation]);

  // ----- completion logs -----
  const removeLogById = useCallback(async (logId: string, taskId: string) => {
    let id = resolveId(logId);
    if (isTempId(id)) { const mapped = await getTempIdMapping(id); if (mapped) id = mapped; }
    if (isTempId(id)) {
      await removePendingChangesForTempId(logId);
      return;
    }
    if (isOnlineRef.current) {
      try { await deleteTrackerLog(id); }
      catch { await queueChange('tracker-log-delete', '', { id }); }
    } else {
      await queueChange('tracker-log-delete', '', { id });
    }
    void taskId;
  }, [resolveId]);

  // Append one completion. `holder.id` is set to a fresh temp id here and then
  // upgraded to the real log id once the server responds — so a later undo
  // always targets the correct (latest) log, even after redo.
  const addLogOnce = useCallback((listId: string, taskId: string, doneAt: string, note: string | null, createdBySub: string | null, createdByName: string | null, kind: 'done' | 'skip', holder: { id: string }) => {
    const tempLogId = generateTempId();
    holder.id = tempLogId;
    optimisticVersionRef.current++;
    if (isOnlineRef.current) pendingMutationsRef.current++;
    patchTask(listId, taskId, t => {
      const newEvent = !t.last_event_at || Date.parse(doneAt) > Date.parse(t.last_event_at) ? doneAt : t.last_event_at;
      if (kind === 'skip') return { ...t, last_event_at: newEvent };
      const newLast = !t.last_done_at || Date.parse(doneAt) > Date.parse(t.last_done_at) ? doneAt : t.last_done_at;
      const isLatest = newLast === doneAt;
      return {
        ...t,
        last_done_at: newLast,
        last_event_at: newEvent,
        total_count: t.total_count + 1,
        ...(isLatest ? { last_note: note, last_done_by: createdByName ?? t.last_done_by } : {}),
      };
    });
    void (async () => {
      const realTaskId = await resolveIdAsync(taskId);
      if (isOnlineRef.current && !isTempId(realTaskId)) {
        try {
          const created = await addTrackerLog(realTaskId, { done_at: doneAt, note, created_by_sub: createdBySub, kind });
          holder.id = created.id;
          await saveTempIdMapping(tempLogId, created.id);
        } catch {
          await queueChange('tracker-log-add', '', { tempLogId, taskId: realTaskId, done_at: doneAt, note, created_by_sub: createdBySub, kind });
        } finally { settleMutation(); }
      } else {
        if (isOnlineRef.current) settleMutation();
        await queueChange('tracker-log-add', '', { tempLogId, taskId: realTaskId, done_at: doneAt, note, created_by_sub: createdBySub, kind });
      }
    })();
  }, [patchTask, resolveIdAsync, settleMutation]);

  type LogStats = { last_done_at: string | null; last_event_at: string | null; total_count: number; avg_interval_days: number | null; last_note: string | null; last_done_by: string | null };
  const snapshotStats = (listId: string, taskId: string): LogStats => {
    const t = listsRef.current.find(l => l.id === listId)?.tasks.find(x => x.id === taskId);
    return t
      ? { last_done_at: t.last_done_at, last_event_at: t.last_event_at, total_count: t.total_count, avg_interval_days: t.avg_interval_days, last_note: t.last_note, last_done_by: t.last_done_by }
      : { last_done_at: null, last_event_at: null, total_count: 0, avg_interval_days: null, last_note: null, last_done_by: null };
  };

  /** Add a completion. Undoable (undo deletes the log). Returns a holder tracking the log id. */
  const addLog = useCallback((listId: string, taskId: string, doneAt: string, note: string | null = null, who?: { sub: string | null; name: string | null }) => {
    const holder = { id: '' };
    const prevStats = snapshotStats(listId, taskId);
    addLogOnce(listId, taskId, doneAt, note, who?.sub ?? null, who?.name ?? null, 'done', holder);
    pushAction({
      type: 'tracker-log-add',
      undo: async () => {
        optimisticVersionRef.current++;
        patchTask(listId, taskId, t => ({ ...t, ...prevStats }));
        await removeLogById(holder.id, taskId);
      },
      redo: async () => { addLogOnce(listId, taskId, doneAt, note, who?.sub ?? null, who?.name ?? null, 'done', holder); },
    });
    return holder;
  }, [addLogOnce, patchTask, pushAction, removeLogById]);

  /** Mark a task done now (or backdated). Undoable. */
  const markDone = useCallback((listId: string, taskId: string, doneAt?: string, note: string | null = null, who?: { sub: string | null; name: string | null }) => {
    addLog(listId, taskId, doneAt ?? new Date().toISOString(), note, who);
  }, [addLog]);

  /** Skip this cycle — logs a skip entry (resets recency, not a completion). Undoable.
   *  Returns a holder tracking the log id + the timestamp, so callers can show it optimistically. */
  const skipTask = useCallback((listId: string, taskId: string) => {
    const iso = new Date().toISOString();
    const holder = { id: '' };
    const prevEvent = listsRef.current.find(l => l.id === listId)?.tasks.find(t => t.id === taskId)?.last_event_at ?? null;
    addLogOnce(listId, taskId, iso, null, null, null, 'skip', holder);
    pushAction({
      type: 'tracker-skip',
      undo: async () => {
        patchTask(listId, taskId, t => ({ ...t, last_event_at: prevEvent }));
        await removeLogById(holder.id, taskId);
      },
      redo: async () => { addLogOnce(listId, taskId, iso, null, null, null, 'skip', holder); },
    });
    return { holder, doneAt: iso };
  }, [addLogOnce, patchTask, pushAction, removeLogById]);

  /** Remove a completion/skip, applying recomputed stats. Undoable (undo re-adds the log). */
  const removeLog = useCallback(async (listId: string, taskId: string, log: TrackerLog, recomputed: LogStats) => {
    const prev = snapshotStats(listId, taskId);
    const holder = { id: log.id };
    optimisticVersionRef.current++;
    patchTask(listId, taskId, t => ({ ...t, ...recomputed }));
    await removeLogById(holder.id, taskId);
    pushAction({
      type: 'tracker-log-delete',
      undo: async () => {
        optimisticVersionRef.current++;
        patchTask(listId, taskId, t => ({ ...t, ...prev }));
        addLogOnce(listId, taskId, log.done_at, log.note ?? null, log.created_by_sub ?? null, log.created_by_name ?? null, log.kind === 'skip' ? 'skip' : 'done', holder);
      },
      redo: async () => {
        optimisticVersionRef.current++;
        patchTask(listId, taskId, t => ({ ...t, ...recomputed }));
        await removeLogById(holder.id, taskId);
      },
    });
  }, [patchTask, pushAction, addLogOnce, removeLogById]);

  /** Push externally-recomputed stats into a task (used by the detail view). */
  const applyTaskStats = useCallback((listId: string, taskId: string, stats: { last_done_at: string | null; total_count: number; avg_interval_days: number | null }) => {
    optimisticVersionRef.current++;
    patchTask(listId, taskId, t => ({ ...t, ...stats }));
  }, [patchTask]);

  return {
    lists, loading,
    createList, updateList, deleteList, reorderLists,
    shareList, unshareList,
    createTask, updateTask, deleteTask, reorderTasks,
    markDone, addLog, removeLog, applyTaskStats, skipTask,
    setEditing,
  };
}
