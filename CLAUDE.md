# Meal Planner — Claude Instructions

## Running Commands
The shell working directory may not be the project root. Always use `--prefix` or `cd` with `&&` to ensure correct directory. On macOS with Homebrew, Node/npm may not be in the default PATH.

```bash
# Frontend tests
cd <project-root>/frontend && npm run test:run 2>&1

# Frontend build
npm run build --prefix <project-root>/frontend 2>&1

# Backend tests
cd <project-root>/backend && .venv/bin/python -m pytest tests/ 2>&1

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
- **Cross-section drag**: Each section has its own `useDragReorder` instance. Parent component bridges them via `onDropOutside`/`onDragMove` callbacks and shared `crossDrag` state. Drop target found by querying `[data-section-id]` elements and measuring item rects within `[data-item-container]`
- **Collapsed state with replace APIs**: When `replaceGroceryListAPI`/`replacePantryListAPI` recreates sections (new server IDs), local state keyed by ID resets. Fix: lift collapsed state to parent component, keyed by section **name** (stable across replace operations)

## Optimistic Update Patterns (useGroceryList)
- **Optimistic version tracking**: `optimisticVersionRef` (useRef counter) incremented on every local/optimistic update. `loadGroceryList` captures the version before fetching; if the version changed while the fetch was in-flight, discard the stale server response. This prevents realtime/refetch responses from overwriting newer local state
- **Pending mutations + deferred load**: `pendingMutationsRef` tracks count of in-flight mutation API calls. While > 0, realtime-triggered refetches (`grocery.updated` events) set `deferredLoadRef = true` instead of calling `loadGroceryList`. When all mutations settle (counter hits 0), the deferred load fires. Pattern: increment before API call, decrement in `finally` block via `settleMutation()`
- **Critical: no gap between version bump and pending guard**: In undo/redo handlers, `pendingMutationsRef.current++` MUST come immediately after `optimisticVersionRef.current++` — before any `await` calls (like `saveLocalGrocerySections`). Any `await` between them yields to the event loop, letting SSE events trigger unguarded refetches that overwrite optimistic state. `settleMutation()` goes at the very end, unconditionally (not inside `if (isOnline)`).
- **settleMutation pattern**: `settleMutation()` decrements `pendingMutationsRef`, checks if deferred load is needed, and calls `loadGroceryListRef.current()` if so. Uses a stable ref (`loadGroceryListRef`) to avoid stale closure issues
- **Push undo before API call**: For destructive operations like `deleteItem`, push the undo action BEFORE making the API call so the user can undo immediately (especially important with snackbar undo buttons)
- **Undo/redo with replaceGroceryListAPI**: For complex state changes (delete, clear), both undo and redo use `replaceGroceryListAPI` with full list snapshots rather than trying to reverse individual operations. Simpler and more reliable
- All mutation functions follow the same pattern: capture `prevSections`, increment `optimisticVersionRef`, optimistic `setSections`, save locally, API call (or queue offline), `pushAction` with undo/redo that also use the version/mutation refs

## Optimistic Update Patterns (usePantry)
- **Debounced updates**: `updateItem` uses a 500ms debounce timer (`updateTimersRef`) and accumulates changes in `pendingUpdatesRef`. This lets rapid +/- clicks batch into a single API call
- **Guard against stale server responses**: After the debounced API call returns, only apply the server response if `!pendingUpdatesRef.current[id]` — a newer pending update means the response is already stale
- **Guard SSE during debounce**: The `pantry.updated` SSE handler skips `refreshItems()` when `Object.keys(pendingUpdatesRef.current).length > 0` — prevents stale server state from overwriting optimistic changes during rapid edits
- **loadTokenRef pattern**: `refreshItems` uses `const token = ++loadTokenRef.current` and checks `token === loadTokenRef.current` after async work. `invalidateLoad()` increments the counter to invalidate in-flight refreshes

## Preview / Local Dev Auth
- Backend has a `/api/auth/dev-login` endpoint that's only available when `OIDC_ISSUER` env var is empty. It sets a fake session (`dev-user` / `dev@localhost`) and redirects to `/`
- The `.env` file is in the project root — run uvicorn from the project root with `--app-dir backend` (not `cd backend && uvicorn`) so pydantic-settings can find `.env`
- Launch config overrides for local dev: `OIDC_ISSUER=` (empty), `SECURE_COOKIES=false`, `FRONTEND_URL=http://localhost:5173`, `POSTGRES_HOST=localhost`
- To authenticate in preview: navigate to `/api/auth/dev-login` (e.g. `window.location.href = '/api/auth/dev-login'`)
- Docker postgres (`meal-planner-db-1` from docker-compose) uses password from `.env`. The standalone `mealplanner-pg` container uses `changeme`. They use different volumes

## Testing Patterns
- Mock `authEvents` in test files that import modules using it: `vi.mock('../../authEvents', () => ({ emitAuthFailure: vi.fn(), onAuthFailure: vi.fn(() => vi.fn()) }))`
- Mock fetch responses need `headers: { get: () => 'application/json' }` since `fetchAPI` now checks content-type on errors
- `useSync.test.ts` uses `importOriginal` for `api/client` mock to preserve `AuthError` class for `instanceof` checks
