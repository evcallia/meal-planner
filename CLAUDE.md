# Meal Planner — Claude Instructions

## Running Commands
On macOS with Homebrew, Node/npm may not be in the default PATH.

```bash
# Frontend tests
npm run test:run 2>&1

# Frontend build
npm run build --prefix <project-root>/frontend 2>&1

# Backend tests
.venv/bin/python -m pytest tests/ 2>&1

# Run all tests
bash <project-root>/run-tests.sh
```

Key details:
- On macOS with Homebrew, export `PATH="/opt/homebrew/bin:$PATH"` if npm/node isn't found
- Shell cwd may reset — always use absolute paths or `cd` in the same command

## Architecture Notes
- `authEvents.ts` provides a global event bus for auth/CF failures (created Feb 2026)
- `getCurrentUser()` returns `AuthCheckResult` (not `UserInfo | null`) — has 3 states: `authenticated`, `auth-failed`, `network-error`
- `AuthError` class in `api/client.ts` for distinguishing auth errors from network errors in catch blocks
- `ConnectionStatus` type includes `'auth-required'` state (in addition to online/offline/syncing)
- Service worker has a `cacheWillUpdate` plugin that rejects HTML responses for API routes (prevents CF challenge caching)
- `fetchAPI` handles 204 No Content responses by returning `undefined` without parsing JSON body

## Server-Side User Settings
- `user_settings` table: `sub` (PK, from OIDC), `settings` (JSON), `updated_at` (DateTime)
- `GET /api/settings` returns `{ settings, updated_at }` for the authenticated user; empty `{}` if no row
- `PUT /api/settings` upserts and broadcasts `settings.updated` SSE event to the user's other sessions
- **Offline-first**: `useSettings` loads from localStorage immediately (zero delay), then syncs with server in background
- **Last-write-wins**: compares `updated_at` timestamps — server newer → apply server; local newer → push to server
- **localStorage format**: `{ settings: {...}, updated_at: "ISO8601" }` — auto-migrates from old flat format (just `{...}`)
- **SSE listener**: listens for `settings.updated` events, applies if incoming `updated_at` is newer than local
- `DEFAULT_SETTINGS` is exported from `useSettings.ts` for use in tests

## Per-User SSE Broadcasting
- `EventBroadcaster` tracks `sub` per queue via `_queue_subs` dict
- `subscribe(sub=...)` associates a queue with a user's OIDC subject
- `publish()` broadcasts to ALL queues (unchanged — used for shared data like grocery/pantry/calendar)
- `publish_to_user(sub, payload)` broadcasts only to queues for that user (used for settings)
- `broadcast_to_user()` helper function in `realtime.py` wraps `publish_to_user`
- SSE endpoint passes `user.get("sub")` to `subscribe()` so queues are tagged

## Data-Carrying SSE Events
- SSE events carry mutation data so clients apply deltas directly without API refetches
- Event format: `{ type: "grocery.updated", payload: { action: "item-added", sectionId: "...", item: {...} }, source_id: "..." }`
- **Actions per entity**: grocery/pantry have `item-added`, `item-updated`, `item-deleted`, `item-moved`, `section-added`, `section-renamed`, `section-deleted`, `section-reordered`, `items-reordered`, `cleared-checked` (grocery only), `cleared-all`, `replaced`. Stores have `added`, `updated`, `deleted`, `reordered`. Meal-ideas have `added`, `updated`, `deleted`
- **Frontend hooks**: Each hook has an `applyRealtimeEvent(payload)` function that switches on `action` to apply deltas to React state directly
- **Fallback on missing action**: If `payload?.action` is undefined (legacy event), hooks fall back to full API refetch via `loadXxxRef.current()`
- **App.tsx cache warmer**: Applies ALL SSE actions to localStorage + IndexedDB for inactive tabs (grocery, pantry, stores, meal-ideas). Already-data-carrying events (notes, calendar, settings) unchanged
- **IndexedDB persistence**: State sync `useEffect` in each hook persists to IDB whenever state changes, keeping offline cache current after SSE deltas
- All entities referenced by server-assigned ID in SSE payloads — never match on mutable fields like names

