import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useGroceryList } from '../hooks/useGroceryList';
import { useStores } from '../hooks/useStores';
import { parseGroceryText } from '../utils/groceryParser';
import { GrocerySection } from '../types';
import { useDragReorder, computeShiftTransform } from '../hooks/useDragReorder';
import { StoreAutocomplete } from './StoreAutocomplete';
import { StoreFilterBar } from './StoreFilterBar';
import { ItemAutocomplete } from './ItemAutocomplete';
import {
  ChecklistItemRow,
  ChecklistSectionCard,
  MenuRadioOption,
  NONE_STORE_ID,
} from './ChecklistParts';
import { getEditHighlight } from '../utils/editHighlightColors';
import { toTitleCase } from '../utils/titleCase';
import { parseServerDate } from '../utils/serverDate';

// Re-exported for the store chips + existing importers; the constant itself
// lives with the shared checklist parts.
export { NONE_STORE_ID };

interface GroceryListViewProps {
  compactView?: boolean;
  editHighlightColor?: string;
  // Store chip filter — lives in synced user settings (App owns the single
  // useSettings instance) so it survives restarts and follows the user.
  selectedStores?: string[];
  excludedStores?: string[];
  onStoreFilterChange?: (updates: { selected?: string[]; excluded?: string[] }) => void;
  // Display preferences (synced user settings). See useSettings.
  groupBy?: 'category' | 'none';
  hideStores?: boolean;
  sortBy?: 'manual' | 'alphabetical';
  onUpdateDisplayPrefs?: (updates: { groupBy?: 'category' | 'none'; hideStores?: boolean; sortBy?: 'manual' | 'alphabetical' }) => void;
}

const EMPTY_FILTER: string[] = [];

