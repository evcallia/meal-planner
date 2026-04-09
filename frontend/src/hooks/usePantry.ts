import { useState, useEffect, useCallback, useRef } from 'react';
import { PantrySection, PantryItem } from '../types';
import {
  getPantryList,
  replacePantryList as replacePantryListAPI,
  addPantryItem as addPantryItemAPI,
  updatePantryItem as updatePantryItemAPI,
  deletePantryItem as deletePantryItemAPI,
  clearPantryItems as clearPantryItemsAPI,
  reorderPantrySections as reorderPantrySectionsAPI,
  reorderPantryItems as reorderPantryItemsAPI,
  renamePantrySection as renamePantrySectionAPI,
  movePantryItem as movePantryItemAPI,
  createPantrySection as createPantrySectionAPI,
  deletePantrySection as deletePantrySectionAPI,
} from '../api/client';
import {
  saveLocalPantrySections,
  saveLocalPantryItems,
  getLocalPantrySections,
  getLocalPantryItems,
  saveLocalPantryItem,
  deleteLocalPantryItem,
  queueChange,
  generateTempId,
  saveTempIdMapping,
} from '../db';
import { useOnlineStatus } from './useOnlineStatus';
import { useUndo } from '../contexts/UndoContext';
import { toTitleCase } from '../utils/titleCase';
import { useIdRemap } from './useIdRemap';

interface PantrySSEPayload {
  action: string;
  sectionId?: string;
  item?: PantryItem;
  itemId?: string;
  fromSectionId?: string;
  toSectionId?: string;
  section?: PantrySection;
  sections?: PantrySection[] | { id: string; position: number }[];
  items?: { id: string; position: number }[];
  name?: string;
}

const PANTRY_STORAGE_KEY = 'meal-planner-pantry-sections';

function savePantryToLocalStorage(sections: PantrySection[]) {
  try {
    localStorage.setItem(PANTRY_STORAGE_KEY, JSON.stringify(sections));
  } catch { /* storage full — best effort */ }
}

