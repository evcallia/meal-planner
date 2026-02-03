import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MealIdea } from '../types';
import { createMealIdea, deleteMealIdea, getMealIdeas, updateMealIdea } from '../api/client';

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
      setIdeas(serverIdeas);

      if (!hasHydratedRef.current) {
        hasHydratedRef.current = true;
        const localIdeas = parseStoredIdeas(localStorage.getItem(STORAGE_KEY));
        if (serverIdeas.length === 0 && localIdeas.length > 0) {
          for (const idea of localIdeas) {
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
        setIdeas(parseStoredIdeas(localStorage.getItem(STORAGE_KEY)));
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
      try {
        invalidateLoad();
        const created = await createMealIdea({ title });
        if (!isMountedRef.current) return;
        setIdeas(prev => [...prev, created]);
        void refreshIdeas();
      } catch (error) {
        console.error('Failed to add meal idea:', error);
      }
    };
    void run();
  }, []);

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
      }
    }, 500);
  }, []);

  const removeIdea = useCallback((id: string) => {
    const run = async () => {
      if (updateTimersRef.current[id]) {
        clearTimeout(updateTimersRef.current[id]);
      }
      delete pendingUpdatesRef.current[id];
      try {
        invalidateLoad();
        await deleteMealIdea(id);
        if (!isMountedRef.current) return;
        setIdeas(prev => prev.filter(idea => idea.id !== id));
        void refreshIdeas();
      } catch (error) {
        console.error('Failed to remove meal idea:', error);
      }
    };
    void run();
  }, []);

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
