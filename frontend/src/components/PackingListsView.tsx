import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePacking } from '../hooks/usePacking';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { PackingList, PackingItem, DirectoryUser, UserInfo, Store, ItemDefaultEntry } from '../types';
import { getUsers } from '../api/client';
import { useDragReorder, computeShiftTransform } from '../hooks/useDragReorder';
import { useTabReorder } from '../hooks/useTabReorder';
import { StoreAutocomplete } from './StoreAutocomplete';
import { StoreFilterBar } from './StoreFilterBar';
import { ItemAutocomplete } from './ItemAutocomplete';
import {
  ChecklistSectionCard,
  MenuRadioOption,
  NONE_STORE_ID,
} from './ChecklistParts';
import { bagProgress, visibleSectionItems } from '../utils/packing';
import { getEditHighlight } from '../utils/editHighlightColors';
import { toTitleCase } from '../utils/titleCase';

// The Travel tab: multiple shareable packing lists, each a sectioned checklist
// with a bag per item. Rows, section cards and chips are the same components
// the Grocery tab uses (see ChecklistParts); what's specific here is the
// list tabs, the bag-progress header, and the packed-items behaviour.

const ACTIVE_KEY = 'meal-planner-packing-active';
const TOOLBAR_KEY = 'meal-planner-packing-toolbar';
const COLLAPSED_KEY = 'meal-planner-packing-collapsed';

const LIST_COLORS: { name: string; bar: string }[] = [
  { name: 'blue', bar: 'bg-blue-500' },
  { name: 'emerald', bar: 'bg-emerald-500' },
  { name: 'amber', bar: 'bg-amber-500' },
  { name: 'rose', bar: 'bg-rose-500' },
  { name: 'violet', bar: 'bg-violet-500' },
  { name: 'slate', bar: 'bg-slate-500' },
];

const colorBar = (color: string | null) => LIST_COLORS.find(c => c.name === color)?.bar ?? 'bg-blue-500';

export interface PackingListsViewProps {
  user: UserInfo;
  editHighlightColor?: string;
  showChecked?: boolean;
  hideBags?: boolean;
  sortBy?: 'manual' | 'alphabetical';
  selectedBags?: string[];
  excludedBags?: string[];
  onUpdateDisplayPrefs?: (updates: {
    showChecked?: boolean;
    hideBags?: boolean;
    sortBy?: 'manual' | 'alphabetical';
    selectedBags?: string[];
    excludedBags?: string[];
  }) => void;
  // Per-list notification override (shares the tracker's namespace).
  notifyEditsDefault?: boolean;
  listNotifyOverrides?: Record<string, { edits?: boolean; due?: boolean }>;
  onSetListNotify?: (listId: string, changes: { edits?: boolean }) => void;
}

const EMPTY: string[] = [];

