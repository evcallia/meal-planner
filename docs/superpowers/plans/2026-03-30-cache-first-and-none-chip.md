# Cache-First Loading & "None" Store Chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all data loading cache-first (instant from IndexedDB, then silently update from server) and add a "None" store chip to filter grocery items with no store assigned.

**Architecture:** Each load function changes from `if (online) { fetch } else { cache }` to `cache first → set state → setLoading(false) → if (online) { fetch in background → update state + cache }`. The "None" chip uses a sentinel value `"__none__"` passed through the existing `filterStoreId` / `StoreFilterBar` props.

**Tech Stack:** React hooks, Dexie (IndexedDB), TypeScript

---

### Task 1: Cache-first loading in `useStores`

**Files:**
- Modify: `frontend/src/hooks/useStores.ts:37-57`

- [ ] **Step 1: Update `loadStores` to cache-first**

Replace the `loadStores` function (lines 37-57) with:

```typescript
const loadStores = useCallback(async () => {
  const fetchVersion = optimisticVersionRef.current;

  // 1. Load from cache immediately
  try {
    const local = await getLocalStores();
    if (optimisticVersionRef.current !== fetchVersion) return;
    if (local.length > 0) {
      setStores(local);
      setLoading(false);
    }
  } catch { /* IndexedDB failed — continue to API */ }

  // 2. If online, fetch from API in background
  if (isOnlineRef.current) {
    try {
      const data = await getStoresAPI();
      if (optimisticVersionRef.current !== fetchVersion) return;
      setStores(data);
      await saveLocalStores(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
    } catch { /* API failed — keep cached data */ }
  }

  setLoading(false);
}, []);
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run src/hooks/__tests__/useStores.test.ts src/hooks/__tests__/useStores.undo.test.ts 2>&1`

Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useStores.ts
git commit -m "feat: cache-first loading for stores"
```

---

### Task 2: Cache-first loading in `useGroceryList`

**Files:**
- Modify: `frontend/src/hooks/useGroceryList.ts:108-142`

- [ ] **Step 1: Update `loadGroceryList` to cache-first**

Replace the `loadGroceryList` function (lines 108-142) with:

```typescript
const loadGroceryList = useCallback(async () => {
  const fetchVersion = optimisticVersionRef.current;

  // 1. Load from cache immediately
  try {
    const localData = await loadFromLocal();
    if (optimisticVersionRef.current !== fetchVersion) return;
    if (localData.length > 0) {
      setSections(localData);
      setLoading(false);
    }
  } catch { /* cache failed — continue to API */ }

  // 2. If online, fetch from API in background
  if (isOnlineRef.current) {
    try {
      const data = await getGroceryList();
      if (optimisticVersionRef.current !== fetchVersion) return;
      setSections(data);
      saveGroceryToLocalStorage(data);
      await saveLocalGrocerySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
      const allItems = data.flatMap(s => s.items);
      await saveLocalGroceryItems(allItems.map(i => ({
        id: i.id,
        section_id: i.section_id,
        name: i.name,
        quantity: i.quantity,
        checked: i.checked,
        position: i.position,
        store_id: i.store_id,
        updated_at: i.updated_at,
      })));
    } catch { /* API failed — keep cached data */ }
  }

  setLoading(false);
}, []);
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run src/hooks/__tests__/useGroceryList.test.ts src/hooks/__tests__/useGroceryList.offline.test.ts src/hooks/__tests__/useGroceryList.api-errors.test.ts 2>&1`

Expected: All existing tests pass (some may need minor updates if they assert network-first behavior).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useGroceryList.ts
git commit -m "feat: cache-first loading for grocery list"
```

---

### Task 3: Cache-first loading in `usePantry`

**Files:**
- Modify: `frontend/src/hooks/usePantry.ts:101-127`

- [ ] **Step 1: Update `loadPantryList` to cache-first**

Replace the `loadPantryList` function (lines 101-127) with:

