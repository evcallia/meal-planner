import { useState, useEffect, useCallback, useRef } from 'react';
import { GrocerySection, GroceryItem } from '../types';
import {
  getGroceryList,
  replaceGroceryList as replaceGroceryListAPI,
  toggleGroceryItem as toggleGroceryItemAPI,
  addGroceryItem as addGroceryItemAPI,
  deleteGroceryItem as deleteGroceryItemAPI,
  editGroceryItem as editGroceryItemAPI,
  clearGroceryItems as clearGroceryItemsAPI,
  reorderGrocerySections as reorderGrocerySectionsAPI,
  reorderGroceryItems as reorderGroceryItemsAPI,
  renameGrocerySection as renameGrocerySectionAPI,
  moveGroceryItem as moveGroceryItemAPI,
} from '../api/client';
import {
  saveLocalGrocerySections,
  saveLocalGroceryItems,
  getLocalGrocerySections,
  getLocalGroceryItems,
  saveLocalGroceryItem,
  deleteLocalGroceryItem,
  queueChange,
  getPendingChanges,
  generateTempId,
} from '../db';
import { useOnlineStatus } from './useOnlineStatus';
import { useUndo } from '../contexts/UndoContext';
import { ParsedGrocerySection } from '../utils/groceryParser';
import { toTitleCase } from '../utils/titleCase';

const GROCERY_STORAGE_KEY = 'meal-planner-grocery';

function saveGroceryToLocalStorage(sections: GrocerySection[]) {
  try {
    localStorage.setItem(GROCERY_STORAGE_KEY, JSON.stringify(sections));
  } catch { /* storage full — best effort */ }
}

