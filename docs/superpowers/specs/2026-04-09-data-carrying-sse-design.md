# Data-Carrying SSE Events

## Problem

The current SSE system uses notification-only events for grocery, pantry, stores, and meal-ideas. When a mutation happens, the server broadcasts a minimal event (e.g., `grocery.updated` with `{}`), and every receiving client makes a full API call to refetch the entire entity list. This creates unnecessary network traffic — the server already has the changed data at broadcast time.

Some events (settings, notes, calendar) already carry their data. This spec extends that pattern to the remaining entities.

## Core Principles

- SSE events carry the change data so clients apply updates directly without refetching
- All entities referenced by **server-assigned ID** — never match on names or other mutable fields
- Temp IDs never leave the originating client; SSE payloads always contain real server IDs
- Full server refresh limited to: tab focus, PWA focus, online reconnect, deferred-load fallback after pending mutations settle

## Event Format

Existing envelope unchanged: `{ type, payload, source_id }`. The `payload` gains an `action` field describing the mutation, plus the relevant entity data.

```json
{
  "type": "grocery.updated",
  "payload": {
    "action": "item-added",
    "sectionId": "uuid",
    "item": { "id": "uuid", "name": "Milk", "quantity": 2, "checked": false, "store_id": "uuid", "position": 3 }
  },
  "source_id": "client-uuid"
}
```

## Actions By Entity

### grocery.updated

| Action | Payload Fields | Notes |
|--------|---------------|-------|
| `item-added` | `sectionId`, `item` (full object) | |
| `item-updated` | `sectionId`, `item` (full object) | Covers rename, quantity, check, store change |
| `item-deleted` | `sectionId`, `itemId` | |
| `item-moved` | `fromSectionId`, `toSectionId`, `item` (full object) | Cross-section move |
| `section-added` | `section` (full object, empty items) | |
| `section-renamed` | `sectionId`, `name` | |
| `section-deleted` | `sectionId` | |
| `section-reordered` | `sections` (array of `{ id, position }`) | |
| `items-reordered` | `sectionId`, `items` (array of `{ id, position }`) | |
| `cleared-checked` | (none) | Client removes all checked items locally |
| `cleared-all` | (none) | Client clears entire list locally |
| `replaced` | `sections` (full list) | For mergeList, paste, bulk ops |

### pantry.updated

| Action | Payload Fields | Notes |
|--------|---------------|-------|
| `item-added` | `sectionId`, `item` (full object) | |
| `item-updated` | `sectionId`, `item` (full object) | |
| `item-deleted` | `sectionId`, `itemId` | |
| `section-added` | `section` (full object, empty items) | |
| `section-renamed` | `sectionId`, `name` | |
| `section-deleted` | `sectionId` | |
| `section-reordered` | `sections` (array of `{ id, position }`) | |
| `items-reordered` | `sectionId`, `items` (array of `{ id, position }`) | |
| `cleared-checked` | (none) | |
| `cleared-all` | (none) | |
| `replaced` | `sections` (full list) | |

### stores.updated

| Action | Payload Fields | Notes |
|--------|---------------|-------|
| `added` | `store` (full object) | |
| `updated` | `store` (full object) | |
| `deleted` | `storeId` | |

### meal-ideas.updated

| Action | Payload Fields | Notes |
|--------|---------------|-------|
| `added` | `idea` (full object) | |
| `updated` | `idea` (full object) | Full payload so receiver can replace-by-ID |
| `deleted` | `ideaId` | |

### Already Data-Carrying (No Changes)

These events already carry their data and require no modifications:

- `settings.updated` — carries `{ settings, updated_at }`
- `notes.updated` — carries `{ date, meal_note }`
- `item.updated` — carries `{ date, line_index, itemized }`
- `calendar.refreshed` — carries `{ events_by_date, last_refresh }`
- `calendar.hidden` — carries `{ hidden_id, event_id, event_uid, ... }`
- `calendar.unhidden` — carries `{ hidden_id, event_uid, calendar_name, ... }`

## Frontend Apply Logic

Each hook gains an `applyRealtimeEvent(action, payload)` function that switches on `action` and mutates state directly:

- **Add**: Insert item/section at correct position
- **Update**: Find by ID, replace with incoming object
- **Delete**: Remove by ID
- **Reorder**: Update position fields by ID
- **Clear**: Remove checked items or all items from local state
- **Replace**: Full state replacement

After applying the delta, persist to IndexedDB/localStorage so the offline cache stays current.

## Guard Pattern (Unchanged)

The existing concurrency guards remain:

1. **SOURCE_ID filter** in useRealtime — skip own events (unchanged)
2. **Pending mutation guard** — if `pendingMutationsRef > 0`, defer the event (set `deferredLoadRef = true`)
3. **Deferred load** — when all mutations settle, do a full server refetch via existing `loadXxx()`
4. **Tab focus / PWA focus / reconnect** — `broadcastFullRefresh()` does a full refetch of all entities (unchanged)

The deferred-load fallback ensures correctness when SSE events arrive during local mutations. The tab-focus refresh catches anything missed while the app was backgrounded.

## Backend Changes

Each router's `broadcast_event()` call is updated to include the `action` and serialized entity data. The entity is already in scope at the broadcast site (just created/updated/queried), so this is serializing what's already available. No new database queries needed.

Example — grocery item add (current → new):

```python
# Current
await broadcast_event("grocery.updated", {}, source_id=source_id)

# New
await broadcast_event("grocery.updated", {
    "action": "item-added",
    "sectionId": str(section.id),
    "item": GroceryItemSchema.model_validate(item).model_dump(mode="json"),
}, source_id=source_id)
```

## Offline / Temp ID Interaction

No conflict with the existing offline/temp ID system:

1. Client A creates item with temp ID → optimistic update → API call → server returns real ID → Client A remaps temp→real
2. Server broadcasts SSE with **real server ID** to other clients
3. Client B receives SSE with real IDs → applies directly

Temp IDs are local to the originating client and never appear in SSE payloads.

## Post-Sync Refetch

The existing `pending-changes-synced` DOM event (dispatched by `useSync` after draining the offline queue) continues to trigger full refetches. This is correct — after syncing queued offline changes, a full refresh picks up any server-side effects or concurrent changes from other devices.
