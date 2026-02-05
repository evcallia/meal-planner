import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MealIdea } from '../types';
import { createMealIdea, deleteMealIdea, getMealIdeas, updateMealIdea } from '../api/client';
import { useOnlineStatus } from './useOnlineStatus';
import {
  generateTempId,
  isTempId,
  queueChange,
  saveLocalMealIdea,
  getLocalMealIdeas,
  deleteLocalMealIdea,
  clearLocalMealIdeas,
} from '../db';

interface MealIdeaInput {
  title: string;
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

export function useMealIdeas() {
  const [ideas, setIdeas] = useState<MealIdea[]>([]);
  const isMountedRef = useRef(true);
  const updateTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingUpdatesRef = useRef<Record<string, Partial<MealIdeaInput>>>({});
  const loadTokenRef = useRef(0);
  const hasHydratedRef = useRef(false);
  const hasSavedRef = useRef(false);
  const isOnline = useOnlineStatus();

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
  }, [ideas]);

  const refreshIdeas = useCallback(async () => {
    const token = ++loadTokenRef.current;
    try {
      const serverIdeas = await getMealIdeas();
      if (!isMountedRef.current || token !== loadTokenRef.current) return;

      // Merge with any local-only ideas (temp IDs)
      const localIdeas = await getLocalMealIdeas();
      const tempIdeas = localIdeas.filter(idea => isTempId(idea.id));
      const mergedIdeas = [...serverIdeas, ...tempIdeas];

      setIdeas(mergedIdeas);

      // Sync server ideas to local DB for offline access
      await clearLocalMealIdeas();
      for (const idea of mergedIdeas) {
        await saveLocalMealIdea(idea);
      }

      if (!hasHydratedRef.current) {
        hasHydratedRef.current = true;
        const legacyIdeas = parseStoredIdeas(localStorage.getItem(STORAGE_KEY));
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
    } catch (error) {
      console.error('Failed to load meal ideas:', error);
      if (isMountedRef.current && token === loadTokenRef.current) {
        // Load from IndexedDB when offline
        const localIdeas = await getLocalMealIdeas();
        if (localIdeas.length > 0) {
          setIdeas(localIdeas);
        } else {
          // Fall back to localStorage
          setIdeas(parseStoredIdeas(localStorage.getItem(STORAGE_KEY)));
        }
      }
    }
  }, []);

  useEffect(() => {
    refreshIdeas();
  }, [refreshIdeas]);

  useEffect(() => {
    const handleRealtime = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string } | undefined;
      if (detail?.type === 'meal-ideas.updated') {
        refreshIdeas();
      }
    };
    window.addEventListener('meal-planner-realtime', handleRealtime as EventListener);
    return () => {
      window.removeEventListener('meal-planner-realtime', handleRealtime as EventListener);
    };
  }, [refreshIdeas]);

  const addIdea = useCallback((input: MealIdeaInput) => {
    const run = async () => {
      const title = input.title.trim();
      if (!title) return;

      // Always add optimistically with a temp ID first
      const tempId = generateTempId();
      const newIdea: MealIdea = {
        id: tempId,
        title,
        updated_at: new Date().toISOString(),
      };

      // Add to local state immediately
      setIdeas(prev => [...prev, newIdea]);

      // Save to IndexedDB
      await saveLocalMealIdea(newIdea);

      if (isOnline) {
        try {
          invalidateLoad();
          const created = await createMealIdea({ title });
          if (!isMountedRef.current) return;

          // Replace temp idea with server idea
          setIdeas(prev => prev.map(idea => idea.id === tempId ? created : idea));

          // Update IndexedDB with real ID
          await deleteLocalMealIdea(tempId);
          await saveLocalMealIdea(created);
        } catch (error) {
          console.error('Failed to add meal idea:', error);
          // Queue for later sync - idea already in local state with temp ID
          await queueChange('meal-idea-add', '', { id: tempId, title });
        }
      } else {
        // Queue for sync when back online
        await queueChange('meal-idea-add', '', { id: tempId, title });
      }
    };

    void run();
  }, [isOnline]);

  const updateIdea = useCallback((id: string, updates: Partial<Pick<MealIdea, 'title'>>) => {
    setIdeas(prev => prev.map(idea => {
      if (idea.id !== id) return idea;
      const title = updates.title !== undefined ? updates.title.trim() : idea.title;
      return {
        ...idea,
        ...updates,
        title: title || idea.title,
      };
    }));

    const nextUpdates = pendingUpdatesRef.current[id] ?? {};
    const sanitizedUpdates: Partial<MealIdeaInput> = {
      ...nextUpdates,
      ...updates,
    };
    if (sanitizedUpdates.title !== undefined && sanitizedUpdates.title.trim().length === 0) {
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

      // Update local DB
      const currentIdea = ideas.find(idea => idea.id === id);
      if (currentIdea) {
        const updatedIdea = {
          ...currentIdea,
          title: payload.title !== undefined ? payload.title : currentIdea.title,
          updated_at: new Date().toISOString(),
        };
        await saveLocalMealIdea(updatedIdea);
      }

      if (isOnline && !isTempId(id)) {
        try {
          invalidateLoad();
          const updated = await updateMealIdea(id, {
            title: payload?.title,
          });
          if (!isMountedRef.current) return;
          setIdeas(prev => prev.map(idea => idea.id === id ? updated : idea));
          void refreshIdeas();
        } catch (error) {
          console.error('Failed to update meal idea:', error);
          // Queue for later sync
          await queueChange('meal-idea-update', '', { id, ...payload });
        }
      } else {
        // Queue for later sync (offline or temp ID)
        await queueChange('meal-idea-update', '', { id, ...payload });
      }
    }, 500);
  }, [isOnline, ideas]);

  const removeIdea = useCallback((id: string) => {
    const run = async () => {
      if (updateTimersRef.current[id]) {
        clearTimeout(updateTimersRef.current[id]);
      }
      delete pendingUpdatesRef.current[id];

      // Remove from local state immediately
      setIdeas(prev => prev.filter(idea => idea.id !== id));

      // Remove from local DB
      await deleteLocalMealIdea(id);

      if (isOnline && !isTempId(id)) {
        try {
          invalidateLoad();
          await deleteMealIdea(id);
          if (!isMountedRef.current) return;
          void refreshIdeas();
        } catch (error) {
          console.error('Failed to remove meal idea:', error);
          // Queue for later sync
          await queueChange('meal-idea-delete', '', { id });
        }
      } else if (!isTempId(id)) {
        // Queue for later sync (offline, but not a temp ID)
        await queueChange('meal-idea-delete', '', { id });
      }
      // If it's a temp ID, we just need to remove it from the add queue
      // which will happen during sync when the temp ID isn't found
    };
    void run();
  }, [isOnline, refreshIdeas]);

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
  };
}
