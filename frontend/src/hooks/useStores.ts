import { useState, useEffect, useCallback, useRef } from 'react';
import { Store, GrocerySection } from '../types';
import {
  getStores as getStoresAPI,
  createStore as createStoreAPI,
  updateStore as updateStoreAPI,
  deleteStore as deleteStoreAPI,
  reorderStores as reorderStoresAPI,
  editGroceryItem as editGroceryItemAPI,
} from '../api/client';
import { saveLocalStores, getLocalStores } from '../db';
import { useOnlineStatus } from './useOnlineStatus';
import { useUndo } from '../contexts/UndoContext';

const STORES_STORAGE_KEY = 'meal-planner-stores';

function saveStoresToLocalStorage(stores: Store[]) {
  try {
    localStorage.setItem(STORES_STORAGE_KEY, JSON.stringify(stores));
  } catch { /* storage full — best effort */ }
}

function loadStoresFromLocalStorage(): Store[] {
  try {
    const raw = localStorage.getItem(STORES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

interface UseStoresOptions {
  grocerySections?: GrocerySection[];
  onItemsStoreChanged?: (itemIds: string[], storeId: string | null) => void;
}

let sessionLoaded = false;
export function resetStoresSessionLoaded() { sessionLoaded = false; }
export function markStoresSessionLoaded() { sessionLoaded = true; }

export function useStores(options: UseStoresOptions = {}) {
  const { grocerySections, onItemsStoreChanged } = options;
  const [stores, setStores] = useState<Store[]>(() => loadStoresFromLocalStorage());
  const [loading, setLoading] = useState(() => loadStoresFromLocalStorage().length === 0);
  const isOnline = useOnlineStatus();
  const { pushAction } = useUndo();
  const pendingRef = useRef(0);
  const deferredRef = useRef(false);
  const optimisticVersionRef = useRef(0);
  const grocerySectionsRef = useRef(grocerySections);
  grocerySectionsRef.current = grocerySections;
  const onItemsStoreChangedRef = useRef(onItemsStoreChanged);
  onItemsStoreChangedRef.current = onItemsStoreChanged;

  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const loadStores = useCallback(async (skipApi = false) => {
    const fetchVersion = optimisticVersionRef.current;

    // 1. Try IndexedDB (may have fresher data than localStorage init)
    try {
      const local = await getLocalStores();
      if (optimisticVersionRef.current !== fetchVersion) return;
      if (local.length > 0) {
        setStores(local);
        setLoading(false);
      }
    } catch { /* IndexedDB failed */ }

    // 2. If online, fetch from API in background
    if (!skipApi && isOnlineRef.current) {
      try {
        const data = await getStoresAPI();
        if (optimisticVersionRef.current !== fetchVersion) return;
        setStores(data);
        await saveLocalStores(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
        sessionLoaded = true;
      } catch { /* API failed — keep cached data */ }
    }

    setLoading(false);
  }, []);

  const loadStoresRef = useRef(loadStores);
  loadStoresRef.current = loadStores;

  const settleMutation = useCallback(() => {
    pendingRef.current--;
    if (pendingRef.current === 0) {
      deferredRef.current = false;
      loadStoresRef.current();
    }
  }, []);

  useEffect(() => { loadStores(sessionLoaded); }, [loadStores]);

  // Keep localStorage in sync with stores state for reliable offline access
  useEffect(() => {
    if (stores.length > 0) {
      saveStoresToLocalStorage(stores);
    }
  }, [stores]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type === 'stores.updated') {
        if (pendingRef.current > 0) {
          deferredRef.current = true;
        } else {
          loadStoresRef.current();
        }
      }
    };
    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
  }, []);

  const createStore = useCallback(async (name: string): Promise<Store | null> => {
    try {
      optimisticVersionRef.current++;
      pendingRef.current++;
      const store = await createStoreAPI(name);
      setStores(prev => {
        const exists = prev.find(s => s.id === store.id);
        if (exists) return prev;
        const updated = [...prev, store].sort((a, b) => a.position - b.position);
        saveLocalStores(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
        return updated;
      });
      return store;
    } catch {
      return null;
    } finally {
      settleMutation();
    }
  }, [settleMutation]);

  const renameStore = useCallback(async (storeId: string, name: string) => {
    const prevName = stores.find(s => s.id === storeId)?.name;
    if (!prevName || prevName === name) return;

    optimisticVersionRef.current++;
    pendingRef.current++;
    setStores(prev => prev.map(s => s.id === storeId ? { ...s, name } : s));
    try {
      await updateStoreAPI(storeId, { name });
    } catch { /* will sync on next load */ }
    finally { settleMutation(); }

    pushAction({
      type: 'rename-store',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingRef.current++;
        setStores(prev => prev.map(s => s.id === storeId ? { ...s, name: prevName } : s));
        try { await updateStoreAPI(storeId, { name: prevName }); } catch {}
        finally { settleMutation(); }
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingRef.current++;
        setStores(prev => prev.map(s => s.id === storeId ? { ...s, name } : s));
        try { await updateStoreAPI(storeId, { name }); } catch {}
        finally { settleMutation(); }
      },
    });
  }, [stores, settleMutation, pushAction]);

  const removeStore = useCallback(async (storeId: string) => {
    const deletedStore = stores.find(s => s.id === storeId);
    if (!deletedStore) return;

    // Capture item IDs that reference this store (for undo restore)
    const affectedItemIds = (grocerySectionsRef.current ?? [])
      .flatMap(s => s.items)
      .filter(i => i.store_id === storeId)
      .map(i => i.id);

    // Optimistically null out store_id on affected items
    onItemsStoreChangedRef.current?.(affectedItemIds, null);

    optimisticVersionRef.current++;
    pendingRef.current++;
    setStores(prev => {
      const updated = prev.filter(s => s.id !== storeId);
      saveLocalStores(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
      return updated;
    });

    // Push undo BEFORE API call so it's immediately available
    pushAction({
      type: 'delete-store',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingRef.current++;
        try {
          // Re-create the store (API deduplicates by name, returns existing or new)
          const restored = await createStoreAPI(deletedStore.name);
          // Restore position
          await updateStoreAPI(restored.id, { position: deletedStore.position });
          const restoredStore = { ...restored, position: deletedStore.position };

          setStores(prev => {
            const updated = [...prev, restoredStore].sort((a, b) => a.position - b.position);
            saveLocalStores(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
            return updated;
          });

          // Optimistically restore store_id on affected items
          onItemsStoreChangedRef.current?.(affectedItemIds, restored.id);

          // Re-assign store to affected items on server
          for (const itemId of affectedItemIds) {
            try { await editGroceryItemAPI(itemId, { store_id: restored.id }); } catch {}
          }
        } catch { /* best effort */ }
        finally { settleMutation(); }
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingRef.current++;
        // Null out store_id on affected items again
        onItemsStoreChangedRef.current?.(affectedItemIds, null);

        setStores(prev => {
          const updated = prev.filter(s => s.name.toLowerCase() !== deletedStore.name.toLowerCase());
          saveLocalStores(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
          return updated;
        });
        // Find the current ID (may differ from original if re-created)
        const current = await getStoresAPI();
        const match = current.find(s => s.name.toLowerCase() === deletedStore.name.toLowerCase());
        if (match) {
          try { await deleteStoreAPI(match.id); } catch {}
        }
        settleMutation();
      },
    });

    try {
      await deleteStoreAPI(storeId);
    } catch { /* will sync on next load */ }
    finally { settleMutation(); }
  }, [stores, settleMutation, pushAction]);

  const reorderStoresLocal = useCallback(async (fromIndex: number, toIndex: number) => {
    const updated = [...stores];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    const reordered = updated.map((s, i) => ({ ...s, position: i }));

    optimisticVersionRef.current++;
    setStores(reordered);
    await saveLocalStores(reordered.map(s => ({ id: s.id, name: s.name, position: s.position })));

    pendingRef.current++;
    try {
      await reorderStoresAPI(reordered.map(s => s.id));
    } catch { /* will sync on next load */ }
    finally { settleMutation(); }
  }, [stores, settleMutation]);

  return { stores, loading, createStore, renameStore, removeStore, reorderStores: reorderStoresLocal };
}