## Item Defaults (Store Auto-Populate)
- `item_defaults` table: `item_name` (PK, lowercase), `store_id` (FK → stores, nullable)
- `GET /api/grocery/item-defaults` returns all defaults with non-null store_id
- `ItemDefaultSchema` in schemas.py: `item_name`, `store_id`
- Frontend caches in IDB `itemDefaults` store (version 8), synced on app load via `fetchAllData`
- `GroceryListView` merges IDB defaults + current list items into `itemDefaultsMap` (useMemo on `[idbDefaults, sections]`)
- Quick-add and per-section-add forms check `itemDefaultsMap` for store auto-populate when item isn't in current list
- `useGroceryList` calls `putLocalItemDefault()` after add/edit API responses to keep IDB cache warm
- `StoreAutocomplete` always shows as editable input with pre-populated store name; X clears input only (no immediate update)

## Calendar Holidays
- US holidays fetched from Google's public iCal feed, cached in-memory (24h TTL) and in DB (`cached_calendar_events` with `calendar_name = "US Holidays"`)
- `include_holidays` query param on `/api/days/events` and `/api/days` (default `true`)
- `showHolidays` setting (default `true`) controls frontend visibility
- `holidayColor` / `calendarColor` settings allow per-user color customization for holiday vs regular events
- `EVENT_COLORS` map in `DayCard.tsx` maps color names to Tailwind class sets (text, bg, border, hover variants for light/dark)

## Store Chip Filtering
- **Multi-select**: `selectedStoreIds: Set<string>` in GroceryListView — tap multiple store chips to filter by several stores. Persisted to localStorage (`meal-planner-selected-stores`)
- **Exclude**: `excludedStoreIds: Set<string>` — long-press chip (800ms auto-opens popover) to exclude a store. Excluded chips show dimmed with strikethrough. Tap excluded chip to un-exclude. Persisted to localStorage (`meal-planner-excluded-stores`)
- **Filtering priority**: (1) remove excluded stores' items, (2) if any selected, show only those, (3) otherwise show all non-excluded
- **Chip visibility**: Only show chips for stores with unchecked items (or excluded stores). "Show all stores" toggle in kebab menu overrides this (persisted to localStorage `meal-planner-show-all-stores`)
- **None chip**: Supports multi-select, exclude, and long-press popover (exclude/include + cancel only, no rename/delete). Uses `NONE_STORE_ID = '__none__'`
- **Auto-deselect**: `useEffect` watches `storeCounts` — when a selected store's count drops to 0, it's removed from the selection
- **Two-phase long-press**: 300ms = drag-ready (movement starts drag), 800ms = auto-open popover (no release needed). None chip uses index `-1` to skip drag

## Drag & Drop Patterns
- `useDragReorder` hook supports both touch (long-press 300ms) and mouse (handle-based immediate drag)
- **containerRef approach**: Hook accepts a `containerRef` pointing to the container of draggable items. Items must have `data-drag-index` attributes. Uses `:scope > [data-drag-index]` to find draggable children — avoids broken `parentElement` traversal when DOM nesting doesn't match expectations
- Use refs for callbacks (`onReorderRef`) in drag hooks to avoid stale closures — document-level event handlers capture values at creation time
- Prevent text selection during drag: `document.body.style.setProperty('user-select', 'none')` + `document.getSelection()?.removeAllRanges()` — use `setProperty`/`removeProperty` to avoid TypeScript issues with vendor prefixes
- **flushSync for DOM layout**: Use `flushSync` from `react-dom` in `beginDrag` to flush `onDragStart` callback (e.g. section collapse) synchronously before caching rects and cloning the ghost element. This ensures the DOM layout reflects collapsed state before measurements. Import: `import { flushSync } from 'react-dom'`
- Collapse during drag uses `display: none` (not `max-height`) — simpler and avoids needing to know content height
- After DOM layout changes during drag (e.g. section collapse), recache rects via `requestAnimationFrame` in a `useEffect` triggered by `dragState.isDragging`
- Desktop drag handles: `cursor-grab active:cursor-grabbing` on SVG grip icons, `onMouseDown` for immediate drag start
- Touch + mouse coexistence: touch uses long-press timer on the row/header element, mouse uses `onMouseDown` on the grip icon only — no conflict since they're on different elements
- Ghost element: clone of `[data-drag-index]` element, `position: fixed`, `overflow: hidden`, cleaned up on unmount via `useEffect`
- **Mobile touch scroll prevention**: React synthetic touch handlers are passive by default — `e.preventDefault()` in `onTouchMove` won't block page scrolling. Fix: add a document-level `touchmove` listener with `{ passive: false }` in `beginDrag`, clean up in `finishDrag`
- **Auto-scroll during drag**: `requestAnimationFrame` loop in `beginDrag` scrolls viewport when `lastClientY` is within 60px of edges (proportional speed, max 12px/frame). Must recache item rects after each scroll frame for accurate hit-testing
- **Cross-section/cross-day drag**: Each section/day has its own `useDragReorder` instance. Parent component bridges them via `onDropOutside`/`onDragMove` callbacks and shared `crossDrag` state. Drop target found by querying `[data-section-id]` or `[data-day-date]` elements and measuring item rects within `[data-item-container]` or `[data-meal-container]`
- **Meal drag reordering**: DayCard uses `useDragReorder` for within-day reorder + cross-day moves. CalendarView bridges cross-day via `findMealDropTarget` (queries `[data-day-date]` DOM elements). Dragged item hidden with `opacity: 0` so shifted items are visible. `handleMealReorder` remaps `line_index` for itemized checkboxes. `handleMoveMeal` accepts optional `insertAt` for precise cross-day insertion position
- **Collapsed state with replace APIs**: When `replaceGroceryListAPI`/`replacePantryListAPI` recreates sections (new server IDs), local state keyed by ID resets. Fix: lift collapsed state to parent component, keyed by section **name** (stable across replace operations)