function loadGroceryFromLocalStorage(): GrocerySection[] {
  try {
    const raw = localStorage.getItem(GROCERY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

export function useGroceryList() {
  const [sections, setSections] = useState<GrocerySection[]>([]);
  const [loading, setLoading] = useState(true);
  const isOnline = useOnlineStatus();
  const { pushAction } = useUndo();

  // Broadcast unchecked item count for the bottom nav badge
  useEffect(() => {
    const count = sections.reduce((sum, s) => sum + s.items.filter(i => !i.checked).length, 0);
    window.dispatchEvent(new CustomEvent('grocery-count-changed', { detail: count }));
  }, [sections]);

  // When delete+undo re-creates an item, it gets a new server ID.
  // This map lets older undo entries resolve the original ID → current ID.
  const idRemapRef = useRef(new Map<string, string>());
  const resolveId = (originalId: string): string => {
    let id = originalId;
    while (idRemapRef.current.has(id)) {
      id = idRemapRef.current.get(id)!;
    }
    return id;
  };

  // Version counter: incremented on every optimistic update.
  // loadGroceryList checks this before applying fetched data to avoid
  // overwriting newer optimistic state with a stale server response.
  const optimisticVersionRef = useRef(0);
  // Tracks in-flight mutation API calls. While > 0, realtime-triggered
  // refetches are deferred to prevent stale server data from overwriting
  // optimistic state.
  const pendingMutationsRef = useRef(0);
  const deferredLoadRef = useRef(false);

  // Assemble GrocerySection[] from separate IndexedDB tables, falling back to localStorage
  const loadFromLocal = async (): Promise<GrocerySection[]> => {
    try {
      const localSections = await getLocalGrocerySections();
      const localItems = await getLocalGroceryItems();
      if (localSections.length > 0) {
        return localSections.map(s => ({
          ...s,
          items: localItems
            .filter(i => i.section_id === s.id)
            .sort((a, b) => (a.checked === b.checked ? a.position - b.position : a.checked ? 1 : -1)),
        }));
      }
    } catch { /* IndexedDB failed */ }
    return loadGroceryFromLocalStorage();
  };

  // Use a ref so loadGroceryList doesn't depend on isOnline directly.
  // This prevents the load function from being recreated (and re-triggered)
  // when going online→offline, which would overwrite in-memory optimistic state.
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  // Load grocery list (cache-first: show cached data immediately, then refresh from API)
  const loadGroceryList = useCallback(async () => {
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

    // 2. If online, fetch from API in background (skip if pending offline changes exist)
    if (isOnlineRef.current) {
      const pending = await getPendingChanges();
      const hasGroceryChanges = pending.some(c => c.type.startsWith('grocery-'));
      if (!hasGroceryChanges) {
        try {
          const data = await getGroceryList();
          if (optimisticVersionRef.current !== fetchVersion) return;
          setSections(data);
          saveGroceryToLocalStorage(data);
          await saveLocalGrocerySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
          const allItems = data.flatMap(s => s.items);
          await saveLocalGroceryItems(allItems.map(i => ({
            id: i.id,
            section_id: i.section_id,
            name: i.name,
            quantity: i.quantity,
            checked: i.checked,
            position: i.position,
            store_id: i.store_id,
            updated_at: i.updated_at,
          })));
        } catch { /* API failed — keep cached data */ }
      }
    }

    setLoading(false);
  }, []);

  // Keep a stable ref to loadGroceryList for use in mutation settle callbacks
  const loadGroceryListRef = useRef(loadGroceryList);
  loadGroceryListRef.current = loadGroceryList;

  const settleMutation = useCallback(() => {
    pendingMutationsRef.current--;
    if (pendingMutationsRef.current === 0 && deferredLoadRef.current) {
      deferredLoadRef.current = false;
      loadGroceryListRef.current();
    }
  }, []);

  // Helper: replace list on server and apply the response (which has new server IDs)
  const replaceAndApply = async (payload: { name: string; items: { name: string; quantity: string | null; checked: boolean; store_id: string | null }[] }[]) => {
    const result = await replaceGroceryListAPI(payload);
    optimisticVersionRef.current++;
    setSections(result);
    await saveLocalGrocerySections(result.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalGroceryItems(result.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
    }))));
  };

  // Load on mount, and reload when coming back online (but not when going offline)
  const prevOnlineRef = useRef(isOnline);
  useEffect(() => {
    const wasOffline = !prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    if (isOnline && wasOffline) {
      // Coming back online — refresh from server
      loadGroceryList();
    }
  }, [isOnline, loadGroceryList]);

  useEffect(() => {
    loadGroceryList();
  }, [loadGroceryList]);

  // Listen for realtime updates
  useEffect(() => {
    const handler = (e: Event) => {
      const { detail } = e as CustomEvent;
      if (detail?.type === 'grocery.updated') {
        if (pendingMutationsRef.current > 0) {
          deferredLoadRef.current = true;
          return;
        }
        loadGroceryList();
      }
    };
    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
  }, [loadGroceryList]);

  // Merge parsed grocery items into existing list
  const mergeList = useCallback(async (parsed: ParsedGrocerySection[]) => {
    const prevSections = sections;

    // Build merged sections: match by name (case-insensitive), append new items
    const mergedSections: GrocerySection[] = [...sections.map(s => ({
      ...s,
      items: [...s.items],
    }))];

    for (const parsedSection of parsed) {
      const existingIndex = mergedSections.findIndex(
        s => s.name.toLowerCase() === parsedSection.name.toLowerCase()
      );

      // Helper: find store_id from any existing item with matching name
      const lookupStoreId = (name: string): string | null => {
        const match = mergedSections.flatMap(s => s.items).find(
          i => i.name.toLowerCase() === name.toLowerCase() && i.store_id
        );
        return match?.store_id ?? null;
      };

      if (existingIndex >= 0) {
        // Merge items into existing section — dedup by name
        const existing = mergedSections[existingIndex];
        let maxPos = existing.items.length > 0
          ? Math.max(...existing.items.map(i => i.position)) + 1
          : 0;
        const updatedItems = [...existing.items];

        for (const item of parsedSection.items) {
          const trimmedName = toTitleCase(item.name);
          const existingItem = updatedItems.find(
            i => !i.checked && i.name.toLowerCase() === trimmedName.toLowerCase()
          );
          if (existingItem) {
            // Dedup: merge quantities
            const existingQty = parseInt(existingItem.quantity || '1') || 1;
            const addingQty = parseInt(item.quantity || '1') || 1;
            existingItem.quantity = String(existingQty + addingQty);
          } else {
            updatedItems.push({
              id: generateTempId(),
              section_id: existing.id,
              name: trimmedName,
              quantity: item.quantity,
              checked: false,
              position: maxPos++,
              store_id: lookupStoreId(trimmedName),
              updated_at: new Date().toISOString(),
            });
          }
        }
        mergedSections[existingIndex] = { ...existing, items: updatedItems };
      } else {
        // Create new section — still dedup within the parsed items and look up stores
        const sectionId = generateTempId();
        const dedupedItems: GroceryItem[] = [];
        let pos = 0;
        for (const item of parsedSection.items) {
          const trimmedName = toTitleCase(item.name);
          const existingItem = dedupedItems.find(
            i => i.name.toLowerCase() === trimmedName.toLowerCase()
          );
          if (existingItem) {
            const existingQty = parseInt(existingItem.quantity || '1') || 1;
            const addingQty = parseInt(item.quantity || '1') || 1;
            existingItem.quantity = String(existingQty + addingQty);
          } else {
            dedupedItems.push({
              id: generateTempId(),
              section_id: sectionId,
              name: trimmedName,
              quantity: item.quantity,
              checked: false,
              position: pos++,
              store_id: lookupStoreId(trimmedName),
              updated_at: new Date().toISOString(),
            });
          }
        }
        mergedSections.push({
          id: sectionId,
          name: parsedSection.name,
          position: mergedSections.length,
          items: dedupedItems,
        });
      }
    }

    optimisticVersionRef.current++;
    setSections(mergedSections);

    // Save locally
    await saveLocalGrocerySections(mergedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalGroceryItems(mergedSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
    }))));

    // Sync — replace the full list on the server with the merged result
    const mergedPayload = mergedSections.map(s => ({
      name: s.name,
      items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked, store_id: i.store_id })),
    }));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const result = await replaceGroceryListAPI(mergedPayload);
        optimisticVersionRef.current++;
        setSections(result);
        await saveLocalGrocerySections(result.map(s => ({ id: s.id, name: s.name, position: s.position })));
        await saveLocalGroceryItems(result.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
        }))));
      } catch {
        await queueChange('grocery-replace', '', { sections: mergedPayload });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-replace', '', { sections: mergedPayload });
    }

    pushAction({
      type: 'merge-grocery-list',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalGrocerySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        await saveLocalGroceryItems(prevSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
        }))));
        if (isOnline) {
          try {
            const payload = prevSections.map(s => ({
              name: s.name,
              items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked, store_id: i.store_id })),
            }));
            await replaceGroceryListAPI(payload);
          } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(mergedSections);
        if (isOnline) {
          try { await replaceGroceryListAPI(mergedPayload); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Toggle item checked
  const toggleItem = useCallback(async (itemId: string, checked: boolean) => {
    const checkedAt = new Date().toISOString();

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => ({
      ...s,
      items: s.items.map(i => i.id === itemId ? { ...i, checked, updated_at: checkedAt } : i)
        .sort((a, b) => (a.checked === b.checked ? a.position - b.position : a.checked ? 1 : -1)),
    })));

    // Update local
    const allItems = sections.flatMap(s => s.items);
    const item = allItems.find(i => i.id === itemId);
    if (item) {
      await saveLocalGroceryItem({
        id: item.id, section_id: item.section_id, name: item.name,
        quantity: item.quantity, checked, position: item.position, store_id: item.store_id, updated_at: checkedAt,
      });
    }

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await toggleGroceryItemAPI(itemId, checked); } catch {
        await queueChange('grocery-check', '', { id: itemId, checked });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-check', '', { id: itemId, checked });
    }

    pushAction({
      type: 'check-grocery-item',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        // Toggle back the specific item (not full snapshot restore — avoids multi-user conflicts)
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.map(i => i.id === itemId ? { ...i, checked: !checked, updated_at: item?.updated_at ?? checkedAt } : i)
            .sort((a, b) => (a.checked === b.checked ? a.position - b.position : a.checked ? 1 : -1)),
        })));
        if (item) {
          await saveLocalGroceryItem({
            id: item.id, section_id: item.section_id, name: item.name,
            quantity: item.quantity, checked: !checked, position: item.position, store_id: item.store_id, updated_at: item.updated_at,
          });
        }
        if (isOnline) {
          try { await toggleGroceryItemAPI(itemId, !checked); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.map(i => i.id === itemId ? { ...i, checked, updated_at: checkedAt } : i)
            .sort((a, b) => (a.checked === b.checked ? a.position - b.position : a.checked ? 1 : -1)),
        })));
        if (item) {
          await saveLocalGroceryItem({
            id: item.id, section_id: item.section_id, name: item.name,
            quantity: item.quantity, checked, position: item.position, store_id: item.store_id, updated_at: checkedAt,
          });
        }
        if (isOnline) {
          try { await toggleGroceryItemAPI(itemId, checked); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Add item to a section (merges with existing duplicate if found)
  const addItem = useCallback(async (sectionId: string, name: string, quantity: string | null = null) => {
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const trimmedName = toTitleCase(name.trim());

    // Check for existing unchecked item with same name (case-insensitive)
    const existingItem = section.items.find(
      i => !i.checked && i.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (existingItem) {
      // Merge: add quantities together
      const existingQty = parseInt(existingItem.quantity || '1') || 1;
      const addingQty = parseInt(quantity || '1') || 1;
      const mergedQty = String(existingQty + addingQty);

      // Delegate to editItem logic inline
      const prevQuantity = existingItem.quantity;
      optimisticVersionRef.current++;
      setSections(prev => prev.map(s => ({
        ...s,
        items: s.items.map(i => i.id === existingItem.id ? { ...i, quantity: mergedQty } : i),
      })));

      await saveLocalGroceryItem({
        id: existingItem.id, section_id: existingItem.section_id, name: existingItem.name,
        quantity: mergedQty, checked: existingItem.checked, position: existingItem.position,
        store_id: existingItem.store_id, updated_at: new Date().toISOString(),
      });

      if (isOnline) {
        pendingMutationsRef.current++;
        try { await editGroceryItemAPI(existingItem.id, { quantity: mergedQty }); } catch {
          await queueChange('grocery-edit', '', { id: existingItem.id, quantity: mergedQty });
        } finally { settleMutation(); }
      } else {
        await queueChange('grocery-edit', '', { id: existingItem.id, quantity: mergedQty });
      }

      pushAction({
        type: 'merge-grocery-item',
        undo: async () => {
          optimisticVersionRef.current++;
          pendingMutationsRef.current++;
          setSections(prev => prev.map(s => ({
            ...s,
            items: s.items.map(i => i.id === existingItem.id ? { ...i, quantity: prevQuantity } : i),
          })));
          await saveLocalGroceryItem({
            id: existingItem.id, section_id: existingItem.section_id, name: existingItem.name,
            quantity: prevQuantity, checked: existingItem.checked, position: existingItem.position,
            store_id: existingItem.store_id, updated_at: new Date().toISOString(),
          });
          if (isOnline) {
            try { await editGroceryItemAPI(existingItem.id, { quantity: prevQuantity }); } catch { /* queue */ }
          }
          settleMutation();
        },
        redo: async () => {
          optimisticVersionRef.current++;
          pendingMutationsRef.current++;
          setSections(prev => prev.map(s => ({
            ...s,
            items: s.items.map(i => i.id === existingItem.id ? { ...i, quantity: mergedQty } : i),
          })));
          if (isOnline) {
            try { await editGroceryItemAPI(existingItem.id, { quantity: mergedQty }); } catch { /* queue */ }
          }
          settleMutation();
        },
      });
      return;
    }

    const tempId = generateTempId();
    const maxPos = section.items.length > 0 ? Math.max(...section.items.map(i => i.position)) + 1 : 0;
    // Look up store_id from any existing item with the same name (including checked items in any section)
    const existingWithStore = sections.flatMap(s => s.items).find(
      i => i.name.toLowerCase() === trimmedName.toLowerCase() && i.store_id
    );
    const newItem: GroceryItem = {
      id: tempId,
      section_id: sectionId,
      name: trimmedName,
      quantity,
      checked: false,
      position: maxPos,
      store_id: existingWithStore?.store_id ?? null,
      updated_at: new Date().toISOString(),
    };

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => s.id === sectionId
      ? { ...s, items: [...s.items.filter(i => !i.checked), newItem, ...s.items.filter(i => i.checked)] }
      : s
    ));

    await saveLocalGroceryItem({
      id: newItem.id, section_id: newItem.section_id, name: newItem.name,
      quantity: newItem.quantity, checked: false, position: newItem.position, store_id: newItem.store_id, updated_at: newItem.updated_at,
    });

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const created = await addGroceryItemAPI(sectionId, trimmedName, quantity);
        // Update temp item with server response (real ID, auto-populated store_id)
        if (created.store_id || created.id !== tempId) {
          optimisticVersionRef.current++;
          setSections(prev => prev.map(s => s.id === sectionId
            ? { ...s, items: s.items.map(i => i.id === tempId ? { ...i, id: created.id, store_id: created.store_id } : i) }
            : s
          ));
          newItem.id = created.id;
          newItem.store_id = created.store_id;
          await saveLocalGroceryItem({
            id: created.id, section_id: sectionId, name: trimmedName,
            quantity, checked: false, position: newItem.position, store_id: created.store_id, updated_at: created.updated_at,
          });
          await deleteLocalGroceryItem(tempId);
        }
      } catch {
        await queueChange('grocery-add', '', { id: tempId, sectionId, name: trimmedName, quantity });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-add', '', { id: tempId, sectionId, name: trimmedName, quantity });
    }

    pushAction({
      type: 'add-grocery-item',
      undo: async () => {
        // Use newItem.id (not tempId) — it's updated to the real server ID after creation
        const currentId = newItem.id;
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId
          ? { ...s, items: s.items.filter(i => i.id !== currentId) }
          : s
        ));
        await deleteLocalGroceryItem(currentId);
        if (isOnline) {
          try { await deleteGroceryItemAPI(currentId); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId
          ? { ...s, items: [...s.items.filter(i => !i.checked), newItem, ...s.items.filter(i => i.checked)] }
          : s
        ));
        await saveLocalGroceryItem({
          id: newItem.id, section_id: newItem.section_id, name: newItem.name,
          quantity: newItem.quantity, checked: false, position: newItem.position, store_id: newItem.store_id, updated_at: newItem.updated_at,
        });
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Delete an item — uses targeted POST/DELETE for undo/redo (not PUT)
  // to avoid multi-user conflicts where PUT would overwrite other users' changes.
  const deleteItem = useCallback(async (itemId: string) => {
    const item = sections.flatMap(s => s.items).find(i => i.id === itemId);
    if (!item) return;

    // Capture the deleted item's details for undo re-creation
    const deletedItem = { ...item };
    const deletedItemRef = { id: item.id };

    // Push undo action BEFORE API call so undo is available immediately
    pushAction({
      type: 'delete-grocery-item',
      undo: async () => {
        // Re-add the specific item via POST (not PUT) — doesn't affect other users' items
        const prevId = deletedItemRef.id;
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        const tempId = generateTempId();
        const restoredItem: GroceryItem = { ...deletedItem, id: tempId };
        setSections(prev => prev.map(s => s.id === deletedItem.section_id
          ? { ...s, items: [...s.items.filter(i => !i.checked), restoredItem, ...s.items.filter(i => i.checked)] }
          : s
        ));
        if (isOnline) {
          try {
            const created = await addGroceryItemAPI(deletedItem.section_id, deletedItem.name, deletedItem.quantity, deletedItem.store_id);
            // Apply real ID
            optimisticVersionRef.current++;
            setSections(prev => prev.map(s => s.id === deletedItem.section_id
              ? { ...s, items: s.items.map(i => i.id === tempId ? { ...i, id: created.id } : i) }
              : s
            ));
            deletedItemRef.id = created.id;
            // Record old→new so older undo entries can find the item
            idRemapRef.current.set(prevId, created.id);
            await saveLocalGroceryItem({
              id: created.id, section_id: deletedItem.section_id, name: deletedItem.name,
              quantity: deletedItem.quantity, checked: deletedItem.checked, position: deletedItem.position,
              store_id: created.store_id, updated_at: created.updated_at,
            });
            await deleteLocalGroceryItem(tempId);
            // If it was checked, toggle it
            if (deletedItem.checked) {
              await toggleGroceryItemAPI(created.id, true);
            }
          } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        // Delete the specific item via DELETE (not PUT)
        const currentId = deletedItemRef.id;
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.filter(i => i.id !== currentId),
        })));
        await deleteLocalGroceryItem(currentId);
        if (isOnline) {
          try { await deleteGroceryItemAPI(currentId); } catch { /* queue */ }
        }
        settleMutation();
      },
    });

    // Optimistic update
    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => ({
      ...s,
      items: s.items.filter(i => i.id !== itemId),
    })));

    await deleteLocalGroceryItem(itemId);

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await deleteGroceryItemAPI(itemId); } catch {
        await queueChange('grocery-delete', '', { id: itemId, name: deletedItem.name });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-delete', '', { id: itemId, name: deletedItem.name });
    }
  }, [sections, isOnline, pushAction]);

  // Edit an item's name or quantity
  const editItem = useCallback(async (itemId: string, updates: { name?: string; quantity?: string | null; store_id?: string | null }) => {
    const allItems = sections.flatMap(s => s.items);
    const item = allItems.find(i => i.id === itemId);
    if (!item) return;

    // Apply title case to name edits
    if (updates.name !== undefined) {
      updates = { ...updates, name: toTitleCase(updates.name) };
    }

    // If name changed and item has no store, look up store from existing items with the new name
    if (updates.name !== undefined && updates.store_id === undefined && !item.store_id) {
      const match = sections.flatMap(s => s.items).find(
        i => i.name.toLowerCase() === updates.name!.toLowerCase() && i.store_id
      );
      if (match) {
        updates = { ...updates, store_id: match.store_id };
      }
    }

    // Check for duplicate: if name is changing to match another unchecked item in the same section, merge
    const finalName = updates.name ?? item.name;
    const section = sections.find(s => s.id === item.section_id);
    if (section) {
      const duplicate = section.items.find(
        i => i.id !== itemId && !i.checked && i.name.toLowerCase() === finalName.toLowerCase()
      );
      if (duplicate) {
        // Merge: combine quantities into the duplicate, delete the edited item
        const editedQty = parseInt((updates.quantity !== undefined ? updates.quantity : item.quantity) || '1') || 1;
        const dupQty = parseInt(duplicate.quantity || '1') || 1;
        const mergedQty = String(editedQty + dupQty);

        // Capture state for targeted undo (not PUT-based)
        const deletedItem = { ...item };
        const deletedItemRef = { id: item.id };
        const dupOriginalQty = duplicate.quantity;
        const dupId = duplicate.id;

        optimisticVersionRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items
            .filter(i => i.id !== itemId)
            .map(i => i.id === dupId ? { ...i, quantity: mergedQty } : i),
        })));

        if (isOnline) {
          pendingMutationsRef.current++;
          try {
            // Targeted: update duplicate's qty + delete the edited item
            await editGroceryItemAPI(dupId, { quantity: mergedQty });
            await deleteGroceryItemAPI(itemId);
          } catch {
            await queueChange('grocery-edit', '', { id: dupId, quantity: mergedQty });
            await queueChange('grocery-delete', '', { id: itemId, name: deletedItem.name });
          } finally { settleMutation(); }
        } else {
          await queueChange('grocery-edit', '', { id: dupId, quantity: mergedQty });
          await queueChange('grocery-delete', '', { id: itemId, name: deletedItem.name });
        }

        pushAction({
          type: 'edit-merge-grocery-item',
          undo: async () => {
            // Targeted undo: restore duplicate's qty + re-add the deleted item
            optimisticVersionRef.current++;
            pendingMutationsRef.current++;
            // Restore duplicate quantity
            setSections(prev => prev.map(s => ({
              ...s,
              items: s.items.map(i => i.id === dupId ? { ...i, quantity: dupOriginalQty } : i),
            })));
            // Re-add deleted item
            const tempId = generateTempId();
            const restoredItem: GroceryItem = { ...deletedItem, id: tempId };
            setSections(prev => prev.map(s => s.id === deletedItem.section_id
              ? { ...s, items: [...s.items.filter(i => !i.checked), restoredItem, ...s.items.filter(i => i.checked)] }
              : s
            ));
            if (isOnline) {
              try {
                await editGroceryItemAPI(dupId, { quantity: dupOriginalQty });
                const created = await addGroceryItemAPI(deletedItem.section_id, deletedItem.name, deletedItem.quantity, deletedItem.store_id);
                optimisticVersionRef.current++;
                setSections(prev => prev.map(s => s.id === deletedItem.section_id
                  ? { ...s, items: s.items.map(i => i.id === tempId ? { ...i, id: created.id } : i) }
                  : s
                ));
                deletedItemRef.id = created.id;
                await deleteLocalGroceryItem(tempId);
              } catch { /* queue */ }
            }
            settleMutation();
          },
          redo: async () => {
            // Targeted redo: merge again
            const currentId = deletedItemRef.id;
            optimisticVersionRef.current++;
            pendingMutationsRef.current++;
            setSections(prev => prev.map(s => ({
              ...s,
              items: s.items
                .filter(i => i.id !== currentId)
                .map(i => i.id === dupId ? { ...i, quantity: mergedQty } : i),
            })));
            if (isOnline) {
              try {
                await editGroceryItemAPI(dupId, { quantity: mergedQty });
                await deleteGroceryItemAPI(currentId);
              } catch { /* queue */ }
            }
            settleMutation();
          },
        });
        return;
      }
    }

    const prevName = item.name;
    const prevQuantity = item.quantity;
    const prevStoreId = item.store_id;

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => ({
      ...s,
      items: s.items.map(i => i.id === itemId ? {
        ...i,
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.quantity !== undefined ? { quantity: updates.quantity } : {}),
        ...(updates.store_id !== undefined ? { store_id: updates.store_id } : {}),
      } : i),
    })));

    // Update local
    await saveLocalGroceryItem({
      id: item.id, section_id: item.section_id,
      name: updates.name ?? item.name,
      quantity: updates.quantity !== undefined ? updates.quantity : item.quantity,
      checked: item.checked, position: item.position,
      store_id: updates.store_id !== undefined ? updates.store_id : item.store_id,
      updated_at: new Date().toISOString(),
    });

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        const serverItem = await editGroceryItemAPI(itemId, updates);
        // If server returned a different store_id (e.g. from item_defaults), apply it
        const optimisticStoreId = updates.store_id !== undefined ? updates.store_id : item.store_id;
        if (serverItem.store_id !== optimisticStoreId) {
          optimisticVersionRef.current++;
          setSections(prev => prev.map(s => ({
            ...s,
            items: s.items.map(i => i.id === itemId ? { ...i, store_id: serverItem.store_id } : i),
          })));
          await saveLocalGroceryItem({
            id: item.id, section_id: item.section_id,
            name: serverItem.name, quantity: serverItem.quantity,
            checked: serverItem.checked, position: item.position,
            store_id: serverItem.store_id, updated_at: serverItem.updated_at,
          });
        }
      } catch {
        await queueChange('grocery-edit', '', { id: itemId, ...updates });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-edit', '', { id: itemId, ...updates });
    }

    pushAction({
      type: 'edit-grocery-item',
      undo: async () => {
        const currentId = resolveId(itemId);
        const undoUpdates: { name?: string; quantity?: string | null; store_id?: string | null } = {};
        if (updates.name !== undefined) undoUpdates.name = prevName;
        if (updates.quantity !== undefined) undoUpdates.quantity = prevQuantity;
        if (updates.store_id !== undefined) undoUpdates.store_id = prevStoreId;

        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.map(i => i.id === currentId ? { ...i, ...undoUpdates } : i),
        })));
        await saveLocalGroceryItem({
          id: currentId, section_id: item.section_id,
          name: undoUpdates.name ?? item.name,
          quantity: undoUpdates.quantity !== undefined ? undoUpdates.quantity : item.quantity,
          checked: item.checked, position: item.position,
          store_id: undoUpdates.store_id !== undefined ? undoUpdates.store_id : item.store_id,
          updated_at: new Date().toISOString(),
        });
        if (isOnline) {
          try { await editGroceryItemAPI(currentId, undoUpdates); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        const currentId = resolveId(itemId);
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.map(i => i.id === currentId ? {
            ...i,
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.quantity !== undefined ? { quantity: updates.quantity } : {}),
            ...(updates.store_id !== undefined ? { store_id: updates.store_id } : {}),
          } : i),
        })));
        await saveLocalGroceryItem({
          id: currentId, section_id: item.section_id,
          name: updates.name ?? item.name,
          quantity: updates.quantity !== undefined ? updates.quantity : item.quantity,
          checked: item.checked, position: item.position,
          store_id: updates.store_id !== undefined ? updates.store_id : item.store_id,
          updated_at: new Date().toISOString(),
        });
        if (isOnline) {
          try { await editGroceryItemAPI(currentId, updates); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Clear checked items
  const clearChecked = useCallback(async () => {
    const prevSections = sections;
    const checkedItems = sections.flatMap(s => s.items.filter(i => i.checked));
    if (checkedItems.length === 0) return;

    // Remove checked items, remove empty sections
    const newSections = sections
      .map(s => ({ ...s, items: s.items.filter(i => !i.checked) }))
      .filter(s => s.items.length > 0);

    optimisticVersionRef.current++;
    setSections(newSections);

    // Update local storage
    await saveLocalGrocerySections(newSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalGroceryItems(newSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
    }))));

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await clearGroceryItemsAPI('checked'); } catch {
        await queueChange('grocery-clear', '', { mode: 'checked' });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-clear', '', { mode: 'checked' });
    }

    const clearCheckedPayload = prevSections.map(s => ({
      name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked, store_id: i.store_id })),
    }));
    pushAction({
      type: 'clear-checked-grocery',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        if (isOnline) {
          try { await replaceAndApply(clearCheckedPayload); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(newSections);
        if (isOnline) {
          try { await clearGroceryItemsAPI('checked'); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Clear all items
  const clearAll = useCallback(async () => {
    const prevSections = sections;
    if (sections.length === 0) return;

    optimisticVersionRef.current++;
    setSections([]);

    // Clear local storage
    await saveLocalGrocerySections([]);
    await saveLocalGroceryItems([]);

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await clearGroceryItemsAPI('all'); } catch {
        await queueChange('grocery-clear', '', { mode: 'all' });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-clear', '', { mode: 'all' });
    }

    const clearAllPayload = prevSections.map(s => ({
      name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked, store_id: i.store_id })),
    }));
    pushAction({
      type: 'clear-all-grocery',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        if (isOnline) {
          try { await replaceAndApply(clearAllPayload); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections([]);
        if (isOnline) {
          try { await clearGroceryItemsAPI('all'); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

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

    await saveLocalGrocerySections(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));

    const sectionIds = updated.map(s => s.id);
    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        await reorderGrocerySectionsAPI(sectionIds);
      } catch {
        await queueChange('grocery-reorder-sections', '', { sectionIds });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-reorder-sections', '', { sectionIds });
    }

    const prevOrder = prevSections.map(s => s.id);
    pushAction({
      type: 'reorder-grocery-sections',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        // Reorder current sections to match previous order (without restoring snapshot)
        setSections(prev => {
          const byId = new Map(prev.map(s => [s.id, s]));
          const reordered = prevOrder.filter(id => byId.has(id)).map((id, i) => ({ ...byId.get(id)!, position: i }));
          // Append any sections not in prevOrder (added by another user)
          const prevSet = new Set(prevOrder);
          const extra = prev.filter(s => !prevSet.has(s.id)).map((s, i) => ({ ...s, position: reordered.length + i }));
          return [...reordered, ...extra];
        });
        if (isOnline) {
          try { await reorderGrocerySectionsAPI(prevOrder); } catch { /* queue */ }
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
        if (isOnline) {
          try { await reorderGrocerySectionsAPI(sectionIds); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Reorder items within a section
  // When orderedIds is provided (e.g., during sort-by-store), use that order instead of from/to indices
  const reorderItems = useCallback(async (sectionId: string, fromIndex: number, toIndex: number, orderedIds?: string[]) => {
    if (fromIndex === toIndex && !orderedIds) return;
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const unchecked = section.items.filter(i => !i.checked);
    const checked = section.items.filter(i => i.checked);

    let updatedItems;
    if (orderedIds) {
      // Use the provided order — items not in orderedIds keep their relative position after
      const idOrder = new Map(orderedIds.map((id, i) => [id, i]));
      const inOrder = orderedIds.map(id => unchecked.find(i => i.id === id)!).filter(Boolean);
      const notInOrder = unchecked.filter(i => !idOrder.has(i.id));
      updatedItems = [...inOrder, ...notInOrder].map((item, i) => ({ ...item, position: i }));
    } else {
      const reordered = [...unchecked];
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      updatedItems = reordered.map((item, i) => ({ ...item, position: i }));
    }
    const allItems = [...updatedItems, ...checked.map((item, i) => ({ ...item, position: updatedItems.length + i }))];

    const updatedSections = sections.map(s => s.id === sectionId ? { ...s, items: allItems } : s);
    optimisticVersionRef.current++;
    setSections(updatedSections);

    await saveLocalGroceryItems(updatedSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
    }))));

    const itemIds = updatedItems.map(i => i.id);
    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        await reorderGroceryItemsAPI(sectionId, itemIds);
      } catch {
        await queueChange('grocery-reorder-items', '', { sectionId, itemIds });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-reorder-items', '', { sectionId, itemIds });
    }

    const prevItemOrder = unchecked.map(i => i.id);
    pushAction({
      type: 'reorder-grocery-items',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        // Reorder items in this section to previous order (without restoring full snapshot)
        setSections(prev => prev.map(s => {
          if (s.id !== sectionId) return s;
          const currentUnchecked = s.items.filter(i => !i.checked);
          const currentChecked = s.items.filter(i => i.checked);
          const byId = new Map(currentUnchecked.map(i => [i.id, i]));
          const reordered = prevItemOrder.filter(id => byId.has(id)).map((id, i) => ({ ...byId.get(id)!, position: i }));
          const prevSet = new Set(prevItemOrder);
          const extra = currentUnchecked.filter(i => !prevSet.has(i.id)).map((i, idx) => ({ ...i, position: reordered.length + idx }));
          return { ...s, items: [...reordered, ...extra, ...currentChecked.map((i, idx) => ({ ...i, position: reordered.length + extra.length + idx }))] };
        }));
        if (isOnline) {
          try { await reorderGroceryItemsAPI(sectionId, prevItemOrder); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => {
          if (s.id !== sectionId) return s;
          const currentUnchecked = s.items.filter(i => !i.checked);
          const currentChecked = s.items.filter(i => i.checked);
          const byId = new Map(currentUnchecked.map(i => [i.id, i]));
          const reordered = itemIds.filter(id => byId.has(id)).map((id, i) => ({ ...byId.get(id)!, position: i }));
          const newSet = new Set(itemIds);
          const extra = currentUnchecked.filter(i => !newSet.has(i.id)).map((i, idx) => ({ ...i, position: reordered.length + idx }));
          return { ...s, items: [...reordered, ...extra, ...currentChecked.map((i, idx) => ({ ...i, position: reordered.length + extra.length + idx }))] };
        }));
        if (isOnline) {
          try { await reorderGroceryItemsAPI(sectionId, itemIds); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Rename a section
  const renameSection = useCallback(async (sectionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const section = sections.find(s => s.id === sectionId);
    if (!section || section.name === trimmed) return;

    const updatedSections = sections.map(s => s.id === sectionId ? { ...s, name: trimmed } : s);
    optimisticVersionRef.current++;
    setSections(updatedSections);

    await saveLocalGrocerySections(updatedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        await renameGrocerySectionAPI(sectionId, trimmed);
      } catch {
        await queueChange('grocery-rename-section', '', { sectionId, name: trimmed });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-rename-section', '', { sectionId, name: trimmed });
    }

    const prevName = section.name;
    pushAction({
      type: 'rename-grocery-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId ? { ...s, name: prevName } : s));
        if (isOnline) {
          try { await renameGrocerySectionAPI(sectionId, prevName); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId ? { ...s, name: trimmed } : s));
        if (isOnline) {
          try { await renameGrocerySectionAPI(sectionId, trimmed); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Move item between sections
  const moveItem = useCallback(async (fromSectionId: string, fromIndex: number, toSectionId: string, toIndex: number) => {
    if (fromSectionId === toSectionId) return;

    const fromSection = sections.find(s => s.id === fromSectionId);
    const toSection = sections.find(s => s.id === toSectionId);
    if (!fromSection || !toSection) return;

    const unchecked = fromSection.items.filter(i => !i.checked);
    const item = unchecked[fromIndex];
    if (!item) return;

    // Optimistic local update
    const newSections = sections.map(s => {
      if (s.id === fromSectionId) {
        const items = s.items.filter(i => i.id !== item.id).map((i, idx) => ({ ...i, position: idx }));
        return { ...s, items };
      }
      if (s.id === toSectionId) {
        const targetUnchecked = s.items.filter(i => !i.checked);
        const targetChecked = s.items.filter(i => i.checked);
        const movedItem = { ...item, section_id: toSectionId };
        targetUnchecked.splice(toIndex, 0, movedItem);
        const allItems = [...targetUnchecked, ...targetChecked].map((i, idx) => ({ ...i, position: idx }));
        return { ...s, items: allItems };
      }
      return s;
    });

    pushAction({
      type: 'move-grocery-item',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        // Move back: reverse the operation locally
        setSections(prev => {
          const currentToSection = prev.find(s => s.id === toSectionId);
          const movedItem = currentToSection?.items.find(i => i.id === item.id);
          if (!movedItem) return prev;
          return prev.map(s => {
            if (s.id === toSectionId) {
              return { ...s, items: s.items.filter(i => i.id !== item.id).map((i, idx) => ({ ...i, position: idx })) };
            }
            if (s.id === fromSectionId) {
              const unc = s.items.filter(i => !i.checked);
              const chk = s.items.filter(i => i.checked);
              unc.splice(fromIndex, 0, { ...movedItem, section_id: fromSectionId });
              return { ...s, items: [...unc, ...chk].map((i, idx) => ({ ...i, position: idx })) };
            }
            return s;
          });
        });
        if (isOnline) {
          try { await moveGroceryItemAPI(item.id, fromSectionId, fromIndex); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => {
          const currentFromSection = prev.find(s => s.id === fromSectionId);
          const movedItem = currentFromSection?.items.find(i => i.id === item.id);
          if (!movedItem) return prev;
          return prev.map(s => {
            if (s.id === fromSectionId) {
              return { ...s, items: s.items.filter(i => i.id !== item.id).map((i, idx) => ({ ...i, position: idx })) };
            }
            if (s.id === toSectionId) {
              const unc = s.items.filter(i => !i.checked);
              const chk = s.items.filter(i => i.checked);
              unc.splice(toIndex, 0, { ...movedItem, section_id: toSectionId });
              return { ...s, items: [...unc, ...chk].map((i, idx) => ({ ...i, position: idx })) };
            }
            return s;
          });
        });
        if (isOnline) {
          try { await moveGroceryItemAPI(item.id, toSectionId, toIndex); } catch { /* queue */ }
        }
        settleMutation();
      },
    });

    optimisticVersionRef.current++;
    setSections(newSections);

    await saveLocalGrocerySections(newSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalGroceryItems(newSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
    }))));

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await moveGroceryItemAPI(item.id, toSectionId, toIndex); } catch {
        await queueChange('grocery-move-item', '', { id: item.id, toSectionId, toPosition: toIndex });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-move-item', '', { id: item.id, toSectionId, toPosition: toIndex });
    }
  }, [sections, isOnline, pushAction, settleMutation]);

  // Batch update store_id on multiple items (no undo push — used by store delete/undo)
  const batchUpdateStoreId = useCallback(async (itemIds: string[], storeId: string | null) => {
    if (itemIds.length === 0) return;
    optimisticVersionRef.current++;
    const idSet = new Set(itemIds);
    setSections(prev => prev.map(s => ({
      ...s,
      items: s.items.map(i => idSet.has(i.id) ? { ...i, store_id: storeId } : i),
    })));
  }, []);

  return { sections, loading, mergeList, toggleItem, addItem, deleteItem, editItem, clearChecked, clearAll, reorderSections, reorderItems, renameSection, moveItem, batchUpdateStoreId };
}
