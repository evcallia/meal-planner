import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PantryItem } from '../types';
import { createPantryItem, deletePantryItem, getPantryItems, updatePantryItem } from '../api/client';
import { useOnlineStatus } from './useOnlineStatus';
import {
  generateTempId,
  isTempId,
  queueChange,
  saveLocalPantryItem,
  getLocalPantryItems,
  deleteLocalPantryItem,
  clearLocalPantryItems,
} from '../db';

interface PantryItemInput {
  name: string;
  quantity?: number;
}

const STORAGE_KEY = 'meal-planner-pantry';
function parseStoredItems(raw: string | null): PantryItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item.name === 'string')
      .map(item => ({
        id: typeof item.id === 'string' ? item.id : '',
        name: item.name.trim(),
        quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : 0,
        updated_at: typeof item.updated_at === 'string'
          ? item.updated_at
          : new Date(Number.isFinite(Number(item.updatedAt)) ? Number(item.updatedAt) : Date.now()).toISOString(),
      }))
      .filter(item => item.name.length > 0);
  } catch {
    return [];
  }
}

function normalizeQuantity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function usePantry() {
  const [items, setItems] = useState<PantryItem[]>([]);
  const isMountedRef = useRef(true);
  const updateTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingUpdatesRef = useRef<Record<string, Partial<PantryItemInput>>>({});
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Ignore storage errors.
    }
  }, [items]);

  const refreshItems = useCallback(async () => {
    const token = ++loadTokenRef.current;

    // If offline, just load from local DB
    if (!isOnline) {
      const localItems = await getLocalPantryItems();
      if (isMountedRef.current && token === loadTokenRef.current) {
        if (localItems.length > 0) {
          setItems(localItems);
        } else {
          setItems(parseStoredItems(localStorage.getItem(STORAGE_KEY)));
        }
      }
      return;
    }

    try {
      const serverItems = await getPantryItems();
      if (!isMountedRef.current || token !== loadTokenRef.current) return;

      // Merge with any local-only items (temp IDs)
      const localItems = await getLocalPantryItems();
      const tempItems = localItems.filter(item => isTempId(item.id));
      const mergedItems = [...serverItems, ...tempItems];

      setItems(mergedItems);

      // Sync server items to local DB for offline access
      await clearLocalPantryItems();
      for (const item of mergedItems) {
        await saveLocalPantryItem(item);
      }

      if (!hasHydratedRef.current) {
        hasHydratedRef.current = true;
        const legacyItems = parseStoredItems(localStorage.getItem(STORAGE_KEY));
        if (serverItems.length === 0 && legacyItems.length > 0) {
          for (const item of legacyItems) {
            await createPantryItem({ name: item.name, quantity: normalizeQuantity(item.quantity) });
          }
          const refreshed = await getPantryItems();
          if (isMountedRef.current && token === loadTokenRef.current) {
            setItems(refreshed);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load pantry items:', error);
      if (isMountedRef.current && token === loadTokenRef.current) {
        // Load from IndexedDB when offline
        const localItems = await getLocalPantryItems();
        if (localItems.length > 0) {
          setItems(localItems);
        } else {
          // Fall back to localStorage
          setItems(parseStoredItems(localStorage.getItem(STORAGE_KEY)));
        }
      }
    }
  }, [isOnline]);

  useEffect(() => {
    refreshItems();
  }, [refreshItems]);

  useEffect(() => {
    const handleRealtime = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string } | undefined;
      if (detail?.type === 'pantry.updated') {
        refreshItems();
      }
    };
    window.addEventListener('meal-planner-realtime', handleRealtime as EventListener);
    return () => {
      window.removeEventListener('meal-planner-realtime', handleRealtime as EventListener);
    };
  }, [refreshItems]);

  const addItem = useCallback((input: PantryItemInput) => {
    const run = async () => {
      const name = input.name.trim();
      if (!name) return;
      const quantity = normalizeQuantity(input.quantity ?? 1);

      // Always add optimistically with a temp ID first
      const tempId = generateTempId();
      const newItem: PantryItem = {
        id: tempId,
        name,
        quantity,
        updated_at: new Date().toISOString(),
      };

      // Add to local state immediately
      setItems(prev => [...prev, newItem]);

      // Save to IndexedDB
      await saveLocalPantryItem(newItem);

      if (isOnline) {
        try {
          invalidateLoad();
          const created = await createPantryItem({ name, quantity });
          if (!isMountedRef.current) return;

          // Replace temp item with server item
          setItems(prev => prev.map(item => item.id === tempId ? created : item));

          // Update IndexedDB with real ID
          await deleteLocalPantryItem(tempId);
          await saveLocalPantryItem(created);
        } catch (error) {
          console.error('Failed to add pantry item:', error);
          // Queue for later sync - item already in local state with temp ID
          await queueChange('pantry-add', '', { id: tempId, name, quantity });
        }
      } else {
        // Queue for sync when back online
        await queueChange('pantry-add', '', { id: tempId, name, quantity });
      }
    };

    void run();
  }, [isOnline]);

  const updateItem = useCallback((id: string, updates: Partial<Pick<PantryItem, 'name' | 'quantity'>>) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;
      const name = updates.name !== undefined ? updates.name.trim() : item.name;
      return {
        ...item,
        ...updates,
        name: name || item.name,
        quantity: updates.quantity !== undefined ? normalizeQuantity(updates.quantity) : item.quantity,
      };
    }));

    const nextUpdates = pendingUpdatesRef.current[id] ?? {};
    const sanitizedUpdates: Partial<PantryItemInput> = {
      ...nextUpdates,
      ...updates,
    };
    if (sanitizedUpdates.name !== undefined && sanitizedUpdates.name.trim().length === 0) {
      delete sanitizedUpdates.name;
    }
    pendingUpdatesRef.current[id] = sanitizedUpdates;

    if (updateTimersRef.current[id]) {
      clearTimeout(updateTimersRef.current[id]);
    }

    updateTimersRef.current[id] = setTimeout(async () => {
      const payload = pendingUpdatesRef.current[id];
      delete pendingUpdatesRef.current[id];
      if (!payload || (payload.name === undefined && payload.quantity === undefined)) {
        return;
      }

      // Update local DB
      const currentItem = items.find(item => item.id === id);
      if (currentItem) {
        const updatedItem = {
          ...currentItem,
          name: payload.name !== undefined ? payload.name : currentItem.name,
          quantity: payload.quantity !== undefined ? normalizeQuantity(payload.quantity) : currentItem.quantity,
          updated_at: new Date().toISOString(),
        };
        await saveLocalPantryItem(updatedItem);
      }

      if (isOnline && !isTempId(id)) {
        try {
          invalidateLoad();
          const updated = await updatePantryItem(id, {
            name: payload?.name,
            quantity: payload?.quantity !== undefined ? normalizeQuantity(payload.quantity) : undefined,
          });
          if (!isMountedRef.current) return;
          setItems(prev => prev.map(item => item.id === id ? updated : item));
          void refreshItems();
        } catch (error) {
          console.error('Failed to update pantry item:', error);
          // Queue for later sync
          await queueChange('pantry-update', '', { id, ...payload });
        }
      } else {
        // Queue for later sync (offline or temp ID)
        await queueChange('pantry-update', '', { id, ...payload });
      }
    }, 500);
  }, [isOnline, items]);

  const removeItem = useCallback((id: string) => {
    const run = async () => {
      if (updateTimersRef.current[id]) {
        clearTimeout(updateTimersRef.current[id]);
      }
      delete pendingUpdatesRef.current[id];

      // Remove from local state immediately
      setItems(prev => prev.filter(item => item.id !== id));

      // Remove from local DB
      await deleteLocalPantryItem(id);

      if (isOnline && !isTempId(id)) {
        try {
          invalidateLoad();
          await deletePantryItem(id);
          if (!isMountedRef.current) return;
          void refreshItems();
        } catch (error) {
          console.error('Failed to remove pantry item:', error);
          // Queue for later sync
          await queueChange('pantry-delete', '', { id });
        }
      } else if (!isTempId(id)) {
        // Queue for later sync (offline, but not a temp ID)
        await queueChange('pantry-delete', '', { id });
      }
      // If it's a temp ID, we just need to remove it from the add queue
      // which will happen during sync when the temp ID isn't found
    };
    void run();
  }, [isOnline, refreshItems]);

  const adjustQuantity = useCallback((id: string, delta: number) => {
    const current = items.find(item => item.id === id);
    const nextQuantity = normalizeQuantity((current?.quantity ?? 0) + delta);
    updateItem(id, { quantity: nextQuantity });
  }, [items, updateItem]);

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  return {
    items: sortedItems,
    addItem,
    updateItem,
    removeItem,
    adjustQuantity,
  };
}
