# Grocery Store Assignment

## Overview

Add the ability to assign a grocery store (e.g., "Whole Foods", "Trader Joe's") to individual grocery items. Assignments persist as defaults — once set, the store auto-populates whenever that item is added again. The feature is shared across all users (no per-user scoping).

## Data Model

### New Tables

**`stores`**

| Column     | Type     | Constraints              |
|------------|----------|--------------------------|
| id         | UUID     | PK                       |
| name       | TEXT     | Case-insensitive unique (CITEXT or functional index), not null. Stored in title case. |
| position   | INTEGER  | Default 0                |
| created_at | DATETIME | Default now              |

Represents a grocery store. Shared across all users. `position` controls custom sort order in the filter bar and within-section sort. Store names are normalized to title case on creation (e.g., "whole foods" → "Whole Foods"). Uniqueness is case-insensitive.

**`item_defaults`**

| Column    | Type | Constraints                          |
|-----------|------|--------------------------------------|
| id        | UUID | PK                                   |
| item_name | TEXT | Unique, not null. Normalized: lowercase, trimmed |
| store_id  | UUID | FK → stores, nullable, ON DELETE SET NULL |

Maps a normalized item name to its default store. One row per unique item name. When a user assigns a store to "Bananas", future additions of "bananas" (case-insensitive) auto-populate the store.

### Modified Tables

**`grocery_items`** — add column:

| Column   | Type | Constraints                          |
|----------|------|--------------------------------------|
| store_id | UUID | FK → stores, nullable, ON DELETE SET NULL |

## Backend API

### New Endpoints

| Method | Endpoint                  | Purpose                                  |
|--------|---------------------------|------------------------------------------|
| GET    | `/api/stores`             | List all stores ordered by position      |
| POST   | `/api/stores`             | Create a store (name, optional position) |
| PATCH  | `/api/stores/{store_id}`  | Update store name or position            |
| DELETE | `/api/stores/{store_id}`  | Delete store (nullifies all references)  |
| PATCH  | `/api/stores/reorder`     | Reorder stores (array of IDs)            |

### Modified Endpoints

| Endpoint                              | Change                                                                 |
|---------------------------------------|------------------------------------------------------------------------|
| `GET /api/grocery`                    | Include `store_id` on each item                                        |
| `POST /api/grocery/items`             | Accept optional `store_id`. If omitted, auto-populate from `item_defaults` by normalized name |
| `PATCH /api/grocery/items/{item_id}`  | Accept optional `store_id`. When set, upsert `item_defaults` for that item name |
| `PUT /api/grocery`                    | Include `store_id` per item for replace/undo/redo                      |

### Auto-Default Logic

- **On item create** (POST): if no `store_id` provided, look up `item_defaults` by normalized item name and populate `store_id` from the match.
- **On store assignment** (PATCH with `store_id`): upsert `item_defaults` row for the normalized item name with the new `store_id`.
- **On store clear** (PATCH with `store_id: null`): also null out the `item_defaults.store_id` for that item name, so the default is cleared.
- **On store delete**: FK `ON DELETE SET NULL` handles `grocery_items.store_id` and `item_defaults.store_id` automatically.
- **On replace** (PUT): does NOT trigger `item_defaults` lookups — it is a full state replacement (undo/redo), not an "add" operation.

### SSE

Add `stores.updated` event so store list changes (create, rename, reorder, delete) sync to all connected clients in real time.

## Frontend: Store Assignment UI

### Item Edit View

The existing inline edit interaction expands to include a store field:

- Below the name/quantity fields, a **store autocomplete input** appears
- Typing filters existing stores by name
- If no match, shows a "Create [typed name]" option that creates the store and assigns it
- Selecting a store triggers a PATCH to the item (which also upserts `item_defaults`)
- A clear/remove button to unset the store assignment

### Grocery List Display

- Items with a store show the store name as **greyed subtext below the item name**
- Styling: smaller muted text (e.g., `text-sm text-gray-400 dark:text-gray-500`)
- Items without a store display as they do today (name only)
- Subtext is compact — no extra vertical padding

## Frontend: Filter Bar

### Placement & Appearance

- Sits below the action bar (add items, clear menu), above the sections
- Horizontally scrollable row of store "chips" (pill-shaped buttons)
- Chips ordered by `stores.position` (user's custom order)
- Only visible when at least one store exists

### Behavior

- **Single-select**: tapping a chip activates that store filter; tapping it again deselects
- **When filtered**: only items matching the selected store are shown in their respective sections. Items with **no store assigned are hidden**.
- **Empty sections**: sections with no matching items are hidden during filtering

## Frontend: Sort by Store

### Toggle

- A sort toggle button in the action bar area (sort icon)
- When active: within each section, items are grouped by store in the user's custom store order (`stores.position`). Items with no store sort to the end within each section.
- **Drag-reorder while sorted**: allowed. Dragging an item while sort-by-store is active writes the new visual order as permanent positions (same as a normal reorder). This lets users fine-tune order within store groups.
- Sort state is ephemeral (not persisted, resets on page reload). When toggled off, items display in their current position order (which may have been modified by drags during sort mode).

### Interaction with Filter

- Filter and sort are independent and can be used together or separately
- Both active: filtered items shown, sorted by store within sections

## Store Management

No dedicated settings page. Stores are managed via the filter bar:

- **Creation**: implicit when typing a new name in the store autocomplete
- **Renaming**: long-press a filter chip → edit popover with name field. Renaming updates the `stores` row; all FK references update automatically.
- **Reordering**: drag filter chips to rearrange. Persists to `stores.position`.
- **Deletion**: edit popover includes a delete option. Deleting nullifies all `grocery_items.store_id` and `item_defaults.store_id` references.

## Offline & Sync

### Store Assignments

Follow the same optimistic update + offline queue pattern as existing grocery mutations:
- Increment `optimisticVersionRef`, optimistic `setSections`, API call (or queue offline), push undo action
- Store assignment is undoable (reverts item's `store_id`, does NOT revert the `item_defaults` upsert)

### Stores List

- Cached locally in IndexedDB alongside grocery sections
- `stores.updated` SSE events trigger a refetch with pending-mutation guards

### Replace / Undo / Redo

- `PUT /api/grocery` carries full item state including `store_id` — undo/redo preserves store assignments
- `item_defaults` are not part of undo/redo — they represent persistent preferences, not transient list state

### Auto-Populate on Add

- Backend populates `store_id` from `item_defaults` on item creation
- Frontend receives populated `store_id` in the API response
- Bulk add (text parsing) needs no parser changes — store assignment happens server-side

### Offline Store Creation

When a user creates a new store while offline (via the autocomplete "Create [name]" option), use the existing temp ID pattern (`generateTempId` / `isTempId` / `saveTempIdMapping` in `db.ts`). The store is created locally with a temp ID and queued for creation on reconnect. The temp-to-real ID mapping is applied to any `grocery_items.store_id` and `item_defaults.store_id` references when the sync completes.

### Concurrent Store Creation

If two users create a store with the same name simultaneously, the backend uses `ON CONFLICT DO NOTHING` (or equivalent) on the case-insensitive unique constraint and returns the existing store. The autocomplete should also re-query stores after creation to pick up the server-canonical row.

## Future Extensibility

The design supports future expansion without migration headaches:
- `stores` table can gain columns (address, notes, etc.)
- `item_defaults` can gain columns (default quantity, default section, etc.)
- A generic `tags` table could coexist alongside `stores` if a broader tagging system is ever needed