## Offline Patterns
- **Full documentation**: See `docs/offline-patterns.md` for all canonical patterns
- **No destructive replacements**: Never use `grocery-replace`/`pantry-replace` for CRUD ops — use targeted change types (`pantry-create-section`, `grocery-add`, etc.). Replacements overwrite other users' concurrent changes. Only use for `clearAll`/`clearChecked`/`mergeList`.
- **ID resolution**: Use `resolveId()` (sync, in-memory) in undo/redo handlers. Use `resolveIdAsync()` (async, IndexedDB fallback) in main mutation API calls — temp IDs may have been synced externally by `useSync`.
- **ID remap chain**: Use `remapId()` (not `idRemapRef.current.set()`) when recording new server IDs — it flattens the entire chain for multi-cycle undo/redo.
- **Undo/redo serialization**: `UndoContext` blocks concurrent undo/redo to prevent race conditions with ID remaps.
- All mutations must: (1) update state optimistically, (2) persist to IndexedDB, (3) call API if online or queue change if offline
- Undo/redo handlers must use `isOnlineRef.current` (not stale `isOnline`), always queue on failure/offline, always call `settleMutation()`
- Every `ChangeType` in `db.ts` must have a matching handler in `useSync.ts`
- Temp IDs must be mapped via `saveTempIdMapping`/`remapId` and resolved in `useSync.ts` for ALL ID fields (item, section, store)
- Queue payloads must include fallback fields (e.g., `sectionName`) for name-based resolution when temp IDs can't be mapped
- Delete endpoints must be idempotent (return 200 not 404 when already deleted)
- **Post-sync refetch**: `useSync` dispatches `'pending-changes-synced'` DOM event after draining the queue. All data hooks listen for this event and refetch from API, and App.tsx calls `fetchAllData()` for inactive tab cache warming. This picks up changes made by other devices while offline — needed because `fetchAllData` skips entities with pending changes, and SSE events from our own sync are filtered by `SOURCE_ID`

## Optimistic Update Patterns (useGroceryList)
- **Optimistic version tracking**: `optimisticVersionRef` (useRef counter) incremented on every local/optimistic update. `loadGroceryList` captures the version before fetching; if the version changed while the fetch was in-flight, discard the stale server response. This prevents realtime/refetch responses from overwriting newer local state
- **Pending mutations + deferred load**: `pendingMutationsRef` tracks count of in-flight mutation API calls. While > 0, realtime-triggered refetches (`grocery.updated` events) set `deferredLoadRef = true` instead of calling `loadGroceryList`. When all mutations settle (counter hits 0), the deferred load fires. Pattern: increment before API call, decrement in `finally` block via `settleMutation()`
- **Critical: no gap between version bump and pending guard**: In undo/redo handlers, `pendingMutationsRef.current++` MUST come immediately after `optimisticVersionRef.current++` — before any `await` calls (like `saveLocalGrocerySections`). Any `await` between them yields to the event loop, letting SSE events trigger unguarded refetches that overwrite optimistic state. `settleMutation()` goes at the very end, unconditionally (not inside `if (isOnline)`).
- **settleMutation pattern**: `settleMutation()` decrements `pendingMutationsRef`, checks if deferred load is needed, and calls `loadGroceryListRef.current()` if so. Uses a stable ref (`loadGroceryListRef`) to avoid stale closure issues
- **Push undo before API call**: For destructive operations like `deleteItem`, push the undo action BEFORE making the API call so the user can undo immediately (especially important with snackbar undo buttons)
- **Undo/redo with replaceGroceryListAPI**: For complex state changes (delete, clear), both undo and redo use `replaceGroceryListAPI` with full list snapshots rather than trying to reverse individual operations. Simpler and more reliable
- All mutation functions follow the same pattern: capture `prevSections`, increment `optimisticVersionRef`, optimistic `setSections`, save locally, API call (or queue offline), `pushAction` with undo/redo that also use the version/mutation refs

