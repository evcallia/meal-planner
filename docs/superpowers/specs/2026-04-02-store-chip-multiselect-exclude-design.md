# Store Chip Multi-Select, Exclude & Visibility

## Problem

The grocery store chip bar currently shows all stores regardless of whether they have items, and only supports single-store filtering. The user frequents 4 stores but only visits one every ~3 weeks. During regular shopping, items for that infrequent store clutter the list. Additionally, the store clear button ("x") in item edit mode is hard to notice.

## Design

### Chip Visibility

**Default:** Only show store chips (including "None") that have unchecked items assigned to them.

**"Show all stores" menu option:** Added to the kebab menu. When toggled on, all stores show regardless of item count. Persisted to localStorage. Label toggles between "Show all stores" / "Show only active stores".

### Multi-Select (Include)

Replace the current single-select `filterStoreId: string | null` with `selectedStoreIds: Set<string>`.

**Tap behavior on neutral chip:** Add to selection set. Chip turns blue.
**Tap behavior on selected chip:** Remove from selection set. Chip returns to neutral.
**Filtering:** When `selectedStoreIds` is non-empty, only show items from selected stores (plus "None" if selected). When empty, show all non-excluded items.

### Exclude

**State:** `excludedStoreIds: Set<string>` persisted in localStorage (`meal-planner-excluded-stores`).

**Setting exclusion:** Long-press a chip to open the edit popover. New "Exclude" button added between the input and the Delete/Cancel/Save row. Styled distinctly (e.g., amber/orange text: "Exclude from list").

**Chip appearance when excluded:** Dimmed opacity, strikethrough text, distinct muted styling. Still shows item count badge (dimmed). Excluded chips always display regardless of "show all stores" toggle (so user can un-exclude).

**Tap behavior on excluded chip:** Removes exclusion (returns to neutral). Does NOT add to selection — just un-excludes.

**Edit popover on excluded chip:** Shows "Include in list" instead of "Exclude from list".

**Filtering priority:**
1. Remove items from excluded stores
2. If any stores are selected, show only those stores' items
3. If no stores are selected, show all remaining (non-excluded) items

A store cannot be both selected and excluded. If a user excludes a selected store, remove it from the selection set.

### StoreAutocomplete Clear Button

Replace the current small gray "✕" with a more visible treatment:
- Use a bolder "X" or a clear icon
- Red/destructive coloring (`text-red-400 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300`)
- Slightly larger hit target

### State Summary

| State | Tap Action | Visual | Items |
|-------|-----------|--------|-------|
| Neutral | Add to selection | Gray chip | Shown (if no selection active) |
| Selected | Remove from selection | Blue chip | Shown |
| Excluded | Remove exclusion | Dimmed + strikethrough | Hidden |

### Persistence

- `excludedStoreIds` → localStorage `meal-planner-excluded-stores` (JSON array of store IDs)
- `showAllStores` → localStorage `meal-planner-show-all-stores` (boolean)
- `selectedStoreIds` → localStorage `meal-planner-selected-stores` (JSON array of store IDs)

### Files to Modify

- `frontend/src/components/StoreFilterBar.tsx` — multi-select props, excluded state styling, edit popover exclude button
- `frontend/src/components/GroceryListView.tsx` — state management (`selectedStoreIds`, `excludedStoreIds`, `showAllStores`), filtering logic, menu option, chip visibility filtering
- `frontend/src/components/StoreAutocomplete.tsx` — clear button styling

### No Backend Changes

All changes are frontend-only. Exclude/include is a local view preference, not persisted server-side.