function loadPantryFromLocalStorage(): PantrySection[] {
  try {
    const raw = localStorage.getItem(PANTRY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

let pantrySessionLoaded = false;
export function resetPantrySessionLoaded() { pantrySessionLoaded = false; }
export function markPantrySessionLoaded() { pantrySessionLoaded = true; }

export function usePantry() {
  const [sections, setSections] = useState<PantrySection[]>([]);
  const [loading, setLoading] = useState(true);
  const isOnline = useOnlineStatus();
  const { pushAction } = useUndo();

  const optimisticVersionRef = useRef(0);
  const pendingMutationsRef = useRef(0);
  const deferredLoadRef = useRef(false);

  // Keep localStorage and IndexedDB in sync for reliable offline access
  useEffect(() => {
    if (sections.length > 0) {
      savePantryToLocalStorage(sections);
      void Promise.resolve(saveLocalPantrySections(sections.map(s => ({ id: s.id, name: s.name, position: s.position })))).catch(() => {});
      void Promise.resolve(saveLocalPantryItems(sections.flatMap(s => s.items.map(i => ({
        id: i.id, section_id: i.section_id, name: i.name,
        quantity: i.quantity, position: i.position, updated_at: i.updated_at,
      }))))).catch(() => {});
    }
  }, [sections]);

  // When delete+undo re-creates an item, it gets a new server ID.
  // resolveId follows the remap chain; remapId flattens all intermediate IDs.
  const { resolveId, resolveIdAsync, remapId } = useIdRemap();

  // Debounce state for updateItem
  const updateTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pendingUpdatesRef = useRef<Record<string, { name?: string; quantity?: number }>>({});

  useEffect(() => {
    return () => {
      Object.values(updateTimersRef.current).forEach(timer => clearTimeout(timer));
    };
  }, []);

  const loadFromLocal = async (): Promise<PantrySection[]> => {
    try {
      const localSections = await getLocalPantrySections();
      const localItems = await getLocalPantryItems();
      if (localSections.length > 0) {
        return localSections.map(s => ({
          ...s,
          items: localItems
            .filter(i => i.section_id === s.id)
            .sort((a, b) => a.position - b.position),
        }));
      }
    } catch { /* IndexedDB failed */ }
    return loadPantryFromLocalStorage();
  };

  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const loadPantryList = useCallback(async (skipApi = false) => {
    const fetchVersion = optimisticVersionRef.current;

    // 1. Load from cache immediately
    try {
      const localData = await loadFromLocal();
      if (optimisticVersionRef.current !== fetchVersion) return;
      if (localData.length > 0) {
        setSections(localData);
        setLoading(false);
      }
    } catch { /* cache failed — continue to API */ }

    // 2. If online, fetch from API
    if (!skipApi && isOnlineRef.current) {
      try {
        const data = await getPantryList();
        if (optimisticVersionRef.current !== fetchVersion) return;
        setSections(data);
        savePantryToLocalStorage(data);
        await saveLocalPantrySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
        const allItems = data.flatMap(s => s.items);
        await saveLocalPantryItems(allItems.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, position: i.position, updated_at: i.updated_at,
        })));
        pantrySessionLoaded = true;
      } catch { /* API failed — keep cached data */ }
    }

    setLoading(false);
  }, []);

  const loadPantryListRef = useRef(loadPantryList);
  loadPantryListRef.current = loadPantryList;

  const settleMutation = useCallback(() => {
    pendingMutationsRef.current--;
    if (pendingMutationsRef.current === 0 && deferredLoadRef.current) {
      deferredLoadRef.current = false;
      loadPantryListRef.current();
    }
  }, []);

  // Helper: replace list on server and apply the response (which has new server IDs)
  const replaceAndApply = async (payload: { name: string; items: { name: string; quantity: number }[] }[]) => {
    const result = await replacePantryListAPI(payload);
    optimisticVersionRef.current++;
    setSections(result);
    await saveLocalPantrySections(result.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalPantryItems(result.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, position: i.position, updated_at: i.updated_at,
    }))));
  };

  const applyRealtimeEvent = useCallback((payload: PantrySSEPayload) => {
    if (!payload?.action) {
      loadPantryListRef.current();
      return;
    }
    const { action } = payload;
    switch (action) {
      case 'item-added':
        if (payload.sectionId && payload.item) {
          setSections(prev => prev.map(s => {
            if (s.id !== payload.sectionId) return s;
            if (s.items.some(i => i.id === payload.item!.id)) return s;
            return { ...s, items: [...s.items, payload.item!] };
          }));
        }
        break;
      case 'item-updated':
        if (payload.sectionId && payload.item) {
          setSections(prev => prev.map(s => {
            if (s.id !== payload.sectionId) return s;
            return { ...s, items: s.items.map(i => i.id === payload.item!.id ? payload.item! : i) };
          }));
        }
        break;
      case 'item-deleted':
        if (payload.sectionId && payload.itemId) {
          setSections(prev => prev.map(s => {
            if (s.id !== payload.sectionId) return s;
            return { ...s, items: s.items.filter(i => i.id !== payload.itemId) };
          }));
        }
        break;
      case 'item-moved':
        if (payload.fromSectionId && payload.toSectionId && payload.item) {
          setSections(prev => prev.map(s => {
            if (s.id === payload.fromSectionId) {
              return { ...s, items: s.items.filter(i => i.id !== payload.item!.id) };
            }
            if (s.id === payload.toSectionId) {
              if (s.items.some(i => i.id === payload.item!.id)) return s;
              const items = [...s.items, payload.item!].sort((a, b) => a.position - b.position);
              return { ...s, items };
            }
            return s;
          }));
        }
        break;
      case 'section-added':
        if (payload.section) {
          setSections(prev => {
            if (prev.some(s => s.id === payload.section!.id)) return prev;
            return [...prev, payload.section!].sort((a, b) => a.position - b.position);
          });
        }
        break;
      case 'section-renamed':
        if (payload.sectionId && payload.name) {
          setSections(prev => prev.map(s =>
            s.id === payload.sectionId ? { ...s, name: payload.name! } : s
          ));
        }
        break;
      case 'section-deleted':
        if (payload.sectionId) {
          setSections(prev => prev.filter(s => s.id !== payload.sectionId));
        }
        break;
      case 'section-reordered':
        if (payload.sections) {
          const posMap = new Map((payload.sections as { id: string; position: number }[]).map(s => [s.id, s.position]));
          setSections(prev => prev.map(s => {
            const pos = posMap.get(s.id);
            return pos !== undefined ? { ...s, position: pos } : s;
          }).sort((a, b) => a.position - b.position));
        }
        break;
      case 'items-reordered':
        if (payload.sectionId && payload.items) {
          const posMap = new Map(payload.items.map(i => [i.id, i.position]));
          setSections(prev => prev.map(s => {
            if (s.id !== payload.sectionId) return s;
            return { ...s, items: s.items.map(i => {
              const pos = posMap.get(i.id);
              return pos !== undefined ? { ...i, position: pos } : i;
            }).sort((a, b) => a.position - b.position) };
          }));
        }
        break;
      case 'cleared-all':
        setSections([]);
        break;
      case 'replaced':
        if (payload.sections) {
          setSections(payload.sections as PantrySection[]);
        }
        break;
    }
  }, []);

  useEffect(() => {
    loadPantryList(pantrySessionLoaded);
  }, [loadPantryList]);

  // Listen for realtime updates
  useEffect(() => {
    const handler = (e: Event) => {
      const { detail } = e as CustomEvent;
      if (detail?.type === 'pantry.updated') {
        // Guard: don't refresh if debounced updates are pending
        if (Object.keys(pendingUpdatesRef.current).length > 0) return;
        if (pendingMutationsRef.current > 0) {
          deferredLoadRef.current = true;
          return;
        }
        applyRealtimeEvent(detail.payload as PantrySSEPayload);
      }
    };
    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
  }, [applyRealtimeEvent]);

  // Refetch after offline sync completes to pick up other devices' changes
  useEffect(() => {
    const handler = () => loadPantryList();
    window.addEventListener('pending-changes-synced', handler);
    return () => window.removeEventListener('pending-changes-synced', handler);
  }, [loadPantryList]);

  // Add item to a section
  const addItem = useCallback(async (sectionId: string, name: string, quantity: number = 1) => {
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const tempId = generateTempId();
    const maxPos = section.items.length > 0 ? Math.max(...section.items.map(i => i.position)) + 1 : 0;
    const newItem: PantryItem = {
      id: tempId,
      section_id: sectionId,
      name: toTitleCase(name.trim()),
      quantity,
      position: maxPos,
      updated_at: new Date().toISOString(),
    };

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => s.id === sectionId
      ? { ...s, items: [...s.items, newItem] }
      : s
    ));

    await saveLocalPantryItem({
      id: newItem.id, section_id: newItem.section_id, name: newItem.name,
      quantity: newItem.quantity, position: newItem.position, updated_at: newItem.updated_at,
    });

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const realSectionId = await resolveIdAsync(sectionId);
        const created = await addPantryItemAPI(realSectionId, toTitleCase(name.trim()), quantity);
        // Update temp item with server response (real ID)
        if (created.id !== tempId) {
          optimisticVersionRef.current++;
          setSections(prev => prev.map(s => s.id === sectionId
            ? { ...s, items: s.items.map(i => i.id === tempId ? { ...i, id: created.id } : i) }
            : s
          ));
          newItem.id = created.id;
          await saveLocalPantryItem({
            id: created.id, section_id: sectionId, name: newItem.name,
            quantity: newItem.quantity, position: newItem.position, updated_at: created.updated_at,
          });
          await deleteLocalPantryItem(tempId);
        }
      } catch {
        await queueChange('pantry-add', '', { id: tempId, sectionId, sectionName: section.name, name: toTitleCase(name.trim()), quantity });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-add', '', { id: tempId, sectionId, name: toTitleCase(name.trim()), quantity });
    }

    pushAction({
      type: 'add-pantry-item',
      undo: async () => {
        // Resolve through ID remap chain — the item may have been recreated
        // with a new server ID (e.g., add → delete → undo delete → undo add)
        const currentId = resolveId(newItem.id);
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId
          ? { ...s, items: s.items.filter(i => i.id !== currentId) }
          : s
        ));
        await deleteLocalPantryItem(currentId);
        if (isOnlineRef.current) {
          try { await deletePantryItemAPI(currentId); } catch {
            await queueChange('pantry-delete', '', { id: currentId });
          }
        } else {
          await queueChange('pantry-delete', '', { id: currentId });
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        const redoTempId = generateTempId();
        const redoItem: PantryItem = { ...newItem, id: redoTempId };
        setSections(prev => prev.map(s => s.id === sectionId
          ? { ...s, items: [...s.items, redoItem] }
          : s
        ));
        await saveLocalPantryItem({
          id: redoItem.id, section_id: redoItem.section_id, name: redoItem.name,
          quantity: redoItem.quantity, position: redoItem.position, updated_at: redoItem.updated_at,
        });
        if (isOnlineRef.current) {
          try {
            const created = await addPantryItemAPI(sectionId, newItem.name, newItem.quantity);
            if (created.id !== redoTempId) {
              optimisticVersionRef.current++;
              setSections(prev => prev.map(s => s.id === sectionId
                ? { ...s, items: s.items.map(i => i.id === redoTempId ? { ...i, id: created.id } : i) }
                : s
              ));
              remapId(newItem.id, created.id);
              newItem.id = created.id;
              await saveLocalPantryItem({
                id: created.id, section_id: sectionId, name: newItem.name,
                quantity: newItem.quantity, position: newItem.position, updated_at: created.updated_at,
              });
              await deleteLocalPantryItem(redoTempId);
            }
          } catch {
            await queueChange('pantry-add', '', { id: redoTempId, sectionId, name: newItem.name, quantity: newItem.quantity });
          }
        } else {
          newItem.id = redoTempId;
          await queueChange('pantry-add', '', { id: redoTempId, sectionId, name: newItem.name, quantity: newItem.quantity });
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction, settleMutation]);

  // Update item (debounced 500ms for rapid +/- clicks)
  const updateItem = useCallback((id: string, updates: { name?: string; quantity?: number }) => {
    // Apply title case to name edits
    if (updates.name !== undefined) {
      updates = { ...updates, name: toTitleCase(updates.name) };
    }

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => ({
      ...s,
      items: s.items.map(i => {
        if (i.id !== id) return i;
        return {
          ...i,
          ...(updates.name !== undefined ? { name: updates.name } : {}),
          ...(updates.quantity !== undefined ? { quantity: Math.max(0, Math.round(updates.quantity)) } : {}),
        };
      }),
    })));

    const nextUpdates = pendingUpdatesRef.current[id] ?? {};
    pendingUpdatesRef.current[id] = { ...nextUpdates, ...updates };

    if (updateTimersRef.current[id]) {
      clearTimeout(updateTimersRef.current[id]);
    }

    updateTimersRef.current[id] = setTimeout(async () => {
      const payload = pendingUpdatesRef.current[id];
      delete pendingUpdatesRef.current[id];
      if (!payload || (payload.name === undefined && payload.quantity === undefined)) return;

      // Update local DB
      const item = sections.flatMap(s => s.items).find(i => i.id === id);
      if (item) {
        await saveLocalPantryItem({
          ...item,
          name: payload.name ?? item.name,
          quantity: payload.quantity !== undefined ? Math.max(0, Math.round(payload.quantity)) : item.quantity,
          updated_at: new Date().toISOString(),
        });
      }

      // Resolve temp→real ID (item may have been synced while debounce was pending)
      const realId = await resolveIdAsync(id);

      if (isOnlineRef.current) {
        pendingMutationsRef.current++;
        try {
          await updatePantryItemAPI(realId, {
            name: payload.name,
            quantity: payload.quantity !== undefined ? Math.max(0, Math.round(payload.quantity)) : undefined,
          });
        } catch {
          await queueChange('pantry-update', '', { id: realId, ...payload });
        } finally { settleMutation(); }
      } else {
        await queueChange('pantry-update', '', { id: realId, ...payload });
      }
    }, 500);
  }, [isOnline, sections, settleMutation]);

  // Adjust quantity helper
  const adjustQuantity = useCallback((id: string, delta: number) => {
    const item = sections.flatMap(s => s.items).find(i => i.id === id);
    if (!item) return;
    const prevQty = item.quantity;
    const nextQty = Math.max(0, Math.round(prevQty + delta));
    updateItem(id, { quantity: nextQty });

    pushAction({
      type: 'adjust-pantry-qty',
      undo: async () => {
        updateItem(resolveId(id), { quantity: prevQty });
      },
      redo: async () => {
        updateItem(resolveId(id), { quantity: nextQty });
      },
    });
  }, [sections, updateItem, pushAction]);

  // Remove item
  const removeItem = useCallback(async (itemId: string) => {
    const item = sections.flatMap(s => s.items).find(i => i.id === itemId);
    if (!item) return;

    if (updateTimersRef.current[itemId]) {
      clearTimeout(updateTimersRef.current[itemId]);
    }
    delete pendingUpdatesRef.current[itemId];

    const deletedItem = { ...item };
    const deletedItemRef = { id: item.id };
    const section = sections.find(s => s.id === item.section_id);
    const originalIndex = section ? section.items.findIndex(i => i.id === itemId) : -1;

    pushAction({
      type: 'delete-pantry-item',
      undo: async () => {
        // Re-add the specific item via POST (not PUT) — doesn't affect other users' items
        const prevId = deletedItemRef.id;
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        const tempId = generateTempId();
        const restoredItem: PantryItem = { ...deletedItem, id: tempId };
        setSections(prev => prev.map(s => {
          if (s.id !== deletedItem.section_id) return s;
          const items = [...s.items];
          const insertAt = Math.min(originalIndex, items.length);
          items.splice(insertAt, 0, restoredItem);
          return { ...s, items };
        }));
        await saveLocalPantryItem({
          id: tempId, section_id: deletedItem.section_id, name: deletedItem.name,
          quantity: deletedItem.quantity, position: deletedItem.position, updated_at: new Date().toISOString(),
        });
        if (isOnlineRef.current) {
          try {
            const created = await addPantryItemAPI(deletedItem.section_id, deletedItem.name, deletedItem.quantity);
            // Apply real ID and capture item order for server reorder
            optimisticVersionRef.current++;
            let sectionItemIds: string[] = [];
            setSections(prev => prev.map(s => {
              if (s.id !== deletedItem.section_id) return s;
              const updated = { ...s, items: s.items.map(i => i.id === tempId ? { ...i, id: created.id } : i) };
              sectionItemIds = updated.items.map(i => i.id);
              return updated;
            }));
            deletedItemRef.id = created.id;
            remapId(prevId, created.id);
            await deleteLocalPantryItem(tempId);
            await saveLocalPantryItem({
              id: created.id, section_id: deletedItem.section_id, name: deletedItem.name,
              quantity: deletedItem.quantity, position: deletedItem.position, updated_at: created.updated_at,
            });
            // Reorder on server to preserve original position (server adds at end)
            if (sectionItemIds.length > 1) {
              try { await reorderPantryItemsAPI(deletedItem.section_id, sectionItemIds); } catch { /* best effort */ }
            }
          } catch {
            await queueChange('pantry-add', '', { id: tempId, sectionId: deletedItem.section_id, name: deletedItem.name, quantity: deletedItem.quantity });
          }
        } else {
          await queueChange('pantry-add', '', { id: tempId, sectionId: deletedItem.section_id, name: deletedItem.name, quantity: deletedItem.quantity });
        }
        settleMutation();
      },
      redo: async () => {
        // Resolve through ID remap chain — the item may have been recreated with a new ID
        const currentId = resolveId(deletedItemRef.id);
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.filter(i => i.id !== currentId),
        })));
        await deleteLocalPantryItem(currentId);
        if (isOnlineRef.current) {
          try { await deletePantryItemAPI(currentId); } catch {
            await queueChange('pantry-delete', '', { id: currentId });
          }
        } else {
          await queueChange('pantry-delete', '', { id: currentId });
        }
        settleMutation();
      },
    });

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => ({
      ...s,
      items: s.items.filter(i => i.id !== itemId),
    })));

    await deleteLocalPantryItem(itemId);

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const realId = await resolveIdAsync(itemId);
        await deletePantryItemAPI(realId);
      } catch {
        await queueChange('pantry-delete', '', { id: itemId });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-delete', '', { id: itemId });
    }
  }, [sections, isOnline, pushAction, settleMutation, resolveIdAsync]);

  // Clear all items
  const clearAll = useCallback(async () => {
    const prevSections = sections;
    if (sections.length === 0) return;

    optimisticVersionRef.current++;
    setSections([]);

    await saveLocalPantrySections([]);
    await saveLocalPantryItems([]);

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await clearPantryItemsAPI('all'); } catch {
        await queueChange('pantry-replace', '', { sections: [] });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-replace', '', { sections: [] });
    }

    const clearAllPayload = prevSections.map(s => ({
      name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity })),
    }));
    pushAction({
      type: 'clear-all-pantry',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalPantrySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        await saveLocalPantryItems(prevSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name, quantity: i.quantity, position: i.position, updated_at: i.updated_at,
        }))));
        if (isOnlineRef.current) {
          try { await replaceAndApply(clearAllPayload); } catch {
            await queueChange('pantry-replace', '', { sections: clearAllPayload });
          }
        } else {
          await queueChange('pantry-replace', '', { sections: clearAllPayload });
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections([]);
        if (isOnlineRef.current) {
          try { await clearPantryItemsAPI('all'); } catch {
            await queueChange('pantry-replace', '', { sections: [] });
          }
        } else {
          await queueChange('pantry-replace', '', { sections: [] });
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction, settleMutation]);

  // Reorder sections
  const reorderSections = useCallback(async (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const prevSections = sections;

    const reordered = [...sections];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const updated = reordered.map((s, i) => ({ ...s, position: i }));

    optimisticVersionRef.current++;
    setSections(updated);

    await saveLocalPantrySections(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));

    const sectionIds = updated.map(s => s.id);
    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const realIds = await Promise.all(sectionIds.map(id => resolveIdAsync(id)));
        await reorderPantrySectionsAPI(realIds);
      } catch {
        await queueChange('pantry-reorder-sections', '', { sectionIds });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-reorder-sections', '', { sectionIds });
    }

    const prevOrder = prevSections.map(s => s.id);
    pushAction({
      type: 'reorder-pantry-sections',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => {
          const byId = new Map(prev.map(s => [s.id, s]));
          const reordered = prevOrder.filter(id => byId.has(id)).map((id, i) => ({ ...byId.get(id)!, position: i }));
          const prevSet = new Set(prevOrder);
          const extra = prev.filter(s => !prevSet.has(s.id)).map((s, i) => ({ ...s, position: reordered.length + i }));
          return [...reordered, ...extra];
        });
        if (isOnlineRef.current) {
          try { await reorderPantrySectionsAPI(prevOrder); } catch {
            await queueChange('pantry-reorder-sections', '', { sectionIds: prevOrder });
          }
        } else {
          await queueChange('pantry-reorder-sections', '', { sectionIds: prevOrder });
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => {
          const byId = new Map(prev.map(s => [s.id, s]));
          const reordered = sectionIds.filter(id => byId.has(id)).map((id, i) => ({ ...byId.get(id)!, position: i }));
          const newSet = new Set(sectionIds);
          const extra = prev.filter(s => !newSet.has(s.id)).map((s, i) => ({ ...s, position: reordered.length + i }));
          return [...reordered, ...extra];
        });
        if (isOnlineRef.current) {
          try { await reorderPantrySectionsAPI(sectionIds); } catch {
            await queueChange('pantry-reorder-sections', '', { sectionIds });
          }
        } else {
          await queueChange('pantry-reorder-sections', '', { sectionIds });
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction, settleMutation]);

  // Reorder items within a section
  const reorderItems = useCallback(async (sectionId: string, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const reordered = [...section.items];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const updatedItems = reordered.map((item, i) => ({ ...item, position: i }));

    const updatedSections = sections.map(s => s.id === sectionId ? { ...s, items: updatedItems } : s);
    optimisticVersionRef.current++;
    setSections(updatedSections);

    await saveLocalPantryItems(updatedSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, position: i.position, updated_at: i.updated_at,
    }))));

    const itemIds = updatedItems.map(i => i.id);
    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const realSectionId = await resolveIdAsync(sectionId);
        const realItemIds = await Promise.all(itemIds.map(id => resolveIdAsync(id)));
        await reorderPantryItemsAPI(realSectionId, realItemIds);
      } catch {
        await queueChange('pantry-reorder-items', '', { sectionId, itemIds });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-reorder-items', '', { sectionId, itemIds });
    }

    const prevItemOrder = section.items.map(i => i.id);
    pushAction({
      type: 'reorder-pantry-items',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => {
          if (s.id !== sectionId) return s;
          const byId = new Map(s.items.map(i => [i.id, i]));
          const reordered = prevItemOrder.filter(id => byId.has(id)).map((id, i) => ({ ...byId.get(id)!, position: i }));
          const prevSet = new Set(prevItemOrder);
          const extra = s.items.filter(i => !prevSet.has(i.id)).map((i, idx) => ({ ...i, position: reordered.length + idx }));
          return { ...s, items: [...reordered, ...extra] };
        }));
        if (isOnlineRef.current) {
          try { await reorderPantryItemsAPI(sectionId, prevItemOrder); } catch {
            await queueChange('pantry-reorder-items', '', { sectionId, itemIds: prevItemOrder });
          }
        } else {
          await queueChange('pantry-reorder-items', '', { sectionId, itemIds: prevItemOrder });
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => {
          if (s.id !== sectionId) return s;
          const byId = new Map(s.items.map(i => [i.id, i]));
          const reordered = itemIds.filter(id => byId.has(id)).map((id, i) => ({ ...byId.get(id)!, position: i }));
          const newSet = new Set(itemIds);
          const extra = s.items.filter(i => !newSet.has(i.id)).map((i, idx) => ({ ...i, position: reordered.length + idx }));
          return { ...s, items: [...reordered, ...extra] };
        }));
        if (isOnlineRef.current) {
          try { await reorderPantryItemsAPI(sectionId, itemIds); } catch {
            await queueChange('pantry-reorder-items', '', { sectionId, itemIds });
          }
        } else {
          await queueChange('pantry-reorder-items', '', { sectionId, itemIds });
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction, settleMutation]);

  // Add a new empty section
  const addSection = useCallback(async (name: string) => {
    const trimmed = toTitleCase(name.trim());
    if (!trimmed) return;

    const existing = sections.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing.id;

    const sectionRef = { id: '', name: trimmed };

    const tempId = generateTempId();
    const newSection: PantrySection = {
      id: tempId,
      name: trimmed,
      position: sections.length,
      items: [],
    };

    optimisticVersionRef.current++;
    setSections(prev => [...prev, newSection]);

    await saveLocalPantrySections([...sections, newSection].map(s => ({ id: s.id, name: s.name, position: s.position })));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const created = await createPantrySectionAPI(trimmed);
        sectionRef.id = created.id;
        optimisticVersionRef.current++;
        setSections(prev => prev.map(s => s.id === tempId ? { ...created, items: s.items } : s));
        // Best-effort local DB updates — don't queue a replace if these fail
        try {
          await saveTempIdMapping(tempId, created.id);
          await saveLocalPantrySections((await getLocalPantrySections()).map(s => s.id === tempId ? { id: created.id, name: created.name, position: created.position } : s));
        } catch { /* IndexedDB failure is non-fatal here — server already has the section */ }
      } catch {
        sectionRef.id = tempId;
        await queueChange('pantry-create-section', '', { tempId, name: trimmed });
      } finally { settleMutation(); }
    } else {
      sectionRef.id = tempId;
      await queueChange('pantry-create-section', '', { tempId, name: trimmed });
    }

    pushAction({
      type: 'add-pantry-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.filter(s => s.id !== sectionRef.id));
        if (isOnlineRef.current) {
          try { await deletePantrySectionAPI(sectionRef.id); } catch {
            await queueChange('pantry-delete-section', '', { sectionId: sectionRef.id, name: trimmed });
          }
        } else {
          await queueChange('pantry-delete-section', '', { sectionId: sectionRef.id, name: trimmed });
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        if (isOnlineRef.current) {
          try {
            const created = await createPantrySectionAPI(trimmed);
            sectionRef.id = created.id;
            setSections(prev => [...prev, { ...created, items: [] }]);
          } catch {
            const redoId = generateTempId();
            sectionRef.id = redoId;
            setSections(prev => [...prev, { id: redoId, name: trimmed, position: prev.length, items: [] as PantryItem[] }]);
            await queueChange('pantry-create-section', '', { tempId: redoId, name: trimmed });
          }
        } else {
          const redoId = generateTempId();
          sectionRef.id = redoId;
          setSections(prev => [...prev, { id: redoId, name: trimmed, position: prev.length, items: [] as PantryItem[] }]);
          await queueChange('pantry-create-section', '', { tempId: redoId, name: trimmed });
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction, settleMutation]);

  // Delete a section
  const deleteSection = useCallback(async (sectionId: string) => {
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const deletedSection = { ...section, items: [...section.items] };
    const originalIndex = sections.indexOf(section);
    const sectionRef = { id: sectionId };

    pushAction({
      type: 'delete-pantry-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        if (isOnlineRef.current) {
          try {
            const created = await createPantrySectionAPI(deletedSection.name);
            const prevId = sectionRef.id;
            sectionRef.id = created.id;
            await saveTempIdMapping(prevId, created.id);
            const restoredItems: PantryItem[] = [];
            for (const item of deletedSection.items) {
              const createdItem = await addPantryItemAPI(created.id, item.name, item.quantity);
              restoredItems.push(createdItem);
            }
            optimisticVersionRef.current++;
            let reorderIds: string[] = [];
            let reindexedSections: PantrySection[] = [];
            setSections(prev => {
              const next = [...prev];
              const insertAt = Math.min(originalIndex, next.length);
              next.splice(insertAt, 0, { ...created, items: restoredItems });
              reindexedSections = next.map((s, i) => ({ ...s, position: i }));
              reorderIds = reindexedSections.map(s => s.id);
              return reindexedSections;
            });
            await saveLocalPantrySections(reindexedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
            for (const item of restoredItems) {
              await saveLocalPantryItem({ id: item.id, section_id: item.section_id, name: item.name, quantity: item.quantity, position: item.position, updated_at: item.updated_at });
            }
            await reorderPantrySectionsAPI(reorderIds);
          } catch {
            const tempSectionId = generateTempId();
            let reindexed: PantrySection[] = [];
            setSections(prev => {
              const next = [...prev];
              const insertAt = Math.min(originalIndex, next.length);
              next.splice(insertAt, 0, { ...deletedSection, id: tempSectionId });
              reindexed = next.map((s, i) => ({ ...s, position: i }));
              return reindexed;
            });
            await saveLocalPantrySections(reindexed.map(s => ({ id: s.id, name: s.name, position: s.position })));
            await saveLocalPantryItems(reindexed.flatMap(s => s.items.map(i => ({ id: i.id, section_id: i.section_id, name: i.name, quantity: i.quantity, position: i.position, updated_at: i.updated_at }))));
            sectionRef.id = tempSectionId;
            await queueChange('pantry-create-section', '', { tempId: tempSectionId, name: deletedSection.name });
            for (const item of deletedSection.items) {
              await queueChange('pantry-add', '', { id: generateTempId(), sectionId: tempSectionId, sectionName: deletedSection.name, name: item.name, quantity: item.quantity });
            }
          }
        } else {
          const tempSectionId = generateTempId();
          let reindexed: PantrySection[] = [];
          setSections(prev => {
            const next = [...prev];
            const insertAt = Math.min(originalIndex, next.length);
            next.splice(insertAt, 0, { ...deletedSection, id: tempSectionId });
            reindexed = next.map((s, i) => ({ ...s, position: i }));
            return reindexed;
          });
          await saveLocalPantrySections(reindexed.map(s => ({ id: s.id, name: s.name, position: s.position })));
          await saveLocalPantryItems(reindexed.flatMap(s => s.items.map(i => ({ id: i.id, section_id: i.section_id, name: i.name, quantity: i.quantity, position: i.position, updated_at: i.updated_at }))));
          sectionRef.id = tempSectionId;
          await queueChange('pantry-create-section', '', { tempId: tempSectionId, name: deletedSection.name });
          for (const item of deletedSection.items) {
            await queueChange('pantry-add', '', { id: generateTempId(), sectionId: tempSectionId, sectionName: deletedSection.name, name: item.name, quantity: item.quantity });
          }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.filter(s => s.id !== sectionRef.id));
        if (isOnlineRef.current) {
          try { await deletePantrySectionAPI(sectionRef.id); } catch {
            await queueChange('pantry-delete-section', '', { sectionId: sectionRef.id, name: deletedSection.name });
          }
        } else {
          await queueChange('pantry-delete-section', '', { sectionId: sectionRef.id, name: deletedSection.name });
        }
        settleMutation();
      },
    });

    optimisticVersionRef.current++;
    setSections(prev => prev.filter(s => s.id !== sectionId).map((s, i) => ({ ...s, position: i })));

    await saveLocalPantrySections(sections.filter(s => s.id !== sectionId).map((s, i) => ({ id: s.id, name: s.name, position: i })));
    await saveLocalPantryItems(sections.filter(s => s.id !== sectionId).flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, position: i.position, updated_at: i.updated_at,
    }))));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const realSectionId = await resolveIdAsync(sectionId);
        await deletePantrySectionAPI(realSectionId);
      } catch {
        await queueChange('pantry-delete-section', '', { sectionId, name: section.name });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-delete-section', '', { sectionId, name: section.name });
    }
  }, [sections, isOnline, pushAction, settleMutation, resolveIdAsync]);

  // Rename a section
  const renameSection = useCallback(async (sectionId: string, newName: string) => {
    const trimmed = toTitleCase(newName.trim());
    if (!trimmed) return;
    const section = sections.find(s => s.id === sectionId);
    if (!section || section.name === trimmed) return;
    const duplicate = sections.find(s => s.id !== sectionId && s.name.toLowerCase() === trimmed.toLowerCase());
    if (duplicate) return;

    const updatedSections = sections.map(s => s.id === sectionId ? { ...s, name: trimmed } : s);
    optimisticVersionRef.current++;
    setSections(updatedSections);

    await saveLocalPantrySections(updatedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const realSectionId = await resolveIdAsync(sectionId);
        await renamePantrySectionAPI(realSectionId, trimmed);
      } catch {
        await queueChange('pantry-rename-section', '', { sectionId, name: trimmed });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-rename-section', '', { sectionId, name: trimmed });
    }

    const prevName = section.name;
    pushAction({
      type: 'rename-pantry-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId ? { ...s, name: prevName } : s));
        if (isOnlineRef.current) {
          try { await renamePantrySectionAPI(sectionId, prevName); } catch {
            await queueChange('pantry-rename-section', '', { sectionId, name: prevName });
          }
        } else {
          await queueChange('pantry-rename-section', '', { sectionId, name: prevName });
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId ? { ...s, name: trimmed } : s));
        if (isOnlineRef.current) {
          try { await renamePantrySectionAPI(sectionId, trimmed); } catch {
            await queueChange('pantry-rename-section', '', { sectionId, name: trimmed });
          }
        } else {
          await queueChange('pantry-rename-section', '', { sectionId, name: trimmed });
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction, settleMutation]);

  // Move item between sections
  const moveItem = useCallback(async (fromSectionId: string, fromIndex: number, toSectionId: string, toIndex: number) => {
    if (fromSectionId === toSectionId) return;

    const fromSection = sections.find(s => s.id === fromSectionId);
    const toSection = sections.find(s => s.id === toSectionId);
    if (!fromSection || !toSection) return;

    const item = fromSection.items[fromIndex];
    if (!item) return;

    // Optimistic local update
    const newSections = sections.map(s => {
      if (s.id === fromSectionId) {
        const items = s.items.filter(i => i.id !== item.id).map((i, idx) => ({ ...i, position: idx }));
        return { ...s, items };
      }
      if (s.id === toSectionId) {
        const targetItems = [...s.items];
        const movedItem = { ...item, section_id: toSectionId };
        targetItems.splice(toIndex, 0, movedItem);
        return { ...s, items: targetItems.map((i, idx) => ({ ...i, position: idx })) };
      }
      return s;
    });

    pushAction({
      type: 'move-pantry-item',
      undo: async () => {
        const currentItemId = resolveId(item.id);
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => {
          const currentToSection = prev.find(s => s.id === toSectionId);
          const movedItem = currentToSection?.items.find(i => i.id === currentItemId);
          if (!movedItem) return prev;
          return prev.map(s => {
            if (s.id === toSectionId) {
              return { ...s, items: s.items.filter(i => i.id !== currentItemId).map((i, idx) => ({ ...i, position: idx })) };
            }
            if (s.id === fromSectionId) {
              const items = [...s.items];
              items.splice(fromIndex, 0, { ...movedItem, section_id: fromSectionId });
              return { ...s, items: items.map((i, idx) => ({ ...i, position: idx })) };
            }
            return s;
          });
        });
        if (isOnlineRef.current) {
          try { await movePantryItemAPI(currentItemId, fromSectionId, fromIndex); } catch {
            await queueChange('pantry-move-item', '', { id: currentItemId, toSectionId: fromSectionId, toPosition: fromIndex });
          }
        } else {
          await queueChange('pantry-move-item', '', { id: currentItemId, toSectionId: fromSectionId, toPosition: fromIndex });
        }
        settleMutation();
      },
      redo: async () => {
        const currentItemId = resolveId(item.id);
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => {
          const currentFromSection = prev.find(s => s.id === fromSectionId);
          const movedItem = currentFromSection?.items.find(i => i.id === currentItemId);
          if (!movedItem) return prev;
          return prev.map(s => {
            if (s.id === fromSectionId) {
              return { ...s, items: s.items.filter(i => i.id !== currentItemId).map((i, idx) => ({ ...i, position: idx })) };
            }
            if (s.id === toSectionId) {
              const items = [...s.items];
              items.splice(toIndex, 0, { ...movedItem, section_id: toSectionId });
              return { ...s, items: items.map((i, idx) => ({ ...i, position: idx })) };
            }
            return s;
          });
        });
        if (isOnlineRef.current) {
          try { await movePantryItemAPI(currentItemId, toSectionId, toIndex); } catch {
            await queueChange('pantry-move-item', '', { id: currentItemId, toSectionId, toPosition: toIndex });
          }
        } else {
          await queueChange('pantry-move-item', '', { id: currentItemId, toSectionId, toPosition: toIndex });
        }
        settleMutation();
      },
    });

    optimisticVersionRef.current++;
    setSections(newSections);

    await saveLocalPantrySections(newSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalPantryItems(newSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, position: i.position, updated_at: i.updated_at,
    }))));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const realItemId = await resolveIdAsync(item.id);
        const realSectionId = await resolveIdAsync(toSectionId);
        await movePantryItemAPI(realItemId, realSectionId, toIndex);
      } catch {
        await queueChange('pantry-move-item', '', { id: item.id, toSectionId, toPosition: toIndex });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-move-item', '', { id: item.id, toSectionId, toPosition: toIndex });
    }
  }, [sections, isOnline, pushAction, settleMutation]);

  return {
    sections,
    loading,
    addSection,
    deleteSection,
    addItem,
    updateItem,
    adjustQuantity,
    removeItem,
    clearAll,
    reorderSections,
    reorderItems,
    renameSection,
    moveItem,
  };
}
