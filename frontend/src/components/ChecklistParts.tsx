import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Store, ItemDefaultEntry, RecipeRef } from '../types';
import { useDragReorder, computeShiftTransform } from '../hooks/useDragReorder';
import { StoreAutocomplete } from './StoreAutocomplete';
import { ItemAutocomplete } from './ItemAutocomplete';
import { useScrollIntoViewOnEdit } from '../hooks/useScrollIntoViewOnEdit';
import { useCommitOnKeyboardDismiss } from '../hooks/useCommitOnKeyboardDismiss';
import { exitEditAnchored } from '../utils/exitEditAnchored';
import { closeOnBlurOutside } from '../utils/closeOnBlurOutside';
import { kbFocus, kbLog } from '../utils/kbdebug';
import { getEditHighlight } from '../utils/editHighlightColors';
import { parseQuantity } from '../utils/quantity';
import { useOptionalUndo } from '../contexts/UndoContext';

// Presentational building blocks shared by the Grocery tab and the Lists
// (packing) tab. Both are "sectioned checklist with a chip per item", so the
// row, the section card, the section combobox and the menu radio live here
// once. The only vocabulary difference is the chip: grocery calls it a store,
// the Lists tab calls it a tag — hence the neutral `chip*` prop names.
//
// A chip is structurally a Store ({id, name, position}); PackingBag satisfies
// the same shape.

export const NONE_STORE_ID = '__none__';

/** The subset of an item both checklists share. */
export interface ChecklistItem {
  id: string;
  section_id: string;
  name: string;
  quantity: string | null;
  checked: boolean;
  position: number;
  // Grocery-only (Recipe Keeper attribution); Lists/Travel items never set
  // this, so it's always absent there and the recipe line never renders.
  recipes?: RecipeRef[];
}

export interface ChecklistSectionLike {
  id: string;
  name: string;
  position: number;
  items: ChecklistItem[];
}

type DragHandlers = ReturnType<ReturnType<typeof useDragReorder>['getDragHandlers']>;

// ----- section name combobox (used inside the item edit form) -----