export function GroceryListView({
  compactView: _compactView,
  editHighlightColor = 'emerald',
  selectedStores = EMPTY_FILTER,
  excludedStores = EMPTY_FILTER,
  onStoreFilterChange,
  groupBy = 'category',
  hideStores = false,
  sortBy = 'manual',
  onUpdateDisplayPrefs,
}: GroceryListViewProps) {
  const { sections, loading, mergeList, toggleItem, addItem, deleteItem, editItem, clearChecked, clearAll, reorderSections, reorderItems, reorderItemsGlobal, renameSection, deleteSection, createSection, moveItem, batchUpdateStoreId, itemDefaultsMap, removeItemDefault } = useGroceryList();
  const { stores, createStore, renameStore, removeStore, reorderStores } = useStores({
    grocerySections: sections,
    onItemsStoreChanged: batchUpdateStoreId,
  });

  const currentListItemNames = useMemo(() => {
    const names = new Set<string>();
    for (const section of sections) {
      for (const item of section.items) {
        names.add(item.name.toLowerCase());
      }
    }
    return names;
  }, [sections]);

  const [addMode, setAddMode] = useState<'closed' | 'quick' | 'paste'>('closed');
  const [toolbarExpanded, setToolbarExpanded] = useState(() => {
    try { return localStorage.getItem('meal-planner-toolbar-expanded') !== 'false'; } catch { return true; }
  });
  const [quickAddSection, setQuickAddSection] = useState('');
  const [quickAddQuantity, setQuickAddQuantity] = useState(0);
  const [quickAddItemName, setQuickAddItemName] = useState('');
  const [quickAddStoreId, setQuickAddStoreId] = useState<string | null>(null);
  const [showSectionDropdown, setShowSectionDropdown] = useState(false);
  const [inputText, setInputText] = useState('');
  const [addingToSection, setAddingToSection] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const commitEditingRef = useRef<(() => void) | null>(null);
  const handleEditingItemChange = useCallback((id: string | null) => {
    // If switching to a new item, commit the current edit first
    if (id !== null && editingItemId !== null && id !== editingItemId) {
      commitEditingRef.current?.();
    }
    setEditingItemId(id);
  }, [editingItemId]);
  const [newItemName, setNewItemName] = useState('');
  const [showClearMenu, setShowClearMenu] = useState(false);
  const selectedStoreIds = useMemo(() => new Set(selectedStores), [selectedStores]);
  const excludedStoreIds = useMemo(() => new Set(excludedStores), [excludedStores]);
  // When stores are hidden there is no chip UI to reveal or change the filter,
  // so it must not silently filter the list — treat it as empty for all
  // display decisions. The saved filter is preserved and returns when stores
  // are shown again.
  const activeSelectedStoreIds = useMemo(
    () => (hideStores ? new Set<string>() : selectedStoreIds), [hideStores, selectedStoreIds]);
  const activeExcludedStoreIds = useMemo(
    () => (hideStores ? new Set<string>() : excludedStoreIds), [hideStores, excludedStoreIds]);
  const onStoreFilterChangeRef = useRef(onStoreFilterChange);
  onStoreFilterChangeRef.current = onStoreFilterChange;

  // One-time migration: the filter used to live in localStorage — seed the
  // synced setting from any leftover value, then drop the legacy keys.
  useEffect(() => {
    try {
      const legacySelected = localStorage.getItem('meal-planner-selected-stores');
      const legacyExcluded = localStorage.getItem('meal-planner-excluded-stores');
      if (legacySelected === null && legacyExcluded === null) return;
      localStorage.removeItem('meal-planner-selected-stores');
      localStorage.removeItem('meal-planner-excluded-stores');
      const selected: string[] = legacySelected ? JSON.parse(legacySelected) : [];
      const excluded: string[] = legacyExcluded ? JSON.parse(legacyExcluded) : [];
      if ((selected.length > 0 || excluded.length > 0)
        && selectedStoreIds.size === 0 && excludedStoreIds.size === 0) {
        onStoreFilterChangeRef.current?.({ selected, excluded });
      }
    } catch { /* corrupt legacy value — start clean */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showAllStores, setShowAllStores] = useState<boolean>(() => {
    try {
      return localStorage.getItem('meal-planner-show-all-stores') === 'true';
    } catch { return false; }
  });
  const [sortByStore, setSortByStore] = useState(false);
  const [isSectionDragging, setIsSectionDragging] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('meal-planner-grocery-collapsed');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const clearMenuRef = useRef<HTMLDivElement>(null);
  const sectionContainerRef = useRef<HTMLDivElement>(null);
  const sectionDropdownRef = useRef<HTMLDivElement>(null);
  const quickAddItemRef = useRef<HTMLInputElement>(null);

  const storeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const section of sections) {
      for (const item of section.items) {
        if (!item.checked && item.store_id) {
          counts.set(item.store_id, (counts.get(item.store_id) ?? 0) + 1);
        } else if (!item.checked && !item.store_id) {
          counts.set(NONE_STORE_ID, (counts.get(NONE_STORE_ID) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [sections]);

  const filteredSections = useMemo(() => {
    const all = sections
      .map(s => ({ name: s.name, id: s.id, isEmpty: s.items.length === 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!quickAddSection.trim()) return all;
    const lower = quickAddSection.toLowerCase();
    return all.filter(s => s.name.toLowerCase().includes(lower));
  }, [sections, quickAddSection]);

  // Auto-deselect stores that no longer have unchecked items. Gated on
  // `loading`: before the list loads every count is 0, and running then wiped
  // the saved filter on every cold start (the "filter doesn't persist" bug).
  useEffect(() => {
    if (loading || selectedStoreIds.size === 0) return;
    const next = [...selectedStoreIds].filter(id => (storeCounts.get(id) ?? 0) > 0);
    if (next.length !== selectedStoreIds.size) {
      onStoreFilterChangeRef.current?.({ selected: next });
    }
  }, [loading, storeCounts, selectedStoreIds]);

  const handleToggleSelect = useCallback((storeId: string) => {
    const next = new Set(selectedStoreIds);
    if (next.has(storeId)) {
      next.delete(storeId);
    } else {
      next.add(storeId);
    }
    onStoreFilterChangeRef.current?.({ selected: [...next] });
  }, [selectedStoreIds]);

  const handleExclude = useCallback((storeId: string) => {
    const updates: { selected?: string[]; excluded?: string[] } = {
      excluded: [...new Set(excludedStoreIds).add(storeId)],
    };
    if (selectedStoreIds.has(storeId)) {
      updates.selected = [...selectedStoreIds].filter(id => id !== storeId);
    }
    onStoreFilterChangeRef.current?.(updates);
  }, [selectedStoreIds, excludedStoreIds]);

  const handleRemoveExclusion = useCallback((storeId: string) => {
    onStoreFilterChangeRef.current?.({
      excluded: [...excludedStoreIds].filter(id => id !== storeId),
    });
  }, [excludedStoreIds]);

  const handleToggleShowAllStores = useCallback(() => {
    setShowAllStores(prev => {
      const next = !prev;
      try { localStorage.setItem('meal-planner-show-all-stores', String(next)); } catch {}
      return next;
    });
  }, []);

  const visibleStores = useMemo(() => {
    if (showAllStores) return stores;
    return stores.filter(s =>
      (storeCounts.get(s.id) ?? 0) > 0 || excludedStoreIds.has(s.id)
    );
  }, [stores, storeCounts, excludedStoreIds, showAllStores]);

  const visibleSections = useMemo(() => {
    let filtered = sections.filter(s => s.items.some(i => !i.checked));

    // 1. Remove excluded stores' items
    if (activeExcludedStoreIds.size > 0) {
      filtered = filtered
        .map(s => ({
          ...s,
          items: s.items.filter(i => {
            if (!i.store_id) return !activeExcludedStoreIds.has(NONE_STORE_ID);
            return !activeExcludedStoreIds.has(i.store_id);
          }),
        }))
        .filter(s => s.items.some(i => !i.checked));
    }

    // 2. If any stores are selected, show only those
    if (activeSelectedStoreIds.size > 0) {
      filtered = filtered
        .map(s => ({
          ...s,
          items: s.items.filter(i => !i.checked && (activeSelectedStoreIds.has(NONE_STORE_ID)
            ? !i.store_id || activeSelectedStoreIds.has(i.store_id!)
            : i.store_id && activeSelectedStoreIds.has(i.store_id))),
        }))
        .filter(s => s.items.length > 0);
    }

    const effectiveSortByStore = sortByStore && !hideStores;
    if (sortBy === 'alphabetical' || effectiveSortByStore) {
      const storeOrder = new Map(stores.map(s => [s.id, s.position]));
      filtered = filtered.map(s => ({
        ...s,
        items: [...s.items].sort((a, b) => {
          if (sortBy === 'alphabetical') return a.name.localeCompare(b.name);
          const aPos = a.store_id ? (storeOrder.get(a.store_id) ?? Infinity) : Infinity;
          const bPos = b.store_id ? (storeOrder.get(b.store_id) ?? Infinity) : Infinity;
          if (aPos !== bPos) return aPos - bPos;
          return a.position - b.position;
        }),
      }));
    }
    return filtered;
  }, [sections, activeSelectedStoreIds, activeExcludedStoreIds, sortByStore, stores, sortBy, hideStores]);

  // "Group by: none" — one flat list of every unchecked item across the
  // (already filtered/sorted) visible sections. Items keep their section
  // membership in the data; this is purely a view. Alphabetical re-sorts the
  // whole list globally.
  const flatItems = useMemo(() => {
    const rows: { item: GrocerySection['items'][number]; sectionName: string }[] = [];
    for (const s of visibleSections) {
      for (const item of s.items) {
        if (item.checked) continue;
        rows.push({ item, sectionName: s.name });
      }
    }
    if (sortBy === 'alphabetical') {
      rows.sort((a, b) => a.item.name.localeCompare(b.item.name));
    } else {
      // Manual: follow the cross-section global order.
      rows.sort((a, b) => (a.item.global_position ?? 0) - (b.item.global_position ?? 0));
    }
    return rows;
  }, [visibleSections, sortBy]);

  // Manual drag reorder only makes sense with the natural (manual) item order.
  const itemDragEnabled = sortBy === 'manual';
  // Flat-view (group by: none) manual drag reorders the global order.
  const flatDragEnabled = groupBy === 'none' && sortBy === 'manual';

  const flatContainerRef = useRef<HTMLDivElement>(null);
  const handleFlatReorder = useCallback((from: number, to: number) => {
    const ids = flatItems.map(r => r.item.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    reorderItemsGlobal(ids);
  }, [flatItems, reorderItemsGlobal]);

  const { dragState: flatDragState, getDragHandlers: getFlatDragHandlers, getHandleMouseDown: getFlatHandleMouseDown } = useDragReorder({
    itemCount: flatItems.length,
    onReorder: handleFlatReorder,
    containerRef: flatContainerRef,
  });

  const handleSectionReorder = useCallback((from: number, to: number) => {
    const fromSection = visibleSections[from];
    const toSection = visibleSections[to];
    const fromFull = sections.findIndex(s => s.id === fromSection.id);
    const toFull = sections.findIndex(s => s.id === toSection.id);
    reorderSections(fromFull, toFull);
  }, [visibleSections, sections, reorderSections]);

  const handleSectionDragStart = useCallback(() => {
    setIsSectionDragging(true);
  }, []);

  const handleSectionDragEnd = useCallback(() => {
    setIsSectionDragging(false);
  }, []);

  const { dragState: sectionDragState, getDragHandlers: getSectionDragHandlers, getHandleMouseDown: getSectionHandleMouseDown } = useDragReorder({
    itemCount: visibleSections.length,
    onReorder: handleSectionReorder,
    containerRef: sectionContainerRef,
    onDragStart: handleSectionDragStart,
    onDragEnd: handleSectionDragEnd,
  });

  const [crossDrag, setCrossDrag] = useState<{
    sourceSectionId: string;
    targetSectionId: string;
    targetIndex: number;
    itemHeight: number;
  } | null>(null);

  const findDropTarget = useCallback((sourceSectionId: string, clientY: number) => {
    if (!sectionContainerRef.current) return null;
    const sectionEls = sectionContainerRef.current.querySelectorAll('[data-section-id]');
    for (const el of sectionEls) {
      const sectionId = (el as HTMLElement).dataset.sectionId;
      if (!sectionId || sectionId === sourceSectionId) continue;
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        const itemContainer = el.querySelector('[data-item-container]');
        let targetIndex = 0;
        let itemHeight = 36;
        if (itemContainer) {
          const itemEls = itemContainer.querySelectorAll(':scope > [data-drag-index]');
          targetIndex = itemEls.length;
          for (let i = 0; i < itemEls.length; i++) {
            const itemRect = itemEls[i].getBoundingClientRect();
            if (itemRect.height > 0) {
              itemHeight = itemRect.height;
              if (clientY < itemRect.top + itemRect.height / 2) {
                targetIndex = i;
                break;
              }
            }
          }
        }
        return { sectionId, targetIndex, itemHeight };
      }
    }
    return null;
  }, []);

  const handleItemDragMove = useCallback((sourceSectionId: string, _fromIndex: number, clientY: number) => {
    const target = findDropTarget(sourceSectionId, clientY);
    setCrossDrag(prev => {
      if (!target) return prev ? null : prev;
      if (prev?.targetSectionId === target.sectionId && prev?.targetIndex === target.targetIndex) return prev;
      return { sourceSectionId, targetSectionId: target.sectionId, targetIndex: target.targetIndex, itemHeight: target.itemHeight };
    });
  }, [findDropTarget]);

  const handleItemDragEnd = useCallback(() => {
    setCrossDrag(null);
  }, []);

  const handleItemDropOutside = useCallback((sourceSectionId: string, fromIndex: number, clientY: number) => {
    const target = findDropTarget(sourceSectionId, clientY);
    if (!target) return;
    // Indices are into the filtered/visible items — resolve to unfiltered indices
    const visSource = visibleSections.find(s => s.id === sourceSectionId);
    const visSourceUnchecked = visSource?.items.filter(i => !i.checked);
    const draggedItem = visSourceUnchecked?.[fromIndex];
    if (!draggedItem) return;
    // Resolve source index in unfiltered section
    const fullSource = sections.find(s => s.id === sourceSectionId);
    const fullSourceUnchecked = fullSource?.items.filter(i => !i.checked) ?? [];
    const realFromIndex = fullSourceUnchecked.findIndex(i => i.id === draggedItem.id);
    if (realFromIndex === -1) return;
    // Resolve target index: find where the drop position maps in the unfiltered list
    let realToIndex = target.targetIndex;
    const visTarget = visibleSections.find(s => s.id === target.sectionId);
    const fullTarget = sections.find(s => s.id === target.sectionId);
    if (visTarget && fullTarget) {
      const visTargetUnchecked = visTarget.items.filter(i => !i.checked);
      const fullTargetUnchecked = fullTarget.items.filter(i => !i.checked);
      if (target.targetIndex < visTargetUnchecked.length) {
        // Insert before this visible item — find its position in the full list
        const anchorItem = visTargetUnchecked[target.targetIndex];
        realToIndex = fullTargetUnchecked.findIndex(i => i.id === anchorItem.id);
        if (realToIndex === -1) realToIndex = fullTargetUnchecked.length;
      } else {
        // Appending to end
        realToIndex = fullTargetUnchecked.length;
      }
    }
    moveItem(sourceSectionId, realFromIndex, target.sectionId, realToIndex);
  }, [findDropTarget, moveItem, visibleSections, sections]);

  // Move an item to another section from the edit form (creates the section if needed)
  const handleChangeItemSection = useCallback(async (itemId: string, targetName: string) => {
    const fromSection = sections.find(s => s.items.some(i => i.id === itemId));
    if (!fromSection) return;
    // moveItem indexes into the section's unchecked items
    const fromIndex = fromSection.items.filter(i => !i.checked).findIndex(i => i.id === itemId);
    if (fromIndex === -1) return;
    const trimmed = toTitleCase(targetName.trim());
    if (!trimmed || trimmed.toLowerCase() === fromSection.name.toLowerCase()) return;

    let target = sections.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
    if (!target) {
      target = await createSection(trimmed);
    }
    // Append to the end of the target section's unchecked items
    await moveItem(fromSection.id, fromIndex, target.id, target.items.filter(i => !i.checked).length);
  }, [sections, createSection, moveItem]);

  const toggleCollapsed = useCallback((sectionName: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionName)) next.delete(sectionName);
      else next.add(sectionName);
      try { localStorage.setItem('meal-planner-grocery-collapsed', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  // When sort-by-store is active, drag indices correspond to the sorted visibleSections,
  // not the unsorted sections. Map sorted indices to the item IDs and use reorderItemsByIds.
  const handleReorderItems = useCallback((sectionId: string, from: number, to: number) => {
    if ((!sortByStore || hideStores) && activeSelectedStoreIds.size === 0 && activeExcludedStoreIds.size === 0) {
      reorderItems(sectionId, from, to);
      return;
    }
    // Get items in the order they're displayed (sorted/filtered)
    const visSection = visibleSections.find(s => s.id === sectionId);
    if (!visSection) return;
    const displayedItems = visSection.items.filter(i => !i.checked);
    // Apply the drag to the displayed order
    const reordered = [...displayedItems];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    // Pass the new ID order to the hook
    reorderItems(sectionId, from, to, reordered.map(i => i.id));
  }, [sortByStore, hideStores, activeSelectedStoreIds, activeExcludedStoreIds, visibleSections, reorderItems]);

  useEffect(() => {
    if (!showClearMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (clearMenuRef.current && !clearMenuRef.current.contains(e.target as Node)) {
        setShowClearMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showClearMenu]);

  useEffect(() => {
    if (!showSectionDropdown) return;
    // Elevate the .glass ancestor so the dropdown renders above store chips on iOS
    const glassAncestor = sectionDropdownRef.current?.closest('.glass');
    if (glassAncestor instanceof HTMLElement) {
      glassAncestor.style.zIndex = '20';
      glassAncestor.style.position = 'relative';
    }
    const handleClick = (e: MouseEvent) => {
      if (sectionDropdownRef.current && !sectionDropdownRef.current.contains(e.target as Node)) {
        setShowSectionDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      if (glassAncestor instanceof HTMLElement) {
        glassAncestor.style.zIndex = '';
        glassAncestor.style.position = '';
      }
    };
  }, [showSectionDropdown]);

  const handleSubmitText = useCallback(async () => {
    const text = inputText.trim();
    if (!text) return;

    const parsed = parseGroceryText(text);
    if (parsed.length > 0) {
      await mergeList(parsed);
      setInputText('');
      setAddMode('closed');
    }
  }, [inputText, mergeList]);

  const handleAddItem = useCallback(async (sectionId: string) => {
    if (!newItemName.trim()) return;
    const qtyMatch = newItemName.trim().match(/^\((\d+)\)\s+(.+)$/);
    const name = qtyMatch ? qtyMatch[2] : newItemName.trim();
    const qty = qtyMatch ? qtyMatch[1] : undefined;
    // Auto-populate store from item defaults (merged IDB + current list items).
    // Never touch the target section — the user picked it explicitly.
    const nameLower = name.toLowerCase();
    await addItem(sectionId, name, qty, itemDefaultsMap.get(nameLower)?.storeId ?? null);
    setNewItemName('');
    setAddingToSection(null);
  }, [newItemName, itemDefaultsMap, addItem]);

  const handleQuickAdd = useCallback(async () => {
    const trimmedName = quickAddItemName.trim();
    const trimmedSection = (quickAddSection.trim() || 'Default').replace(/(^|\s)\S/g, c => c.toUpperCase());
    if (!trimmedName) return;

    const quantity = quickAddQuantity > 0 ? String(quickAddQuantity) : null;

    const existingSection = sections.find(
      s => s.name.toLowerCase() === trimmedSection.toLowerCase()
    );

    if (existingSection) {
      await addItem(existingSection.id, trimmedName, quantity, quickAddStoreId);
    } else {
      await mergeList([{ name: trimmedSection, items: [{ name: trimmedName, quantity, store_id: quickAddStoreId }] }]);
    }

    setQuickAddItemName('');
    setQuickAddQuantity(0);
    setQuickAddStoreId(null);
    requestAnimationFrame(() => quickAddItemRef.current?.focus());
  }, [quickAddItemName, quickAddSection, quickAddQuantity, quickAddStoreId, sections, addItem, mergeList]);

  // Autofill store + section when the typed name exactly matches a known item
  // (current list items or remembered item defaults). Unmatched names clear the
  // store but leave the section untouched.
  const applyQuickAddDefaults = useCallback((name: string) => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) {
      setQuickAddStoreId(null);
      return;
    }
    const defaults = itemDefaultsMap.get(trimmed);
    setQuickAddStoreId(defaults?.storeId ?? null);
    if (defaults?.sectionName) setQuickAddSection(defaults.sectionName);
  }, [itemDefaultsMap]);

  const resetQuickAdd = useCallback(() => {
    setQuickAddSection('');
    setQuickAddItemName('');
    setQuickAddQuantity(0);
    setQuickAddStoreId(null);
  }, []);

  const handleClearChecked = useCallback(async () => {
    setShowClearMenu(false);
    await clearChecked();
  }, [clearChecked]);

  const handleClearAll = useCallback(async () => {
    setShowClearMenu(false);
    await clearAll();
  }, [clearAll]);

  // Most-recently-checked first. parseServerDate, not `new Date`: the API
  // sends naive UTC while optimistic updates write a "Z" — read raw, the two
  // are hours apart and the order jumps around (see utils/serverDate.ts).
  const checkedItems = useMemo(() => {
    return sections.flatMap(s => s.items.filter(i => i.checked))
      .sort((a, b) => parseServerDate(b.updated_at) - parseServerDate(a.updated_at));
  }, [sections]);

  // Format for copy exactly as displayed: flat (no headers) when grouped by
  // none, sectioned otherwise, and honoring the selected sort order.
  const formatForCopy = useCallback((secs: typeof sections) => {
    const orderItems = (items: typeof secs[number]['items']) => (
      sortBy === 'alphabetical'
        ? [...items].sort((a, b) => a.name.localeCompare(b.name))
        : groupBy === 'none'
          ? [...items].sort((a, b) => (a.global_position ?? 0) - (b.global_position ?? 0))
          : items
    );
    const lineFor = (item: typeof secs[number]['items'][number]) =>
      item.quantity ? `(${item.quantity}) ${item.name}` : item.name;

    if (groupBy === 'none') {
      const items = orderItems(secs.flatMap(s => s.items.filter(i => !i.checked)));
      return items.map(lineFor).join('\n').trim();
    }
    const lines: string[] = [];
    for (const section of secs) {
      const unchecked = section.items.filter(i => !i.checked);
      if (unchecked.length === 0) continue;
      lines.push(`[${section.name}]`);
      for (const item of orderItems(unchecked)) {
        lines.push(lineFor(item));
      }
      lines.push('');
    }
    return lines.join('\n').trim();
  }, [groupBy, sortBy]);

  const handleCopyFullList = useCallback(() => {
    navigator.clipboard.writeText(formatForCopy(sections));
    setShowClearMenu(false);
  }, [sections, formatForCopy]);

  const handleCopyFiltered = useCallback(() => {
    navigator.clipboard.writeText(formatForCopy(visibleSections));
    setShowClearMenu(false);
  }, [visibleSections, formatForCopy]);

  const hasItems = sections.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="grocery-loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  const closeIcon = (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );

  return (
    <div
      className="edit-accent-scope"
      style={{ '--edit-accent': getEditHighlight(editHighlightColor).accent } as React.CSSProperties}
    >
      {/* Sticky header: action bar + store chips */}
      <div className="sticky z-[9] glass rounded-2xl mt-4 mb-2 p-3 space-y-3" style={{ top: 'calc(var(--header-h, 48px) + 24px)' }}>
      {/* Action bar: add items + sort + kebab + chevron */}
      <div className="flex items-center gap-2">
        {sections.length === 0 || addMode !== 'closed' ? (
          <div className="flex-1 glass rounded-lg p-4">
            {addMode === 'paste' ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {sections.length === 0 ? 'Add your grocery list' : 'Paste grocery list'}
                  </h3>
                  {sections.length > 0 && (
                    <button
                      onClick={() => { setAddMode('closed'); setInputText(''); }}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                      aria-label="Close add items"
                    >
                      {closeIcon}
                    </button>
                  )}
                </div>
                <textarea
                  ref={textareaRef}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  placeholder={'Type or paste grocery list...\n\n[Produce]\n(2) Bananas\nArugula\n\n[Dairy]\nMilk\nYogurt'}
                  className="w-full h-32 p-3 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={handleSubmitText}
                    disabled={!inputText.trim()}
                    className="px-4 py-1.5 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 rounded-lg transition-colors"
                  >
                    Add items
                  </button>
                  <button
                    onClick={() => {
                      const ta = textareaRef.current;
                      if (!ta) return;
                      const pos = ta.selectionStart;
                      const before = inputText.slice(0, pos);
                      const after = inputText.slice(pos);
                      const needsNewline = before.length > 0 && !before.endsWith('\n');
                      const insert = (needsNewline ? '\n' : '') + '[]';
                      const newText = before + insert + after;
                      const cursorPos = pos + insert.length - 1;
                      setInputText(newText);
                      requestAnimationFrame(() => {
                        ta.focus();
                        ta.setSelectionRange(cursorPos, cursorPos);
                      });
                    }}
                    className="ml-auto text-sm text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"
                  >
                    Add section
                  </button>
                </div>
                <button
                  onClick={() => setAddMode('quick')}
                  className="mt-2 text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  Back to quick add
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {sections.length === 0 ? 'Add your grocery list' : 'Add Items'}
                  </h3>
                  {sections.length > 0 && (
                    <button
                      onClick={() => { setAddMode('closed'); resetQuickAdd(); }}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                      aria-label="Close add items"
                    >
                      {closeIcon}
                    </button>
                  )}
                </div>

                {/* Item + Qty row */}
                <div className="flex items-center gap-2 mb-2">
                  <ItemAutocomplete
                    value={quickAddItemName}
                    testId="quick-add-item"
                    onChange={val => {
                      setQuickAddItemName(val);
                      applyQuickAddDefaults(val);
                    }}
                    onSelect={displayName => {
                      setQuickAddItemName(displayName);
                      applyQuickAddDefaults(displayName);
                    }}
                    items={itemDefaultsMap}
                    currentListItemNames={currentListItemNames}
                    onDelete={removeItemDefault}
                    inputRef={quickAddItemRef}
                    placeholder="Item name..."
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleQuickAdd();
                      } else if (e.key === 'Escape') {
                        setAddMode('closed');
                        resetQuickAdd();
                      }
                    }}
                    className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => setQuickAddQuantity(q => Math.max(0, q - 1))} className="w-7 h-7 flex items-center justify-center rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 text-sm font-bold">&minus;</button>
                    <span className="w-6 text-center text-sm font-medium text-blue-600 dark:text-blue-400">{quickAddQuantity || '\u2013'}</span>
                    <button onClick={() => setQuickAddQuantity(q => q + 1)} className="w-7 h-7 flex items-center justify-center rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 text-sm font-bold">+</button>
                  </div>
                </div>

                {/* Section + Store row */}
                <div className="flex gap-2 mb-2 relative z-20">
                  <div className="relative flex-1 min-w-0" ref={sectionDropdownRef}>
                    <label className="block text-[10px] font-medium text-gray-400 dark:text-gray-500 mb-0.5 ml-1">Section</label>
                    {/* Inner wrapper so the clear X centers on the input, not input+label */}
                    <div className="relative">
                    <input
                      data-testid="quick-add-section"
                      type="text"
                      value={quickAddSection}
                      onChange={e => { setQuickAddSection(e.target.value); setShowSectionDropdown(true); }}
                      onFocus={e => { e.target.select(); setShowSectionDropdown(true); }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === 'Tab') {
                          setShowSectionDropdown(false);
                        } else if (e.key === 'Escape') {
                          setShowSectionDropdown(false);
                        }
                      }}
                      placeholder="Default"
                      className="w-full px-3 py-1.5 pr-8 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    {quickAddSection && (
                      <button
                        onClick={() => { setQuickAddSection(''); setShowSectionDropdown(false); }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        aria-label="Clear section"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                        </svg>
                      </button>
                    )}
                    </div>
                    {showSectionDropdown && filteredSections.length > 0 && (
                      <div className="absolute z-30 left-0 right-0 mt-1 glass-menu rounded-lg max-h-40 overflow-y-auto shadow-lg">
                        {filteredSections.map(s => (
                          <div
                            key={s.id}
                            className="flex items-center hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                          >
                            <button
                              onClick={() => {
                                setQuickAddSection(s.name);
                                setShowSectionDropdown(false);
                                requestAnimationFrame(() => quickAddItemRef.current?.focus());
                              }}
                              className="flex-1 text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300"
                            >
                              {s.name}
                            </button>
                            {s.isEmpty && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteSection(s.id);
                                  if (quickAddSection === s.name) setQuickAddSection('');
                                }}
                                className="px-2 py-1 mr-1 text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400"
                                aria-label={`Delete section ${s.name}`}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                                </svg>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {!hideStores && (
                    <div className="flex-1 min-w-0">
                      <label className="block text-[10px] font-medium text-gray-400 dark:text-gray-500 mb-0.5 ml-1">Store</label>
                      <StoreAutocomplete
                        stores={stores}
                        selectedStoreId={quickAddStoreId}
                        onSelect={setQuickAddStoreId}
                        onCreate={createStore}
                      />
                    </div>
                  )}
                </div>

                {/* Add Item button + paste link */}
                <div className="flex items-center gap-2">
                  <button
                    data-testid="quick-add-submit"
                    onClick={handleQuickAdd}
                    disabled={!quickAddItemName.trim()}
                    className="flex-1 py-1.5 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 rounded-lg transition-colors"
                  >
                    Add Item
                  </button>
                  <button
                    onClick={() => setAddMode('paste')}
                    className="text-xs text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    Paste a list
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <button
              onClick={() => setAddMode('quick')}
              className="flex-1 py-3 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
            >
              Add items
            </button>

            {/* Sort by store toggle */}
            {stores.length > 0 && !hideStores && (
              <button
                onClick={() => setSortByStore(prev => !prev)}
                className={`p-2 rounded ${sortByStore ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'}`}
                title={sortByStore ? 'Unsort' : 'Sort by store'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M3 3a1 1 0 000 2h11a1 1 0 100-2H3zM3 7a1 1 0 000 2h7a1 1 0 100-2H3zM3 11a1 1 0 100 2h4a1 1 0 100-2H3z" />
                </svg>
              </button>
            )}

            {/* Clear menu */}
            {hasItems && (
              <div className="relative" ref={clearMenuRef}>
                <button
                  onClick={() => setShowClearMenu(prev => !prev)}
                  className="p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 transition-colors"
                  aria-label="Clear options"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                  </svg>
                </button>
                {showClearMenu && (
                  <div className="absolute right-0 top-full mt-1 glass-menu rounded-lg py-1 z-20 min-w-[220px]">
                    {visibleSections.length > 0 && (activeSelectedStoreIds.size > 0 || activeExcludedStoreIds.size > 0) && (
                      <button
                        onClick={handleCopyFiltered}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                      >
                        Copy filtered list
                      </button>
                    )}
                    {sections.some(s => s.items.some(i => !i.checked)) && (
                      <button
                        onClick={handleCopyFullList}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                      >
                        Copy full list
                      </button>
                    )}
                    {stores.length > 0 && !hideStores && (
                      <button
                        onClick={() => { handleToggleShowAllStores(); setShowClearMenu(false); }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                      >
                        {showAllStores ? 'Show only active store chips' : 'Show all store chips'}
                      </button>
                    )}
                    {checkedItems.length > 0 && (
                      <button
                        onClick={handleClearChecked}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                      >
                        Clear checked ({checkedItems.length})
                      </button>
                    )}
                    {groupBy !== 'none' && visibleSections.length > 1 && (
                      collapsedSections.size > 0 ? (
                        <button
                          onClick={() => { setCollapsedSections(new Set()); try { localStorage.setItem('meal-planner-grocery-collapsed', '[]'); } catch {} setShowClearMenu(false); }}
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        >
                          Expand all sections
                        </button>
                      ) : (
                        <button
                          onClick={() => { const all = new Set(sections.map(s => s.name)); setCollapsedSections(all); try { localStorage.setItem('meal-planner-grocery-collapsed', JSON.stringify([...all])); } catch {} setShowClearMenu(false); }}
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        >
                          Collapse all sections
                        </button>
                      )
                    )}
                    {/* Display preferences */}
                    <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
                    <div className="px-4 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Group by</div>
                    <MenuRadioOption
                      label="Category"
                      active={groupBy === 'category'}
                      onClick={() => onUpdateDisplayPrefs?.({ groupBy: 'category' })}
                    />
                    <MenuRadioOption
                      label="None"
                      active={groupBy === 'none'}
                      onClick={() => onUpdateDisplayPrefs?.({ groupBy: 'none' })}
                    />
                    <div className="px-4 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Sort by</div>
                    <MenuRadioOption
                      label="Manually"
                      active={sortBy === 'manual'}
                      onClick={() => onUpdateDisplayPrefs?.({ sortBy: 'manual' })}
                    />
                    <MenuRadioOption
                      label="Alphabetically"
                      active={sortBy === 'alphabetical'}
                      onClick={() => onUpdateDisplayPrefs?.({ sortBy: 'alphabetical' })}
                    />
                    <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
                    <button
                      onClick={() => { onUpdateDisplayPrefs?.({ hideStores: !hideStores }); setShowClearMenu(false); }}
                      className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    >
                      {hideStores ? 'Show stores' : 'Hide stores'}
                    </button>
                    <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
                    <button
                      onClick={handleClearAll}
                      className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      Clear all items
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Chevron toggle for store chips */}
            {visibleStores.length > 0 && !hideStores && (
              <button
                onClick={() => { const next = !toolbarExpanded; setToolbarExpanded(next); try { localStorage.setItem('meal-planner-toolbar-expanded', String(next)); } catch {} }}
                className="relative p-2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                aria-label={toolbarExpanded ? 'Hide store filters' : 'Show store filters'}
              >
                <svg className={`w-4 h-4 transition-transform ${toolbarExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                {!toolbarExpanded && (selectedStoreIds.size > 0 || excludedStoreIds.size > 0) && (
                  <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-blue-500" />
                )}
              </button>
            )}
          </>
        )}
      </div>

      {/* Store filter bar — collapsible */}
      {toolbarExpanded && !hideStores && (
        <StoreFilterBar
          stores={visibleStores}
          selectedStoreIds={selectedStoreIds}
          excludedStoreIds={excludedStoreIds}
          onToggleSelect={handleToggleSelect}
          onRemoveExclusion={handleRemoveExclusion}
          onRename={renameStore}
          onDelete={removeStore}
          onReorder={reorderStores}
          onExclude={handleExclude}
          storeCounts={storeCounts}
          noneCount={storeCounts.get(NONE_STORE_ID) ?? 0}
        />
      )}
      </div>

      {/* Group by "none" — one flat list of every unchecked item, no headers */}
      {groupBy === 'none' ? (
        flatItems.length > 0 && (
          <div className="mt-4 glass rounded-lg py-1" ref={flatContainerRef} data-item-container>
            {flatItems.map(({ item, sectionName }, index) => {
              const isBeingDragged = flatDragState.isDragging && flatDragState.dragIndex === index;
              const shiftStyle = computeShiftTransform(index, flatDragState);
              return (
                <div
                  key={item.id}
                  data-drag-index={index}
                  style={{
                    opacity: isBeingDragged ? 0.3 : 1,
                    transform: shiftStyle || undefined,
                    transition: flatDragState.isDragging ? 'transform 200ms ease-out, opacity 200ms' : undefined,
                  }}
                >
                  <ChecklistItemRow
                    item={item}
                    onToggle={toggleItem}
                    onDelete={deleteItem}
                    onEdit={editItem}
                    dragHandlers={flatDragEnabled ? getFlatDragHandlers(index) : undefined}
                    handleMouseDown={flatDragEnabled ? getFlatHandleMouseDown(index) : undefined}
                    isDragging={flatDragState.isDragging}
                    chips={stores}
                    chipId={item.store_id}
                    onCreateChip={createStore}
                    editingItemId={editingItemId}
                    onEditingItemChange={handleEditingItemChange}
                    commitEditingRef={commitEditingRef}
                    sectionName={sectionName}
                    allSections={sections}
                    editHighlightColor={editHighlightColor}
                    onChangeSection={handleChangeItemSection}
                    hideChips={hideStores}
                  />
                </div>
              );
            })}
          </div>
        )
      ) : (
      /* Sections with unchecked items */
      <div ref={sectionContainerRef} className="mt-4">
        {visibleSections.map((section, sectionIndex) => {
          const isBeingDragged = sectionDragState.isDragging && sectionDragState.dragIndex === sectionIndex;
          const shiftStyle = computeShiftTransform(sectionIndex, sectionDragState);
          return (
            <div
              key={section.id}
              data-drag-index={sectionIndex}
              data-section-id={section.id}
              className={sectionIndex > 0 ? 'mt-4' : ''}
              style={{
                opacity: isBeingDragged ? 0.3 : 1,
                transform: shiftStyle || undefined,
                transition: sectionDragState.isDragging ? 'transform 200ms ease-out, opacity 200ms' : undefined,
              }}
            >
              <ChecklistSectionCard
                section={section}
                visibleItems={section.items.filter(i => !i.checked)}
                sectionDragHandlers={getSectionDragHandlers(sectionIndex)}
                sectionHandleMouseDown={getSectionHandleMouseDown(sectionIndex)}
                isSectionDragging={isSectionDragging}
                isCollapsed={collapsedSections.has(section.name)}
                onToggleCollapse={() => toggleCollapsed(section.name)}
                onToggle={toggleItem}
                onDelete={deleteItem}
                onEdit={editItem}
                onRenameSection={renameSection}
                onReorderItems={(from, to) => handleReorderItems(section.id, from, to)}
                onItemDropOutside={(fromIndex, clientY) => handleItemDropOutside(section.id, fromIndex, clientY)}
                onItemDragMove={(fromIndex, clientY) => handleItemDragMove(section.id, fromIndex, clientY)}
                onItemDragEnd={handleItemDragEnd}
                crossDropTarget={crossDrag?.targetSectionId === section.id ? { targetIndex: crossDrag.targetIndex, itemHeight: crossDrag.itemHeight } : null}
                addingToSection={addingToSection}
                onStartAdd={setAddingToSection}
                newItemName={newItemName}
                onNewItemNameChange={setNewItemName}
                onAddItem={handleAddItem}
                chips={stores}
                chipIdFor={item => (item as GrocerySection['items'][number]).store_id}
                onCreateChip={createStore}
                editingItemId={editingItemId}
                onEditingItemChange={handleEditingItemChange}
                commitEditingRef={commitEditingRef}
                itemDefaultsMap={itemDefaultsMap}
                currentListItemNames={currentListItemNames}
                onDeleteItemDefault={removeItemDefault}
                allSections={sections}
                editHighlightColor={editHighlightColor}
                onChangeSection={handleChangeItemSection}
                hideChips={hideStores}
                itemDragEnabled={itemDragEnabled}
              />
            </div>
          );
        })}
      </div>
      )}

      {/* Checked items */}
      {checkedItems.length > 0 && (
        <div className="mt-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="font-medium text-gray-400 dark:text-gray-500 mb-2 text-sm">
            Checked ({checkedItems.length})
          </h3>
          <div className="space-y-1">
            {checkedItems.map(item => (
              <ChecklistItemRow
                key={item.id}
                item={item}
                onToggle={toggleItem}
                onDelete={deleteItem}
                onEdit={editItem}
                chips={stores}
                chipId={item.store_id}
                onCreateChip={createStore}
                editingItemId={editingItemId}
                onEditingItemChange={handleEditingItemChange}
                commitEditingRef={commitEditingRef}
                sectionName={sections.find(s => s.id === item.section_id)?.name ?? ''}
                allSections={sections}
                editHighlightColor={editHighlightColor}
                onChangeSection={handleChangeItemSection}
                hideChips={hideStores}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
