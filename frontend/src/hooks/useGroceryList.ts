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
} from '../api/client';
import {
  saveLocalGrocerySections,
  saveLocalGroceryItems,
  getLocalGrocerySections,
  getLocalGroceryItems,
  saveLocalGroceryItem,
  deleteLocalGroceryItem,
  queueChange,
  generateTempId,
} from '../db';
import { useOnlineStatus } from './useOnlineStatus';
import { useUndo } from '../contexts/UndoContext';
import { ParsedGrocerySection } from '../utils/groceryParser';

export function useGroceryList() {
  const [sections, setSections] = useState<GrocerySection[]>([]);
  const [loading, setLoading] = useState(true);
  const isOnline = useOnlineStatus();
  const { pushAction } = useUndo();

  // Version counter: incremented on every optimistic update.
  // loadGroceryList checks this before applying fetched data to avoid
  // overwriting newer optimistic state with a stale server response.
  const optimisticVersionRef = useRef(0);
  // Tracks in-flight mutation API calls. While > 0, realtime-triggered
  // refetches are deferred to prevent stale server data from overwriting
  // optimistic state.
  const pendingMutationsRef = useRef(0);
  const deferredLoadRef = useRef(false);

  // Load grocery list
  const loadGroceryList = useCallback(async () => {
    const fetchVersion = optimisticVersionRef.current;
    try {
      if (isOnline) {
        const data = await getGroceryList();
        // If an optimistic update happened while we were fetching, discard this result
        if (optimisticVersionRef.current !== fetchVersion) return;
        setSections(data);
        // Cache locally
        await saveLocalGrocerySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
        const allItems = data.flatMap(s => s.items);
        await saveLocalGroceryItems(allItems.map(i => ({
          id: i.id,
          section_id: i.section_id,
          name: i.name,
          quantity: i.quantity,
          checked: i.checked,
          position: i.position,
          updated_at: i.updated_at,
        })));
      } else {
        // Load from local
        const localSections = await getLocalGrocerySections();
        const localItems = await getLocalGroceryItems();
        const assembled: GrocerySection[] = localSections.map(s => ({
          ...s,
          items: localItems
            .filter(i => i.section_id === s.id)
            .sort((a, b) => (a.checked === b.checked ? a.position - b.position : a.checked ? 1 : -1)),
        }));
        setSections(assembled);
      }
    } catch {
      // Fallback to local
      const localSections = await getLocalGrocerySections();
      const localItems = await getLocalGroceryItems();
      const assembled: GrocerySection[] = localSections.map(s => ({
        ...s,
        items: localItems
          .filter(i => i.section_id === s.id)
          .sort((a, b) => (a.checked === b.checked ? a.position - b.position : a.checked ? 1 : -1)),
      }));
      setSections(assembled);
    } finally {
      setLoading(false);
    }
  }, [isOnline]);

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

      if (existingIndex >= 0) {
        // Append new items to existing section
        const existing = mergedSections[existingIndex];
        const maxPos = existing.items.length > 0
          ? Math.max(...existing.items.map(i => i.position)) + 1
          : 0;
        const newItems: GroceryItem[] = parsedSection.items.map((item, ii) => ({
          id: generateTempId(),
          section_id: existing.id,
          name: item.name,
          quantity: item.quantity,
          checked: false,
          position: maxPos + ii,
          updated_at: new Date().toISOString(),
        }));
        mergedSections[existingIndex] = {
          ...existing,
          items: [...existing.items, ...newItems],
        };
      } else {
        // Create new section
        const sectionId = generateTempId();
        mergedSections.push({
          id: sectionId,
          name: parsedSection.name,
          position: mergedSections.length,
          items: parsedSection.items.map((item, ii) => ({
            id: generateTempId(),
            section_id: sectionId,
            name: item.name,
            quantity: item.quantity,
            checked: false,
            position: ii,
            updated_at: new Date().toISOString(),
          })),
        });
      }
    }

    optimisticVersionRef.current++;
    setSections(mergedSections);

    // Save locally
    await saveLocalGrocerySections(mergedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
    await saveLocalGroceryItems(mergedSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
    }))));

    // Sync — replace the full list on the server with the merged result
    const mergedPayload = mergedSections.map(s => ({
      name: s.name,
      items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked })),
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
          quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
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
          quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
        }))));
        if (isOnline) {
          try {
            const payload = prevSections.map(s => ({
              name: s.name,
              items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked })),
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
    const prevSections = sections;

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => ({
      ...s,
      items: s.items.map(i => i.id === itemId ? { ...i, checked } : i)
        .sort((a, b) => (a.checked === b.checked ? a.position - b.position : a.checked ? 1 : -1)),
    })));

    // Update local
    const allItems = sections.flatMap(s => s.items);
    const item = allItems.find(i => i.id === itemId);
    if (item) {
      await saveLocalGroceryItem({
        id: item.id, section_id: item.section_id, name: item.name,
        quantity: item.quantity, checked, position: item.position, updated_at: new Date().toISOString(),
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
        setSections(prevSections);
        if (item) {
          await saveLocalGroceryItem({
            id: item.id, section_id: item.section_id, name: item.name,
            quantity: item.quantity, checked: !checked, position: item.position, updated_at: new Date().toISOString(),
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
          items: s.items.map(i => i.id === itemId ? { ...i, checked } : i)
            .sort((a, b) => (a.checked === b.checked ? a.position - b.position : a.checked ? 1 : -1)),
        })));
        if (item) {
          await saveLocalGroceryItem({
            id: item.id, section_id: item.section_id, name: item.name,
            quantity: item.quantity, checked, position: item.position, updated_at: new Date().toISOString(),
          });
        }
        if (isOnline) {
          try { await toggleGroceryItemAPI(itemId, checked); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Add item to a section
  const addItem = useCallback(async (sectionId: string, name: string, quantity: string | null = null) => {
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const tempId = generateTempId();
    const maxPos = section.items.length > 0 ? Math.max(...section.items.map(i => i.position)) + 1 : 0;
    const newItem: GroceryItem = {
      id: tempId,
      section_id: sectionId,
      name: name.trim(),
      quantity,
      checked: false,
      position: maxPos,
      updated_at: new Date().toISOString(),
    };

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => s.id === sectionId
      ? { ...s, items: [...s.items.filter(i => !i.checked), newItem, ...s.items.filter(i => i.checked)] }
      : s
    ));

    await saveLocalGroceryItem({
      id: newItem.id, section_id: newItem.section_id, name: newItem.name,
      quantity: newItem.quantity, checked: false, position: newItem.position, updated_at: newItem.updated_at,
    });

    if (isOnline) {
      pendingMutationsRef.current++;
      try {
        await addGroceryItemAPI(sectionId, name.trim(), quantity);
      } catch {
        await queueChange('grocery-add', '', { id: tempId, sectionId, name: name.trim(), quantity });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-add', '', { id: tempId, sectionId, name: name.trim(), quantity });
    }

    pushAction({
      type: 'add-grocery-item',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => s.id === sectionId
          ? { ...s, items: s.items.filter(i => i.id !== tempId) }
          : s
        ));
        await deleteLocalGroceryItem(tempId);
        if (isOnline) {
          try { await deleteGroceryItemAPI(tempId); } catch { /* queue */ }
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
          quantity: newItem.quantity, checked: false, position: newItem.position, updated_at: newItem.updated_at,
        });
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Delete an item — follows the meal planner pattern:
  // capture full before/after state, push undo before API call,
  // undo/redo both use replaceGroceryListAPI for full state replacement.
  const deleteItem = useCallback(async (itemId: string) => {
    const item = sections.flatMap(s => s.items).find(i => i.id === itemId);
    if (!item) return;

    const prevSections = sections;
    const newSections = sections.map(s => ({
      ...s,
      items: s.items.filter(i => i.id !== itemId),
    }));
    const toPayload = (secs: GrocerySection[]) => secs.map(s => ({
      name: s.name,
      items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked })),
    }));

    // Push undo action BEFORE API call so undo is available immediately
    pushAction({
      type: 'delete-grocery-item',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalGrocerySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        await saveLocalGroceryItems(prevSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
        }))));
        if (isOnline) {
          try { await replaceGroceryListAPI(toPayload(prevSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(newSections);
        await saveLocalGrocerySections(newSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        await saveLocalGroceryItems(newSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
        }))));
        if (isOnline) {
          try { await replaceGroceryListAPI(toPayload(newSections)); } catch { /* queue */ }
        }
        settleMutation();
      },
    });

    // Optimistic update
    optimisticVersionRef.current++;
    setSections(newSections);

    await deleteLocalGroceryItem(itemId);

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await deleteGroceryItemAPI(itemId); } catch {
        await queueChange('grocery-delete', '', { id: itemId });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-delete', '', { id: itemId });
    }
  }, [sections, isOnline, pushAction]);

  // Edit an item's name or quantity
  const editItem = useCallback(async (itemId: string, updates: { name?: string; quantity?: string | null }) => {
    const allItems = sections.flatMap(s => s.items);
    const item = allItems.find(i => i.id === itemId);
    if (!item) return;

    const prevName = item.name;
    const prevQuantity = item.quantity;

    optimisticVersionRef.current++;
    setSections(prev => prev.map(s => ({
      ...s,
      items: s.items.map(i => i.id === itemId ? {
        ...i,
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.quantity !== undefined ? { quantity: updates.quantity } : {}),
      } : i),
    })));

    // Update local
    await saveLocalGroceryItem({
      id: item.id, section_id: item.section_id,
      name: updates.name ?? item.name,
      quantity: updates.quantity !== undefined ? updates.quantity : item.quantity,
      checked: item.checked, position: item.position,
      updated_at: new Date().toISOString(),
    });

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await editGroceryItemAPI(itemId, updates); } catch {
        await queueChange('grocery-edit', '', { id: itemId, ...updates });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-edit', '', { id: itemId, ...updates });
    }

    pushAction({
      type: 'edit-grocery-item',
      undo: async () => {
        const undoUpdates: { name?: string; quantity?: string | null } = {};
        if (updates.name !== undefined) undoUpdates.name = prevName;
        if (updates.quantity !== undefined) undoUpdates.quantity = prevQuantity;

        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.map(i => i.id === itemId ? { ...i, ...undoUpdates } : i),
        })));
        await saveLocalGroceryItem({
          id: item.id, section_id: item.section_id,
          name: undoUpdates.name ?? item.name,
          quantity: undoUpdates.quantity !== undefined ? undoUpdates.quantity : item.quantity,
          checked: item.checked, position: item.position,
          updated_at: new Date().toISOString(),
        });
        if (isOnline) {
          try { await editGroceryItemAPI(itemId, undoUpdates); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prev => prev.map(s => ({
          ...s,
          items: s.items.map(i => i.id === itemId ? {
            ...i,
            ...(updates.name !== undefined ? { name: updates.name } : {}),
            ...(updates.quantity !== undefined ? { quantity: updates.quantity } : {}),
          } : i),
        })));
        await saveLocalGroceryItem({
          id: item.id, section_id: item.section_id,
          name: updates.name ?? item.name,
          quantity: updates.quantity !== undefined ? updates.quantity : item.quantity,
          checked: item.checked, position: item.position,
          updated_at: new Date().toISOString(),
        });
        if (isOnline) {
          try { await editGroceryItemAPI(itemId, updates); } catch { /* queue */ }
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
      quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
    }))));

    if (isOnline) {
      pendingMutationsRef.current++;
      try { await clearGroceryItemsAPI('checked'); } catch {
        await queueChange('grocery-clear', '', { mode: 'checked' });
      } finally { settleMutation(); }
    } else {
      await queueChange('grocery-clear', '', { mode: 'checked' });
    }

    pushAction({
      type: 'clear-checked-grocery',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalGrocerySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        await saveLocalGroceryItems(prevSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
        }))));
        if (isOnline) {
          try {
            await replaceGroceryListAPI(prevSections.map(s => ({
              name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked })),
            })));
          } catch { /* queue */ }
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

    pushAction({
      type: 'clear-all-grocery',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalGrocerySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        await saveLocalGroceryItems(prevSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
        }))));
        if (isOnline) {
          try {
            await replaceGroceryListAPI(prevSections.map(s => ({
              name: s.name, items: s.items.map(i => ({ name: i.name, quantity: i.quantity, checked: i.checked })),
            })));
          } catch { /* queue */ }
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

    pushAction({
      type: 'reorder-grocery-sections',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalGrocerySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        const prevIds = prevSections.map(s => s.id);
        if (isOnline) {
          try { await reorderGrocerySectionsAPI(prevIds); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(updated);
        await saveLocalGrocerySections(updated.map(s => ({ id: s.id, name: s.name, position: s.position })));
        if (isOnline) {
          try { await reorderGrocerySectionsAPI(sectionIds); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  // Reorder items within a section
  const reorderItems = useCallback(async (sectionId: string, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const prevSections = sections;
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const unchecked = section.items.filter(i => !i.checked);
    const checked = section.items.filter(i => i.checked);

    const reordered = [...unchecked];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    const updatedItems = reordered.map((item, i) => ({ ...item, position: i }));
    const allItems = [...updatedItems, ...checked.map((item, i) => ({ ...item, position: updatedItems.length + i }))];

    const updatedSections = sections.map(s => s.id === sectionId ? { ...s, items: allItems } : s);
    optimisticVersionRef.current++;
    setSections(updatedSections);

    await saveLocalGroceryItems(updatedSections.flatMap(s => s.items.map(i => ({
      id: i.id, section_id: i.section_id, name: i.name,
      quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
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

    pushAction({
      type: 'reorder-grocery-items',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalGroceryItems(prevSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
        }))));
        const prevUnchecked = prevSections.find(s => s.id === sectionId)?.items.filter(i => !i.checked) ?? [];
        if (isOnline) {
          try { await reorderGroceryItemsAPI(sectionId, prevUnchecked.map(i => i.id)); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(updatedSections);
        await saveLocalGroceryItems(updatedSections.flatMap(s => s.items.map(i => ({
          id: i.id, section_id: i.section_id, name: i.name,
          quantity: i.quantity, checked: i.checked, position: i.position, updated_at: i.updated_at,
        }))));
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
    const prevSections = sections;
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

    pushAction({
      type: 'rename-grocery-section',
      undo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(prevSections);
        await saveLocalGrocerySections(prevSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        if (isOnline) {
          try { await renameGrocerySectionAPI(sectionId, section.name); } catch { /* queue */ }
        }
        settleMutation();
      },
      redo: async () => {
        optimisticVersionRef.current++;
        pendingMutationsRef.current++;
        setSections(updatedSections);
        await saveLocalGrocerySections(updatedSections.map(s => ({ id: s.id, name: s.name, position: s.position })));
        if (isOnline) {
          try { await renameGrocerySectionAPI(sectionId, trimmed); } catch { /* queue */ }
        }
        settleMutation();
      },
    });
  }, [sections, isOnline, pushAction]);

  return { sections, loading, mergeList, toggleItem, addItem, deleteItem, editItem, clearChecked, clearAll, reorderSections, reorderItems, renameSection };
}