export function SectionCombobox({ sections, value, onChange }: {
  sections: { id: string; name: string }[];
  value: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionInputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const sorted = [...sections].sort((a, b) => a.name.localeCompare(b.name));
    const q = value.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(s => s.name.toLowerCase().includes(q));
  }, [sections, value]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={sectionInputRef}
        type="text"
        value={value}
        placeholder="Section"
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-sm text-sm py-0.5 pl-2 pr-7 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-1 focus:ring-blue-500"
      />
      {value.trim() && (
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => { onChange(''); setOpen(true); sectionInputRef.current?.focus(); }}
          aria-label="Clear section"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      {open && matches.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 glass-menu rounded-lg shadow-lg z-20 max-h-40 overflow-y-auto">
          {matches.map(s => (
            <button
              key={s.id}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(s.name); setOpen(false); }}
              className="block w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ----- kebab-menu radio option -----

export function MenuRadioOption({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-4 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
    >
      <span>{label}</span>
      {active && (
        <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      )}
    </button>
  );
}

// ----- recipe vs. store visual language -----
//
// Stores/bags are solid-filled chips (StoreFilterBar's default styling);
// recipes are outlined chips led by this icon, both in the filter bar and on
// the item row's recipe line. The pairing (icon + outline vs. solid fill) is
// the whole point — it must not depend on color alone, so it survives
// greyscale and colorblind viewing. Purely decorative (aria-hidden): the
// surrounding button/label already carries the accessible name.
export function RecipeIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      data-testid="recipe-icon"
      className={`${className} shrink-0 pointer-events-none`}
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M8 3v6M12 3v6M16 3v6M8 9h8M12 9v12" />
    </svg>
  );
}

// ----- recipe attribution line + all-recipes popover -----

// Units on the item that aren't linked to any recipe (see CLAUDE.md "Recipe
// Keeper Sync" — quantity is authoritative, links are a subset of it).
// Rendered as a final unlabelled "No recipe (N)" row in the popover so the
// count still adds up to the item's full quantity.
//
// Must subtract the SUM of each ref's `count`, not `recipes.length` —
// Recipe Keeper stores one link per recipe-ingredient occurrence, so an item
// added to the same recipe six times collapses to ONE ref with count 6.
// Using the ref count there produced a phantom "No recipe" row for an item
// that was fully accounted for (e.g. quantity 6, one recipe, `6 - 1 = 5`).
function mpOnlyUnits(quantity: string | null, recipes: RecipeRef[]): number {
  const linked = recipes.reduce((sum, r) => sum + (r.count ?? 1), 0);
  return Math.max(0, parseQuantity(quantity) - linked);
}

/**
 * Secondary text under an item's name naming which recipe(s) it came from,
 * truncated to two names plus "+N". Tapping opens a popover listing every
 * recipe — required, not decorative, since truncation with no way to see the
 * rest defeats the point of attribution.
 *
 * Portals to <body> with fixed coordinates rather than rendering inline:
 * `.glass` gives every card its own stacking context (backdrop-filter does
 * that), so a nested popover would paint under later sibling cards and the
 * fixed bottom nav where it can't be tapped. Same pattern as the Lists-tab
 * per-section menu (PackingListsView's SectionMenu).
 */
function RecipeLine({ recipes, quantity, hidden }: { recipes: RecipeRef[]; quantity: string | null; hidden?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const POPOVER_WIDTH = 240;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
    const POPOVER_MAX = 280;
    if (window.innerHeight - rect.bottom < POPOVER_MAX) {
      setPos({ bottom: window.innerHeight - rect.top + 6, left });
    } else {
      setPos({ top: rect.bottom + 6, left });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
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

  if (hidden || recipes.length === 0) return null;

  const shown = recipes.slice(0, 2).map(r => r.title);
  const extra = recipes.length - shown.length;
  const label = shown.join(', ') + (extra > 0 ? ` +${extra}` : '');
  const noRecipeCount = mpOnlyUnits(quantity, recipes);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="recipe-chip"
        aria-label={`Recipe: ${label}`}
        // The row's onClick starts rename editing — this must not bubble.
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="flex items-center gap-1 max-w-full text-left text-xs text-gray-400 dark:text-gray-500 leading-tight hover:text-gray-600 dark:hover:text-gray-300"
      >
        <RecipeIcon className="w-2.5 h-2.5" />
        <span className="truncate min-w-0">{label}</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          data-testid="recipe-popover"
          role="dialog"
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left }}
          className="z-60 glass-menu rounded-lg py-1 min-w-[180px] max-w-[240px] max-h-[60vh] overflow-y-auto shadow-lg"
          onClick={e => e.stopPropagation()}
        >
          <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Recipes
          </div>
          {recipes.map(r => (
            <div key={r.id} className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 truncate">
              {r.title}{(r.count ?? 1) > 1 ? ` ×${r.count}` : ''}
            </div>
          ))}
          {noRecipeCount > 0 && (
            <div className="px-3 py-1.5 text-sm text-gray-400 dark:text-gray-500 border-t border-gray-200 dark:border-gray-700 mt-1 pt-1.5">
              No recipe ({noRecipeCount})
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}

// ----- item row -----

export interface ChecklistItemRowProps {
  item: ChecklistItem;
  onToggle: (id: string, checked: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, updates: { name?: string; quantity?: string | null; store_id?: string | null }) => void;
  dragHandlers?: DragHandlers;
  handleMouseDown?: (e: React.MouseEvent) => void;
  isDragging?: boolean;
  /** Stores (grocery) or tags (Lists). */
  chips: Store[];
  /** Which chip this item is assigned to. */
  chipId: string | null;
  onCreateChip: (name: string) => Promise<Store | null>;
  chipPlaceholder?: string;
  editingItemId: string | null;
  onEditingItemChange: (id: string | null) => void;
  commitEditingRef: React.MutableRefObject<(() => void) | null>;
  sectionName: string;
  allSections: { id: string; name: string }[];
  editHighlightColor: string;
  onChangeSection: (itemId: string, targetSectionName: string) => void;
  hideChips?: boolean;
  /** Lists let you fix a typo on an already-completed item; grocery doesn't. */
  allowEditWhenChecked?: boolean;
  /** Grocery only: "Hide recipes" drops the per-item recipe line (and the
   *  filter chips) without touching what's filtered. */
  hideRecipes?: boolean;
  /** Identity used to match against `editingItemId` for THIS rendered copy
   *  of the row. Defaults to `item.id`, which is correct whenever an item
   *  renders exactly once (grocery sections, flat/"none" view, Lists/
   *  packing). Grocery's group-by-recipe view renders a collapsed item once
   *  per recipe it belongs to, so it passes a composite key (e.g.
   *  `${group.id}-${item.id}`) per copy — only the tapped copy then matches
   *  editingItemId and mounts an edit form, so two copies can never both
   *  satisfy the comparison and stomp the shared commitEditingRef. It also
   *  means editingItemId left over from a different view (a bare item id,
   *  or a different view's composite key) never coincidentally matches
   *  here, so a stale edit never appears mounted after switching views
   *  without committing. */
  editId?: string;
}

export function ChecklistItemRow({
  item, onToggle, onDelete, onEdit, dragHandlers, handleMouseDown, isDragging,
  chips, chipId, onCreateChip, chipPlaceholder,
  editingItemId, onEditingItemChange, commitEditingRef,
  sectionName, allSections, onChangeSection, editHighlightColor,
  hideChips = false, allowEditWhenChecked = false, hideRecipes = false, editId,
}: ChecklistItemRowProps) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwipeRevealed, setIsSwipeRevealed] = useState(false);
  const rowEditId = editId ?? item.id;
  const isEditing = editingItemId === rowEditId;
  const [editName, setEditName] = useState(item.name);
  const [editQuantity, setEditQuantity] = useState(item.quantity ?? '');
  const [editChipId, setEditChipId] = useState<string | null>(chipId);
  const [editSectionName, setEditSectionName] = useState(sectionName);
  const touchStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const swipeModeRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // A <form>, not a <div>: iOS's keyboard shows previous/next arrows that
  // walk the fields sharing a FORM OWNER. Without a form element the grouping
  // is left to Safari's heuristics, which linked the name and category boxes
  // but not the store/tag one, so there was no way to reach it from the
  // keyboard. `input.form` is what the arrows key off, and only a <form>
  // ancestor sets it.
  const editFormRef = useRef<HTMLFormElement>(null);
  useScrollIntoViewOnEdit(editFormRef, isEditing);

  const chipName = chips?.find(s => s.id === chipId)?.name;

  const SWIPE_THRESHOLD = 50;
  const SWIPE_MAX = 80;

  const commitEditRef = useRef<(() => void) | null>(null) as React.MutableRefObject<(() => void) | null>;
  // Grouped when an UndoProvider is in scope (always, in the app); run
  // straight through when there isn't one (bare renders in tests).
  const undoCtx = useOptionalUndo();
  const runAsUndoGroup = undoCtx?.runAsUndoGroup ?? (async (_type: string, fn: () => void | Promise<void>) => { await fn(); });

  const exitEditMode = useCallback(() => {
    const anchor = (editFormRef.current?.closest('[data-drag-index]') ?? editFormRef.current) as HTMLElement | null;
    exitEditAnchored(anchor, () => onEditingItemChange(null));
  }, [onEditingItemChange]);

  const startEditing = useCallback(() => {
    if (item.checked && !allowEditWhenChecked) return;
    setEditName(item.name);
    setEditQuantity(item.quantity ?? '');
    setEditChipId(chipId);
    setEditSectionName(sectionName);
    onEditingItemChange(rowEditId);
  }, [rowEditId, item.name, item.quantity, item.checked, chipId, sectionName, onEditingItemChange, allowEditWhenChecked]);

  const commitEdit = useCallback(() => {
    const trimmedName = editName.trim();
    kbLog('commitEdit', { editName, itemName: item.name, editQuantity, itemQuantity: item.quantity ?? null, focus: kbFocus() });
    if (!trimmedName) {
      kbLog('commitEdit:empty-exit');
      exitEditMode();
      return;
    }

    const updates: { name?: string; quantity?: string | null; store_id?: string | null } = {};
    if (trimmedName !== item.name) updates.name = trimmedName;
    const qtyNum = parseInt(editQuantity) || 0;
    const newQty = qtyNum > 0 ? String(qtyNum) : null;
    if (newQty !== item.quantity) updates.quantity = newQty;
    if (editChipId !== chipId) updates.store_id = editChipId;

    kbLog(Object.keys(updates).length > 0 ? 'commitEdit:saving' : 'commitEdit:nothing-changed', { updates });
    // Empty section box falls back to the same default category quick-add uses
    const targetSection = editSectionName.trim() || 'Default';
    const movingSection = targetSection.toLowerCase() !== sectionName.toLowerCase();
    // ONE undo entry for one commit. These are two mutations and each pushes
    // its own entry, so changing a name and a category together used to take
    // two undos and show a half-reverted item in between. Awaited in order:
    // the edit has to land before the move, because moveItem rebuilds the
    // whole list from its own snapshot.
    void runAsUndoGroup('edit-grocery-item-fields', async () => {
      if (Object.keys(updates).length > 0) {
        await onEdit(item.id, updates);
      }
      if (movingSection) {
        await onChangeSection(item.id, targetSection);
      }
    });
    exitEditMode();
  }, [editName, editQuantity, editChipId, editSectionName, sectionName, item.id, item.name, item.quantity, chipId, onEdit, onChangeSection, exitEditMode, runAsUndoGroup]);

  // Dismissing the keyboard with its own key saves, like tapping Save.
  useCommitOnKeyboardDismiss(editFormRef, isEditing, commitEdit);

  const cancelEdit = useCallback(() => {
    exitEditMode();
    setEditName(item.name);
    setEditQuantity(item.quantity ?? '');
    setEditChipId(chipId);
    setEditSectionName(sectionName);
  }, [item.name, item.quantity, chipId, sectionName, exitEditMode]);

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
      <form
        ref={editFormRef}
        // Nothing here submits — the buttons below carry type="button" and
        // this catches every other route (implicit submission on Enter, and
        // any untyped button inside StoreAutocomplete/SectionCombobox).
        onSubmit={e => e.preventDefault()}
        // On the FORM, not the name input: iOS's dismiss key fires focusout
        // from whichever field had focus, and the quantity, section and chip
        // fields are all part of the same edit. Blurring out of any of them
        // commits the whole form; moving between them does not (focusout
        // bubbles, and closeOnBlurOutside re-checks where focus landed).
        onBlur={() => {
          kbLog('editRow:form-blur', { editName, editSectionName, editChipId, focus: kbFocus() });
          closeOnBlurOutside(editFormRef, commitEdit);
        }}
        className={`px-4 py-1.5 space-y-1.5 ${getEditHighlight(editHighlightColor).form}`}
      >
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setEditQuantity(String(Math.max(0, qtyNum - 1) || ''))}
              className="w-7 h-7 flex items-center justify-center rounded-sm bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 text-sm font-bold"
            >
              −
            </button>
            <span className="w-8 text-center text-sm font-medium text-blue-600 dark:text-blue-400">
              {qtyNum || '–'}
            </span>
            <button
              type="button"
              onClick={() => setEditQuantity(String(qtyNum + 1))}
              className="w-7 h-7 flex items-center justify-center rounded-sm bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 text-sm font-bold"
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
            className="flex-1 min-w-0 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-sm text-sm py-0.5 px-2 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <SectionCombobox
          sections={allSections}
          value={editSectionName}
          onChange={setEditSectionName}
        />
        {!hideChips && (
          <StoreAutocomplete
            stores={chips}
            selectedStoreId={editChipId}
            onSelect={setEditChipId}
            onCreate={onCreateChip}
            placeholder={chipPlaceholder}
          />
        )}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={cancelEdit}
            className="text-gray-400 hover:text-gray-600 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commitEdit}
            className="text-blue-500 hover:text-blue-600 text-sm font-medium"
          >
            Save
          </button>
        </div>
      </form>
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
            className="drag-handle w-3.5 h-3.5 text-gray-300 dark:text-gray-600 shrink-0 mt-0.5 cursor-grab active:cursor-grabbing"
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
          aria-label={item.checked ? `Uncheck ${item.name}` : `Check ${item.name}`}
          className={`
            shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center mt-0.5
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
              min-w-0 wrap-break-word cursor-pointer
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
          {chipName && !hideChips && (
            <div className="text-xs text-gray-400 dark:text-gray-500 leading-tight">
              {chipName}
            </div>
          )}
          <RecipeLine recipes={item.recipes ?? []} quantity={item.quantity} hidden={hideRecipes} />
        </div>

        {/* Desktop delete button */}
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          className="hover-delete-btn shrink-0 items-center ml-1 text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400"
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

// ----- section card -----

export interface ChecklistSectionCardProps {
  section: ChecklistSectionLike;
  /** Rows to render, already filtered/ordered by the parent. Drag indices are
   *  indices into THIS array. */
  visibleItems: ChecklistItem[];
  sectionDragHandlers: DragHandlers;
  sectionHandleMouseDown: (e: React.MouseEvent) => void;
  isSectionDragging: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onToggle: (id: string, checked: boolean) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, updates: { name?: string; quantity?: string | null; store_id?: string | null }) => void;
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
  /** Store (grocery) / tag (Lists) for the inline add form. Shown as a second
   *  line so the auto-populated value is visible and can be overridden before
   *  adding — it used to be applied invisibly from the item defaults. */
  newItemChipId: string | null;
  onNewItemChipChange: (chipId: string | null) => void;
  onAddItem: (sectionId: string) => void;
  chips: Store[];
  chipIdFor: (item: ChecklistItem) => string | null;
  onCreateChip: (name: string) => Promise<Store | null>;
  chipPlaceholder?: string;
  editingItemId: string | null;
  onEditingItemChange: (id: string | null) => void;
  commitEditingRef: React.MutableRefObject<(() => void) | null>;
  itemDefaultsMap: Map<string, ItemDefaultEntry>;
  currentListItemNames: Set<string>;
  onDeleteItemDefault: (itemName: string) => void;
  allSections: { id: string; name: string }[];
  editHighlightColor: string;
  onChangeSection: (itemId: string, targetSectionName: string) => void;
  hideChips?: boolean;
  itemDragEnabled?: boolean;
  allowEditWhenChecked?: boolean;
  hideRecipes?: boolean;
  /** Replaces the default "N items" header label (Lists shows "3/7 completed"). */
  headerMeta?: React.ReactNode;
  /** Optional controls in the header, left of the count (Lists puts its
   *  per-section menu here). Grocery passes nothing. */
  headerActions?: React.ReactNode;
}

export function ChecklistSectionCard({
  section,
  visibleItems,
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
  newItemChipId,
  onNewItemChipChange,
  onAddItem,
  chips,
  chipIdFor,
  onCreateChip,
  chipPlaceholder,
  editingItemId,
  onEditingItemChange,
  commitEditingRef,
  itemDefaultsMap,
  currentListItemNames,
  onDeleteItemDefault,
  allSections,
  editHighlightColor,
  onChangeSection,
  hideChips = false,
  itemDragEnabled = true,
  allowEditWhenChecked = false,
  hideRecipes = false,
  headerMeta,
  headerActions,
}: ChecklistSectionCardProps) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const itemContainerRef = useRef<HTMLDivElement>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState(section.name);
  const headerInputRef = useRef<HTMLInputElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  // See the note on the edit row's editFormRef: a <form> is what gives the
  // keyboard's previous/next arrows a field set to walk.
  const addFormRef = useRef<HTMLFormElement>(null);
  useScrollIntoViewOnEdit(addFormRef, addingToSection === section.id);

  const commitRename = useCallback(() => {
    const trimmed = editNameValue.trim();
    if (trimmed && trimmed !== section.name) {
      onRenameSection(section.id, trimmed);
    }
    setIsEditingName(false);
  }, [editNameValue, section.id, section.name, onRenameSection]);

  // Add stays open after a successful add (rapid entry) instead of unmounting
  // the still-focused input — that unmount is what triggers iOS's visual-
  // viewport "jump to top" bug. The Add button's onMouseDown below prevents
  // the default focus-shift so the input (and the iOS keyboard) never loses
  // focus in the first place — the real fix, since a `.focus()` call after
  // an await can't reopen a keyboard iOS already closed outside a user-
  // gesture context. This `.focus()` is now just belt-and-braces (e.g. in
  // case something else ever steals focus during the add) — harmless since
  // the input never unmounts here, so it's a no-op the rest of the time.
  const handleAdd = useCallback(() => {
    Promise.resolve(onAddItem(section.id)).then(() => {
      addInputRef.current?.focus();
    });
  }, [onAddItem, section.id]);

  // Cancel / Escape still unmount the form, so anchor the scroll position on
  // the section itself across that change (see exitEditAnchored).
  const closeAdd = useCallback(() => {
    exitEditAnchored(sectionRef.current, () => onStartAdd(null));
  }, [onStartAdd]);

  // Dismissing the keyboard (or otherwise moving focus out of the form)
  // ADDS what was typed, then closes. It used to just close and leave the
  // text for next time, which read as "my item vanished" — the Add button
  // was the only thing that worked. Closing matters as much as adding: a
  // form left mounted with the keyboard gone is the one state whose scroll
  // position cannot be held, and exitEditAnchored needs the unmount.
  const commitAddAndClose = useCallback(() => {
    if (!newItemName.trim()) {
      closeAdd();
      return;
    }
    Promise.resolve(onAddItem(section.id)).finally(closeAdd);
  }, [newItemName, onAddItem, section.id, closeAdd]);

  useEffect(() => {
    if (isEditingName && headerInputRef.current) {
      headerInputRef.current.focus();
      headerInputRef.current.select();
    }
  }, [isEditingName]);

  const { dragState: itemDragState, getDragHandlers: getItemDragHandlers, getHandleMouseDown: getItemHandleMouseDown } = useDragReorder({
    itemCount: visibleItems.length,
    onReorder: onReorderItems,
    containerRef: itemContainerRef,
    onDropOutside: onItemDropOutside,
    onDragMove: onItemDragMove,
    onDragEnd: onItemDragEnd,
  });

  return (
    <div ref={sectionRef} className="glass rounded-lg">
      {/* Section Header -- long-press to drag section */}
      <div
        className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-600 flex items-center justify-between px-4 py-2 rounded-t-lg"
        {...sectionDragHandlers}
      >
        <div className="flex items-center gap-2">
          <svg
            className="drag-handle w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0 cursor-grab active:cursor-grabbing"
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
              className="font-semibold text-sm bg-white dark:bg-gray-700 border rounded-sm px-1.5 py-0.5 text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-1 min-w-0"
              style={{ borderColor: 'var(--edit-accent)' }}
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
        <div className="flex items-center gap-1">
        {headerActions}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          className="flex items-center gap-1 text-gray-400 dark:text-gray-500 text-xs hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        >
          {headerMeta ?? `${visibleItems.length} item${visibleItems.length !== 1 ? 's' : ''}`}
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
      </div>

      {/* Items — collapse during section drag or manual collapse */}
      <div style={{ display: (isSectionDragging || isCollapsed) ? 'none' : undefined }}>
        <div className="py-1" ref={itemContainerRef} data-item-container>
          {visibleItems.map((item, index) => {
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
                <ChecklistItemRow
                  item={item}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onEdit={onEdit}
                  dragHandlers={itemDragEnabled ? getItemDragHandlers(index) : undefined}
                  handleMouseDown={itemDragEnabled ? getItemHandleMouseDown(index) : undefined}
                  isDragging={itemDragState.isDragging}
                  chips={chips}
                  chipId={chipIdFor(item)}
                  onCreateChip={onCreateChip}
                  chipPlaceholder={chipPlaceholder}
                  editingItemId={editingItemId}
                  onEditingItemChange={onEditingItemChange}
                  commitEditingRef={commitEditingRef}
                  sectionName={section.name}
                  allSections={allSections}
                  editHighlightColor={editHighlightColor}
                  onChangeSection={onChangeSection}
                  hideChips={hideChips}
                  allowEditWhenChecked={allowEditWhenChecked}
                  hideRecipes={hideRecipes}
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
            <form
              ref={addFormRef}
              data-testid="inline-add-form"
              onSubmit={e => e.preventDefault()}
              className="px-4 py-2 space-y-1.5"
            >
              <div className="flex items-center gap-2">
              <ItemAutocomplete
                value={newItemName}
                onChange={name => onNewItemNameChange(name)}
                onSelect={displayName => {
                  onNewItemNameChange(displayName);
                }}
                items={itemDefaultsMap}
                currentListItemNames={currentListItemNames}
                onDelete={onDeleteItemDefault}
                placeholder="Item name..."
                autoFocus
                inputRef={addInputRef}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleAdd();
                  if (e.key === 'Escape') closeAdd();
                }}
                onBlur={() => closeOnBlurOutside(addFormRef, commitAddAndClose)}
                className="flex-1 bg-transparent border-b border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-hidden focus:border-blue-500 text-sm py-1"
              />
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={handleAdd}
                className="text-blue-500 hover:text-blue-600 text-sm font-medium"
              >
                Add
              </button>
              <button
                type="button"
                onClick={closeAdd}
                className="text-gray-400 hover:text-gray-600 text-sm"
              >
                Cancel
              </button>
              </div>
              {!hideChips && (
                <StoreAutocomplete
                  stores={chips}
                  selectedStoreId={newItemChipId}
                  onSelect={onNewItemChipChange}
                  onCreate={onCreateChip}
                  placeholder={chipPlaceholder}
                />
              )}
            </form>
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
