import { useState, useEffect, useCallback, useRef } from 'react';
import { Store } from '../types';
import {
  getStores as getStoresAPI,
  createStore as createStoreAPI,
  updateStore as updateStoreAPI,
  deleteStore as deleteStoreAPI,
  reorderStores as reorderStoresAPI,
} from '../api/client';
import { saveLocalStores, getLocalStores } from '../db';
import { useOnlineStatus } from './useOnlineStatus';

export function useStores() {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const isOnline = useOnlineStatus();
  const pendingRef = useRef(0);
  const deferredRef = useRef(false);

  const loadStores = useCallback(async () => {
    try {
      if (isOnline) {
        const data = await getStoresAPI();
        setStores(data);
        await saveLocalStores(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
      } else {
        const local = await getLocalStores();
        setStores(local);
      }
    } catch {
      const local = await getLocalStores();
      setStores(local);
    } finally {
      setLoading(false);
    }
  }, [isOnline]);

  const loadStoresRef = useRef(loadStores);
  loadStoresRef.current = loadStores;

  const settleMutation = useCallback(() => {
    pendingRef.current--;
    if (pendingRef.current === 0 && deferredRef.current) {
      deferredRef.current = false;
      loadStoresRef.current();
    }
  }, []);

  useEffect(() => { loadStores(); }, [loadStores]);

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
    pendingRef.current++;
    setStores(prev => prev.map(s => s.id === storeId ? { ...s, name } : s));
    try {
      await updateStoreAPI(storeId, { name });
    } catch { /* will sync on next load */ }
    finally { settleMutation(); }
  }, [settleMutation]);

  const removeStore = useCallback(async (storeId: string) => {
    pendingRef.current++;
    setStores(prev => {
      const updated = prev.filter(s => s.id !== storeId);
      saveLocalStores(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
      return updated;
    });
    try {
      await deleteStoreAPI(storeId);
    } catch { /* will sync on next load */ }
    finally { settleMutation(); }
  }, [settleMutation]);

  const reorderStoresLocal = useCallback(async (fromIndex: number, toIndex: number) => {
    const updated = [...stores];
    const [moved] = updated.splice(fromIndex, 1);
    updated.splice(toIndex, 0, moved);
    const reordered = updated.map((s, i) => ({ ...s, position: i }));

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
