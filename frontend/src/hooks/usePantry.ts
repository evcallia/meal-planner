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
} from '../db';
import { useOnlineStatus } from './useOnlineStatus';
import { useUndo } from '../contexts/UndoContext';
import { toTitleCase } from '../utils/titleCase';

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

export function usePantry() {
  const [sections, setSections] = useState<PantrySection[]>([]);
  const [loading, setLoading] = useState(true);
  const isOnline = useOnlineStatus();
  const { pushAction } = useUndo();

  const optimisticVersionRef = useRef(0);
  const pendingMutationsRef = useRef(0);
  const deferredLoadRef = useRef(false);

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

  const loadPantryList = useCallback(async () => {
    const fetchVersion = optimisticVersionRef.current;
    try {
      if (isOnline) {
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
      } else {
        setSections(await loadFromLocal());
      }
    } catch {
      setSections(await loadFromLocal());
    } finally {
      setLoading(false);
    }
  }, [isOnline]);

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

  useEffect(() => {
    loadPantryList();
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
        loadPantryList();
      }
    };
    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
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
        const created = await addPantryItemAPI(sectionId, toTitleCase(name.trim()), quantity);
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
        await queueChange('pantry-add', '', { id: tempId, sectionId, name: toTitleCase(name.trim()), quantity });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-add', '', { id: tempId, sectionId, name: toTitleCase(name.trim()), quantity });
    }

    pushAction({
      type: 'add-pantry-item',
      undo: async () => {
        const currentId = newItem.id;
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId
          ? { ...s, items: s.items.filter(i => i.id !== currentId) }
          : s
        ));
        await deleteLocalPantryItem(currentId);
        if (isOnline) {
          try { await deletePantryItemAPI(currentId); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId
          ? { ...s, items: [...s.items, newItem] }
          : s
        ));
        await saveLocalPantryItem({
          id: newItem.id, section_id: newItem.section_id, name: newItem.name,
          quantity: newItem.quantity, position: newItem.position, updated_at: newItem.updated_at,
        });
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

      if (isOnline) {
        pendingMutationsRef.current++;
        try {
          await updatePantryItemAPI(id, {
            name: payload.name,
            quantity: payload.quantity !== undefined ? Math.max(0, Math.round(payload.quantity)) : undefined,
          });
        } catch {
          await queueChange('pantry-update', '', { id, ...payload });
        } finally { settleMutation(); }
      } else {
        await queueChange('pantry-update', '', { id, ...payload });
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
        updateItem(id, { quantity: prevQty });
      },
      redo: async () => {
        updateItem(id, { quantity: nextQty });
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

    pushAction({
      type: 'delete-pantry-item',
      undo: async () => {
        // Re-add the specific item via POST (not PUT) — doesn't affect other users' items
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        const tempId = generateTempId();
        const restoredItem: PantryItem = { ...deletedItem, id: tempId };
        setSections(prev => prev.map(s => s.id === deletedItem.section_id
          ? { ...s, items: [...s.items, restoredItem] }
          : s
        ));
        if (isOnline) {
          try {
            const created = await addPantryItemAPI(deletedItem.section_id, deletedItem.name, deletedItem.quantity);
            optimisticVersionRef.current++;
            setSections(prev => prev.map(s => s.id === deletedItem.section_id
              ? { ...s, items: s.items.map(i => i.id === tempId ? { ...i, id: created.id } : i) }
              : s
            ));
            deletedItemRef.id = created.id;
            await deleteLocalPantryItem(tempId);
          } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        const currentId = deletedItemRef.id;
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.filter(i => i.id !== currentId),
        })));
        await deleteLocalPantryItem(currentId);
        if (isOnline) {
          try { await deletePantryItemAPI(currentId); } catch { /* queue */ }
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
      try { await deletePantryItemAPI(itemId); } catch {
        await queueChange('pantry-delete', '', { id: itemId });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-delete', '', { id: itemId });
    }
  }, [sections, isOnline, pushAction, settleMutation]);

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
          try { await clearPantryItemsAPI('all'); } catch { /* queue */ }
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
        await reorderPantrySectionsAPI(sectionIds);
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
        if (isOnline) {
          try { await reorderPantrySectionsAPI(prevOrder); } catch { /* queue */ }
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
          try { await reorderPantrySectionsAPI(sectionIds); } catch { /* queue */ }
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
        await reorderPantryItemsAPI(sectionId, itemIds);
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
        if (isOnline) {
          try { await reorderPantryItemsAPI(sectionId, prevItemOrder); } catch { /* queue */ }
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
        if (isOnline) {
          try { await reorderPantryItemsAPI(sectionId, itemIds); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction, settleMutation]);

  // Add a new empty section
  const addSection = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

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
        setSections(prev => prev.map(s => s.id === tempId ? { ...created, items: [] } : s));
        await saveLocalPantrySections((await getLocalPantrySections()).map(s => s.id === tempId ? { id: created.id, name: created.name, position: created.position } : s));
      } catch {
        sectionRef.id = tempId;
        await queueChange('pantry-replace', '', { sections: [...sections, newSection].map(s => ({ name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity })) })) });
      } finally { settleMutation(); }
    } else {
      sectionRef.id = tempId;
      await queueChange('pantry-replace', '', { sections: [...sections, newSection].map(s => ({ name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity })) })) });
    }

    pushAction({
      type: 'add-pantry-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.filter(s => s.id !== sectionRef.id));
        if (isOnline) {
          try { await deletePantrySectionAPI(sectionRef.id); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        if (isOnline) {
          try {
            const created = await createPantrySectionAPI(trimmed);
            sectionRef.id = created.id;
            setSections(prev => [...prev, { ...created, items: [] }]);
          } catch { /* queue */ }
        } else {
          const redoId = generateTempId();
          sectionRef.id = redoId;
          setSections(prev => [...prev, { id: redoId, name: trimmed, position: prev.length, items: [] }]);
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
    const sectionRef = { id: sectionId };

    pushAction({
      type: 'delete-pantry-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        if (isOnline) {
          try {
            const created = await createPantrySectionAPI(deletedSection.name);
            sectionRef.id = created.id;
            const restoredItems: PantryItem[] = [];
            for (const item of deletedSection.items) {
              const createdItem = await addPantryItemAPI(created.id, item.name, item.quantity);
              restoredItems.push(createdItem);
            }
            optimisticVersionRef.current++;
            setSections(prev => [...prev, { ...created, items: restoredItems }]);
          } catch { /* queue */ }
        } else {
          setSections(prev => [...prev, deletedSection]);
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.filter(s => s.id !== sectionRef.id));
        if (isOnline) {
          try { await deletePantrySectionAPI(sectionRef.id); } catch { /* queue */ }
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
      try { await deletePantrySectionAPI(sectionId); } catch {
        await queueChange('pantry-replace', '', { sections: sections.filter(s => s.id !== sectionId).map(s => ({ name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity })) })) });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-replace', '', { sections: sections.filter(s => s.id !== sectionId).map(s => ({ name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity })) })) });
    }
  }, [sections, isOnline, pushAction, settleMutation]);

  // Rename a section
  const renameSection = useCallback(async (sectionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const section = sections.find(s => s.id === sectionId);
    if (!section || section.name === trimmed) return;

    const updatedSections = sections.map(s => s.id === sectionId ? { ...s, name: trimmed } : s);
    optimisticVersionRef.current++;
    setSections(updatedSections);

    await saveLocalPantrySections(updatedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        await renamePantrySectionAPI(sectionId, trimmed);
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
        if (isOnline) {
          try { await renamePantrySectionAPI(sectionId, prevName); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId ? { ...s, name: trimmed } : s));
        if (isOnline) {
          try { await renamePantrySectionAPI(sectionId, trimmed); } catch { /* queue */ }
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
              const items = [...s.items];
              items.splice(fromIndex, 0, { ...movedItem, section_id: fromSectionId });
              return { ...s, items: items.map((i, idx) => ({ ...i, position: idx })) };
            }
            return s;
          });
        });
        if (isOnline) {
          try { await movePantryItemAPI(item.id, fromSectionId, fromIndex); } catch { /* queue */ }
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
              const items = [...s.items];
              items.splice(toIndex, 0, { ...movedItem, section_id: toSectionId });
              return { ...s, items: items.map((i, idx) => ({ ...i, position: idx })) };
            }
            return s;
          });
        });
        if (isOnline) {
          try { await movePantryItemAPI(item.id, toSectionId, toIndex); } catch { /* queue */ }
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
      try { await movePantryItemAPI(item.id, toSectionId, toIndex); } catch {
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