export function PackingListsView({
  user,
  editHighlightColor = 'emerald',
  showChecked = true,
  hideBags = false,
  sortBy = 'manual',
  selectedBags = EMPTY,
  excludedBags = EMPTY,
  onUpdateDisplayPrefs,
  notifyEditsDefault = false,
  listNotifyOverrides = {},
  onSetListNotify,
}: PackingListsViewProps) {
  const packing = usePacking();
  const { lists, loading } = packing;
  const isOnline = useOnlineStatus();

  const [activeId, setActiveId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
  });
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [newListColor, setNewListColor] = useState(LIST_COLORS[0].name);
  const [shareOpen, setShareOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTrip, setEditingTrip] = useState(false);
  const [tripName, setTripName] = useState('');
  const [tripColor, setTripColor] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [toolbarExpanded, setToolbarExpanded] = useState(() => {
    try { return localStorage.getItem(TOOLBAR_KEY) !== 'false'; } catch { return true; }
  });
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch { return new Set<string>(); }
  });

  const [quickName, setQuickName] = useState('');
  const [quickQty, setQuickQty] = useState(0);
  const [quickSection, setQuickSection] = useState('');
  const [quickBagId, setQuickBagId] = useState<string | null>(null);
  const [sectionDropdownOpen, setSectionDropdownOpen] = useState(false);
  const [addingToSection, setAddingToSection] = useState<string | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isSectionDragging, setIsSectionDragging] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const commitEditingRef = useRef<(() => void) | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const sectionContainerRef = useRef<HTMLDivElement>(null);
  const sectionDropdownRef = useRef<HTMLDivElement>(null);
  const quickNameRef = useRef<HTMLInputElement>(null);

  const activeList = useMemo(
    () => lists.find(l => l.id === activeId) ?? lists[0] ?? null,
    [lists, activeId],
  );
  const listId = activeList?.id ?? '';

  useEffect(() => {
    if (activeList) {
      try { localStorage.setItem(ACTIVE_KEY, activeList.id); } catch { /* ignore */ }
    }
  }, [activeList]);

  // Long-press a trip tab to drag it — the same gesture as the Lists tab.
  const { dragId, dragOrder, justDraggedRef, tabHandlers } = useTabReorder({
    tabIds: lists.map(l => l.id),
    stripRef: tabStripRef,
    onReorder: (order) => packing.reorderLists(order),
  });
  const orderedTabs = useMemo(
    () => (dragOrder
      ? (dragOrder.map(id => lists.find(l => l.id === id)).filter(Boolean) as PackingList[])
      : lists),
    [dragOrder, lists],
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!sectionDropdownOpen) return;
    const glass = sectionDropdownRef.current?.closest('.glass');
    if (glass instanceof HTMLElement) { glass.style.zIndex = '20'; glass.style.position = 'relative'; }
    const onClick = (e: MouseEvent) => {
      if (sectionDropdownRef.current && !sectionDropdownRef.current.contains(e.target as Node)) {
        setSectionDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('mousedown', onClick);
      if (glass instanceof HTMLElement) { glass.style.zIndex = ''; glass.style.position = ''; }
    };
  }, [sectionDropdownOpen]);

  // ----- bags as chips -----

  const bags: Store[] = useMemo(
    () => (activeList?.bags ?? []).map(b => ({ id: b.id, name: b.name, position: b.position })),
    [activeList],
  );
  const selectedBagIds = useMemo(() => new Set(hideBags ? [] : selectedBags), [selectedBags, hideBags]);
  const excludedBagIds = useMemo(() => new Set(hideBags ? [] : excludedBags), [excludedBags, hideBags]);

  // Chip counts show what's still UNPACKED, matching the grocery chips.
  const bagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const section of activeList?.sections ?? []) {
      for (const item of section.items) {
        if (item.checked) continue;
        const key = item.bag_id ?? NONE_STORE_ID;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }, [activeList]);

  const progress = useMemo(
    () => (activeList ? bagProgress(activeList) : { bags: [], total: { id: '__total__', name: 'Total', packed: 0, total: 0, percent: 100 } }),
    [activeList],
  );

  const updatePrefs = onUpdateDisplayPrefs ?? (() => {});
  const updatePrefsRef = useRef(updatePrefs);
  updatePrefsRef.current = updatePrefs;

  const handleToggleBag = useCallback((bagId: string) => {
    const next = new Set(selectedBagIds);
    if (next.has(bagId)) next.delete(bagId); else next.add(bagId);
    updatePrefsRef.current({ selectedBags: [...next] });
  }, [selectedBagIds]);

  const handleExcludeBag = useCallback((bagId: string) => {
    const updates: { selectedBags?: string[]; excludedBags?: string[] } = {
      excludedBags: [...new Set(excludedBagIds).add(bagId)],
    };
    if (selectedBagIds.has(bagId)) updates.selectedBags = [...selectedBagIds].filter(id => id !== bagId);
    updatePrefsRef.current(updates);
  }, [selectedBagIds, excludedBagIds]);

  const handleIncludeBag = useCallback((bagId: string) => {
    updatePrefsRef.current({ excludedBags: [...excludedBagIds].filter(id => id !== bagId) });
  }, [excludedBagIds]);

  const handleReorderBags = useCallback((from: number, to: number) => {
    const ids = bags.map(b => b.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    packing.reorderBags(listId, ids);
  }, [bags, listId, packing]);

  // ----- sections / items -----

  const visibleSections = useMemo(() => {
    if (!activeList) return [];
    return activeList.sections
      .map(section => {
        let items = visibleSectionItems(section, { showChecked, sortBy });
        if (excludedBagIds.size > 0) {
          items = items.filter(i => !excludedBagIds.has(i.bag_id ?? NONE_STORE_ID));
        }
        if (selectedBagIds.size > 0) {
          items = items.filter(i => selectedBagIds.has(i.bag_id ?? NONE_STORE_ID));
        }
        return { section, items };
      })
      // A section with nothing left to show only stays visible when no filter
      // is hiding its contents (so empty sections remain addable-to).
      .filter(({ section, items }) =>
        items.length > 0 || (selectedBagIds.size === 0 && excludedBagIds.size === 0 && section.items.length === 0));
  }, [activeList, showChecked, sortBy, selectedBagIds, excludedBagIds]);

  const currentListItemNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of activeList?.sections ?? []) for (const i of s.items) names.add(i.name.toLowerCase());
    return names;
  }, [activeList]);

  // Suggestions come from every trip; the bag is remembered by NAME and
  // resolved against this list's bags.
  const itemDefaultsMap = useMemo(() => {
    const bagIdByName = new Map(bags.map(b => [b.name.toLowerCase(), b.id]));
    const map = new Map<string, ItemDefaultEntry>();
    for (const [name, s] of packing.itemSuggestions) {
      map.set(name, {
        storeId: s.bagName ? bagIdByName.get(s.bagName.toLowerCase()) ?? null : null,
        sectionName: s.sectionName,
      });
    }
    return map;
  }, [packing.itemSuggestions, bags]);

  const sectionOptions = useMemo(() => {
    const all = (activeList?.sections ?? [])
      .map(s => ({ id: s.id, name: s.name, isEmpty: s.items.length === 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const q = quickSection.trim().toLowerCase();
    return q ? all.filter(s => s.name.toLowerCase().includes(q)) : all;
  }, [activeList, quickSection]);

  const allSections = useMemo(
    () => (activeList?.sections ?? []).map(s => ({ id: s.id, name: s.name })),
    [activeList],
  );

  const toggleCollapsed = useCallback((sectionName: string) => {
    setCollapsedSections(prev => {
      const key = `${listId}:${sectionName}`;
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, [listId]);

  const handleEditingItemChange = useCallback((id: string | null) => {
    if (id !== null && editingItemId !== null && id !== editingItemId) commitEditingRef.current?.();
    setEditingItemId(id);
  }, [editingItemId]);

  // ----- drag: sections + cross-section items -----

  const handleSectionReorder = useCallback((from: number, to: number) => {
    const ids = visibleSections.map(v => v.section.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    // Sections hidden by a filter keep their relative place at the end.
    const hidden = (activeList?.sections ?? []).filter(s => !ids.includes(s.id)).map(s => s.id);
    packing.reorderSections(listId, [...ids, ...hidden]);
  }, [visibleSections, activeList, listId, packing]);

  const { dragState: sectionDragState, getDragHandlers: getSectionDragHandlers, getHandleMouseDown: getSectionHandleMouseDown } =
    useDragReorder({
      itemCount: visibleSections.length,
      onReorder: handleSectionReorder,
      containerRef: sectionContainerRef,
      onDragStart: () => setIsSectionDragging(true),
      onDragEnd: () => setIsSectionDragging(false),
    });

  const [crossDrag, setCrossDrag] = useState<{
    targetSectionId: string; targetIndex: number; itemHeight: number;
  } | null>(null);

  const findDropTarget = useCallback((sourceSectionId: string, clientY: number) => {
    if (!sectionContainerRef.current) return null;
    for (const el of sectionContainerRef.current.querySelectorAll('[data-section-id]')) {
      const id = (el as HTMLElement).dataset.sectionId;
      if (!id || id === sourceSectionId) continue;
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const container = el.querySelector('[data-item-container]');
      let targetIndex = 0;
      let itemHeight = 36;
      if (container) {
        const rows = container.querySelectorAll(':scope > [data-drag-index]');
        targetIndex = rows.length;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i].getBoundingClientRect();
          if (r.height > 0) {
            itemHeight = r.height;
            if (clientY < r.top + r.height / 2) { targetIndex = i; break; }
          }
        }
      }
      return { sectionId: id, targetIndex, itemHeight };
    }
    return null;
  }, []);

  const handleItemDragMove = useCallback((sourceSectionId: string, _from: number, clientY: number) => {
    const target = findDropTarget(sourceSectionId, clientY);
    setCrossDrag(prev => {
      if (!target) return prev ? null : prev;
      if (prev?.targetSectionId === target.sectionId && prev?.targetIndex === target.targetIndex) return prev;
      return { targetSectionId: target.sectionId, targetIndex: target.targetIndex, itemHeight: target.itemHeight };
    });
  }, [findDropTarget]);

  const handleItemDropOutside = useCallback((sourceSectionId: string, fromIndex: number, clientY: number) => {
    const target = findDropTarget(sourceSectionId, clientY);
    if (!target) return;
    const source = visibleSections.find(v => v.section.id === sourceSectionId);
    const dragged = source?.items[fromIndex];
    if (!dragged) return;
    // Drop index is into the FILTERED rows — resolve it to a real position in
    // the target section's full item list.
    const targetView = visibleSections.find(v => v.section.id === target.sectionId);
    const fullTarget = activeList?.sections.find(s => s.id === target.sectionId);
    let toPosition = fullTarget?.items.length ?? 0;
    if (targetView && fullTarget) {
      const anchor = targetView.items[target.targetIndex];
      if (anchor) {
        const idx = fullTarget.items.findIndex(i => i.id === anchor.id);
        toPosition = idx === -1 ? fullTarget.items.length : idx;
      }
    }
    packing.moveItem(listId, dragged.id, target.sectionId, toPosition);
  }, [findDropTarget, visibleSections, activeList, listId, packing]);

  const handleReorderItems = useCallback((sectionId: string, from: number, to: number) => {
    const view = visibleSections.find(v => v.section.id === sectionId);
    if (!view) return;
    const ids = view.items.map(i => i.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    packing.reorderItems(listId, sectionId, ids);
  }, [visibleSections, listId, packing]);

  // ----- actions -----

  const handleQuickAdd = useCallback(async () => {
    const name = quickName.trim();
    if (!name || !activeList) return;
    const sectionName = toTitleCase(quickSection.trim() || 'General');
    const section = await packing.createSection(activeList.id, sectionName);
    if (!section) return;
    await packing.addItem(activeList.id, section.id, name, quickQty > 0 ? String(quickQty) : null, quickBagId);
    setQuickName('');
    setQuickQty(0);
    requestAnimationFrame(() => quickNameRef.current?.focus());
  }, [quickName, quickSection, quickQty, quickBagId, activeList, packing]);

  // Exact-name match fills in the bag and section the item usually goes in.
  const applyQuickAddDefaults = useCallback((name: string) => {
    const key = name.trim().toLowerCase();
    if (!key) { setQuickBagId(null); return; }
    const d = itemDefaultsMap.get(key);
    setQuickBagId(d?.storeId ?? null);
    if (d?.sectionName) setQuickSection(d.sectionName);
  }, [itemDefaultsMap]);

  const handleInlineAdd = useCallback(async (sectionId: string) => {
    const name = newItemName.trim();
    if (!name || !activeList) return;
    const m = name.match(/^\((\d+)\)\s+(.+)$/);
    const bagId = itemDefaultsMap.get((m ? m[2] : name).toLowerCase())?.storeId ?? null;
    await packing.addItem(activeList.id, sectionId, m ? m[2] : name, m ? m[1] : null, bagId);
    setNewItemName('');
    setAddingToSection(null);
  }, [newItemName, activeList, packing, itemDefaultsMap]);

  const handleChangeItemSection = useCallback(async (itemId: string, targetName: string) => {
    if (!activeList) return;
    const from = activeList.sections.find(s => s.items.some(i => i.id === itemId));
    if (!from) return;
    const trimmed = toTitleCase(targetName.trim());
    if (!trimmed || trimmed.toLowerCase() === from.name.toLowerCase()) return;
    const target = await packing.createSection(activeList.id, trimmed);
    if (!target) return;
    await packing.moveItem(activeList.id, itemId, target.id, target.items.length);
  }, [activeList, packing]);

  const handleCreateList = useCallback(async () => {
    const name = newListName.trim();
    if (!name) return;
    const id = await packing.createList(name, newListColor);
    setActiveId(id);
    setNewListName('');
    setNewListOpen(false);
  }, [newListName, newListColor, packing]);

  // Name and color save together — one settings round-trip, one undo entry.
  const saveTrip = useCallback(() => {
    const name = tripName.trim();
    if (!activeList) return;
    const updates: { name?: string; color?: string | null } = {};
    if (name && name !== activeList.name) updates.name = name;
    if (tripColor !== activeList.color) updates.color = tripColor;
    if (Object.keys(updates).length > 0) packing.updateList(activeList.id, updates);
    setEditingTrip(false);
  }, [tripName, tripColor, activeList, packing]);

  const handleCopy = useCallback(() => {
    if (!activeList) return;
    const bagName = new Map(activeList.bags.map(b => [b.id, b.name]));
    const lines: string[] = [];
    for (const { section, items } of visibleSections) {
      if (items.length === 0) continue;
      lines.push(`[${section.name}]`);
      for (const item of items) {
        const qty = item.quantity ? `(${item.quantity}) ` : '';
        const bag = item.bag_id ? ` — ${bagName.get(item.bag_id) ?? ''}` : '';
        lines.push(`${item.checked ? '[x] ' : ''}${qty}${item.name}${bag}`);
      }
      lines.push('');
    }
    navigator.clipboard.writeText(lines.join('\n').trim());
    setMenuOpen(false);
  }, [activeList, visibleSections]);

  // Copying lands in ANOTHER trip, so nothing visibly changes here — say so.
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);
  const showFlash = useCallback((message: string) => {
    setFlash(message);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 4000);
  }, []);

  const handleCopySection = useCallback(async (sectionId: string, toListId: string) => {
    const target = lists.find(l => l.id === toListId);
    const result = await packing.copySectionToList(listId, sectionId, toListId);
    if (!result || !target) return;
    if (result.copied === 0) {
      showFlash(`“${target.name}” already has every item in that section`);
    } else {
      const skipped = result.skipped > 0 ? ` (${result.skipped} already there)` : '';
      showFlash(`Copied ${result.copied} item${result.copied === 1 ? '' : 's'} to “${target.name}”${skipped}`);
    }
  }, [lists, listId, packing, showFlash]);

  const notifyEdits = listNotifyOverrides[listId]?.edits ?? true;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="packing-loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  const anyChecked = (activeList?.sections ?? []).some(s => s.items.some(i => i.checked));
  const anyUnchecked = (activeList?.sections ?? []).some(s => s.items.some(i => !i.checked));

  return (
    <div
      className="edit-accent-scope"
      style={{ '--edit-accent': getEditHighlight(editHighlightColor).accent } as React.CSSProperties}
    >
      <div className="sticky z-[9] glass rounded-2xl mt-4 mb-2 p-3 space-y-3" style={{ top: 'calc(var(--header-h, 48px) + 24px)' }}>
        {/* List tabs */}
        <div className="flex items-center gap-2">
          <div ref={tabStripRef} className="flex-1 min-w-0 flex gap-2 overflow-x-auto no-scrollbar" data-testid="packing-tabs">
            {orderedTabs.map(l => (
              <button
                key={l.id}
                data-tab-id={l.id}
                {...tabHandlers(l.id)}
                onClick={() => { if (justDraggedRef.current) return; setActiveId(l.id); setMenuOpen(false); }}
                className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors flex items-center gap-1.5 select-none ${
                  dragId === l.id ? 'opacity-60 scale-105 ring-2 ring-blue-400' : ''
                } ${
                  l.id === listId
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full pointer-events-none ${colorBar(l.color)}`} />
                <span className="pointer-events-none">{l.name}</span>
              </button>
            ))}
            <button
              onClick={() => setNewListOpen(v => !v)}
              aria-label="New packing list"
              className="shrink-0 px-3 py-1.5 rounded-full text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              +
            </button>
          </div>
        </div>

        {newListOpen && (
          <div className="glass rounded-lg p-3 space-y-2">
            <input
              autoFocus
              value={newListName}
              onChange={e => setNewListName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateList(); if (e.key === 'Escape') setNewListOpen(false); }}
              placeholder="Trip name (e.g. Paris)"
              data-testid="new-list-name"
              className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex items-center gap-2">
              {LIST_COLORS.map(c => (
                <button
                  key={c.name}
                  aria-label={`Color ${c.name}`}
                  onClick={() => setNewListColor(c.name)}
                  className={`w-5 h-5 rounded-full ${c.bar} ${newListColor === c.name ? 'ring-2 ring-offset-1 ring-blue-500 dark:ring-offset-gray-800' : ''}`}
                />
              ))}
              <button
                onClick={handleCreateList}
                disabled={!newListName.trim()}
                data-testid="create-list"
                className="ml-auto px-3 py-1 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 rounded-lg"
              >
                Create
              </button>
            </div>
          </div>
        )}

        {activeList && (
          <>
            {/* Action bar */}
            <div className="flex items-center gap-2">
              {addOpen ? (
                <div className="flex-1 glass rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Add items</h3>
                    <button
                      onClick={() => setAddOpen(false)}
                      aria-label="Close add items"
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div className="flex items-center gap-2 mb-2">
                    <ItemAutocomplete
                      value={quickName}
                      testId="packing-quick-add-item"
                      onChange={v => { setQuickName(v); applyQuickAddDefaults(v); }}
                      onSelect={v => { setQuickName(v); applyQuickAddDefaults(v); }}
                      items={itemDefaultsMap}
                      currentListItemNames={currentListItemNames}
                      onDelete={() => { /* packing suggestions are derived, not stored */ }}
                      allowDelete={false}
                      inputRef={quickNameRef}
                      placeholder="Item name..."
                      onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); handleQuickAdd(); }
                        if (e.key === 'Escape') setAddOpen(false);
                      }}
                      className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => setQuickQty(q => Math.max(0, q - 1))} className="w-7 h-7 flex items-center justify-center rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm font-bold">&minus;</button>
                      <span className="w-6 text-center text-sm font-medium text-blue-600 dark:text-blue-400">{quickQty || '–'}</span>
                      <button onClick={() => setQuickQty(q => q + 1)} className="w-7 h-7 flex items-center justify-center rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 text-sm font-bold">+</button>
                    </div>
                  </div>

                  <div className="flex gap-2 mb-2 relative z-20">
                    <div className="relative flex-1 min-w-0" ref={sectionDropdownRef}>
                      <label className="block text-[10px] font-medium text-gray-400 dark:text-gray-500 mb-0.5 ml-1">Section</label>
                      <input
                        data-testid="packing-quick-add-section"
                        type="text"
                        value={quickSection}
                        onChange={e => { setQuickSection(e.target.value); setSectionDropdownOpen(true); }}
                        onFocus={e => { e.target.select(); setSectionDropdownOpen(true); }}
                        placeholder="General"
                        className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      {sectionDropdownOpen && sectionOptions.length > 0 && (
                        <div className="absolute z-30 left-0 right-0 mt-1 glass-menu rounded-lg max-h-40 overflow-y-auto shadow-lg">
                          {sectionOptions.map(s => (
                            <div key={s.id} className="flex items-center hover:bg-gray-100 dark:hover:bg-gray-700">
                              <button
                                onClick={() => { setQuickSection(s.name); setSectionDropdownOpen(false); requestAnimationFrame(() => quickNameRef.current?.focus()); }}
                                className="flex-1 text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300"
                              >
                                {s.name}
                              </button>
                              {s.isEmpty && (
                                <button
                                  onClick={e => { e.stopPropagation(); packing.deleteSection(listId, s.id); if (quickSection === s.name) setQuickSection(''); }}
                                  aria-label={`Delete section ${s.name}`}
                                  className="px-2 py-1 mr-1 text-red-400 hover:text-red-600"
                                >
                                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {!hideBags && (
                      <div className="flex-1 min-w-0">
                        <label className="block text-[10px] font-medium text-gray-400 dark:text-gray-500 mb-0.5 ml-1">Bag</label>
                        <StoreAutocomplete
                          stores={bags}
                          selectedStoreId={quickBagId}
                          onSelect={setQuickBagId}
                          onCreate={name => packing.createBag(listId, name)}
                          placeholder="Assign bag..."
                          emptyLabel="No bags yet"
                        />
                      </div>
                    )}
                  </div>

                  <button
                    data-testid="packing-quick-add-submit"
                    onClick={handleQuickAdd}
                    disabled={!quickName.trim()}
                    className="w-full py-1.5 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 rounded-lg"
                  >
                    Add Item
                  </button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setAddOpen(true)}
                    className="flex-1 py-3 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                  >
                    Add items
                  </button>

                  <div className="relative" ref={menuRef}>
                    <button
                      onClick={() => setMenuOpen(v => !v)}
                      aria-label="List options"
                      className="p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                      </svg>
                    </button>
                    {menuOpen && (
                      <div className="absolute right-0 top-full mt-1 glass-menu rounded-lg py-1 z-20 min-w-[240px]">
                        {anyUnchecked && (
                          <button
                            onClick={() => { packing.setAllChecked(listId, true); setMenuOpen(false); }}
                            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                          >
                            Check all items
                          </button>
                        )}
                        {anyChecked && (
                          <button
                            onClick={() => { packing.setAllChecked(listId, false); setMenuOpen(false); }}
                            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                          >
                            Uncheck all items
                          </button>
                        )}
                        <button
                          onClick={() => { updatePrefs({ showChecked: !showChecked }); setMenuOpen(false); }}
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          {showChecked ? 'Hide packed items' : 'Show packed items'}
                        </button>
                        <button
                          onClick={handleCopy}
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          Copy list
                        </button>

                        <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
                        <div className="px-4 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">Sort by</div>
                        <MenuRadioOption label="Manually" active={sortBy === 'manual'} onClick={() => updatePrefs({ sortBy: 'manual' })} />
                        <MenuRadioOption label="Alphabetically" active={sortBy === 'alphabetical'} onClick={() => updatePrefs({ sortBy: 'alphabetical' })} />
                        <button
                          onClick={() => { updatePrefs({ hideBags: !hideBags }); setMenuOpen(false); }}
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          {hideBags ? 'Show bags' : 'Hide bags'}
                        </button>

                        <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
                        <button
                          onClick={() => {
                            setTripName(activeList.name);
                            setTripColor(activeList.color);
                            setEditingTrip(true);
                            setMenuOpen(false);
                          }}
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                        >
                          Rename &amp; color
                        </button>
                        {activeList.is_owner && (
                          <button
                            onClick={() => { setShareOpen(true); setMenuOpen(false); }}
                            className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                          >
                            Share…{activeList.shared_with.length > 0 ? ` (${activeList.shared_with.length})` : ''}
                          </button>
                        )}
                        <button
                          onClick={() => { onSetListNotify?.(listId, { edits: !notifyEdits }); setMenuOpen(false); }}
                          disabled={!notifyEditsDefault}
                          title={notifyEditsDefault ? undefined : 'Turn on Travel notifications in Settings first'}
                          className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40"
                        >
                          {notifyEdits ? 'Mute notifications for this trip' : 'Unmute notifications for this trip'}
                        </button>

                        <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
                        {activeList.is_owner ? (
                          <button
                            onClick={() => { packing.deleteList(listId); setMenuOpen(false); }}
                            className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            Delete trip
                          </button>
                        ) : (
                          <button
                            onClick={() => { packing.leaveList(listId); setMenuOpen(false); }}
                            className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                          >
                            Leave trip
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => {
                      const next = !toolbarExpanded;
                      setToolbarExpanded(next);
                      try { localStorage.setItem(TOOLBAR_KEY, String(next)); } catch { /* ignore */ }
                    }}
                    aria-label={toolbarExpanded ? 'Hide bag progress' : 'Show bag progress'}
                    className="p-2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    <svg className={`w-4 h-4 transition-transform ${toolbarExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </>
              )}
            </div>

            {editingTrip && (
              <div className="glass rounded-lg p-3 space-y-2" data-testid="edit-trip">
                <input
                  autoFocus
                  value={tripName}
                  data-testid="edit-trip-name"
                  onChange={e => setTripName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') saveTrip();
                    if (e.key === 'Escape') setEditingTrip(false);
                  }}
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex items-center gap-2">
                  {LIST_COLORS.map(c => (
                    <button
                      key={c.name}
                      aria-label={`Color ${c.name}`}
                      onClick={() => setTripColor(c.name)}
                      className={`w-5 h-5 rounded-full ${c.bar} ${tripColor === c.name ? 'ring-2 ring-offset-1 ring-blue-500 dark:ring-offset-gray-800' : ''}`}
                    />
                  ))}
                  <button onClick={saveTrip} data-testid="edit-trip-save" className="ml-auto text-sm text-blue-500 font-medium">Save</button>
                  <button onClick={() => setEditingTrip(false)} className="text-sm text-gray-400">Cancel</button>
                </div>
              </div>
            )}

            {/* Trip progress (always) + per-bag rows and chips (unless hidden) */}
            {toolbarExpanded && (
              <>
                <BagProgressPanel bags={hideBags ? [] : progress.bags} total={progress.total} />
                {!hideBags && (
                <StoreFilterBar
                  stores={bags}
                  selectedStoreIds={selectedBagIds}
                  excludedStoreIds={excludedBagIds}
                  onToggleSelect={handleToggleBag}
                  onRemoveExclusion={handleIncludeBag}
                  onExclude={handleExcludeBag}
                  onRename={(id, name) => packing.renameBag(listId, id, name)}
                  onDelete={id => packing.deleteBag(listId, id)}
                  onReorder={handleReorderBags}
                  storeCounts={bagCounts}
                  noneCount={bagCounts.get(NONE_STORE_ID) ?? 0}
                />
                )}
              </>
            )}
          </>
        )}
      </div>

      {flash && (
        <div
          role="status"
          data-testid="packing-flash"
          className="mt-2 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {flash}
        </div>
      )}

      {lists.length === 0 && (
        <div className="glass rounded-lg p-6 text-center text-sm text-gray-500 dark:text-gray-400 mt-4">
          No packing lists yet. Tap <span className="font-semibold">+</span> to start one for your next trip.
        </div>
      )}

      {activeList && (
        <div ref={sectionContainerRef} className="mt-4">
          {visibleSections.map(({ section, items }, index) => {
            const isBeingDragged = sectionDragState.isDragging && sectionDragState.dragIndex === index;
            const shift = computeShiftTransform(index, sectionDragState);
            const packed = section.items.filter(i => i.checked).length;
            return (
              <div
                key={section.id}
                data-drag-index={index}
                data-section-id={section.id}
                className={index > 0 ? 'mt-4' : ''}
                style={{
                  opacity: isBeingDragged ? 0.3 : 1,
                  transform: shift || undefined,
                  transition: sectionDragState.isDragging ? 'transform 200ms ease-out, opacity 200ms' : undefined,
                }}
              >
                <ChecklistSectionCard
                  section={section}
                  visibleItems={items}
                  headerMeta={`${packed}/${section.items.length} packed`}
                  headerActions={
                    <SectionMenu
                      sectionName={section.name}
                      itemCount={section.items.length}
                      targets={lists.filter(l => l.id !== listId)}
                      onCopyTo={toListId => handleCopySection(section.id, toListId)}
                      onDelete={() => packing.deleteSection(listId, section.id)}
                    />
                  }
                  sectionDragHandlers={getSectionDragHandlers(index)}
                  sectionHandleMouseDown={getSectionHandleMouseDown(index)}
                  isSectionDragging={isSectionDragging}
                  isCollapsed={collapsedSections.has(`${listId}:${section.name}`)}
                  onToggleCollapse={() => toggleCollapsed(section.name)}
                  onToggle={(id, checked) => packing.toggleItem(listId, id, checked)}
                  onDelete={id => packing.deleteItem(listId, id)}
                  onEdit={(id, updates) => packing.editItem(listId, id, {
                    ...(updates.name !== undefined ? { name: updates.name } : {}),
                    ...(updates.quantity !== undefined ? { quantity: updates.quantity } : {}),
                    ...(updates.store_id !== undefined ? { bag_id: updates.store_id } : {}),
                  })}
                  onRenameSection={(sectionId, name) => packing.renameSection(listId, sectionId, name)}
                  onReorderItems={(from, to) => handleReorderItems(section.id, from, to)}
                  onItemDropOutside={(from, clientY) => handleItemDropOutside(section.id, from, clientY)}
                  onItemDragMove={(from, clientY) => handleItemDragMove(section.id, from, clientY)}
                  onItemDragEnd={() => setCrossDrag(null)}
                  crossDropTarget={crossDrag?.targetSectionId === section.id
                    ? { targetIndex: crossDrag.targetIndex, itemHeight: crossDrag.itemHeight } : null}
                  addingToSection={addingToSection}
                  onStartAdd={setAddingToSection}
                  newItemName={newItemName}
                  onNewItemNameChange={setNewItemName}
                  onAddItem={handleInlineAdd}
                  chips={bags}
                  chipIdFor={item => (item as PackingItem).bag_id}
                  onCreateChip={name => packing.createBag(listId, name)}
                  chipPlaceholder="Assign bag..."
                  editingItemId={editingItemId}
                  onEditingItemChange={handleEditingItemChange}
                  commitEditingRef={commitEditingRef}
                  itemDefaultsMap={itemDefaultsMap}
                  currentListItemNames={currentListItemNames}
                  onDeleteItemDefault={() => { /* derived suggestions — nothing to delete */ }}
                  allSections={allSections}
                  editHighlightColor={editHighlightColor}
                  onChangeSection={handleChangeItemSection}
                  hideChips={hideBags}
                  itemDragEnabled={sortBy === 'manual'}
                  allowEditWhenChecked
                />
              </div>
            );
          })}

          {activeList.sections.length === 0 && (
            <div className="glass rounded-lg p-6 text-center text-sm text-gray-500 dark:text-gray-400">
              Nothing packed yet. Use <span className="font-semibold">Add items</span> to build the list.
            </div>
          )}
        </div>
      )}

      {shareOpen && activeList && (
        <PackingShareModal
          list={activeList}
          isOnline={isOnline}
          currentSub={user.sub}
          onShare={sub => packing.shareList(activeList.id, { sub })}
          onUnshare={sub => packing.unshareList(activeList.id, sub)}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}

// ----- per-section menu (copy this section into another trip) -----

function SectionMenu({ sectionName, itemCount, targets, onCopyTo, onDelete }: {
  sectionName: string;
  itemCount: number;
  targets: PackingList[];
  onCopyTo: (toListId: string) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Deleting takes the items too, so a non-empty section asks first.
  const [confirming, setConfirming] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu is portalled to <body> and positioned by hand. Anchoring it inside
  // the card doesn't work: .glass sets backdrop-filter, which makes every
  // section card its own stacking context — so the menu's z-index only ranked
  // it against its own card's contents, leaving it painted under the following
  // sections and under the fixed bottom nav, where it couldn't be clicked.
  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(8, window.innerWidth - rect.right);
    // Flip up when there isn't room below — that's where the nav island sits.
    const MENU_MAX = 280;
    if (window.innerHeight - rect.bottom < MENU_MAX) {
      setPos({ bottom: window.innerHeight - rect.top + 6, right });
    } else {
      setPos({ top: rect.bottom + 6, right });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const close = () => { setOpen(false); setConfirming(false); };
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close();
    };
    // Keep it glued to the button while the page moves under it.
    const reposition = () => place();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Options for ${sectionName}`}
        // The header itself is a drag handle for the section — don't start a
        // drag or collapse when the menu is tapped.
        onPointerDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        className="px-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          data-testid="section-menu"
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, right: pos.right }}
          // Above the bottom nav island (z-30) and every card's own context.
          className="z-[60] glass-menu rounded-lg py-1 min-w-[220px] max-h-[60vh] overflow-y-auto shadow-lg"
          onClick={e => e.stopPropagation()}
        >
          <div className="px-4 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Copy section to
          </div>
          {targets.length === 0 ? (
            <div className="px-4 py-2 text-sm text-gray-400">No other trips yet</div>
          ) : targets.map(t => (
            <button
              key={t.id}
              onClick={() => { setOpen(false); onCopyTo(t.id); }}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {t.name}
            </button>
          ))}

          <div className="my-1 border-t border-gray-200 dark:border-gray-700" />
          {confirming ? (
            <div className="px-4 py-2 space-y-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Delete “{sectionName}”{itemCount > 0 ? ` and its ${itemCount} item${itemCount === 1 ? '' : 's'}` : ''}?
              </p>
              <div className="flex items-center justify-end gap-3">
                <button onClick={() => setConfirming(false)} className="text-sm text-gray-400">Cancel</button>
                <button
                  data-testid="confirm-delete-section"
                  onClick={() => { setConfirming(false); setOpen(false); onDelete(); }}
                  className="text-sm font-medium text-red-600 dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => (itemCount > 0 ? setConfirming(true) : (setOpen(false), onDelete()))}
              className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              Delete section{itemCount > 0 ? ` (${itemCount})` : ''}
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

// ----- bag progress table (replaces the spreadsheet's "% Pack" column) -----

function BagProgressPanel({ bags, total }: {
  bags: { id: string; name: string; packed: number; total: number; percent: number }[];
  total: { packed: number; total: number; percent: number };
}) {
  // Percentages render without trailing zeros (100%, 50%, 33.3%).
  if (total.total === 0) return null;
  return (
    <div className="space-y-1" data-testid="bag-progress">
      {bags.map(bag => {
        const done = bag.percent >= 100;
        return (
          <div key={bag.id} className="flex items-center gap-2 text-xs">
            <span className={`w-28 shrink-0 truncate ${done ? 'line-through text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-300'}`}>
              {bag.name}
            </span>
            <div className="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
              <div
                className={`h-full rounded-full ${done ? 'bg-emerald-500' : 'bg-blue-500'}`}
                style={{ width: `${bag.percent}%` }}
              />
            </div>
            <span className={`w-24 text-right tabular-nums ${done ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-500 dark:text-gray-400'}`}>
              {bag.packed}/{bag.total}
              <span className="ml-1.5 opacity-70">{bag.percent}%</span>
            </span>
          </div>
        );
      })}
      <div className={`flex items-center gap-2 text-xs font-semibold ${bags.length > 0 ? 'pt-1 border-t border-gray-200 dark:border-gray-700' : ''}`}>
        <span className="w-28 shrink-0 text-gray-700 dark:text-gray-200">Total</span>
        <div className="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
          <div className="h-full rounded-full bg-blue-600" style={{ width: `${total.percent}%` }} />
        </div>
        <span className="w-24 text-right tabular-nums text-gray-700 dark:text-gray-200">
          {total.packed}/{total.total}
          <span className="ml-1.5 opacity-70">{total.percent}%</span>
        </span>
      </div>
    </div>
  );
}

// ----- share modal -----

function PackingShareModal({ list, isOnline, currentSub, onShare, onUnshare, onClose }: {
  list: PackingList;
  isOnline: boolean;
  currentSub: string;
  onShare: (sub: string) => Promise<void>;
  onUnshare: (sub: string) => Promise<void>;
  onClose: () => void;
}) {
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOnline) return;
    getUsers().then(setDirectory).catch(() => {});
  }, [isOnline]);

  const sharedSubs = new Set(list.shared_with.map(u => u.sub));
  const candidates = directory.filter(u => !sharedSubs.has(u.sub) && u.sub !== list.owner_sub && u.sub !== currentSub);

  const doShare = async (sub: string) => {
    setBusy(true);
    setError(null);
    try { await onShare(sub); } catch { setError('Could not share. Try again.'); } finally { setBusy(false); }
  };

  return createPortal(
    <div className="fixed left-0 right-0 top-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" style={{ height: 'var(--vvh, 100dvh)' }} onClick={onClose}>
      <div className="glass-menu w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl max-h-full overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Share "{list.name}"</h3>
            <button onClick={onClose} aria-label="Close" className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>

          {!isOnline && (
            <div className="rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              You're offline — sharing needs a connection.
            </div>
          )}

          {list.shared_with.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs uppercase tracking-wide text-gray-400">Shared with</div>
              {list.shared_with.map(u => (
                <div key={u.sub} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-gray-50 dark:bg-gray-800/40">
                  <span className="text-sm text-gray-700 dark:text-gray-200">{u.name || u.email || u.sub}</span>
                  <button
                    disabled={!isOnline}
                    onClick={() => onUnshare(u.sub).catch(() => {})}
                    className="text-xs text-red-500 hover:underline disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Add person</div>
            {!isOnline ? (
              <p className="text-sm text-gray-400">Reconnect to add people to this trip.</p>
            ) : candidates.length === 0 ? (
              <p className="text-sm text-gray-400">No other users available yet — people appear here once they've signed in.</p>
            ) : (
              <select
                value=""
                disabled={busy}
                aria-label="Add person"
                onChange={e => { if (e.target.value) doShare(e.target.value); }}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 text-gray-900 dark:text-gray-100 text-sm disabled:opacity-50"
              >
                <option value="">Select a person…</option>
                {candidates.map(u => <option key={u.sub} value={u.sub}>{u.name || u.email || u.sub}</option>)}
              </select>
            )}
            {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
          </div>

          <p className="text-xs text-gray-400">Packing lists are private to you until you share them. People you share with can view and update everything.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
