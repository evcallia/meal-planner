# Testing SSE Events & Offline Behavior with Playwright MCP

This document describes how to systematically verify that SSE events propagate to all cache layers and that offline/online transitions work correctly. Use this process after any large changes to SSE, caching, or offline logic.

## Prerequisites

1. Dev server running: `docker-compose -f /path/to/docker-compose.yml up -d --build`
2. Playwright MCP browser tools available
3. Authenticated session (navigate to `/api/auth/dev-login` if using dev auth)

## Setup: Install Test Helpers

After navigating to the app and authenticating, install these helpers via `browser_evaluate`:

```javascript
() => {
  // SSE event interceptor
  window.__sseEvents = [];
  window.addEventListener('meal-planner-realtime', (e) => {
    window.__sseEvents.push({
      type: e.detail?.type,
      action: e.detail?.payload?.action,
      timestamp: Date.now(),
    });
  });

  // Simulate another client (different SOURCE_ID so SSE events aren't filtered)
  window.__otherClient = async (path, options = {}) => {
    const resp = await fetch(path, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-Id': 'other-client-test-id',
        ...options.headers,
      },
    });
    if (!resp.ok && resp.status !== 204) throw new Error(`${resp.status}: ${await resp.text()}`);
    if (resp.status === 204) return null;
    const ct = resp.headers.get('content-type');
    return (ct && ct.includes('application/json')) ? resp.json() : null;
  };

  // Read from IndexedDB (MealPlannerDB)
  window.__readIDB = (storeName) => new Promise((resolve, reject) => {
    const req = indexedDB.open('MealPlannerDB');
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction(storeName, 'readonly');
        const s = tx.objectStore(storeName);
        const g = s.getAll();
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      } catch(e) { resolve(null); }
    };
    req.onerror = () => reject(req.error);
  });

  return 'Helpers installed';
}
```

> **Note:** The IDB version number may change. Omit the version in `indexedDB.open()` to open the current version. If that doesn't work, check `(await indexedDB.databases()).find(d => d.name === 'MealPlannerDB')?.version`.

## Test 1: SSE Event Propagation (Active Tab)

Tests that SSE events from another client update React state, localStorage, and IndexedDB when you're on the relevant tab.

Navigate to the **Grocery** tab, then run:

