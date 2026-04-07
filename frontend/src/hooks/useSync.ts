import { useState, useEffect, useCallback, useRef } from 'react';
import { useOnlineStatus } from './useOnlineStatus';
import {
  getPendingChanges,
  removePendingChange,
  clearPendingChanges,
  isTempId,
  saveTempIdMapping,
  getTempIdMapping,
  deleteLocalPantryItem,
  saveLocalPantryItem,
  deleteLocalGroceryItem,
  saveLocalGroceryItem,
  saveLocalGrocerySection,
  deleteLocalMealIdea,
  saveLocalMealIdea,
  updateLocalHiddenEventId,
  deleteLocalHiddenEvent,
  PendingChange,
} from '../db';
import {
  updateNotes,
  toggleItemized,
  addPantryItem,
  getPantryList,
  updatePantryItem,
  deletePantryItem,
  replacePantryList,
  reorderPantrySections as reorderPantrySectionsAPI,
  reorderPantryItems as reorderPantryItemsAPI,
  renamePantrySection as renamePantrySectionAPI,
  createPantrySection as createPantrySectionAPI,
  deletePantrySection as deletePantrySectionAPI,
  createMealIdea,
  updateMealIdea,
  deleteMealIdea,
  hideCalendarEvent,
  unhideCalendarEvent,
  replaceGroceryList,
  toggleGroceryItem,
  addGroceryItem,
  deleteGroceryItem as deleteGroceryItemAPI,
  editGroceryItem as editGroceryItemAPI,
  clearGroceryItems as clearGroceryItemsAPI,
  reorderGrocerySections as reorderGrocerySectionsAPI,
  reorderGroceryItems as reorderGroceryItemsAPI,
  renameGrocerySection as renameGrocerySectionAPI,
  deleteGrocerySection as deleteGrocerySectionAPI,
  createGrocerySection as createGrocerySectionAPI,
  moveGroceryItem as moveGroceryItemAPI,
  movePantryItem as movePantryItemAPI,
  createStore as createStoreAPI,
  updateStore as updateStoreAPI,
  deleteStore as deleteStoreAPI,
  getStores as getStoresAPI,
  reorderStores as reorderStoresAPI,
} from '../api/client';
import { ConnectionStatus } from '../types';

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Try to extract HTTP status from common patterns
    const msg = error.message;
    if (msg.includes('404')) return '404 Not Found — item may have been deleted';
    if (msg.includes('409')) return '409 Conflict — item was modified elsewhere';
    if (msg.includes('422')) return '422 Unprocessable — invalid data';
    if (msg.includes('500')) return '500 Server Error';
    if (msg.includes('403')) return '403 Forbidden';
    if (msg.includes('401')) return '401 Unauthorized — session may have expired';
    return msg;
  }
  return String(error);
}

