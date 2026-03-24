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
        await addPantryItemAPI(sectionId, toTitleCase(name.trim()), quantity);
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

    const prevSections = sections;
    const newSections = sections.map(s => ({
      ...s,
      items: s.items.filter(i => i.id !== itemId),
    }));
    const toPayload = (secs: PantrySection[]) => secs.map(s => ({
      name: s.name,
      items: s.items.map(i => ({ name: i.name, quantity: i.quantity })),
    }));

    pushAction({
      type: 'delete-pantry-item',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        if (isOnline) {
          try { await replaceAndApply(toPayload(prevSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(newSections);
        if (isOnline) {
          try { await replaceAndApply(toPayload(newSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
    });

    optimisticVersionRef.current++;
    setSections(newSections);

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

    pushAction({
      type: 'reorder-pantry-sections',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalPantrySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        const prevIds = prevSections.map(s => s.id);
        if (isOnline) {
          try { await reorderPantrySectionsAPI(prevIds); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(updated);
        await saveLocalPantrySections(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
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
    const prevSections = sections;
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

    pushAction({
      type: 'reorder-pantry-items',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalPantryItems(prevSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, position: i.position, updated_at: i.updated_at,
        }))));
        const prevItems = prevSections.find(s => s.id === sectionId)?.items ?? [];
        if (isOnline) {
          try { await reorderPantryItemsAPI(sectionId, prevItems.map(i => i.id)); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(updatedSections);
        await saveLocalPantryItems(updatedSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, position: i.position, updated_at: i.updated_at,
        }))));
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

    const tempId = generateTempId();
    const newSection: PantrySection = {
      id: tempId,
      name: trimmed,
      position: sections.length,
      items: [],
    };

    const prevSections = sections;
    const updatedSections = [...sections, newSection];
    optimisticVersionRef.current++;
    setSections(updatedSections);

    const toPayload = (secs: PantrySection[]) => secs.map(s => ({
      name: s.name,
      items: s.items.map(i => ({ name: i.name, quantity: i.quantity })),
    }));

    await saveLocalPantrySections(updatedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        await replacePantryListAPI(toPayload(updatedSections));
      } catch {
        await queueChange('pantry-replace', '', { sections: toPayload(updatedSections) });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-replace', '', { sections: toPayload(updatedSections) });
    }

    pushAction({
      type: 'add-pantry-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        if (isOnline) {
          try { await replaceAndApply(toPayload(prevSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(updatedSections);
        if (isOnline) {
          try { await replaceAndApply(toPayload(updatedSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction, settleMutation]);

  // Delete a section
  const deleteSection = useCallback(async (sectionId: string) => {
    const prevSections = sections;
    const updatedSections = sections.filter(s => s.id !== sectionId).map((s, i) => ({ ...s, position: i }));

    const toPayload = (secs: PantrySection[]) => secs.map(s => ({
      name: s.name,
      items: s.items.map(i => ({ name: i.name, quantity: i.quantity })),
    }));

    pushAction({
      type: 'delete-pantry-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        if (isOnline) {
          try { await replaceAndApply(toPayload(prevSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(updatedSections);
        if (isOnline) {
          try { await replaceAndApply(toPayload(updatedSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
    });

    optimisticVersionRef.current++;
    setSections(updatedSections);

    await saveLocalPantrySections(updatedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalPantryItems(updatedSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, position: i.position, updated_at: i.updated_at,
    }))));

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        await replacePantryListAPI(toPayload(updatedSections));
      } catch {
        await queueChange('pantry-replace', '', { sections: toPayload(updatedSections) });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-replace', '', { sections: toPayload(updatedSections) });
    }
  }, [sections, isOnline, pushAction, settleMutation]);

  // Rename a section
  const renameSection = useCallback(async (sectionId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const prevSections = sections;
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

    pushAction({
      type: 'rename-pantry-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalPantrySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        if (isOnline) {
          try { await renamePantrySectionAPI(sectionId, section.name); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(updatedSections);
        await saveLocalPantrySections(updatedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
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

    const prevSections = sections;
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

    const toPayload = (secs: PantrySection[]) => secs.map(s => ({
      name: s.name,
      items: s.items.map(i => ({ name: i.name, quantity: i.quantity })),
    }));

    pushAction({
      type: 'move-pantry-item',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        if (isOnline) {
          try { await replaceAndApply(toPayload(prevSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(newSections);
        if (isOnline) {
          try { await replaceAndApply(toPayload(newSections)); } catch { /* queue */ }
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
      try { await replacePantryListAPI(toPayload(newSections)); } catch {
        await queueChange('pantry-replace', '', { sections: toPayload(newSections) });
      } finally { settleMutation(); }
    } else {
      await queueChange('pantry-replace', '', { sections: toPayload(newSections) });
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
