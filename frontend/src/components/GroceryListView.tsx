import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useGroceryList } from '../hooks/useGroceryList';
import { useStores } from '../hooks/useStores';
import { parseGroceryText } from '../utils/groceryParser';
import { GrocerySection, Store } from '../types';
import { useDragReorder, computeShiftTransform } from '../hooks/useDragReorder';
import { StoreAutocomplete } from './StoreAutocomplete';
import { StoreFilterBar } from './StoreFilterBar';
import { getLocalItemDefaults } from '../db';

export const NONE_STORE_ID = '__none__';

interface GroceryListViewProps {
  compactView?: boolean;
}

export function GroceryListView({ compactView: _compactView }: GroceryListViewProps) {
  const { sections, loading, mergeList, toggleItem, addItem, deleteItem, editItem, clearChecked, clearAll, reorderSections, reorderItems, renameSection, deleteSection, moveItem, batchUpdateStoreId } = useGroceryList();
  const { stores, createStore, renameStore, removeStore, reorderStores } = useStores({
    grocerySections: sections,
    onItemsStoreChanged: batchUpdateStoreId,
  });
  // Item defaults cache for offline store auto-populate
  const [itemDefaultsMap, setItemDefaultsMap] = useState<Map<string, string | null>>(new Map());
  useEffect(() => {
    const load = () => {
      getLocalItemDefaults().then(defaults => {
        const map = new Map<string, string | null>();
        for (const d of defaults) map.set(d.item_name, d.store_id);
        setItemDefaultsMap(map);
      }).catch(() => {});
    };
    load();
    // Reload when fetchAllData finishes (it dispatches pending-changes-synced or visibility change)
    window.addEventListener('pending-changes-synced', load);
    return () => window.removeEventListener('pending-changes-synced', load);
  }, []);

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
  const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('meal-planner-selected-stores');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [excludedStoreIds, setExcludedStoreIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('meal-planner-excluded-stores');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
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

  // Auto-deselect stores that no longer have unchecked items
  useEffect(() => {
    if (selectedStoreIds.size === 0) return;
    let changed = false;
    const next = new Set(selectedStoreIds);
    for (const id of next) {
      if ((storeCounts.get(id) ?? 0) === 0) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) {
      setSelectedStoreIds(next);
      try { localStorage.setItem('meal-planner-selected-stores', JSON.stringify([...next])); } catch {}
    }
  }, [storeCounts, selectedStoreIds]);

  const handleToggleSelect = useCallback((storeId: string) => {
    setSelectedStoreIds(prev => {
      const next = new Set(prev);
      if (next.has(storeId)) {
        next.delete(storeId);
      } else {
        next.add(storeId);
      }
      try { localStorage.setItem('meal-planner-selected-stores', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const handleExclude = useCallback((storeId: string) => {
    setSelectedStoreIds(prev => {
      if (prev.has(storeId)) {
        const next = new Set(prev);
        next.delete(storeId);
        try { localStorage.setItem('meal-planner-selected-stores', JSON.stringify([...next])); } catch {}
        return next;
      }
      return prev;
    });
    setExcludedStoreIds(prev => {
      const next = new Set(prev);
      next.add(storeId);
      try { localStorage.setItem('meal-planner-excluded-stores', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const handleRemoveExclusion = useCallback((storeId: string) => {
    setExcludedStoreIds(prev => {
      const next = new Set(prev);
      next.delete(storeId);
      try { localStorage.setItem('meal-planner-excluded-stores', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

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
    if (excludedStoreIds.size > 0) {
      filtered = filtered
        .map(s => ({
          ...s,
          items: s.items.filter(i => {
            if (!i.store_id) return !excludedStoreIds.has(NONE_STORE_ID);
            return !excludedStoreIds.has(i.store_id);
          }),
        }))
        .filter(s => s.items.some(i => !i.checked));
    }

    // 2. If any stores are selected, show only those
    if (selectedStoreIds.size > 0) {
      filtered = filtered
        .map(s => ({
          ...s,
          items: s.items.filter(i => !i.checked && (selectedStoreIds.has(NONE_STORE_ID)
            ? !i.store_id || selectedStoreIds.has(i.store_id!)
            : i.store_id && selectedStoreIds.has(i.store_id))),
        }))
        .filter(s => s.items.length > 0);
    }

    if (sortByStore) {
      const storeOrder = new Map(stores.map(s => [s.id, s.position]));
      filtered = filtered.map(s => ({
        ...s,
        items: [...s.items].sort((a, b) => {
          const aPos = a.store_id ? (storeOrder.get(a.store_id) ?? Infinity) : Infinity;
          const bPos = b.store_id ? (storeOrder.get(b.store_id) ?? Infinity) : Infinity;
          if (aPos !== bPos) return aPos - bPos;
          return a.position - b.position;
        }),
      }));
    }
    return filtered;
  }, [sections, selectedStoreIds, excludedStoreIds, sortByStore, stores]);

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
    if (target) {
      moveItem(sourceSectionId, fromIndex, target.sectionId, target.targetIndex);
    }
  }, [findDropTarget, moveItem]);

  const toggleCollapsed = useCallback((sectionName: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionName)) next.delete(sectionName);
      else next.add(sectionName);
      try { localStorage.setItem('meal-planner-grocery-collapsed', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const handleStoreAssign = useCallback((itemId: string, storeId: string | null) => {
    editItem(itemId, { store_id: storeId });
  }, [editItem]);

  // When sort-by-store is active, drag indices correspond to the sorted visibleSections,
  // not the unsorted sections. Map sorted indices to the item IDs and use reorderItemsByIds.
  const handleReorderItems = useCallback((sectionId: string, from: number, to: number) => {
    if (!sortByStore && selectedStoreIds.size === 0 && excludedStoreIds.size === 0) {
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
  }, [sortByStore, selectedStoreIds, excludedStoreIds, visibleSections, reorderItems]);

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
    // Auto-populate store: check current list items first, then item defaults cache
    const nameLower = name.toLowerCase();
    const match = sections.flatMap(s => s.items).find(
      i => i.name.toLowerCase() === nameLower && i.store_id
    );
    await addItem(sectionId, name, qty, match?.store_id ?? itemDefaultsMap.get(nameLower) ?? null);
    setNewItemName('');
    setAddingToSection(null);
  }, [newItemName, sections, addItem]);

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

  const checkedItems = useMemo(() => {
    return sections.flatMap(s => s.items.filter(i => i.checked))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  }, [sections]);

  const formatSectionsForCopy = (secs: typeof sections) => {
    const lines: string[] = [];
    for (const section of secs) {
      const unchecked = section.items.filter(i => !i.checked);
      if (unchecked.length === 0) continue;
      lines.push(`[${section.name}]`);
      for (const item of unchecked) {
        lines.push(item.quantity ? `(${item.quantity}) ${item.name}` : item.name);
      }
      lines.push('');
    }
    return lines.join('\n').trim();
  };

  const handleCopyFullList = useCallback(() => {
    navigator.clipboard.writeText(formatSectionsForCopy(sections));
    setShowClearMenu(false);
  }, [sections]);

  const handleCopyFiltered = useCallback(() => {
    navigator.clipboard.writeText(formatSectionsForCopy(visibleSections));
    setShowClearMenu(false);
  }, [visibleSections]);

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
    <div>
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
                  <input
                    ref={quickAddItemRef}
                    data-testid="quick-add-item"
                    type="text"
                    value={quickAddItemName}
                    onChange={e => {
                      const val = e.target.value;
                      setQuickAddItemName(val);
                      // Auto-populate store: check current list items first, then item defaults cache
                      const trimmed = val.trim().toLowerCase();
                      if (trimmed) {
                        const match = sections.flatMap(s => s.items).find(
                          i => i.name.toLowerCase() === trimmed && i.store_id
                        );
                        setQuickAddStoreId(match?.store_id ?? itemDefaultsMap.get(trimmed) ?? null);
                      } else {
                        setQuickAddStoreId(null);
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleQuickAdd();
                      } else if (e.key === 'Escape') {
                        setAddMode('closed');
                        resetQuickAdd();
                      }
                    }}
                    placeholder="Item name..."
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
                  <div className="flex-1 min-w-0">
                    <label className="block text-[10px] font-medium text-gray-400 dark:text-gray-500 mb-0.5 ml-1">Store</label>
                    <StoreAutocomplete
                      stores={stores}
                      selectedStoreId={quickAddStoreId}
                      onSelect={setQuickAddStoreId}
                      onCreate={createStore}
                    />
                  </div>
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
            {stores.length > 0 && (
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
                    {visibleSections.length > 0 && (selectedStoreIds.size > 0 || excludedStoreIds.size > 0) && (
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
                    {stores.length > 0 && (
                      <button
                        onClick={() => { handleToggleShowAllStores(); setShowClearMenu(false); }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                      >
                        {showAllStores ? 'Show only active stores' : 'Show all stores'}
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
                    {visibleSections.length > 1 && (
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
            {visibleStores.length > 0 && (
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
      {toolbarExpanded && (
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

      {/* Sections with unchecked items */}
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
              <SectionCard
                section={section}
                sectionIndex={sectionIndex}
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
                stores={stores}
                onStoreAssign={handleStoreAssign}
                onCreateStore={createStore}
                editingItemId={editingItemId}
                onEditingItemChange={handleEditingItemChange}
                commitEditingRef={commitEditingRef}
              />
            </div>
          );
        })}
      </div>

      {/* Checked items */}
      {checkedItems.length > 0 && (
        <div className="mt-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="font-medium text-gray-400 dark:text-gray-500 mb-2 text-sm">
            Checked ({checkedItems.length})
          </h3>
          <div className="space-y-1">
            {checkedItems.map(item => (
              <GroceryItemRow
                key={item.id}
                item={item}
                onToggle={toggleItem}
                onDelete={deleteItem}
                onEdit={editItem}
                stores={stores}
                onStoreAssign={handleStoreAssign}
                onCreateStore={createStore}
                editingItemId={editingItemId}
                onEditingItemChange={handleEditingItemChange}
                commitEditingRef={commitEditingRef}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SectionCardProps {
  section: GrocerySection;
  sectionIndex: number;
  sectionDragHandlers: ReturnType<ReturnType<typeof useDragReorder>['getDragHandlers']>;
  sectionHandleMouseDown: (e: React.MouseEvent) => void;
  isSectionDragging: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onToggle: (id: string, checked: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, updates: { name?: string; quantity?: string | null }) => void;
  onRenameSection: (sectionId: string, newName: string) => void;
  onReorderItems: (fromIndex: number, toIndex: number) => void;
  onItemDropOutside: (fromIndex: number, clientY: number) => void;
  onItemDragMove: (fromIndex: number, clientY: number) => void;
  onItemDragEnd: () => void;
  crossDropTarget: { targetIndex: number; itemHeight: number } | null;
  addingToSection: string | null;
  onStartAdd: (sectionId: string | null) => void;
  newItemName: string;
  onNewItemNameChange: (name: string) => void;
  onAddItem: (sectionId: string) => void;
  stores: Store[];
  onStoreAssign: (itemId: string, storeId: string | null) => void;
  onCreateStore: (name: string) => Promise<Store | null>;
  editingItemId: string | null;
  onEditingItemChange: (id: string | null) => void;
  commitEditingRef: React.MutableRefObject<(() => void) | null>;
}

function SectionCard({
  section,
  sectionDragHandlers,
  sectionHandleMouseDown,
  isSectionDragging,
  isCollapsed,
  onToggleCollapse,
  onToggle,
  onDelete,
  onEdit,
  onRenameSection,
  onReorderItems,
  onItemDropOutside,
  onItemDragMove,
  onItemDragEnd,
  crossDropTarget,
  addingToSection,
  onStartAdd,
  newItemName,
  onNewItemNameChange,
  onAddItem,
  stores,
  onStoreAssign,
  onCreateStore,
  editingItemId,
  onEditingItemChange,
  commitEditingRef,
}: SectionCardProps) {
  const uncheckedItems = section.items.filter(i => !i.checked);
  const itemContainerRef = useRef<HTMLDivElement>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState(section.name);
  const headerInputRef = useRef<HTMLInputElement>(null);

  const commitRename = useCallback(() => {
    const trimmed = editNameValue.trim();
    if (trimmed && trimmed !== section.name) {
      onRenameSection(section.id, trimmed);
    }
    setIsEditingName(false);
  }, [editNameValue, section.id, section.name, onRenameSection]);

  useEffect(() => {
    if (isEditingName && headerInputRef.current) {
      headerInputRef.current.focus();
      headerInputRef.current.select();
    }
  }, [isEditingName]);

  const { dragState: itemDragState, getDragHandlers: getItemDragHandlers, getHandleMouseDown: getItemHandleMouseDown } = useDragReorder({
    itemCount: uncheckedItems.length,
    onReorder: onReorderItems,
    containerRef: itemContainerRef,
    onDropOutside: onItemDropOutside,
    onDragMove: onItemDragMove,
    onDragEnd: onItemDragEnd,
  });

  return (
    <div className="glass rounded-lg">
      {/* Section Header -- long-press to drag section */}
      <div
        className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-600 flex items-center justify-between px-4 py-2 rounded-t-lg"
        {...sectionDragHandlers}
      >
        <div className="flex items-center gap-2">
          <svg
            className="drag-handle w-4 h-4 text-gray-400 dark:text-gray-500 flex-shrink-0 cursor-grab active:cursor-grabbing"
            fill="currentColor"
            viewBox="0 0 20 20"
            onMouseDown={sectionHandleMouseDown}
          >
            <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
          </svg>
          {isEditingName ? (
            <input
              ref={headerInputRef}
              type="text"
              value={editNameValue}
              onChange={e => setEditNameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setEditNameValue(section.name); setIsEditingName(false); }
              }}
              onBlur={commitRename}
              className="font-semibold text-sm bg-white dark:bg-gray-700 border border-blue-400 dark:border-blue-500 rounded px-1.5 py-0.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-0"
            />
          ) : (
            <h3
              className="font-semibold text-gray-900 dark:text-gray-100 text-sm cursor-pointer"
              onClick={(e) => { e.stopPropagation(); setEditNameValue(section.name); setIsEditingName(true); }}
            >
              {section.name}
            </h3>
          )}
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          className="flex items-center gap-1 text-gray-400 dark:text-gray-500 text-xs hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        >
          {uncheckedItems.length} item{uncheckedItems.length !== 1 ? 's' : ''}
          <svg
            className={`w-3.5 h-3.5 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* Items — collapse during section drag or manual collapse */}
      <div style={{ display: (isSectionDragging || isCollapsed) ? 'none' : undefined }}>
        <div className="py-1" ref={itemContainerRef} data-item-container>
          {uncheckedItems.map((item, index) => {
            const isBeingDragged = itemDragState.isDragging && itemDragState.dragIndex === index;
            const internalShift = computeShiftTransform(index, itemDragState);
            const crossShift = crossDropTarget && index >= crossDropTarget.targetIndex
              ? `translateY(${crossDropTarget.itemHeight}px)` : '';
            const shiftStyle = internalShift || crossShift;
            const isAnimating = itemDragState.isDragging || !!crossDropTarget;
            return (
              <div
                key={item.id}
                data-drag-index={index}
                style={{
                  opacity: isBeingDragged ? 0.3 : 1,
                  transform: shiftStyle || undefined,
                  transition: isAnimating ? 'transform 200ms ease-out, opacity 200ms' : undefined,
                }}
              >
                <GroceryItemRow
                  item={item}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onEdit={onEdit}
                  dragHandlers={getItemDragHandlers(index)}
                  handleMouseDown={getItemHandleMouseDown(index)}
                  isDragging={itemDragState.isDragging}
                  stores={stores}
                  onStoreAssign={onStoreAssign}
                  onCreateStore={onCreateStore}
                  editingItemId={editingItemId}
                  onEditingItemChange={onEditingItemChange}
                  commitEditingRef={commitEditingRef}
                />
              </div>
            );
          })}

          {/* Spacer for cross-section drag target */}
          <div style={{
            height: crossDropTarget ? crossDropTarget.itemHeight : 0,
            transition: 'height 200ms ease-out',
          }} />

          {/* Add item inline */}
          {addingToSection === section.id ? (
            <div className="flex items-center gap-2 px-4 py-2">
              <input
                type="text"
                value={newItemName}
                onChange={e => onNewItemNameChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onAddItem(section.id);
                  if (e.key === 'Escape') onStartAdd(null);
                }}
                placeholder="Item name..."
                autoFocus
                className="flex-1 bg-transparent border-b border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 text-sm py-1"
              />
              <button
                onClick={() => onAddItem(section.id)}
                className="text-blue-500 hover:text-blue-600 text-sm font-medium"
              >
                Add
              </button>
              <button
                onClick={() => onStartAdd(null)}
                className="text-gray-400 hover:text-gray-600 text-sm"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => onStartAdd(section.id)}
              className="w-full text-left text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors px-4 py-1.5 text-sm"
            >
              + Add item
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface GroceryItemRowProps {
  item: GrocerySection['items'][number];
  onToggle: (id: string, checked: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, updates: { name?: string; quantity?: string | null }) => void;
  dragHandlers?: ReturnType<ReturnType<typeof useDragReorder>['getDragHandlers']>;
  handleMouseDown?: (e: React.MouseEvent) => void;
  isDragging?: boolean;
  stores: Store[];
  onStoreAssign: (itemId: string, storeId: string | null) => void;
  onCreateStore: (name: string) => Promise<Store | null>;
  editingItemId: string | null;
  onEditingItemChange: (id: string | null) => void;
  commitEditingRef: React.MutableRefObject<(() => void) | null>;
}

function GroceryItemRow({ item, onToggle, onDelete, onEdit, dragHandlers, handleMouseDown, isDragging, stores, onStoreAssign, onCreateStore, editingItemId, onEditingItemChange, commitEditingRef }: GroceryItemRowProps) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwipeRevealed, setIsSwipeRevealed] = useState(false);
  const isEditing = editingItemId === item.id;
  const [editName, setEditName] = useState(item.name);
  const [editQuantity, setEditQuantity] = useState(item.quantity ?? '');
  const touchStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const swipeModeRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const storeName = stores?.find(s => s.id === item.store_id)?.name;

  const SWIPE_THRESHOLD = 50;
  const SWIPE_MAX = 80;

  const commitEditRef = useRef<(() => void) | null>(null) as React.MutableRefObject<(() => void) | null>;

  const startEditing = useCallback(() => {
    if (item.checked) return;
    setEditName(item.name);
    setEditQuantity(item.quantity ?? '');
    onEditingItemChange(item.id);
  }, [item.id, item.name, item.quantity, item.checked, onEditingItemChange]);

  const commitEdit = useCallback(() => {
    const trimmedName = editName.trim();
    if (!trimmedName) {
      onEditingItemChange(null);
      return;
    }

    const updates: { name?: string; quantity?: string | null } = {};
    if (trimmedName !== item.name) updates.name = trimmedName;
    const qtyNum = parseInt(editQuantity) || 0;
    const newQty = qtyNum > 0 ? String(qtyNum) : null;
    if (newQty !== item.quantity) updates.quantity = newQty;

    if (Object.keys(updates).length > 0) {
      onEdit(item.id, updates);
    }
    onEditingItemChange(null);
  }, [editName, editQuantity, item.id, item.name, item.quantity, onEdit, onEditingItemChange]);

  const cancelEdit = useCallback(() => {
    onEditingItemChange(null);
    setEditName(item.name);
    setEditQuantity(item.quantity ?? '');
  }, [item.name, item.quantity, onEditingItemChange]);

  // Expose commitEdit so parent can call it before switching to another item
  commitEditRef.current = commitEdit;
  useEffect(() => {
    if (isEditing) {
      commitEditingRef.current = () => commitEditRef.current?.();
    }
  }, [isEditing, commitEditingRef]);

  useEffect(() => {
    if (isEditing && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditing]);

  if (isEditing) {
    const qtyNum = parseInt(editQuantity) || 0;
    return (
      <div className="px-4 py-1.5 bg-blue-50 dark:bg-blue-900/20 space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setEditQuantity(String(Math.max(0, qtyNum - 1) || ''))}
              className="w-7 h-7 flex items-center justify-center rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 text-sm font-bold"
            >
              −
            </button>
            <span className="w-8 text-center text-sm font-medium text-blue-600 dark:text-blue-400">
              {qtyNum || '–'}
            </span>
            <button
              onClick={() => setEditQuantity(String(qtyNum + 1))}
              className="w-7 h-7 flex items-center justify-center rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 text-sm font-bold"
            >
              +
            </button>
          </div>
          <input
            ref={nameInputRef}
            type="text"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') cancelEdit();
            }}
            className="flex-1 min-w-0 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-sm py-0.5 px-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <StoreAutocomplete
          stores={stores}
          selectedStoreId={item.store_id}
          onSelect={(storeId) => onStoreAssign(item.id, storeId)}
          onCreate={onCreateStore}
        />
        <div className="flex items-center justify-end gap-3">
          <button
            onClick={cancelEdit}
            className="text-gray-400 hover:text-gray-600 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={commitEdit}
            className="text-blue-500 hover:text-blue-600 text-sm font-medium"
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden">
      {swipeOffset > 0 && (
        <div className="absolute inset-y-0 right-0 flex items-center" style={{ width: SWIPE_MAX }}>
          <button
            type="button"
            data-delete-action
            onClick={() => {
              setSwipeOffset(0);
              setIsSwipeRevealed(false);
              onDelete(item.id);
            }}
            className="w-full h-full bg-red-500 text-white font-medium text-sm flex items-center justify-center"
          >
            Delete
          </button>
        </div>
      )}
      <div
        className="flex items-start gap-2 group px-4 py-1.5"
        style={{
          transform: swipeOffset > 0 ? `translateX(-${swipeOffset}px)` : undefined,
          transition: swipeModeRef.current ? undefined : 'transform 200ms ease-out',
        }}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          touchStartRef.current = { x: touch.clientX, y: touch.clientY };
          swipeModeRef.current = false;
          if (isSwipeRevealed) {
            const target = e.target as HTMLElement;
            if (!target.closest('[data-delete-action]')) {
              setIsSwipeRevealed(false);
              setSwipeOffset(0);
            }
          }
          dragHandlers?.onTouchStart(e);
        }}
        onTouchMove={(e) => {
          if (isDragging) {
            dragHandlers?.onTouchMove(e);
            return;
          }

          if (isSwipeRevealed) return;
          const touch = e.touches[0];
          const dx = touch.clientX - touchStartRef.current.x;
          const dy = Math.abs(touch.clientY - touchStartRef.current.y);
          const absDx = Math.abs(dx);
          if (!swipeModeRef.current && absDx > 15 && dx < 0 && absDx > dy * 1.5) {
            swipeModeRef.current = true;
          }
          if (swipeModeRef.current) {
            e.preventDefault();
            setSwipeOffset(Math.min(Math.max(-dx, 0), SWIPE_MAX));
          }
          dragHandlers?.onTouchMove(e);
        }}
        onTouchEnd={() => {
          dragHandlers?.onTouchEnd();

          if (swipeModeRef.current) {
            if (swipeOffset >= SWIPE_THRESHOLD) {
              setSwipeOffset(SWIPE_MAX);
              setIsSwipeRevealed(true);
            } else {
              setSwipeOffset(0);
            }
            swipeModeRef.current = false;
          }
        }}
      >
        {/* Desktop drag handle for items */}
        {dragHandlers && handleMouseDown && (
          <svg
            className="drag-handle w-3.5 h-3.5 text-gray-300 dark:text-gray-600 flex-shrink-0 mt-0.5 cursor-grab active:cursor-grabbing"
            fill="currentColor"
            viewBox="0 0 20 20"
            onMouseDown={handleMouseDown}
          >
            <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
          </svg>
        )}

        {/* Checkbox */}
        <button
          type="button"
          onClick={() => onToggle(item.id, !item.checked)}
          className={`
            flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center mt-0.5
            transition-colors duration-150
            ${item.checked
              ? 'bg-green-500 border-green-500 dark:bg-green-600 dark:border-green-600'
              : 'border-gray-300 hover:border-gray-400 dark:border-gray-600 dark:hover:border-gray-500'
            }
          `}
        >
          {item.checked && (
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        {/* Item text -- tap to edit */}
        <div className="flex flex-col min-w-0 flex-1" onClick={startEditing}>
          <span
            className={`
              min-w-0 break-words cursor-pointer
              text-sm
              ${item.checked
                ? 'text-gray-400 dark:text-gray-500 line-through'
                : 'text-gray-800 dark:text-gray-200'
              }
            `}
          >
            {item.quantity && (
              <span className={`font-medium ${item.checked ? 'text-gray-400 dark:text-gray-500' : 'text-blue-600 dark:text-blue-400'}`}>
                ({item.quantity}){' '}
              </span>
            )}
            {item.name}
          </span>
          {storeName && (
            <div className="text-xs text-gray-400 dark:text-gray-500 leading-tight">
              {storeName}
            </div>
          )}
        </div>

        {/* Desktop delete button */}
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          className="hover-delete-btn flex-shrink-0 items-center ml-1 text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400"
          aria-label="Delete item"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
