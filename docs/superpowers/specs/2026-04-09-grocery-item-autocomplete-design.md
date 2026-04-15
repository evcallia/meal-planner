# Grocery Item Autocomplete

## Overview

Add autocomplete to the grocery item name input in both the quick-add form and per-section inline add forms. Suggestions come from the existing `itemDefaultsMap` cache (IDB item defaults + current list items). Items not currently on the grocery list can be deleted from the cache via an X button in the dropdown.

## Frontend

### New Component: `ItemAutocomplete`

Modeled after `StoreAutocomplete`. Renders a text input with a filtered dropdown of matching item names.

**Props:**
- `value: string` — current input value
- `onChange: (value: string) => void` — called on every keystroke
- `onSelect: (itemName: string) => void` — called when a suggestion is picked (Enter/Tab/click)
- `items: Map<string, string | null>` — all known item names (lowercase) mapped to store_id (the existing `itemDefaultsMap`)
- `currentListItemNames: Set<string>` — lowercase names of items currently on the grocery list (controls X button visibility)
- `onDelete: (itemName: string) => void` — called when X is clicked on a deletable item
- `placeholder?: string`
- `inputRef?: React.RefObject<HTMLInputElement>`
- `className?: string`

**Behavior:**
- Dropdown opens on focus (if input has text) and on text change
- Case-insensitive partial match filtering: `itemName.includes(query.toLowerCase())`
- Selecting a suggestion (click, Enter, or Tab) calls `onSelect` with the original-cased item name, closes dropdown
- Free-text entry works — typing a name not in the list is fine, no "create" option needed
- Escape closes dropdown
- Enter/Tab with dropdown open selects the top filtered match; with dropdown closed, behaves normally (form submit / focus next)
- Click-outside closes dropdown
- Viewport-aware: opens upward if less than 200px below the input
- Z-index: elevates ancestor `.glass` element when dropdown is open (same pattern as `StoreAutocomplete`)

**X (delete) button:**
- Shown on items where `!currentListItemNames.has(itemName)`
- Click calls `onDelete(itemName)` — stops propagation so the item isn't selected
- Visually matches the delete pattern in section combobox (red X on empty sections)

### Integration: Quick-Add Form (GroceryListView)

Replace the plain `<input>` for item name (~line 591) with `<ItemAutocomplete>`.

- `items` = `itemDefaultsMap` (already computed)
- `currentListItemNames` = derived from `sections.flatMap(s => s.items).map(i => i.name.toLowerCase())` via useMemo
- `onSelect` sets `quickAddItemName` and triggers store auto-populate (existing onChange logic)
- `onDelete` calls the delete API + removes from IDB
- `inputRef` = existing `quickAddItemRef`

### Integration: Per-Section Inline Add Forms

Same component, same props source. The inline add forms already have item name inputs — replace with `<ItemAutocomplete>`.

### IDB Changes

New function in `db.ts`:
- `deleteLocalItemDefault(itemName: string)` — deletes a single entry from the `itemDefaults` object store

## Backend

### New Endpoint: `DELETE /api/grocery/item-defaults/{item_name}`

- Deletes the row from `item_defaults` table where `item_name` matches (case-insensitive)
- Idempotent: returns 204 whether the row existed or not
- Requires authentication (same as other grocery endpoints)

### Frontend API Client

New function in `api/client.ts`:
- `deleteItemDefault(itemName: string)` — `DELETE /api/grocery/item-defaults/{encodeURIComponent(itemName)}`

## Display Casing

Item names in the `itemDefaultsMap` are stored lowercase. The dropdown should display items in title case (using the existing `toTitleCase` utility) for readability. When an item exists in the current grocery list, use the actual cased name from the list instead.

## Testing

- `ItemAutocomplete` unit tests: filtering, selection, keyboard nav, delete button visibility, click-outside
- Backend: test DELETE endpoint (success + idempotent 204)
- Integration: verify store auto-populate still works when selecting from autocomplete
