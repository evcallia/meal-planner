import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MealIdea } from '../types';
import { createMealIdea, deleteMealIdea, getMealIdeas, updateMealIdea } from '../api/client';
import { useOnlineStatus } from './useOnlineStatus';
import { useIdRemap } from './useIdRemap';
import {
  generateTempId,
  isTempId,
  queueChange,
  saveLocalMealIdea,
  getLocalMealIdeas,
  deleteLocalMealIdea,
  clearLocalMealIdeas,
  removePendingChangesForTempId,
  getPendingChanges,
  saveTempIdMapping,
  getTempIdMapping,
} from '../db';

interface MealIdeaInput {
  title: string;
}

interface MealIdeasSSEPayload {
  action: string;
  idea?: MealIdea;
  ideaId?: string;
}

const STORAGE_KEY = 'meal-planner-meal-ideas';
function parseStoredIdeas(raw: string | null): MealIdea[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item.title === 'string')
      .map(item => ({
        id: typeof item.id === 'string' ? item.id : '',
        title: item.title.trim(),
        updated_at: typeof item.updated_at === 'string'
          ? item.updated_at
          : new Date(Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now()).toISOString(),
      }))
      .filter(item => item.title.length > 0);
  } catch {
    return [];
  }
}

let mealIdeasSessionLoaded = false;
export function resetMealIdeasSessionLoaded() { mealIdeasSessionLoaded = false; }
export function markMealIdeasSessionLoaded() { mealIdeasSessionLoaded = true; }