## Grocery Quick-Add Form
- **Add mode state**: `addMode: 'closed' | 'quick' | 'paste'` replaces old `showInputArea` boolean in GroceryListView
- **Quick-add form** (default): Section combobox + quantity stepper + item name input + full-width Add button
- **Section combobox**: Filters existing sections as user types; unmatched input creates a new section. Clear button (X) inside input. Empty sections show red X delete button in dropdown. Dropdown opens below input; `.glass` ancestor elevated on open for iOS z-index stacking
- **Section/store dropdowns**: Both sorted alphabetically via `localeCompare`
- **Store auto-populate**: Both quick-add and inline per-section add auto-populate store from `itemDefaultsMap` (merged IDB item defaults + current list items). Works offline and for items previously cleared from the list
- **Paste mode**: Toggle via "Paste a list instead" link; existing textarea with `[Section]` / `(N) Item` format
- **Rapid entry**: After add, item name clears, quantity resets to 0 (–), section stays selected, focus returns to item input
- **Section name title-casing**: Applied via `toTitleCase` at all entry points: `parseGroceryText`, `mergeList`, `renameSection`, `handleQuickAdd`
- **Delete empty sections**: `DELETE /api/grocery/sections/{id}` (idempotent — returns 204 if already gone), `deleteSection` in `useGroceryList` with targeted `POST /api/grocery/sections` for undo (not replace), mutable `sectionRef` + `idRemapRef` for ID tracking across undo/redo

## Grocery Section API Endpoints
- `POST /api/grocery/sections` — creates empty section with name and optional position, returns `GrocerySectionSchema` (201)
- `DELETE /api/grocery/sections/{id}` — idempotent delete (204 even if already gone), rejects 400 if section has items
- `PATCH /api/grocery/sections/{id}` — rename section (existing)

## Liquid Glass Styling
- **CSS utility classes** in `index.css`: `.glass` (cards/panels), `.glass-nav` (nav bar + bottom nav + FABs), `.glass-menu` (dropdowns/popovers — near-opaque to avoid nested backdrop-filter issues), `.glass-subtle` (section headers), `.glass-sticky` (unused after toolbar refactor)
- **Dark mode gradient**: on `<html>` element with `background-attachment: fixed`; iOS fallback uses `position: fixed` pseudo-element via `@supports (-webkit-touch-callout: none)`. Body is transparent in dark mode
- **Nested backdrop-filter limitation**: `backdrop-filter` doesn't work on elements nested inside a parent with `backdrop-filter`. Dropdowns/menus inside glass panels use `.glass-menu` with 97% opacity instead of relying on blur
- **iOS status bar**: Single `<meta name="theme-color">` tag, dynamically updated in `useDarkMode` hook when dark mode toggles. `apple-mobile-web-app-status-bar-style` set to `black-translucent`. `<html>` background set to `#0c1a2e` in dark mode so iOS safe area matches
- **Nav bar**: `<header>` uses `max-w-lg mx-auto w-full px-4` (same as `<main>`) with glass pill as inner `<div>` — matches toolbar width. Sticky with `z-10`
- **Bottom nav**: Floating island (`glass-nav rounded-full`), fixed `bottom-4`, centered with `left-1/2 -translate-x-1/2`
- **`color-scheme: dark`** on `select` elements in dark mode for white dropdown arrows

