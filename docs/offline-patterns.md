# Offline Patterns

This document defines the canonical patterns for offline-first mutations, undo/redo, and sync in the meal planner app. All hooks that modify data must follow these patterns exactly.

## Core Principles

1. **Optimistic-first**: Update React state and IndexedDB immediately, then sync to server
2. **Targeted operations**: Never use destructive full-list replacements (`replace`) when a targeted operation (add, delete, rename) will do. Replacements overwrite other users' concurrent changes.
3. **Multi-device safe**: Offline changes must merge cleanly with changes made on other devices
4. **Survive reload**: All optimistic state must be persisted to IndexedDB before API calls
5. **Undo/redo safe**: ID chains must be maintained across arbitrary undo/redo cycles

## Architecture Overview

```
User Action → Optimistic State Update → IndexedDB Save → API Call (if online) or Queue Change (if offline)
                                                              ↓
                                                     SSE Event → Other clients refetch
```

- **Optimistic updates**: React state is updated immediately, before the API call
- **IndexedDB**: Local cache persisted so data survives page reload while offline
- **localStorage**: Secondary backup for faster initial render
- **Pending change queue**: IndexedDB-backed queue (`queueChange`) for changes made offline, processed by `useSync.ts` when back online
- **SSE guard**: `pendingMutationsRef` prevents SSE-triggered refetches from overwriting optimistic state
- **Auto-sync**: `useSync` checks for pending changes every 5 seconds, so changes queued while online (from API timeout fallbacks) are retried automatically

## No Destructive Replacements

**NEVER queue `grocery-replace` or `pantry-replace` for operations that can be expressed as targeted changes.** These replace the ENTIRE list on the server, destroying any changes other online users made concurrently.

### When to use replace
- `clearAll` / `clearChecked` — the intent IS to wipe the list
- `mergeList` (grocery paste) — bulk paste is inherently a replace operation

### When NOT to use replace (use targeted ops instead)
- Adding a section → `pantry-create-section` / `grocery-create-section`
- Deleting a section → `pantry-delete-section` / `grocery-delete-section`
- Adding an item → `pantry-add` / `grocery-add`
- Deleting an item → `pantry-delete` / `grocery-delete`
- Undo/redo of any of the above → use the inverse targeted operation

### Why this matters
If User A is online adding items and User B is offline adding a section, when User B syncs:
- **With replace**: User B's queued `pantry-replace` overwrites the entire list, deleting all of User A's items
- **With targeted ops**: User B's `pantry-create-section` only adds the new section, preserving User A's items

## Main Mutation Pattern

Every mutation function must follow this structure:

```typescript
const doSomething = useCallback(async (...args) => {
  // 1. Optimistic state update
  optimisticVersionRef.current++;
  setSections(prev => /* apply change */);

  // 2. Persist to IndexedDB (survives offline reload)
  await saveLocalXxx(...);

  // 3. Resolve temp IDs before API calls (item may have been synced externally)
  // 4. API call with offline fallback
  if (isOnline) {
    pendingMutationsRef.current++;
    try {
      const realId = await resolveIdAsync(id); // resolve temp→real from IndexedDB
      const result = await someAPI(realId, ...);
      // Apply server response if needed (e.g., real IDs)
    } catch {
      await queueChange('change-type', '', { /* complete payload */ });
    } finally {
      settleMutation();
    }
  } else {
    await queueChange('change-type', '', { /* complete payload */ });
  }

  // 5. Push undo action
  pushAction({ type: '...', undo: async () => { ... }, redo: async () => { ... } });
}, [isOnline, ...deps]);
```

Key rules:
- `pendingMutationsRef.current++` MUST be inside `if (isOnline)`, paired with `finally { settleMutation() }`
- The `queueChange` payload MUST include ALL fields that `useSync.ts` needs (check the handler)
- `optimisticVersionRef.current++` MUST come before any `setSections` call
- IndexedDB saves MUST happen before the API call (so offline reload has the data)
- **Use `resolveIdAsync(id)` before API calls** when the ID could be a temp that was synced by `useSync` (which writes to IndexedDB, not the in-memory remap)