```javascript
async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  window.__sseEvents = [];
  const results = {};

  // Get a section to add items to
  const grocery = await (await fetch('/api/grocery', { credentials: 'include' })).json();
  const section = grocery[0];

  // --- ITEM ADD ---
  const item = await window.__otherClient('/api/grocery/items', {
    method: 'POST',
    body: JSON.stringify({ section_id: section.id, name: 'SSE Test Item', quantity: '2' }),
  });
  await wait(1500);

  let ls = JSON.parse(localStorage.getItem('meal-planner-grocery') || '[]');
  let idb = await window.__readIDB('groceryItems');
  results['item-added'] = {
    sse: window.__sseEvents.some(e => e.type === 'grocery.updated' && e.action === 'item-added'),
    ls: ls.some(s => s.items.some(i => i.id === item.id)),
    idb: idb?.some(i => i.id === item.id),
  };

  // --- ITEM UPDATE ---
  window.__sseEvents = [];
  await window.__otherClient(`/api/grocery/items/${item.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'SSE Test Item UPDATED' }),
  });
  await wait(1500);

  ls = JSON.parse(localStorage.getItem('meal-planner-grocery') || '[]');
  idb = await window.__readIDB('groceryItems');
  results['item-updated'] = {
    sse: window.__sseEvents.some(e => e.action === 'item-updated'),
    ls: ls.some(s => s.items.some(i => i.id === item.id && i.name === 'SSE Test Item UPDATED')),
    idb: idb?.some(i => i.id === item.id && i.name === 'SSE Test Item UPDATED'),
  };

  // --- ITEM DELETE ---
  window.__sseEvents = [];
  await window.__otherClient(`/api/grocery/items/${item.id}`, { method: 'DELETE' });
  await wait(1500);

  ls = JSON.parse(localStorage.getItem('meal-planner-grocery') || '[]');
  idb = await window.__readIDB('groceryItems');
  results['item-deleted'] = {
    sse: window.__sseEvents.some(e => e.action === 'item-deleted'),
    ls: !ls.some(s => s.items.some(i => i.id === item.id)),
    idb: !idb?.some(i => i.id === item.id),
  };

  return results;
  // Expected: all values should be true
}
```

### Entities to Test

Repeat the pattern above for each entity. The key variations:

| Entity | Event Type | API Endpoints | LS Key | IDB Store |
|--------|-----------|---------------|--------|-----------|
| Grocery items | `grocery.updated` | `POST/PATCH/DELETE /api/grocery/items/{id}` | `meal-planner-grocery` | `groceryItems` |
| Grocery sections | `grocery.updated` | `POST/PATCH/DELETE /api/grocery/sections/{id}` | `meal-planner-grocery` | `grocerySections` |
| Pantry items | `pantry.updated` | `POST/PUT/DELETE /api/pantry/items/{id}` | `meal-planner-pantry-sections` | `pantryItems` |
| Pantry sections | `pantry.updated` | `POST/PATCH/DELETE /api/pantry/sections/{id}` | `meal-planner-pantry-sections` | `pantrySections` |
| Stores | `stores.updated` | `POST/PATCH/DELETE /api/stores/{id}` | `meal-planner-stores` | `stores` |
| Meal ideas | `meal-ideas.updated` | `POST/PUT/DELETE /api/meal-ideas/{id}` | `meal-planner-meal-ideas` | `mealIdeas` |
| Meal notes | `notes.updated` | `PUT /api/days/{date}/notes` | N/A | `mealNotes` |
| Item toggle | `item.updated` | `PATCH /api/days/{date}/items/{idx}` | N/A | `mealNotes` |
| Calendar hidden | `calendar.hidden` | `POST /api/calendar/hidden` | N/A | `hiddenCalendarEvents` |
| Calendar unhidden | `calendar.unhidden` | `DELETE /api/calendar/hidden/{id}` | N/A | `hiddenCalendarEvents` |

### Actions to Test Per Entity

For grocery and pantry, test all actions:
- `item-added`, `item-updated`, `item-deleted`, `item-moved`
- `section-added`, `section-renamed`, `section-deleted`
- `section-reordered`, `items-reordered`
- `cleared-checked` (grocery only), `cleared-all`
- `replaced` (mergeList/paste)

For stores: `added`, `updated`, `deleted`, `reordered`

For meal-ideas: `added`, `updated`, `deleted`

## Test 2: Cross-Tab Cache Warming (Inactive Tab)

Tests that SSE events update caches for tabs you're NOT currently viewing, via App.tsx's background cache warmer.

Navigate to the **Grocery** tab, then mutate pantry/stores/meal-ideas from another client:

```javascript
async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const results = {};

  // PANTRY mutation while on Grocery tab
  const pantry = await (await fetch('/api/pantry', { credentials: 'include' })).json();
  const pSection = pantry[0];

  const pItem = await window.__otherClient('/api/pantry/items', {
    method: 'POST',
    body: JSON.stringify({ section_id: pSection.id, name: 'CrossTab Test', quantity: 1 }),
  });
  await wait(2000);

  const ls = JSON.parse(localStorage.getItem('meal-planner-pantry-sections') || '[]');
  const idb = await window.__readIDB('pantryItems');
  results['pantry-add-from-grocery-tab'] = {
    ls: ls.some(s => s.items.some(i => i.id === pItem.id)),
    idb: idb?.some(i => i.id === pItem.id),
  };

  // Cleanup
  await window.__otherClient(`/api/pantry/items/${pItem.id}`, { method: 'DELETE' });

  return results;
  // Expected: all true — App.tsx cache warmer applied the delta
}
```

**Critical check:** If cross-tab caching fails, users who go offline before visiting that tab will have stale data.

## Test 3: No Redundant API Refetches on Tab Switch

After the app loads and `fetchAllData` runs, switching tabs should NOT trigger API calls. Monitor the Docker logs:

```bash
docker logs -f meal-planner-app-1 2>&1 | grep "GET /api"
```

Then switch between Meals, Pantry, and Grocery tabs. You should see:
- **First load after page reload:** API calls for all entities (fetchAllData)
- **Subsequent tab switches:** Zero API calls (loaded from cache)
- **Tab focus after backgrounding:** API calls (broadcastFullRefresh resets sessionLoaded flags)

## Test 4: Offline Mutations & Queue

Tests that the app works offline and queues changes correctly.

### Go offline:
```javascript
// Via Playwright browser_run_code:
async (page) => {
  await page.context().setOffline(true);
  await page.waitForTimeout(3000);
  return 'Offline';
}
```

### Perform mutations via UI:
- Add a grocery item (quick-add form)
- Check/uncheck a grocery item
- Switch to Pantry, add an item, adjust quantities
- Switch to Meals, add a meal idea
- Add a meal note to a day

### Verify queue:
```javascript
async () => {
  const pending = await window.__readIDB('pendingChanges');
  return {
    count: pending?.length || 0,
    types: pending?.map(c => c.type) || [],
  };
  // Expected: one entry per mutation, correct change types
}
```

### Verify UI shows changes immediately:
Take screenshots after each mutation — optimistic updates should be visible despite being offline.

### Go back online:
```javascript
async (page) => {
  await page.context().setOffline(false);
  await page.waitForTimeout(8000);
  return 'Online';
}
```

### Known Playwright Limitation

**`setOffline(true)` → `setOffline(false)` can poison AbortControllers.** Playwright's offline simulation aborts in-flight fetch requests, and these aborted AbortControllers may persist even after going back online, causing `AbortError: signal is aborted without reason` on subsequent fetches.

**Workaround:** If sync fails after going back online:
1. Navigate to `about:blank` then back to the app
2. Or create a fresh browser context: `const ctx = await page.context().browser().newContext()`
3. Or reload with `page.reload({ waitUntil: 'domcontentloaded' })`

**For reliable offline→online sync testing, use the real browser/PWA** — toggle airplane mode or disconnect wifi. The Playwright limitation only affects the sync drain, not the offline queueing or UI behavior.

## Test 5: Verify Server State After Sync

After going online and waiting for sync:

```javascript
async () => {
  const pending = await window.__readIDB('pendingChanges');
  const serverGrocery = await (await fetch('/api/grocery', { credentials: 'include' })).json();
  const serverPantry = await (await fetch('/api/pantry', { credentials: 'include' })).json();
  const serverIdeas = await (await fetch('/api/meal-ideas', { credentials: 'include' })).json();

  return {
    queueDrained: (pending?.length || 0) === 0,
    // Check each offline mutation made it to the server
    grocery: {
      hasOfflineItem: serverGrocery.some(s => s.items.some(i => i.name === 'YOUR_ITEM_NAME')),
    },
    pantry: {
      hasOfflineItem: serverPantry.some(s => s.items.some(i => i.name === 'YOUR_ITEM_NAME')),
    },
    mealIdeas: {
      hasOfflineIdea: serverIdeas.some(i => i.title === 'YOUR_IDEA_TITLE'),
    },
  };
}
```

## Test 6: Undo/Redo

Test undo/redo for mutations made both online and offline.

### Online undo/redo:
1. Add a grocery item
2. Click Undo — item disappears, snackbar shows
3. Click Redo — item reappears
4. Verify server state matches after each step

### Offline undo/redo:
1. Go offline
2. Add a grocery item — shows immediately
3. Click Undo — item disappears
4. Click Redo — item reappears
5. Go online — verify sync completes and server has correct final state

## Checklist Summary

Run these checks after any SSE, caching, or offline changes:

- [ ] **Active tab SSE**: All entity types propagate to React state + LS + IDB
- [ ] **Cross-tab SSE**: Inactive tab caches update via App.tsx warmer
- [ ] **No refetch on tab switch**: Docker logs show zero API calls on tab switch
- [ ] **Calendar prefetch**: No API calls when first visiting Meals tab
- [ ] **Offline UI**: All mutations show immediately while offline
- [ ] **Offline queue**: Changes queued correctly in IDB pendingChanges
- [ ] **Online sync**: Queue drains, server has all offline changes
- [ ] **Undo/redo online**: Works correctly, server state consistent
- [ ] **Undo/redo offline**: Works correctly, syncs on reconnect
- [ ] **Store auto-populate**: Works for items in list AND cleared items (IDB item defaults)