export function useMealIdeas() {
  const [ideas, _setIdeas] = useState<MealIdea[]>([]);
  const setIdeasRef = useRef(_setIdeas);
  setIdeasRef.current = _setIdeas;
  const setIdeas = useCallback<typeof _setIdeas>(
    (action) => setIdeasRef.current(action), []
  );
  const isMountedRef = useRef(true);
  const updateTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingUpdatesRef = useRef<Record<string, Partial<MealIdeaInput>>>({});
  const loadTokenRef = useRef(0);
  const hasHydratedRef = useRef(false);
  const hasSavedRef = useRef(false);
  const pendingMutationsRef = useRef(0);
  const deferredLoadRef = useRef(false);
  const { resolveId, remapId } = useIdRemap();
  const isOnline = useOnlineStatus();
  const editingRef = useRef(false);

  const setEditing = useCallback((editing: boolean) => {
    editingRef.current = editing;
  }, []);

  const invalidateLoad = () => {
    loadTokenRef.current += 1;
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      Object.values(updateTimersRef.current).forEach(timer => clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    if (!hasSavedRef.current) {
      hasSavedRef.current = true;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ideas));
    } catch {
      // Ignore storage errors.
    }
    // Keep IndexedDB in sync so SSE delta applies are persisted for offline access
    for (const idea of ideas) {
      void Promise.resolve(saveLocalMealIdea(idea)).catch(() => {});
    }
  }, [ideas]);

  // Use a ref so refreshIdeas doesn't depend on isOnline directly.
  // This prevents the load function from being recreated (and re-triggered)
  // when going online→offline, which would overwrite in-memory optimistic state.
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;
  const ideasRef = useRef(ideas);
  ideasRef.current = ideas;

  // Load meal ideas (cache-first: show cached data immediately, then refresh from API)
  const refreshIdeas = useCallback(async (skipApi = false) => {
    const token = ++loadTokenRef.current;

    // Capture legacy localStorage before anything overwrites it (for first-load hydration)
    const legacyRaw = localStorage.getItem(STORAGE_KEY);

    // 1. Load from cache immediately
    try {
      const localIdeas = await getLocalMealIdeas();
      if (!isMountedRef.current || token !== loadTokenRef.current) return;
      if (localIdeas.length > 0) {
        setIdeas(localIdeas);
      } else {
        // Fall back to localStorage
        const stored = parseStoredIdeas(legacyRaw);
        if (stored.length > 0) {
          setIdeas(stored);
        }
      }
    } catch { /* cache failed — continue to API */ }

    // 2. If online, fetch from API
    if (!skipApi && isOnlineRef.current) {
      const pending = await getPendingChanges();
      const hasMealIdeaChanges = pending.some(c => c.type.startsWith('meal-idea-'));
      if (!hasMealIdeaChanges) {
        try {
          const serverIdeas = await getMealIdeas();
          if (!isMountedRef.current || token !== loadTokenRef.current) return;

          // Merge with any local-only ideas (temp IDs)
          const localIdeas = await getLocalMealIdeas();
          const tempIdeas = localIdeas.filter(idea => isTempId(idea.id));
          const mergedIdeas = [...serverIdeas, ...tempIdeas];

          // Don't overwrite local state while the user is actively editing
          if (!editingRef.current) {
            setIdeas(mergedIdeas);
          }

          // Sync to local DB for offline access
          await clearLocalMealIdeas();
          for (const idea of mergedIdeas) {
            await saveLocalMealIdea(idea);
          }
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(mergedIdeas)); } catch {}

          if (!hasHydratedRef.current) {
            hasHydratedRef.current = true;
            const legacyIdeas = parseStoredIdeas(legacyRaw);
            if (serverIdeas.length === 0 && legacyIdeas.length > 0) {
              for (const idea of legacyIdeas) {
                await createMealIdea({ title: idea.title });
              }
              const refreshed = await getMealIdeas();
              if (isMountedRef.current && token === loadTokenRef.current) {
                setIdeas(refreshed);
              }
            }
          }
          mealIdeasSessionLoaded = true;
        } catch { /* API failed — keep cached data */ }
      }
    }
  }, []);

  // Keep a stable ref to refreshIdeas for use in settleMutation
  const refreshIdeasRef = useRef(refreshIdeas);
  refreshIdeasRef.current = refreshIdeas;

  const settleMutation = useCallback(() => {
    pendingMutationsRef.current--;
    if (pendingMutationsRef.current === 0 && deferredLoadRef.current) {
      deferredLoadRef.current = false;
      refreshIdeasRef.current();
    }
  }, []);

  useEffect(() => {
    refreshIdeas(mealIdeasSessionLoaded);
  }, [refreshIdeas]);

  const applyRealtimeEvent = useCallback((payload: MealIdeasSSEPayload) => {
    if (!payload?.action) {
      refreshIdeasRef.current();
      return;
    }
    const { action } = payload;
    switch (action) {
      case 'added':
        if (payload.idea) {
          setIdeas(prev => {
            if (prev.some(i => i.id === payload.idea!.id)) return prev;
            return [payload.idea!, ...prev];
          });
        }
        break;
      case 'updated':
        if (payload.idea) {
          setIdeas(prev => prev.map(i => i.id === payload.idea!.id ? payload.idea! : i));
        }
        break;
      case 'deleted':
        if (payload.ideaId) {
          setIdeas(prev => prev.filter(i => i.id !== payload.ideaId));
        }
        break;
    }
  }, []);

  useEffect(() => {
    const handleRealtime = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string; payload?: unknown } | undefined;
      if (detail?.type === 'meal-ideas.updated') {
        if (pendingMutationsRef.current > 0) {
          deferredLoadRef.current = true;
        } else {
          applyRealtimeEvent(detail.payload as MealIdeasSSEPayload);
        }
      }
    };
    window.addEventListener('meal-planner-realtime', handleRealtime as EventListener);
    return () => {
      window.removeEventListener('meal-planner-realtime', handleRealtime as EventListener);
    };
  }, [applyRealtimeEvent]);

  // Refetch after offline sync completes to pick up other devices' changes
  useEffect(() => {
    const handler = () => refreshIdeas();
    window.addEventListener('pending-changes-synced', handler);
    return () => window.removeEventListener('pending-changes-synced', handler);
  }, [refreshIdeas]);


  const addIdea = useCallback((input: MealIdeaInput): string => {
    const tempId = generateTempId();
    const run = async () => {
      const title = input.title.trim();
      if (!title) return;
      const newIdea: MealIdea = {
        id: tempId,
        title,
        updated_at: new Date().toISOString(),
      };

      // Add to local state immediately — increment pending guard before any await
      invalidateLoad();
      if (isOnline) pendingMutationsRef.current++;
      setIdeas(prev => [...prev, newIdea]);

      // Save to IndexedDB
      await saveLocalMealIdea(newIdea);

      if (isOnline) {
        try {
          const created = await createMealIdea({ title });
          if (!isMountedRef.current) return;

          // Replace temp idea with server idea
          setIdeas(prev => prev.map(idea => idea.id === tempId ? created : idea));

          // Update IndexedDB with real ID and save temp→real mapping
          remapId(tempId, created.id);
          await saveTempIdMapping(tempId, created.id);
          await deleteLocalMealIdea(tempId);
          await saveLocalMealIdea(created);
        } catch (error) {
          console.error('Failed to add meal idea:', error);
          // Queue for later sync - idea already in local state with temp ID
          await queueChange('meal-idea-add', '', { id: tempId, title });
        } finally {
          settleMutation();
        }
      } else {
        // Queue for sync when back online
        await queueChange('meal-idea-add', '', { id: tempId, title });
      }
    };

    void run();
    return tempId;
  }, [isOnline, remapId, settleMutation]);

  const updateIdea = useCallback((id: string, updates: Partial<Pick<MealIdea, 'title'>>) => {
    setIdeas(prev => prev.map(idea => {
      if (idea.id !== id) return idea;
      return {
        ...idea,
        ...updates,
      };
    }));

    const nextUpdates = pendingUpdatesRef.current[id] ?? {};
    const sanitizedUpdates: Partial<MealIdeaInput> = {
      ...nextUpdates,
      ...updates,
    };
    if (sanitizedUpdates.title !== undefined && sanitizedUpdates.title.length === 0) {
      delete sanitizedUpdates.title;
    }
    pendingUpdatesRef.current[id] = sanitizedUpdates;

    if (updateTimersRef.current[id]) {
      clearTimeout(updateTimersRef.current[id]);
    }

    updateTimersRef.current[id] = setTimeout(async () => {
      const payload = pendingUpdatesRef.current[id];
      delete pendingUpdatesRef.current[id];
      if (!payload || payload.title === undefined) {
        return;
      }

      // Resolve temp→real ID (item may have been synced while debounce was pending)
      let currentId = resolveId(id);
      if (isTempId(currentId)) {
        const mapped = await getTempIdMapping(currentId);
        if (mapped) currentId = mapped;
      }

      // Update local DB
      const currentIdea = ideasRef.current.find(idea => idea.id === id || idea.id === currentId);
      if (currentIdea) {
        const updatedIdea = {
          ...currentIdea,
          title: payload.title !== undefined ? payload.title : currentIdea.title,
          updated_at: new Date().toISOString(),
        };
        await saveLocalMealIdea(updatedIdea);
      }

      if (isOnlineRef.current && !isTempId(currentId)) {
        pendingMutationsRef.current++;
        try {
          await updateMealIdea(currentId, {
            title: payload?.title,
          });
        } catch (error) {
          console.error('Failed to update meal idea:', error);
          await queueChange('meal-idea-update', '', { id: currentId, ...payload });
        } finally {
          settleMutation();
        }
      } else {
        await queueChange('meal-idea-update', '', { id: currentId, ...payload });
      }
    }, 500);
  }, [settleMutation]);

  const removeIdea = useCallback(async (id: string) => {
    // Resolve through ID remap chain — the item may have been synced
    // to the server with a real ID while local state still has a temp ID.
    // Check both in-memory remap AND IndexedDB temp mapping (from useSync).
    let currentId = resolveId(id);
    if (isTempId(currentId)) {
      const mapped = await getTempIdMapping(currentId);
      if (mapped) currentId = mapped;
    }

    if (updateTimersRef.current[currentId]) {
      clearTimeout(updateTimersRef.current[currentId]);
    }
    delete pendingUpdatesRef.current[currentId];

    // Remove from local state immediately (filter both original and resolved IDs)
    setIdeas(prev => prev.filter(idea => idea.id !== id && idea.id !== currentId));

    // Remove from local DB
    await deleteLocalMealIdea(id);
    if (currentId !== id) await deleteLocalMealIdea(currentId);

    if (isOnlineRef.current && !isTempId(currentId)) {
      pendingMutationsRef.current++;
      try {
        invalidateLoad();
        await deleteMealIdea(currentId);
        if (!isMountedRef.current) return;
      } catch (error) {
        console.error('Failed to remove meal idea:', error);
        await queueChange('meal-idea-delete', '', { id: currentId });
      } finally {
        settleMutation();
      }
    } else if (!isTempId(currentId)) {
      await queueChange('meal-idea-delete', '', { id: currentId });
    } else {
      // Still a temp ID with no server mapping — remove the pending add
      await removePendingChangesForTempId(id);
    }
  }, [resolveId, settleMutation]);

  const sortedIdeas = useMemo(() => {
    return [...ideas].sort((a, b) => {
      const aTime = Date.parse(a.updated_at || '');
      const bTime = Date.parse(b.updated_at || '');
      const safeATime = Number.isNaN(aTime) ? 0 : aTime;
      const safeBTime = Number.isNaN(bTime) ? 0 : bTime;
      return safeBTime - safeATime;
    });
  }, [ideas]);

  return {
    ideas: sortedIdeas,
    addIdea,
    updateIdea,
    removeIdea,
    resolveId,
    remapId,
    setEditing,
  };
}