## Undo/Redo Handler Pattern

Every undo and redo handler must follow this structure:

```typescript
undo: async () => {
  optimisticVersionRef.current++;
  pendingMutationsRef.current++;

  // 1. Update React state — use resolveId() for any mutable ID ref
  const currentId = resolveId(someRef.id);
  setSections(prev => /* reverse the change using currentId */);

  // 2. Persist to IndexedDB
  await saveLocalXxx(...);

  // 3. API call with offline fallback — use isOnlineRef.current (NOT isOnline)
  if (isOnlineRef.current) {
    try {
      await someAPI(currentId, ...);
    } catch {
      await queueChange('change-type', '', { /* payload */ });
    }
  } else {
    await queueChange('change-type', '', { /* payload */ });
  }

  // 4. Always call settleMutation
  settleMutation();
},
```

Key rules:
- **Always use `isOnlineRef.current`** in undo/redo (NOT `isOnline` from the closure — it's stale)
- **Never use empty catch blocks** (`catch { /* queue */ }` that don't actually queue) — always `await queueChange(...)`
- **Always have an `else` branch** that queues the change for offline
- **Always call `settleMutation()`** in ALL code paths (after the if/else, not inside)
- **Always persist to IndexedDB** before the API call
- **Never call `queueChange` inside a `setSections` callback** — it's async and won't be awaited. Capture the result from `setSections` in a variable and queue after
- **Always use `resolveId()` when reading mutable ID refs** (e.g., `resolveId(deletedItemRef.id)`, `resolveId(newItem.id)`) — the item may have been recreated with a new server ID through delete/undo cycles
- **Undo/redo must be serialized** — the `UndoContext` blocks concurrent undo/redo calls via `isUndoRedoInProgress` to prevent race conditions where the second undo runs before the first's API call completes and updates ID remaps

## ID Remap Pattern (`useIdRemap` hook)

When items are deleted and restored via undo, they get new server IDs. The `useIdRemap` hook (`hooks/useIdRemap.ts`) centralizes ID chain management:

```typescript
const { resolveId, resolveIdAsync, remapId } = useIdRemap();

// resolveId (sync): follows the in-memory remap chain
const currentId = resolveId(staleId); // e.g., server-1 → server-2 → server-3

// resolveIdAsync (async): resolveId + IndexedDB fallback for externally-synced temp IDs
const currentId = await resolveIdAsync(tempId); // checks in-memory, then getTempIdMapping

// remapId: records a new mapping AND flattens ALL intermediate IDs in the chain
remapId(oldId, newId); // server-1→newId, server-2→newId, server-3→newId
```

### When to use which
- **`resolveId`** — in undo/redo handlers (sync context, IDs were remapped in-memory by this session)
- **`resolveIdAsync`** — in main mutation paths (the ID might be a temp that was synced by `useSync` to IndexedDB without updating in-memory state)
- **`remapId`** — whenever the server returns a new ID for an entity (after POST/create). NEVER use `idRemapRef.current.set()` directly — `remapId` flattens the entire chain

### Why `remapId` flattens
Consider: add → delete → undo (gets server-2, remap s1→s2) → undo add (deletes s2) → redo add (gets server-3, remap s1→s3).

Without flattening: `s1→s3` overwrites `s1→s2`, but `deletedItemRef` still holds `s2` — `resolveId(s2)` returns `s2` (no mapping). 404.

With flattening: `remapId(s1, s3)` also sets `s2→s3`. Now `resolveId(s2)` → `s3`. Correct.

### Remap in re-creation handlers
Any undo/redo handler that **re-creates** an entity (via POST) must call `remapId(prevId, newTempId)` so that ALL other handlers holding references to any previous ID in the chain can resolve to the latest one:

```typescript
undo: async () => {
  const prevId = idRef.id;
  const newTempId = addIdea({ title });
  idRef.id = newTempId;
  remapId(prevId, newTempId); // Links old chain to new temp ID
},
```

## Temp ID Pattern

When creating items offline, they get temporary IDs that must be resolved to real server IDs during sync:

```typescript
// 1. Generate temp ID
const tempId = generateTempId();

// 2. Create item with temp ID in React state and IndexedDB
const newItem = { id: tempId, ... };
setSections(prev => /* insert newItem */);
await saveLocalXxx({ id: tempId, ... });

// 3. If online, call API and map temp → real ID
if (isOnline) {
  pendingMutationsRef.current++;
  try {
    const created = await addXxxAPI(...);
    // Save mapping and flatten the chain
    remapId(tempId, created.id);
    await saveTempIdMapping(tempId, created.id);
    // Update React state with real ID
    optimisticVersionRef.current++;
    setSections(prev => /* replace tempId with created.id */);
    // Update IndexedDB: delete temp, save real
    await deleteLocalXxx(tempId);
    await saveLocalXxx({ id: created.id, ... });
  } catch {
    await queueChange('xxx-add', '', { id: tempId, ... });
  } finally { settleMutation(); }
} else {
  await queueChange('xxx-add', '', { id: tempId, ... });
}
```

Key rules:
- **Always call `remapId(tempId, realId)`** when the server returns a real ID (flattens the chain)
- **Always call `saveTempIdMapping(tempId, realId)`** (persists to IndexedDB for `useSync` and `resolveIdAsync`)
- **Always delete the temp record** from IndexedDB after saving the real one
- **Include the tempId in queue payloads** so `useSync.ts` can resolve it
- **Resolve ALL ID fields in `useSync.ts`** — not just the primary ID, but also `sectionId`, `store_id`, etc.
- **Include fallback fields** (e.g., `sectionName` alongside `sectionId`) so sync handlers can find entities by name when temp IDs can't be resolved

## useSync.ts Handler Pattern

Every queued change type must have a handler in `useSync.ts`:

```typescript
} else if (change.type === 'xxx-add') {
  const payload = change.payload as { id: string; sectionId: string; sectionName?: string; name: string; ... };

  // 1. Resolve ALL temp IDs in the payload
  let realId = payload.id;
  if (isTempId(payload.id)) {
    const mapped = await getTempIdMapping(payload.id);
    if (mapped) realId = mapped;
  }
  let realSectionId = payload.sectionId;
  if (isTempId(payload.sectionId)) {
    const mapped = await getTempIdMapping(payload.sectionId);
    if (mapped) {
      realSectionId = mapped;
    } else if (payload.sectionName) {
      // Fallback: find section by name (created via targeted op, mapping may not exist)
      const sections = await getListAPI();
      const match = sections.find(s => s.name.toLowerCase() === payload.sectionName!.toLowerCase());
      if (match) realSectionId = match.id;
    }
  }
  // Also resolve store_id, etc.

  // 2. Make the API call
  const created = await addXxxAPI(realSectionId, payload.name, ...);

  // 3. Save temp → real ID mapping (for subsequent queued changes)
  if (isTempId(payload.id)) {
    await saveTempIdMapping(payload.id, created.id);
    await deleteLocalXxx(payload.id);
    await saveLocalXxx(created);
  }
}
```

Key rules:
- **Every `ChangeType` in `db.ts` must have a handler** in `useSync.ts`
- **Resolve ALL temp ID fields**, not just the primary one
- **Include name-based fallbacks** for section/store IDs that may have been created by targeted ops without temp mappings
- **Save temp→real mappings** so subsequent queued changes can resolve
- **Update IndexedDB** after sync (delete temp record, save real record)
- **Skip gracefully** when a temp ID can't be resolved (the entity may have been created and deleted offline — treat as no-op)
- **Delete endpoints should be idempotent** on the server (return 200 not 404 when already deleted) to prevent sync from halting on retried deletes

## SSE Guard Pattern

Prevents server-sent events from triggering refetches that overwrite optimistic state:

```typescript
// In the SSE handler:
if (detail?.type === 'xxx.updated') {
  if (pendingMutationsRef.current > 0) {
    deferredLoadRef.current = true;  // Will load after all mutations settle
    return;
  }
  loadXxx();  // Safe to reload — no mutations in flight
}

// In settleMutation:
const settleMutation = useCallback(() => {
  pendingMutationsRef.current--;
  if (pendingMutationsRef.current === 0 && deferredLoadRef.current) {
    deferredLoadRef.current = false;
    loadXxxRef.current();
  }
}, []);
```

Key rules:
- `pendingMutationsRef.current++` before API call, `settleMutation()` in `finally`
- **No `await` calls between `pendingMutationsRef.current++` and the API call** that could yield to the event loop and let SSE events through
- `settleMutation()` must be called in ALL code paths (online success, online failure, offline)

## Cache Warming Guard

`fetchAllData` in App.tsx warms the IndexedDB/localStorage cache on page load and reconnect. It must NOT overwrite optimistic state from pending offline changes:

```typescript
getPendingChanges().then(pending => {
  if (!pending.some(c => c.type.startsWith('grocery-'))) {
    getGroceryList().then(data => { /* write to IndexedDB */ });
  }
  // Same for pantry, meal-ideas
});
```

Without this guard, coming back online would fetch server data (which doesn't have offline changes yet) and overwrite the local optimistic state before `useSync` processes the queued changes.

## Position Preservation in Undo

When undoing a delete, the item must be restored at its original position, both locally AND on the server:

```typescript
// Capture position at delete time
const originalIndex = section.items.findIndex(i => i.id === itemId);

// In undo handler:
// 1. Restore at original position locally
setSections(prev => prev.map(s => {
  if (s.id !== sectionId) return s;
  const items = [...s.items];
  const insertAt = Math.min(originalIndex, items.length);
  items.splice(insertAt, 0, restoredItem);
  return { ...s, items };
}));

// 2. After POST creates the item (server puts it at end), reorder on server
if (sectionItemIds.length > 1) {
  await reorderItemsAPI(sectionId, sectionItemIds);
}
```

## Queue Payload Completeness

The `queueChange` payload must include ALL fields that `useSync.ts` destructures. Common mistakes:
- Missing `store_id` in `grocery-add` payloads
- Missing `tempId` in `store-create` / `grocery-create-section` / `pantry-create-section` payloads
- Missing `sectionName` in `pantry-add` payloads (needed for name-based fallback)
- Field name mismatches (`sectionId` vs `section_id`)

Always cross-reference the `useSync.ts` handler for the change type to verify the payload shape matches.

## Entities and Their Change Types

| Entity | Change Types | Hook |
|--------|-------------|------|
| Grocery items | `grocery-add`, `grocery-delete`, `grocery-edit`, `grocery-check`, `grocery-clear`, `grocery-replace`* | `useGroceryList` |
| Grocery sections | `grocery-create-section`, `grocery-reorder-sections`, `grocery-rename-section`, `grocery-delete-section` | `useGroceryList` |
| Grocery cross-section | `grocery-reorder-items`, `grocery-move-item` | `useGroceryList` |
| Pantry items | `pantry-add`, `pantry-update`, `pantry-delete`, `pantry-replace`* | `usePantry` |
| Pantry sections | `pantry-create-section`, `pantry-delete-section`, `pantry-reorder-sections`, `pantry-reorder-items`, `pantry-rename-section`, `pantry-move-item` | `usePantry` |
| Meal ideas | `meal-idea-add`, `meal-idea-update`, `meal-idea-delete` | `useMealIdeas` |
| Stores | `store-create`, `store-rename`, `store-delete`, `store-reorder` | `useStores` |
| Calendar | `calendar-hide`, `calendar-unhide` | (CalendarView) |
| Notes | `notes`, `itemized` | (CalendarView) |

\* `grocery-replace` and `pantry-replace` are ONLY for `clearAll`/`clearChecked`/`mergeList`. Never for section or item CRUD.

## Testing Patterns

- Mock `isTempId`, `getTempIdMapping`, and `saveTempIdMapping` in ALL test files that mock `../../db`
- Mock `getPendingChanges` returning `Promise.resolve([])`
- Use `resetXSessionLoaded()` in `beforeEach` (currently no-ops, kept for compatibility)
- For offline undo tests: perform action online (mock API success), switch `useOnlineStatus` to false, rerender, then call undo
- Verify `queueChange` is called with the correct type AND complete payload shape