```typescript
const loadPantryList = useCallback(async () => {
  const fetchVersion = optimisticVersionRef.current;

  // 1. Load from cache immediately
  try {
    const localData = await loadFromLocal();
    if (optimisticVersionRef.current !== fetchVersion) return;
    if (localData.length > 0) {
      setSections(localData);
      setLoading(false);
    }
  } catch { /* cache failed — continue to API */ }

  // 2. If online, fetch from API in background
  if (isOnlineRef.current) {
    try {
      const data = await getPantryList();
      if (optimisticVersionRef.current !== fetchVersion) return;
      setSections(data);
      savePantryToLocalStorage(data);
      await saveLocalPantrySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
      const allItems = data.flatMap(s => s.items);
      await saveLocalPantryItems(allItems.map(i => ({
        id: i.id, section_id: i.section_id, name: i.name,
        quantity: i.quantity, position: i.position, updated_at: i.updated_at,
      })));
    } catch { /* API failed — keep cached data */ }
  }

  setLoading(false);
}, []);
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run src/hooks/__tests__/usePantry.test.ts src/hooks/__tests__/usePantry.offline.test.ts src/hooks/__tests__/usePantry.api-errors.test.ts 2>&1`

Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/usePantry.ts
git commit -m "feat: cache-first loading for pantry"
```

---

### Task 4: Cache-first loading in `CalendarView`

**Files:**
- Modify: `frontend/src/components/CalendarView.tsx:200-285` (loadEventsForRange)
- Modify: `frontend/src/components/CalendarView.tsx:364-422` (initial load)
- Modify: `frontend/src/components/CalendarView.tsx:694-870` (loadPreviousWeek, loadNextWeek)

CalendarView has three loading paths. Each needs the cache-first treatment.

- [ ] **Step 1: Update initial load to cache-first**

Replace the initial load `useEffect` (lines 364-422). The key change: load from IndexedDB first, display immediately, then fetch from API and update.

```typescript
useEffect(() => {
  if (initialLoadDone.current) return;
  initialLoadDone.current = true;

  const init = async () => {
    setLoading(true);
    const startStr = formatDate(displayStartRef.current);
    const endStr = formatDate(displayEndRef.current);

    // 1. Load from cache immediately
    try {
      const localNotes = await getLocalNotesForRange(startStr, endStr);
      if (localNotes.length > 0) {
        const data = localNotesToDayData(localNotes, startStr, endStr);
        setDays(data);
        data.forEach(d => daysCache.current.set(d.date, d));
        setLoading(false);

        // Load events from cache too
        loadEventsForRange(displayStartRef.current, displayEndRef.current, false);
      }
    } catch { /* cache failed — will try API */ }

    // 2. If online, fetch from API in background
    if (isOnline) {
      try {
        const requestStart = perfNow();
        const data = await getDays(startStr, endStr);
        logDuration('calendar.days.request', requestStart, {
          start: startStr,
          end: endStr,
        });
        const renderStart = perfNow();
        setDays(data);
        data.forEach(d => daysCache.current.set(d.date, d));
        data.forEach(d => {
          if (d.meal_note) {
            saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
          }
        });
        enqueueRenderLog('calendar.days.render', renderStart, { count: data.length });

        loadEventsForRange(displayStartRef.current, displayEndRef.current, true);
        setTimeout(() => prefetchCacheRange(), 500);
      } catch (error) {
        console.error('Failed to load days from API:', error);
      }
    }

    setLoading(false);
  };
  init();
}, [loadEventsForRange, prefetchCacheRange, isOnline]);
```

- [ ] **Step 2: Update `loadEventsForRange` to cache-first**

Replace the `loadEventsForRange` function (lines 200-285). Load from IndexedDB first, then fetch from API if online.

```typescript
const loadEventsForRange = useCallback(async (start: Date, end: Date, online: boolean = true) => {
  const rangeKey = `${formatDate(start)}_${formatDate(end)}`;
  const startStr = formatDate(start);
  const endStr = formatDate(end);

  setEventsLoadState(prev => {
    if (prev[rangeKey]) return prev;
    return { ...prev, [rangeKey]: 'loading' };
  });

  setEventsLoadState(prev => {
    if (prev[rangeKey] === 'loaded') return prev;
    return { ...prev, [rangeKey]: 'loading' };
  });

  setLoadingEvents(true);

  const applyEvents = (eventsMap: Record<string, CalendarEvent[]>) => {
    const filteredEventsMap = showAllEventsRef.current ? eventsMap : filterEventsMap(eventsMap, hiddenEventKeysRef.current);
    for (const [date, events] of Object.entries(filteredEventsMap)) {
      const cached = daysCache.current.get(date);
      if (cached) {
        daysCache.current.set(date, { ...cached, events });
      }
    }

    const renderStart = perfNow();
    setDays(prev => prev.map(day => {
      if (day.date >= startStr && day.date <= endStr) {
        const dayEvents = filteredEventsMap[day.date] || [];
        return { ...day, events: dayEvents };
      }
      return day;
    }));
    enqueueRenderLog('calendar.events.render', renderStart, { rangeKey });
    setEventsLoadState(prev => ({ ...prev, [rangeKey]: 'loaded' }));
  };

  const loadFromIndexedDB = async () => {
    try {
      await refreshHiddenKeys();
      const localEvents = await getLocalCalendarEventsForRange(startStr, endStr);
      if (Object.keys(localEvents).length > 0) {
        applyEvents(normalizeEventsMap(localEvents));
        return true;
      }
    } catch (dbError) {
      console.error('Failed to load events from IndexedDB:', dbError);
    }
    return false;
  };

  // 1. Load from cache immediately
  await loadFromIndexedDB();

  // 2. If online, fetch from API in background
  if (online) {
    try {
      const requestStart = perfNow();
      const eventsMap = await getEvents(startStr, endStr, true);
      logDuration('calendar.events.request', requestStart, { start: startStr, end: endStr });

      for (const [date, events] of Object.entries(eventsMap)) {
        saveLocalCalendarEvents(date, events);
      }

      applyEvents(eventsMap);
    } catch (error) {
      console.error('Failed to load events from API:', error);
      // Cache data already applied above — no fallback needed
    }
  }

  setLoadingEvents(false);
}, []);
```

- [ ] **Step 3: Update `loadPreviousWeek` and `loadNextWeek` to cache-first**

For both pagination functions, change the pattern from `if (isOnline) { API } else { cache }` to `cache first → API in background`. The existing memory cache check is already fast; the change is: always try local cache first, then API.

In `loadPreviousWeek` (lines 747-780), replace the try block:

```typescript
try {
  // 1. Load from cache immediately
  await loadFromLocalCache();
  loadEventsForRange(newStart, newEnd, false);

  // 2. If online, fetch from API in background and update
  if (isOnline) {
    try {
      const requestStart = perfNow();
      const data = await getDays(startStr, endStr);
      logDuration('calendar.days.request', requestStart, { start: startStr, end: endStr });

      data.forEach(d => {
        daysCache.current.set(d.date, d);
        if (d.meal_note) {
          saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
        }
      });

      const renderStart = perfNow();
      addDaysToDisplay(data);
      enqueueRenderLog('calendar.days.render', renderStart, { count: data.length, direction: 'prev' });
      loadEventsForRange(newStart, newEnd, true);
    } catch (error) {
      console.error('Failed to load previous week from API:', error);
    }
  }
} finally {
  setLoadingMore(null);
}
```

In `loadNextWeek` (lines 836-869), replace the try block with the same pattern (change `'prev'` to `'next'` in the render log):

```typescript
try {
  // 1. Load from cache immediately
  await loadFromLocalCache();
  loadEventsForRange(newStart, newEnd, false);

  // 2. If online, fetch from API in background and update
  if (isOnline) {
    try {
      const requestStart = perfNow();
      const data = await getDays(startStr, endStr);
      logDuration('calendar.days.request', requestStart, { start: startStr, end: endStr });

      data.forEach(d => {
        daysCache.current.set(d.date, d);
        if (d.meal_note) {
          saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
        }
      });

      const renderStart = perfNow();
      addDaysToDisplay(data);
      enqueueRenderLog('calendar.days.render', renderStart, { count: data.length, direction: 'next' });
      loadEventsForRange(newStart, newEnd, true);
    } catch (error) {
      console.error('Failed to load next week from API:', error);
    }
  }
} finally {
  setLoadingMore(null);
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run src/components/__tests__/CalendarView.test.tsx 2>&1`

Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CalendarView.tsx
git commit -m "feat: cache-first loading for calendar view"
```

---

### Task 5: "None" store chip — GroceryListView changes

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx:33-68`

- [ ] **Step 1: Add `NONE_STORE_ID` sentinel and "None" count**

At the top of `GroceryListView.tsx` (after imports, before the component), add:

```typescript
export const NONE_STORE_ID = '__none__';
```

Update the `storeCounts` memo (lines 33-43) to also count items with no store:

```typescript
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
```

- [ ] **Step 2: Update `visibleSections` filter for "None"**

Update the `visibleSections` memo (lines 45-68). The `filterStoreId` check needs to handle `NONE_STORE_ID`:

```typescript
const visibleSections = useMemo(() => {
  let filtered = sections.filter(s => s.items.some(i => !i.checked));
  if (filterStoreId) {
    filtered = filtered
      .map(s => ({
        ...s,
        items: s.items.filter(i => !i.checked && (filterStoreId === NONE_STORE_ID
          ? !i.store_id
          : i.store_id === filterStoreId)),
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
}, [sections, filterStoreId, sortByStore, stores]);
```

- [ ] **Step 3: Pass `noneCount` to StoreFilterBar**

Update the `StoreFilterBar` usage (lines 382-390) to pass the none count:

```tsx
<StoreFilterBar
  stores={stores}
  activeStoreId={filterStoreId}
  onFilterChange={setFilterStoreId}
  onRename={renameStore}
  onDelete={removeStore}
  onReorder={reorderStores}
  storeCounts={storeCounts}
  noneCount={storeCounts.get(NONE_STORE_ID) ?? 0}
/>
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run src/components/__tests__/GroceryListView.test.tsx src/components/__tests__/GroceryListView.additional.test.tsx 2>&1`

Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/GroceryListView.tsx
git commit -m "feat: add None store filtering in grocery list view"
```

---

### Task 6: "None" store chip — StoreFilterBar changes

**Files:**
- Modify: `frontend/src/components/StoreFilterBar.tsx`

- [ ] **Step 1: Add `noneCount` prop and import sentinel**

Update the `StoreFilterBarProps` interface and import:

```typescript
import { NONE_STORE_ID } from './GroceryListView';
```

Add `noneCount` to props:

```typescript
interface StoreFilterBarProps {
  stores: Store[];
  activeStoreId: string | null;
  onFilterChange: (storeId: string | null) => void;
  onRename: (storeId: string, name: string) => void;
  onDelete: (storeId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  storeCounts?: Map<string, number>;
  noneCount?: number;
}
```

Update the destructuring:

```typescript
export function StoreFilterBar({ stores, activeStoreId, onFilterChange, onRename, onDelete, onReorder, storeCounts, noneCount = 0 }: StoreFilterBarProps) {
```

- [ ] **Step 2: Render the "None" chip**

Update the visibility check (line 248) — show bar if stores exist OR none count > 0:

```typescript
if (stores.length === 0 && noneCount === 0) return null;
```

Add the "None" chip after the store chips map (inside the flex container div, after the `stores.map(...)` block, before the closing `</div>`):

```tsx
{noneCount > 0 && (
  <button
    onPointerDown={(e) => {
      // Short tap only — no long-press/drag for None chip
      e.stopPropagation();
    }}
    onPointerUp={() => {
      onFilterChange(activeStoreId === NONE_STORE_ID ? null : NONE_STORE_ID);
    }}
    className={`
      px-3 py-1 rounded-full text-sm font-medium transition-colors select-none touch-none
      ${activeStoreId === NONE_STORE_ID
        ? 'bg-blue-500 text-white'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
      }
    `}
  >
    None
    <span className={`ml-1.5 text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center ${
      activeStoreId === NONE_STORE_ID
        ? 'bg-blue-400/30 text-white'
        : 'bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400'
    }`}>
      {noneCount}
    </span>
  </button>
)}
```

- [ ] **Step 3: Run tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run src/components/__tests__/StoreFilterBar.test.tsx src/components/__tests__/StoreFilterBar.additional.test.tsx 2>&1`

Expected: All existing tests pass.

- [ ] **Step 4: Run the full test suite**

Run: `cd /Users/evan.callia/Desktop/meal-planner && bash run-tests.sh 2>&1`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/StoreFilterBar.tsx
git commit -m "feat: add None chip to store filter bar"
```