export function useSync() {
  const isOnline = useOnlineStatus();
  const [status, setStatus] = useState<ConnectionStatus>(isOnline ? 'online' : 'offline');
  const [pendingCount, setPendingCount] = useState(0);
  const syncErrorsRef = useRef<Map<number, string>>(new Map());

  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const syncPendingChanges = useCallback(async () => {
    if (!isOnline) return;
    // Chain sync calls so they run sequentially, never concurrently
    syncQueueRef.current = syncQueueRef.current.then(async () => {
    try {

    const changes = await getPendingChanges();
    if (changes.length === 0) {
      setStatus('online');
      return;
    }

    setStatus('syncing');
    setPendingCount(changes.length);

    for (const change of changes) {
      try {
        if (change.type === 'notes') {
          const payload = change.payload as { notes: string };
          await updateNotes(change.date, payload.notes);
        } else if (change.type === 'itemized') {
          const payload = change.payload as { lineIndex: number; itemized: boolean };
          await toggleItemized(change.date, payload.lineIndex, payload.itemized);
        } else if (change.type === 'pantry-add') {
          const payload = change.payload as { id: string; sectionId: string; sectionName?: string; name: string; quantity: number };
          let realSectionId = payload.sectionId;
          if (isTempId(payload.sectionId)) {
            const mapped = await getTempIdMapping(payload.sectionId);
            if (mapped) {
              realSectionId = mapped;
            } else if (payload.sectionName) {
              // Section was created via pantry-replace (no temp mapping) — find by name
              const sections = await getPantryList();
              const match = sections.find(s => s.name.toLowerCase() === payload.sectionName!.toLowerCase());
              if (match) {
                realSectionId = match.id;
                await saveTempIdMapping(payload.sectionId, match.id);
              }
            }
          }
          const created = await addPantryItem(realSectionId, payload.name, payload.quantity);
          if (isTempId(payload.id)) {
            await saveTempIdMapping(payload.id, created.id);
            await deleteLocalPantryItem(payload.id);
            await saveLocalPantryItem(created);
          }
        } else if (change.type === 'pantry-update') {
          const payload = change.payload as { id: string; name?: string; quantity?: number };
          // Check if we need to resolve a temp ID
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              // Temp ID not yet synced, skip this update
              console.warn('Skipping pantry update for unsynced temp ID:', payload.id);
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await updatePantryItem(realId, { name: payload.name, quantity: payload.quantity });
        } else if (change.type === 'pantry-delete') {
          const payload = change.payload as { id: string };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              // Item was created and deleted offline before sync
              console.warn('Skipping pantry delete for unsynced temp ID:', payload.id);
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await deletePantryItem(realId);
        } else if (change.type === 'pantry-replace') {
          const payload = change.payload as { sections: { name: string; items: { name: string; quantity: number }[] }[] };
          await replacePantryList(payload.sections);
        } else if (change.type === 'pantry-create-section') {
          const payload = change.payload as { tempId?: string; name: string };
          const created = await createPantrySectionAPI(payload.name);
          if (payload.tempId && isTempId(payload.tempId)) {
            await saveTempIdMapping(payload.tempId, created.id);
          }
        } else if (change.type === 'pantry-delete-section') {
          const payload = change.payload as { sectionId: string; name: string };
          let realSectionId = payload.sectionId;
          if (isTempId(payload.sectionId)) {
            const mapped = await getTempIdMapping(payload.sectionId);
            if (mapped) {
              realSectionId = mapped;
            } else if (payload.name) {
              // Section was created offline — find by name
              const sections = await getPantryList();
              const match = sections.find(s => s.name.toLowerCase() === payload.name.toLowerCase());
              if (match) {
                realSectionId = match.id;
              } else {
                // Section doesn't exist on server — nothing to delete
                if (change.id) await removePendingChange(change.id);
                setPendingCount(prev => prev - 1);
                continue;
              }
            }
          }
          try {
            await deletePantrySectionAPI(realSectionId);
          } catch (e) {
            // 404 is fine — section already deleted
            if (e instanceof Error && e.message.includes('404')) {
              // no-op
            } else {
              throw e;
            }
          }
        } else if (change.type === 'pantry-reorder-sections') {
          const payload = change.payload as { sectionIds: string[] };
          const resolvedIds = await Promise.all(
            payload.sectionIds.map(async (id) => {
              if (isTempId(id)) {
                const mapped = await getTempIdMapping(id);
                return mapped ?? id;
              }
              return id;
            })
          );
          await reorderPantrySectionsAPI(resolvedIds);
        } else if (change.type === 'pantry-reorder-items') {
          const payload = change.payload as { sectionId: string; itemIds: string[] };
          let realSectionId = payload.sectionId;
          if (isTempId(payload.sectionId)) {
            const mapped = await getTempIdMapping(payload.sectionId);
            if (mapped) realSectionId = mapped;
          }
          const resolvedItemIds = await Promise.all(
            payload.itemIds.map(async (id) => {
              if (isTempId(id)) {
                const mapped = await getTempIdMapping(id);
                return mapped ?? id;
              }
              return id;
            })
          );
          await reorderPantryItemsAPI(realSectionId, resolvedItemIds);
        } else if (change.type === 'pantry-rename-section') {
          const payload = change.payload as { sectionId: string; name: string };
          let realSectionId = payload.sectionId;
          if (isTempId(payload.sectionId)) {
            const mapped = await getTempIdMapping(payload.sectionId);
            if (mapped) realSectionId = mapped;
          }
          await renamePantrySectionAPI(realSectionId, payload.name);
        } else if (change.type === 'pantry-move-item') {
          const payload = change.payload as { id: string; toSectionId: string; toPosition: number };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) realId = mapped;
          }
          let realSectionId = payload.toSectionId;
          if (isTempId(payload.toSectionId)) {
            const mapped = await getTempIdMapping(payload.toSectionId);
            if (mapped) realSectionId = mapped;
          }
          await movePantryItemAPI(realId, realSectionId, payload.toPosition);
        } else if (change.type === 'meal-idea-add') {
          const payload = change.payload as { id: string; title: string };
          const created = await createMealIdea({ title: payload.title });
          // Map temp ID to real ID
          if (isTempId(payload.id)) {
            await saveTempIdMapping(payload.id, created.id);
            // Update local DB with real ID
            await deleteLocalMealIdea(payload.id);
            await saveLocalMealIdea(created);
          }
        } else if (change.type === 'meal-idea-update') {
          const payload = change.payload as { id: string; title?: string };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              console.warn('Skipping meal idea update for unsynced temp ID:', payload.id);
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await updateMealIdea(realId, { title: payload.title });
        } else if (change.type === 'meal-idea-delete') {
          const payload = change.payload as { id: string };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              console.warn('Skipping meal idea delete for unsynced temp ID:', payload.id);
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await deleteMealIdea(realId);
        } else if (change.type === 'calendar-hide') {
          const payload = change.payload as {
            tempId: string;
            event_uid: string;
            calendar_name: string;
            title: string;
            start_time: string;
            end_time: string | null;
            all_day: boolean;
          };
          const created = await hideCalendarEvent({
            event_uid: payload.event_uid,
            calendar_name: payload.calendar_name,
            title: payload.title,
            start_time: payload.start_time,
            end_time: payload.end_time,
            all_day: payload.all_day,
          });
          if (isTempId(payload.tempId)) {
            await saveTempIdMapping(payload.tempId, created.id);
            await updateLocalHiddenEventId(payload.tempId, { ...created, updatedAt: Date.now() });
          }
        } else if (change.type === 'calendar-unhide') {
          const payload = change.payload as { hiddenId: string };
          let realId = payload.hiddenId;
          if (isTempId(payload.hiddenId)) {
            const mapped = await getTempIdMapping(payload.hiddenId);
            if (mapped) {
              realId = mapped;
            } else {
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await unhideCalendarEvent(realId);
          await deleteLocalHiddenEvent(realId);
        } else if (change.type === 'grocery-replace') {
          const payload = change.payload as { sections: { name: string; items: { name: string; quantity: string | null; store_id?: string | null }[] }[] };
          await replaceGroceryList(payload.sections);
        } else if (change.type === 'grocery-create-section') {
          const payload = change.payload as { tempId?: string; name: string; position?: number };
          const created = await createGrocerySectionAPI(payload.name, payload.position);
          if (payload.tempId && isTempId(payload.tempId)) {
            await saveTempIdMapping(payload.tempId, created.id);
            await saveLocalGrocerySection({ id: created.id, name: created.name, position: created.position });
          }
        } else if (change.type === 'grocery-check') {
          const payload = change.payload as { id: string; checked: boolean };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              if (change.id) await removePendingChange(change.id);
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await toggleGroceryItem(realId, payload.checked);
        } else if (change.type === 'grocery-add') {
          const payload = change.payload as { id: string; sectionId: string; name: string; quantity: string | null; store_id?: string | null };
          let realSectionId = payload.sectionId;
          if (isTempId(payload.sectionId)) {
            const mapped = await getTempIdMapping(payload.sectionId);
            if (mapped) realSectionId = mapped;
          }
          let realStoreId = payload.store_id ?? null;
          if (realStoreId && isTempId(realStoreId)) {
            const mapped = await getTempIdMapping(realStoreId);
            if (mapped) realStoreId = mapped;
          }
          const created = await addGroceryItem(realSectionId, payload.name, payload.quantity, realStoreId);
          if (isTempId(payload.id)) {
            await saveTempIdMapping(payload.id, created.id);
            await deleteLocalGroceryItem(payload.id);
            await saveLocalGroceryItem(created);
          }
        } else if (change.type === 'grocery-delete') {
          const payload = change.payload as { id: string };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              if (change.id) await removePendingChange(change.id);
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await deleteGroceryItemAPI(realId);
        } else if (change.type === 'grocery-edit') {
          const payload = change.payload as { id: string; name?: string; quantity?: string | null; store_id?: string | null };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              if (change.id) await removePendingChange(change.id);
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          const updates: { name?: string; quantity?: string | null; store_id?: string | null } = {};
          if (payload.name !== undefined) updates.name = payload.name;
          if (payload.quantity !== undefined) updates.quantity = payload.quantity;
          if (payload.store_id !== undefined) {
            let realStoreId = payload.store_id;
            if (realStoreId && isTempId(realStoreId)) {
              const mapped = await getTempIdMapping(realStoreId);
              if (mapped) realStoreId = mapped;
            }
            updates.store_id = realStoreId;
          }
          await editGroceryItemAPI(realId, updates);
        } else if (change.type === 'grocery-clear') {
          const payload = change.payload as { mode: 'checked' | 'all' };
          await clearGroceryItemsAPI(payload.mode);
        } else if (change.type === 'grocery-reorder-sections') {
          const payload = change.payload as { sectionIds: string[] };
          const resolvedIds = await Promise.all(
            payload.sectionIds.map(async (id) => {
              if (isTempId(id)) {
                const mapped = await getTempIdMapping(id);
                return mapped ?? id;
              }
              return id;
            })
          );
          await reorderGrocerySectionsAPI(resolvedIds);
        } else if (change.type === 'grocery-reorder-items') {
          const payload = change.payload as { sectionId: string; itemIds: string[] };
          let realSectionId = payload.sectionId;
          if (isTempId(payload.sectionId)) {
            const mapped = await getTempIdMapping(payload.sectionId);
            if (mapped) realSectionId = mapped;
          }
          const resolvedItemIds = await Promise.all(
            payload.itemIds.map(async (id) => {
              if (isTempId(id)) {
                const mapped = await getTempIdMapping(id);
                return mapped ?? id;
              }
              return id;
            })
          );
          await reorderGroceryItemsAPI(realSectionId, resolvedItemIds);
        } else if (change.type === 'grocery-rename-section') {
          const payload = change.payload as { sectionId: string; name: string };
          let realSectionId = payload.sectionId;
          if (isTempId(payload.sectionId)) {
            const mapped = await getTempIdMapping(payload.sectionId);
            if (mapped) {
              realSectionId = mapped;
            } else {
              if (change.id) await removePendingChange(change.id);
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await renameGrocerySectionAPI(realSectionId, payload.name);
        } else if (change.type === 'grocery-delete-section') {
          const payload = change.payload as { sectionId: string };
          let realSectionId = payload.sectionId;
          if (isTempId(payload.sectionId)) {
            const mapped = await getTempIdMapping(payload.sectionId);
            if (mapped) {
              realSectionId = mapped;
            } else {
              // Section was created and deleted offline before sync — no-op
              if (change.id) await removePendingChange(change.id);
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await deleteGrocerySectionAPI(realSectionId);
        } else if (change.type === 'grocery-move-item') {
          const payload = change.payload as { id: string; toSectionId: string; toPosition: number };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) realId = mapped;
          }
          let realSectionId = payload.toSectionId;
          if (isTempId(payload.toSectionId)) {
            const mapped = await getTempIdMapping(payload.toSectionId);
            if (mapped) realSectionId = mapped;
          }
          await moveGroceryItemAPI(realId, realSectionId, payload.toPosition);
        } else if (change.type === 'store-create') {
          const payload = change.payload as { name: string; tempId?: string };
          const created = await createStoreAPI(payload.name);
          if (payload.tempId) {
            await saveTempIdMapping(payload.tempId, created.id);
          }
        } else if (change.type === 'store-rename') {
          const payload = change.payload as { storeId: string; name: string };
          let realStoreId = payload.storeId;
          if (isTempId(payload.storeId)) {
            const mapped = await getTempIdMapping(payload.storeId);
            if (mapped) {
              realStoreId = mapped;
            } else {
              // Temp store not yet synced — skip
              if (change.id) await removePendingChange(change.id);
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await updateStoreAPI(realStoreId, { name: payload.name });
        } else if (change.type === 'store-delete') {
          const payload = change.payload as { name: string };
          // Find store by name since ID may have changed
          const allStores = await getStoresAPI();
          const match = allStores.find(s => s.name.toLowerCase() === payload.name.toLowerCase());
          if (match) await deleteStoreAPI(match.id);
        } else if (change.type === 'store-reorder') {
          const payload = change.payload as { storeIds: string[] };
          await reorderStoresAPI(payload.storeIds);
        }
        if (change.id) {
          await removePendingChange(change.id);
        }
        setPendingCount(prev => prev - 1);
      } catch (error) {
        console.error('Failed to sync change:', error);
        if (change.id) {
          syncErrorsRef.current.set(change.id, extractErrorMessage(error));
        }
        // If change is older than 1 hour, discard it — it's likely stale
        const ONE_HOUR = 60 * 60 * 1000;
        if (change.createdAt && Date.now() - change.createdAt > ONE_HOUR) {
          console.warn('Discarding stale pending change (>1h old):', change.type, change.date);
          if (change.id) {
            await removePendingChange(change.id);
          }
          setPendingCount(prev => prev - 1);
          continue;
        }
        // For recent changes, stop and retry later
        break;
      }
    }

    const remaining = await getPendingChanges();
    if (remaining.length === 0) {
      setStatus('online');
    }
  } catch { /* sync error — will retry */ }
  });
  await syncQueueRef.current;
  }, [isOnline]);

  // Update status when online state changes
  useEffect(() => {
    if (!isOnline) {
      setStatus('offline');
    } else {
      // When coming online, try to sync
      syncPendingChanges();
    }
  }, [isOnline, syncPendingChanges]);

  // Check pending count periodically and sync if needed
  const syncRef = useRef(syncPendingChanges);
  syncRef.current = syncPendingChanges;
  useEffect(() => {
    const checkPending = async () => {
      const changes = await getPendingChanges();
      setPendingCount(changes.length);
      // Auto-sync if there are pending changes
      if (changes.length > 0) {
        syncRef.current();
      }
    };
    checkPending();
    const interval = setInterval(checkPending, 5000);
    return () => clearInterval(interval);
  }, []);

  const clearAllPendingChanges = useCallback(async () => {
    await clearPendingChanges();
    setPendingCount(0);
    syncErrorsRef.current.clear();
    setStatus(isOnline ? 'online' : 'offline');
  }, [isOnline]);

  const fetchPendingChanges = useCallback(async (): Promise<PendingChange[]> => {
    return getPendingChanges();
  }, []);

  const getSyncErrors = useCallback((): Map<number, string> => {
    return new Map(syncErrorsRef.current);
  }, []);

  const skipPendingChange = useCallback(async (id: number) => {
    await removePendingChange(id);
    syncErrorsRef.current.delete(id);
    const remaining = await getPendingChanges();
    setPendingCount(remaining.length);
    if (remaining.length === 0) {
      setStatus(isOnline ? 'online' : 'offline');
    }
  }, [isOnline]);

  return { status, pendingCount, syncPendingChanges, clearAllPendingChanges, fetchPendingChanges, getSyncErrors, skipPendingChange };
}