## Sticky Toolbars
- **PageHeader measures itself**: `ResizeObserver` sets `--header-h` CSS variable on `:root` with the header's `offsetHeight`
- **Toolbar positioning**: Grocery action bar, pantry action bar, and Future Meals panel use `sticky` with `style={{ top: 'calc(var(--header-h, 48px) + 24px)' }}` and `z-[9]` (below nav bar's `z-10`). The `24px` accounts for nav bar margin + gap
- **Toolbar styling**: Rounded glass pills (`glass rounded-2xl p-3`)
- **Grocery toolbar collapse**: Store filter chips toggle via inline chevron button. State persisted to localStorage (`meal-planner-toolbar-expanded`). Action bar row (Add items + sort + kebab + chevron) always visible

## Collapsible Future Meals Panel
- `MealIdeasPanel` has a collapse toggle on both compact and regular views
- Collapsed state persisted to `localStorage` key `meal-planner-ideas-collapsed`
- When collapsed, shows "Future Meals (N)" count + chevron; hides form and idea list

## Pantry Undo Patterns
- **Section delete undo preserves order**: `deleteSection` captures `originalIndex = sections.indexOf(section)` at deletion time. Both online and offline undo paths use `splice(Math.min(originalIndex, next.length), 0, ...)` to insert at the original position, then reindex positions with `.map((s, i) => ({ ...s, position: i }))`. Online undo also calls `reorderPantrySectionsAPI` to persist the order on the server.

## Optimistic Update Patterns (usePantry)
- **Debounced updates**: `updateItem` uses a 500ms debounce timer (`updateTimersRef`) and accumulates changes in `pendingUpdatesRef`. This lets rapid +/- clicks batch into a single API call
- **Guard against stale server responses**: After the debounced API call returns, only apply the server response if `!pendingUpdatesRef.current[id]` — a newer pending update means the response is already stale
- **Guard SSE during debounce**: The `pantry.updated` SSE handler skips `refreshItems()` when `Object.keys(pendingUpdatesRef.current).length > 0` — prevents stale server state from overwriting optimistic changes during rapid edits
- **loadTokenRef pattern**: `refreshItems` uses `const token = ++loadTokenRef.current` and checks `token === loadTokenRef.current` after async work. `invalidateLoad()` increments the counter to invalidate in-flight refreshes

## OIDC Logout
- `POST /api/auth/logout` clears the app session and returns `{ status, end_session_url }` with authentik's invalidation flow URL
- Frontend `logout()` in `api/client.ts` returns the `end_session_url` (or null)
- `handleLogout(endProviderSession)` in App.tsx: clears local data, then opens authentik's invalidation flow in a popup (desktop) or full redirect (PWA) to kill the authentik session
- PWA detection: `window.matchMedia('(display-mode: standalone)')` or `navigator.standalone`
- 401 auto-logout (`auth-unauthorized` event) passes `endProviderSession=false` to avoid redirect loops — only user-initiated logout triggers authentik invalidation
- authentik's invalidation flow (`/if/flow/default-invalidation-flow/`) auto-logs out without a confirmation prompt (unlike the OIDC end_session_endpoint which shows an interstitial)

## Preview / Local Dev Auth
- Backend has a `/api/auth/dev-login` endpoint that's only available when `OIDC_ISSUER` env var is empty. It sets a fake session (`dev-user` / `dev@localhost`) and redirects to `/`
- The `.env` file is in the project root — run uvicorn from the project root with `--app-dir backend` (not `cd backend && uvicorn`) so pydantic-settings can find `.env`
- Launch config overrides for local dev: `OIDC_ISSUER=` (empty), `SECURE_COOKIES=false`, `FRONTEND_URL=http://localhost:5173`, `POSTGRES_HOST=localhost`
- To authenticate in preview: navigate to `/api/auth/dev-login` (e.g. `window.location.href = '/api/auth/dev-login'`)
- Docker postgres (`meal-planner-db-1` from docker-compose) uses password from `.env`. The standalone `mealplanner-pg` container uses `changeme`. They use different volumes

## Multi-Day Calendar Events
- `get_events_for_date()` in `ical_service.py` checks if `target_date` falls between `start_time.date()` and `end_time.date()` (all-day end dates are exclusive per iCal spec)
- DB query in `_get_events_from_db` uses `or_()` to also fetch events whose `end_time` extends into the requested range
- Frontend `getEventDates()` in CalendarView computes all dates an event spans for restore/hide operations
- `compareEvents()` sorts holidays first, then by `start_time`

## Data Fetching Architecture
- **Singleton online status**: `useOnlineStatus` uses `useSyncExternalStore` with module-level state — single `/api/health` check shared across all consumers, no redundant checks on tab switch
- **Upfront data fetch**: App.tsx `fetchAllData()` fetches grocery, pantry, stores, meal-ideas, item-defaults, calendar days, calendar events, and hidden events in parallel on app load. Marks `sessionLoaded` flags after each entity fetch succeeds
- **Session-loaded guard**: Each hook (`useGroceryList`, `usePantry`, `useMealIdeas`, `useStores`) has a module-level `sessionLoaded` flag. On mount, hooks pass `sessionLoaded` as `skipApi` — first mount fetches from API, subsequent mounts (tab switches) load from cache only. `broadcastFullRefresh` resets all flags so tab-focus/reconnect triggers fresh fetches. Export `reset*SessionLoaded()` and `mark*SessionLoaded()` for App.tsx and tests
- **Calendar prefetch in fetchAllData**: Calendar days, events, and hidden events are prefetched on app load with the same range as CalendarView (-14 to +56 days). `markCalendarSessionLoaded(startStr, endStr)` sets both `sessionLoaded` and `prefetchedStart`/`prefetchedEnd` so CalendarView skips its own API fetch and `loadNextWeek` knows the range is cached
- **Pre-cache double-run prevention**: `preCacheDoneRef` in App.tsx prevents the effect from running twice when auth calls `setUser` twice (cached + API)
- **Focus/reconnect refresh**: `broadcastFullRefresh()` in App.tsx calls `fetchAllData()` (resets flags + re-fetches all data) and dispatches a synthetic `calendar.refreshed` event. Called on `visibilitychange` (hidden→visible) and online reconnect
- **Background cache warmer**: App.tsx SSE handler applies data-carrying deltas to localStorage + IndexedDB for inactive tabs (grocery, pantry, stores, meal-ideas). Already-data-carrying events (notes, item, calendar events, hidden events) save directly to IDB. Active tab's hooks handle their own SSE events. No API refetches — all data comes from the SSE payload
- **Calendar single-fetch**: CalendarView init fetches one `getDays` call for the full range (past 2 weeks through future 8 weeks) and one `getEvents` call, instead of separate calls per range
- **Calendar prefetch range**: Module-level `prefetchedStart`/`prefetchedEnd` strings track the pre-fetched date range. `loadNextWeek`/`loadPreviousWeek` skip API calls when the requested range falls within these boundaries — only hit API when scrolling past the prefetched window
- **Calendar remount guard**: `showAllEvents`/`showHolidays` effect uses prev-value refs to only fire on actual changes, not on component remount (prevents redundant API calls on tab switch)
- **Calendar scroll-to-today**: `scrollToElementWithOffset` accounts for nav bar height (`--header-h` CSS var), sticky panels (`.sticky.z-\[9\]`), and a 48px extra offset so "Load previous" button is also visible
- **Calendar load-previous scroll preservation**: `loadPreviousWeek` uses `flushSync` + scroll anchor pattern — captures first visible day card's position, flushes the state update synchronously, then adjusts `window.scrollBy` so the view stays in place while new days appear above

## Testing Patterns
- Mock `authEvents` in test files that import modules using it: `vi.mock('../../authEvents', () => ({ emitAuthFailure: vi.fn(), onAuthFailure: vi.fn(() => vi.fn()) }))`
- Mock fetch responses need `headers: { get: () => 'application/json' }` since `fetchAPI` now checks content-type on errors
- `useSync.test.ts` uses `importOriginal` for `api/client` mock to preserve `AuthError` class for `instanceof` checks
- `useSettings.test.ts` mocks `useOnlineStatus` to return `false` (offline) to isolate localStorage behavior from server sync. Also mocks `api/client` with `getSettings`/`putSettings` rejecting to simulate offline
- Backend settings tests use `authenticated_client` fixture (not bare `client`) and mock `broadcast_to_user` with `AsyncMock`
- Hooks with module-level `sessionLoaded` flags need `reset*SessionLoaded()` in `beforeEach` to prevent cross-test pollution. Set `navigator.onLine` before `resetOnlineStatus()` when testing offline scenarios
