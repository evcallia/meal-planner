# Meal Planner — Claude Instructions

## Running Commands
On macOS with Homebrew, Node/npm may not be in the default PATH.

```bash
# Frontend tests
npm run test:run 2>&1

# Frontend build
npm run build --prefix <project-root>/frontend 2>&1

# Backend tests (Go)
cd <project-root>/backend && go test ./... 2>&1

# Backend build (Go)
cd <project-root>/backend && go build ./... 2>&1

# Run all tests
bash <project-root>/run-tests.sh
```

Key details:
- On macOS with Homebrew, export `PATH="/opt/homebrew/bin:$PATH"` if npm/node isn't found
- Go may live at `$HOME/sdk/go/bin` or `/usr/local/go/bin` — add to PATH if `go` isn't found
- Shell cwd may reset — always use absolute paths or `cd` in the same command

## Go Backend (backend/)
The backend is a Go rewrite of the original FastAPI app (same API contract). Layout:
- `cmd/server/` — entrypoint (startup mirrors the FastAPI lifespan: AutoMigrate → migrations → cleanup → calendar cache init)
- `internal/config` — env/.env settings + `ValidateSecurity` (same rules as Python `validate_security`)
- `internal/models` — GORM models; all `DateTime` columns are **naive UTC**, `Date` columns are midnight-UTC `time.Time`
- `internal/app` — one file per router (`grocery.go`, `tracker.go`, …), `serialize.go` builds the exact pydantic JSON shapes, `harness_test.go` is the shared test harness (in-memory SQLite + signed-cookie auth + SSE collector)
- `internal/realtime` — SSE broadcaster (per-subscriber queues tagged with user sub, drop-oldest at 100)
- `internal/ical` — holidays feed + hand-rolled CalDAV client + DB cache; `Service` has replaceable fetcher fields as test seams
- `internal/httpx` — FastAPI-shaped errors (`{"detail": ...}`), `model_fields_set`-style body decoding (`DecodeBody` returns present keys), Python-isoformat datetime rendering (no "Z", microseconds only when nonzero)
- Tests use pure-Go SQLite (`glebarez/sqlite`); prod uses Postgres — keep raw SQL portable across both

## Architecture Notes
- `getCurrentUser()` returns `UserInfo | null` (null on 401 from `/api/auth/me` — the one endpoint where 401 is a legitimate logged-out state)
- `AuthError` class in `api/client.ts` for distinguishing auth errors from network errors in catch blocks
- `ConnectionStatus` type includes `'auth-required'` state (in addition to online/offline/syncing)
- `fetchAPI` handles 204 No Content responses by returning `undefined` without parsing JSON body

## PWA Re-Auth Flow
- Detection in `fetchAPI`: 401 from any path except `/auth/me`, 403 + HTML body, 2xx + HTML body (CF interstitial), or ANY redirect (`opaqueredirect`/3xx) → dispatch `'auth-required'` window event + throw `AuthError`. `healthFetch` in `useOnlineStatus` also dispatches on HTML or redirect from `/api/health`
- **`redirect: 'manual'` on all API fetches**: Cloudflare Access answers expired sessions with a 302 to `cloudflareaccess.com`; following it fails as a cross-origin TypeError indistinguishable from being offline. Manual mode surfaces it as a detectable `opaqueredirect`. API endpoints never legitimately redirect (OIDC redirects are full-page navigations, not fetches)
- `useSync` and `useRealtime` each have a module-level `_authRequired` flag set by the `'auth-required'` listener — sync drains and SSE reconnects pause until full-page navigation resets the modules
- `useSync` sets `status = 'auth-required'` on the event; queued changes are untouched and sync resumes after the post-login reload
- `ReAuthModal` (non-dismissable, shows pending count) renders in App.tsx when `status === 'auth-required'`; Sign in button does full-window `window.location.href = getLoginUrl()`
- A 401 does NOT clear local data — the old destructive `auth-unauthorized` → `handleLogout(false)` handler was removed
- **Queue discard rule**: failed changes are retried with a per-change `attempts` counter (`PendingChange.attempts`, incremented on each sync failure); discarded only after `MAX_SYNC_ATTEMPTS` (20) failures. `AuthError` failures pause sync without incrementing. There is no absolute-age discard
- Service worker `NetworkFirst` for `/api/*` has a `cacheWillUpdate` plugin (vite.config.ts) rejecting HTML and non-ok responses so CF challenge pages never enter `api-cache`

## Lists / Tracker (private, shareable recency tracker)
- A 4th tab ("Lists") rebuilding the lastGLANCE concept: track *when you last did* a task. Each task has an optional `target_interval_days`; freshness is `elapsed / target`, color-coded green→amber→red and overdue tasks sort to the top automatically (`utils/recency.ts`)
- **Privacy is a deliberate departure from the app's shared-global model**: tracker entities are per-user. A `TrackerList` has an `owner_sub`; it's private until shared. `TrackerShare(list_id, sub)` grants access. Access rule: `owner_sub == me OR a share row for me`. Owner-only ops: delete list, add/remove shares. Shared users can collaborate on tasks/logs
- Models (`internal/models/models.go`): `TrackerList` (owner_sub, name, icon, color, position) → `TrackerTask` (target_interval_days, notes, position, archived) → `TrackerLog` (done_at — backdatable, note). Stats (`last_done_at`, `total_count`, `avg_interval_days`) are computed from logs server-side in `trackerTaskJSON`, not stored
- **Per-user SSE**: tracker events broadcast via `BroadcastToUser(sub, ...)` to the list's audience (owner + shares) only — never the global `BroadcastEvent`. Full-list payloads use `trackerBroadcastList` which recomputes `is_owner` *per recipient* (a shared user must not receive the owner's perspective). Event type `tracker.updated`; actions: `list-added/updated/deleted/reordered/shared`, `task-added/updated/deleted/logged`, `tasks-reordered`
- `users` table + `recordUser()` (called on OIDC callback + dev-login) is a directory so owners can resolve a collaborator's email → sub when sharing. `GET /api/users` powers the share picker. **Sharing by email requires the target to have signed in at least once** (else 404)
- GORM `AutoMigrate` creates the new tables on startup; no manual migration needed. Endpoints in `internal/app/tracker.go` (`/api/tracker`) and `users.go`
- Frontend: `useTracker` hook (mirrors grocery's optimistic+offline+undo machinery), `ListsView.tsx` (cards, task rows with a "Done" button, task-detail/history modal, share modal), IDB v9 (`trackerLists`, `trackerTasks` — logs are fetched on demand, not cached), `tracker-*` ChangeTypes in `useSync.ts`. Undo/redo covers mark-done, delete task, delete list (snapshots logs at delete time so undo restores history). **List restore remaps ids**: the restore endpoint reissues list/task/log ids, so `restoreList` chains old→new ids (tasks matched by position, logs by done_at+kind+note) so older undo entries keep resolving. **Offline delete→undo**: if the queued `tracker-list-delete` hasn't synced, undo cancels the pending change and keeps the original ids (server untouched); if the delete already synced, undo queues `tracker-list-restore` (full subtree; offline snapshots carry each task's `recent_logs`) and `useSync` maps temp→real ids when it lands
- Tab/page has its own `<UndoProvider id="lists">`. App.tsx warms the tracker IndexedDB cache from `tracker.updated` events while off-tab (like grocery/pantry) — applying list/task deltas incl. `recent_logs` — so lists + history stay current in the background and are ready to go offline with. On the Lists tab, `useTracker` handles events itself; the warmer no-ops there. (Safe despite per-user privacy: the server only broadcasts tracker events to the list's audience.) `recent_logs` also rides along on every SSE task payload, so history updates live; a reconnect does one catch-up `loadTracker` for events missed while offline
- Server datetimes are naive UTC; `parseServerDate()` in `utils/recency.ts` appends `Z` so JS doesn't misread them as local time

## Push Notifications (Web Push)
- **Backend `internal/push`**: VAPID keypair auto-generated on first use and persisted in the `vapid_keys` table (contact claim via `VAPID_SUBJECT` env). `push_subscriptions` table stores one row per device (`sub`, unique `endpoint`, `p256dh`, `auth`). Dead endpoints (404/410 from the push service) are pruned on send. Uses `SherClockHolmes/webpush-go`; sends run in goroutines (`Service.Flush()` waits on them in tests). `Service.Now` and `Service.Send` are injectable test hooks
- **Endpoints** (`internal/app/push.go`): `GET /api/push/public-key`, `POST /api/push/subscriptions` (upsert by endpoint), `DELETE /api/push/subscriptions` (idempotent, own-subscriptions only)
- **Edit batching + suppression**: the first edit starts a batch; the summary notification sends after 2 min without further edits (capped 5 min after the first edit — `BatchQuietDelay`/`BatchMaxDelay`, service fields `BatchQuiet`/`BatchMax`, both 0 = send immediately, used by tests). One edit reads like `Evan added “Milk”`; a burst reads `Evan made 6 edits: added “Milk”, added “Eggs”, updated “Cheese”, …` (details deduped, max 6 kept, 3 shown). After the summary, the sliding 30-min suppression applies: edits keep resetting the window and notify again only after ≥30 min of quiet. Keyed per (category, actor) — tracker per (list, actor). State is in-memory: restart resets everything. `PUSH_EDIT_WINDOW_MINUTES` (default 30) shortens the window AND scales batch delays (window/3 quiet, window cap) for testing. `Sleep` is injectable; batch goroutines are race-clean (`go test -race ./internal/push/`)
- **Testing/diagnostics**: `POST /api/push/test` sends to the CALLER's own devices, bypassing suppression + prefs, returning per-device `{endpoint, status|error}` — surfaced via the "Send test notification" button in Settings. All deliveries log failures/rejections with the push service's response body (`push:` prefix); suppressed edits log too
- **VAPID subject gotcha**: webpush-go prepends `mailto:` itself — `normalizeSubject` strips any `mailto:` prefix from `VAPID_SUBJECT` before passing it in. Without this the JWT sub was `mailto:mailto:…`: Mozilla accepted it, Apple rejected every send with 403 BadJwtToken. Apple is the strict one generally (subject validity, ≤24h exp) — test iOS delivery whenever touching VAPID code
- **Specific notification bodies**: `editPushDetail` (app/push.go) derives a short verb phrase from the SSE payload — `added “Milk”`, `updated meals for Thu, Jul 16`, `cleared the pantry` (the notification title carries the list context); reorder actions notify nobody. Tracker: `trackerPushDetail` derives from `extra["task"]` (`added/updated/completed “X”`), and ambiguous sites pass an explicit `"pushDetail"` entry in the broadcast payload — stripped before it goes out over SSE. Handler-supplied details: grocery/pantry deletes (`removed “Chicken”`, `removed the “Fridge” section`), check/uncheck (`checked off “Milk”`), item renames (`renamed “Old” to “New”` — old name captured before mutation), pantry quantity (`set “Flour” to 3`), list replace (`replaced the grocery list (2 sections, 12 items)` — `countNoun` helper), tracker task archive/restore, tracker membership (`shared the list with Sarah` / `removed X from the list` / `left|rejoined the list` — `trackerMemberName`; `trackerBroadcastList` takes a detail param), tracker list rename, tracker log add/skip/delete. List name stays the notification title
- **Three notification sources**: (1) shared-data edits — `a.broadcast()` in `grocery.go` maps `notes.updated`/`pantry.updated`/`grocery.updated` → push to all subscribed users EXCEPT the editor (actor read from the session); (2) tracker list edits — `trackerBroadcast`/`trackerBroadcastList`/list-delete call `queueTrackerEditPush`, notifying the list's audience (owner + active shares) except the actor; `*reorder*` actions never notify; (3) tracker due tasks — `RunDueLoop` (started in cmd/server, stopped via `Broadcaster.Done`) checks every 5 min (short so digest times are honored promptly). `CheckDueTasks` computes recipients PER USER: newly-due tasks (due_notified_at nil or < baseline) notify every member; still-due tasks whose last notification is ≥24h old (`DueRepeatInterval`) notify only members with `notifyListsDueRepeat` (opt-in "Repeat daily" toggle under List reminders). Per-task mutes: `settings.taskNotifyOverrides[taskId].due` can only MUTE within the list/global gate (see the notification-hierarchy bullet). `due_notified_at` set with `UpdateColumn` (UpdatedAt untouched); repeat tasks' timestamps only advance when a repeat opt-in exists in the audience, so enabling the setting later fires on the next check
- **Daily due digest**: `notifyListsDueDigest` + `notifyListsDueDigestTime` ("HH:MM", default 08:00) + `notifyTimeZone` (IANA, recorded by the client on save; `time/tzdata` is embedded). Digest users are SKIPPED by the immediate/repeat due sends and instead get ONE "Due today" summary at/after their configured LOCAL time, once per local day, covering everything due by END of their local day — due-instants are computed exactly (`baseline + target`), so an 8am digest includes a task crossing its threshold at 9am, while tomorrow's stay out; per-list/per-task mutes apply to look-ahead items identically (tasks labeled `Name (List)`) — `sendDueDigests`, dedup via the `due_digests` table (marked even on quiet days so each day evaluates once; survives restarts). Repeat-daily is subsumed: its toggle is disabled in the UI while digest is on. Feed entries are unaffected (still written when tasks newly become due)
- **Preference gating (strictly opt-in)**: per-category keys in `user_settings` JSON — `notifyMealEdits`, `notifyPantryEdits`, `notifyGroceryEdits`, `notifyListEdits`, `notifyListsDue`. A missing row/key = DISABLED — only an explicit true notifies (`push.LoadNotifyPrefs`/`NotifyPrefs.Enabled`; frontend `DEFAULT_SETTINGS` all false). Same gate feeds the activity feed, so a fresh user's bell is empty. Names must match `PrefKeys` in `internal/push/push.go` and the `Settings` interface in `useSettings.ts`. Test helpers `enableAllNotifyPrefs` (push pkg) / `enableAllPrefsApp` (app pkg) opt recipients in
- **Notification hierarchy (narrow-only cascade)**: global Settings toggles are HARD kill-switches (opt-in, default off); the per-list layer (`settings.listNotifyOverrides[listId].{edits,due}`, defaults ON) can only mute its list; the per-task layer (`taskNotifyOverrides[taskId].due`, defaults ON) can only mute its task. Effective = global && list && task — no lower level can re-enable a disabled upper level (`NotifyPrefs.Enabled`/`DueTaskEnabled`). `SendToUsers` takes a `listID` param (empty for non-tracker categories) carried on tracker batches and passed by the due check. UI mirrors the cascade: "Notifications" in each list's kebab menu (`ListNotifyModal`) locks its toggles with a note when the global is off; the task toggle in TaskDetailModal locks when global or list is off; "Repeat daily" in Settings locks when List reminders is off
- **Frontend**: `utils/push.ts` (`enablePush`/`disablePush`/`getPushSubscription` — uses `getRegistration()` not `.ready` so dev mode without a SW doesn't hang). SW push/notificationclick handlers live in `public/push-sw.js`, pulled into the generated worker via workbox `importScripts` in vite.config.ts. Settings modal has a master toggle (= device subscription state, per-device) + per-category toggles synced via user settings. Notification tags collapse same-scope notifications in the tray
- **Self-healing subscription**: the app-update "nuclear" path (App.tsx `applyUpdate`) unregisters the SW, which DESTROYS its push subscriptions — the device toggle silently reset to off after updates. Fix: `enablePush` records `meal-planner-push-enabled` in localStorage (cleared by `disablePush`); `ensurePushSubscription()` runs once per launch (App.tsx, gated on auth) and silently re-subscribes when the flag is set + permission granted + subscription missing/stale-keyed, then re-POSTs to the server (heals server-side pruning too). It awaits `navigator.serviceWorker.ready`, safe because the flag is only ever set in SW-capable environments. Test-setup gotcha: `src/test/setup.ts` stubs localStorage with bare `vi.fn()`s — tests needing real storage semantics must install their own (see `push.test.ts`)

## Activity Feed ("since you were away")
- `activity_log` table: one row per edit with the SAME verb phrase the push notifications use (`at`, `actor_sub`, `actor_name`, `category`, `detail`, `list_name`), written by `a.logActivity` from the same hooks that queue pushes (`a.broadcast` + `queueTrackerEditPush`); reorders excluded. Retention: 30 days, pruned in `db.CleanupOldData`
- **Tracker privacy via audience snapshot**: tracker rows store `audience` as `|sub1|sub2|` text captured at edit time — feed queries filter `audience = '' OR audience LIKE '%|<sub>|%'`. Snapshot (not a join) so entries stay correctly visible even after the list and its share rows are deleted
- `GET /api/activity` → `{entries (max 100, newest first, EXCLUDING the caller's own edits), last_seen}`; `POST /api/activity/seen` upserts the caller's `activity_seen` marker
- **Feed mirrors notification prefs**: entries are gated on the same cascade as pushes (`push.LoadNotifyPrefs` — `Enabled(category, listID)`, and `DueTaskEnabled(listID, taskID)` for `list-due` rows; `activity_log.list_id`/`task_id` store the ids). Evaluated at READ time, so toggling a pref immediately re-filters history (and the badge). The per-DEVICE master push toggle is deliberately ignored — the feed is a per-user pull surface
- **Due reminders appear in the feed**: `CheckDueTasks` writes one ACTOR-LESS `list-due` row per NEWLY-due task (audience-snapshotted like tracker edits; daily repeat reminders never re-append). Frontend renders actor-less entries without a name, context label "Due"/list name
- **Live `activity.added` SSE**: the server emits the FULLY-RENDERED entry (same shape as GET, via `activityEntryJSON`; payload `{entry, actor_sub}`) whenever a row is logged — `emitActivity`: global categories broadcast to all sessions (client self-excludes via actor_sub), tracker/due go per-audience-member excluding the actor (due via the `Push.OnActivity` hook wired in app.New). `useActivity` appends live entries directly (dedupe by id, cap 100) after client-side gating: own-sub skip + `entryVisible()` mirroring the server cascade (MUST stay in sync with `push.NotifyPrefs`; entries carry `list_id`/`task_id` for it). NO refetch on edit events anymore — fetches remain only for catch-up: launch, reconnect (isOnline flip), visibilitychange→visible (iOS suspends SSE while backgrounded/locked and missed events are never replayed — without this, a due reminder that fired while suspended never bumps the badge), SSE (re)connect (`meal-planner-realtime-connected` window event fired in useRealtime's onopen — covers server restarts, where the startup due check fires BEFORE clients reconnect, plus any network-blip gap), `pending-changes-synced` drain (debounced 5s), and opening the bell (reconciliation)
- **Frontend**: `useActivity` hook in App (fetch on auth+online, debounced 5s refetch on `grocery/pantry/notes/tracker.updated` SSE + `pending-changes-synced`); bell button + unseen badge in `PageHeader` (props threaded through the four page components). `ActivityPanel` marks seen on open AND re-marks whenever entries stream in while open (the viewer is looking at them — they never count toward the badge); the "earlier" divider anchors to `initialLastSeen` captured at mount so re-marking doesn't collapse the "new" grouping; App suppresses the badge entirely while the panel is open (`showActivity ? 0 : unseenCount`) to avoid the transient tick before the seen-marker lands

## Features (tab visibility)
- `settings.featureMeals/featurePantry/featureGrocery/featureLists` (default true, per-user synced) control which tabs exist — "Features" section in Settings (first section). PURELY visual: SSE handling + cache warming for hidden tabs keeps running
- UI enforces at least one enabled (the last on toggle is disabled with a note); App treats missing keys as enabled and an all-off state (bad synced data) as all-on (`visiblePages` fallback). If the current tab's feature is disabled (possibly via settings sync from another device) an effect lands on the first enabled tab. BottomNav takes a `pages` prop and returns null when ≤1 page

## Settings Modal Layout
- Settings are grouped into five collapsible `SettingsSection`s (collapsed by default): **Features** (tab visibility), **Appearance** (dark mode, compact view, text sizes, edit highlight), **Meals** (future meals, itemized column), **Calendar** (sync, event color, holidays, show-all + hidden events), **Notifications** (device toggle "Enable on this device" + per-category + test button). Pending Changes stays outside sections (always visible when present)
- **App updates surface in the bell, not Settings**: the pinned "Update available" row lives at the top of the ActivityPanel, the bell badge adds +1 while an update is pending (`bellCount` in PageHeader), and the settings gear no longer shows an update dot. The floating bottom UpdateNotification banner remains the primary prompt
- Section toggles carry `data-testid="settings-section-toggle"` — tests must expand sections before querying settings inside them (`renderModal` in SettingsModal.test.tsx does it; `expandSections()` in the additional file)

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
- `Broadcaster` (`internal/realtime/realtime.go`) tags each subscriber queue with the user's OIDC sub via `Subscribe(sub)`
- `Publish()`/`BroadcastEvent()` broadcast to ALL queues (used for shared data like grocery/pantry/calendar)
- `PublishToUser(sub, ...)`/`BroadcastToUser()` broadcast only to that user's queues (used for settings + tracker)
- The SSE endpoint (`internal/app/stream.go`) subscribes with the session user's sub so queues are tagged

## Data-Carrying SSE Events
- SSE events carry mutation data so clients apply deltas directly without API refetches
- Event format: `{ type: "grocery.updated", payload: { action: "item-added", sectionId: "...", item: {...} }, source_id: "..." }`
- **Actions per entity**: grocery/pantry have `item-added`, `item-updated`, `item-deleted`, `item-moved`, `section-added`, `section-renamed`, `section-deleted`, `section-reordered`, `items-reordered`, `cleared-checked` (grocery only), `cleared-all`, `replaced`. Stores have `added`, `updated`, `deleted`, `reordered`. Meal-ideas have `added`, `updated`, `deleted`
- **Frontend hooks**: Each hook has an `applyRealtimeEvent(payload)` function that switches on `action` to apply deltas to React state directly
- **Fallback on missing action**: If `payload?.action` is undefined (legacy event), hooks fall back to full API refetch via `loadXxxRef.current()`
- **App.tsx cache warmer**: Applies ALL SSE actions to localStorage + IndexedDB for inactive tabs (grocery, pantry, stores, meal-ideas). Already-data-carrying events (notes, calendar, settings) unchanged
- **IndexedDB persistence**: State sync `useEffect` in each hook persists to IDB whenever state changes, keeping offline cache current after SSE deltas
- All entities referenced by server-assigned ID in SSE payloads — never match on mutable fields like names

## Item Defaults (Store + Section Auto-Populate)
- `item_defaults` table: `item_name` (PK, lowercase), `store_id` (FK → stores, nullable), `section_name` (Text, nullable — by NAME since section IDs are unstable across replace ops)
- `GET /api/grocery/item-defaults` returns defaults with non-null store_id OR section_name
- `DELETE /api/grocery/item-defaults/{item_name}` — idempotent (204), case-insensitive via `func.lower()`
- `PUT /api/grocery/item-defaults/{item_name}` — PARTIAL upsert via `model_fields_set` (`store_id` and/or `section_name`); used by undo restore
- `itemDefaultJSON` in `internal/app/serialize.go`: `item_name`, `store_id`, `section_name`
- **Server writes section defaults** on item add (POST /items), cross-section move (PATCH /items/{id}/move), and list replace (PUT /api/grocery — merge/paste path); store defaults written on PATCH store_id as before
- **Quick-add autofill**: exact item-name match fills store AND section (section combobox only overwritten when a remembered name exists). Per-section inline add fills store only — never moves the item
- `itemDefaultsMap` values are `{ storeId, sectionName }` (per-field merge: current-list values win; IDB fills gaps). `putLocalItemDefault(name, { storeId?, sectionName? })` is a partial read-modify-write
- Frontend caches in IDB `itemDefaults` store (version 8), synced on app load via `fetchAllData`
- `useGroceryList` owns `idbDefaults` state and `itemDefaultsMap` (useMemo merging IDB defaults + current list items)
- `ItemAutocomplete` component: filtered dropdown of previously-used items, title-cased display, X delete button for items not on current list. Used in both quick-add form and per-section inline add
- `removeItemDefault` in `useGroceryList`: deletes from IDB + server with full undo/redo + offline queue (`item-default-delete`, `item-default-put` change types)
- `useGroceryList` calls `putLocalItemDefault()` after add/edit API responses to keep IDB cache warm
- `StoreAutocomplete` always shows as editable input with pre-populated store name; X clears input only (no immediate update)

## Hidden Calendar Events (per-user)
- `hidden_calendar_events` has a `sub` column — hiding an event hides it only for the user who hid it, not other household members (deliberate departure from the shared-global model, like the tracker)
- All three endpoints scope to the session user: list filters by sub, hide dedups on (sub, event_uid, start_time, calendar_name), unhide requires `id AND sub` (returns not_found for someone else's row)
- `FetchICalEvents(..., hiddenForSub)` applies only that user's hide rows; `/api/days` and `/api/days/events` pass `user.Sub`
- `calendar.hidden`/`calendar.unhidden` SSE go via `BroadcastToUser` (only the hider's other sessions), so the frontend needed no changes — cache warmer/CalendarView/SettingsModal receive only their own events
- Migration (`db.RunMigrations`): legacy unscoped rows are cloned once per user in the `users` table, then removed — pre-existing hides stay hidden for everyone. `pruneHiddenEvents` (GC of hides whose events vanished) is unchanged and works across all users' rows

## Calendar Holidays
- US holidays fetched from Google's public iCal feed, cached in-memory (24h TTL) and in DB (`cached_calendar_events` with `calendar_name = "US Holidays"`)
- `include_holidays` query param on `/api/days/events` and `/api/days` (default `true`)
- `showHolidays` setting (default `true`) controls frontend visibility
- `holidayColor` / `calendarColor` settings allow per-user color customization for holiday vs regular events
- `EVENT_COLORS` map in `DayCard.tsx` maps color names to Tailwind class sets (text, bg, border, hover variants for light/dark)

## Store Chip Filtering
- **Synced per-user**: the filter lives in user settings (`grocerySelectedStoreIds`/`groceryExcludedStoreIds` arrays), not localStorage — survives iOS storage eviction and follows the user across devices. App owns the single `useSettings` instance; GroceryListView receives `selectedStores`/`excludedStores`/`onStoreFilterChange` props (defaults keep prop-less test renders working). A one-time mount effect migrates leftover `meal-planner-selected-stores`/`meal-planner-excluded-stores` localStorage values into settings, then deletes the keys
- **Multi-select**: `selectedStoreIds: Set<string>` (memo from props) in GroceryListView — tap multiple store chips to filter by several stores
- **Exclude**: `excludedStoreIds: Set<string>` — long-press chip (800ms auto-opens popover) to exclude a store. Excluded chips show dimmed with strikethrough. Tap excluded chip to un-exclude
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
- **Cross-section drag with store filter**: `handleItemDropOutside` must resolve filtered-view indices to unfiltered indices before calling `moveItem`. Look up the dragged item by filtered index in `visibleSections`, find its real index in the unfiltered section. Same for the target insertion index — find the anchor item's position in the unfiltered target section
- **Collapsed state with replace APIs**: When `replaceGroceryListAPI`/`replacePantryListAPI` recreates sections (new server IDs), local state keyed by ID resets. Fix: lift collapsed state to parent component, keyed by section **name** (stable across replace operations)

## Offline Patterns
- **Full documentation**: See `docs/offline-patterns.md` for all canonical patterns
- **No destructive replacements**: Never use `grocery-replace`/`pantry-replace` for CRUD ops — use targeted change types (`pantry-create-section`, `grocery-add`, etc.). Replacements overwrite other users' concurrent changes. Only use for `clearAll`/`clearChecked`/`mergeList`.
- **ID resolution**: Use `resolveId()` (sync, in-memory) in undo/redo handlers. Use `resolveIdAsync()` (async, IndexedDB fallback) in main mutation API calls — temp IDs may have been synced externally by `useSync`.
- **ID remap chain**: Use `remapId()` (not `idRemapRef.current.set()`) when recording new server IDs — it flattens the entire chain for multi-cycle undo/redo.
- **Undo/redo serialization**: `UndoContext` blocks concurrent undo/redo to prevent race conditions with ID remaps.
- **Per-tab undo stacks**: `UndoProvider` takes an `id` prop; stacks are stored in module-level `Map` so they survive unmount/remount across tab switches. 30-minute inactivity timer clears stale stacks.
- **Module-level setter refs**: All hooks with undo (`useGroceryList`, `usePantry`, `useStores`, `useMealIdeas`) and `CalendarView` use module-level variables for state dispatch (e.g., `_liveSectionsDispatch`). Updated on every render so undo closures from previous mounts call the current mount's setter directly — no cache reload needed.
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
- **Header layout**: right side is [bell, refresh, undo, redo, gear] at normal spacing; the account's FIRST NAME sits in tiny text under the gear. Logout lives in the Settings modal (account row above the footer: "Signed in as X" + red Log out button — `accountName`/`onLogout` props); PageHeader/pages no longer take `onLogout`
- **Fixed-bottom drift fix**: `useVisualViewportPin` glues fixed bottom elements (bottom nav, Today FAB) to the visual viewport — iOS can leave the layout viewport panned or `window.innerHeight` stale after keyboard close, floating fixed elements mid-screen. The hook counters the measured gap with an inline CSS `translate` (composes with Tailwind `transform` classes rather than overwriting them) on vv resize/scroll + focus events, plus a 1s poll since the broken states are exactly missed-event states. backdrop-filter stays on the inner non-fixed layer (separate older iOS drift bug)
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
- 401s no longer trigger auto-logout — they raise the re-auth modal instead (see PWA Re-Auth Flow); only user-initiated logout triggers authentik invalidation
- authentik's invalidation flow (`/if/flow/default-invalidation-flow/`) auto-logs out without a confirmation prompt (unlike the OIDC end_session_endpoint which shows an interstitial)

## Preview / Local Dev Auth
- Backend has a `/api/auth/dev-login` endpoint that's only available when `OIDC_ISSUER` env var is empty. It sets a fake session (`dev-user` / `dev@localhost`) and redirects to `/`
- **Docker in dev-login mode**: `.env` has real OIDC + `SECURE_COOKIES=true`, so dev-login is disabled by default. Shell env overrides `.env` in docker-compose: `OIDC_ISSUER= OIDC_CLIENT_ID= OIDC_CLIENT_SECRET= SECURE_COOKIES=false FRONTEND_URL=http://localhost:8000 docker-compose up -d`. All five are required — `ValidateSecurity()` in `internal/config/config.go` rejects `SECURE_COOKIES=false` unless `FRONTEND_URL` is localhost and OIDC is unset. Restore by re-running `docker-compose up -d` with a clean shell env
- In dev mode `/api/auth/login` returns 500 ("OIDC not configured") — sign in via `/api/auth/dev-login` directly
- The `.env` file is in the project root — run the server from the project root (`go run ./backend/cmd/server`) so `config.Load(".env")` finds it; running from inside `backend/` misses the root `.env`. `backend/cmd/devpg` runs a throwaway embedded Postgres for machines without Docker (`cd backend && go run ./cmd/devpg -port 5433`)
- Launch config overrides for local dev: `OIDC_ISSUER=` (empty), `SECURE_COOKIES=false`, `FRONTEND_URL=http://localhost:5173`, `POSTGRES_HOST=localhost`
- To authenticate in preview: navigate to `/api/auth/dev-login` (e.g. `window.location.href = '/api/auth/dev-login'`)
- Docker postgres (`meal-planner-db-1` from docker-compose) uses password from `.env`. The standalone `mealplanner-pg` container uses `changeme`. They use different volumes

## Multi-Day Calendar Events
- `GetEventsForDate()` in `internal/ical/event.go` checks if `target_date` falls between `start_time.date()` and `end_time.date()` (all-day end dates are exclusive per iCal spec)
- DB query in `_get_events_from_db` uses `or_()` to also fetch events whose `end_time` extends into the requested range
- Frontend `getEventDates()` in CalendarView computes all dates an event spans for restore/hide operations
- `compareEvents()` sorts holidays first, then by `start_time`

## Data Fetching Architecture
- **Singleton online status**: `useOnlineStatus` uses `useSyncExternalStore` with module-level state — single `/api/health` check shared across all consumers, no redundant checks on tab switch
- **Upfront data fetch**: App.tsx `fetchAllData()` fetches grocery, pantry, stores, meal-ideas, item-defaults, calendar days, calendar events, and hidden events in parallel on app load. Marks `sessionLoaded` flags after each entity fetch succeeds
- **Session-loaded guard**: Each hook (`useGroceryList`, `usePantry`, `useMealIdeas`, `useStores`) has a module-level `sessionLoaded` flag. On mount, hooks pass `sessionLoaded` as `skipApi` — first mount fetches from API, subsequent mounts (tab switches) load from cache only. `broadcastFullRefresh` resets all flags so tab-focus/reconnect triggers fresh fetches. Export `reset*SessionLoaded()` and `mark*SessionLoaded()` for App.tsx and tests
- **Calendar prefetch in fetchAllData**: Calendar days, events, and hidden events are prefetched on app load with the same range as CalendarView (-14 to +56 days). `markCalendarSessionLoaded(startStr, endStr)` sets both `sessionLoaded` and `prefetchedStart`/`prefetchedEnd` so CalendarView skips its own API fetch and `loadNextWeek` knows the range is cached
- **Pre-cache double-run prevention**: `preCacheDoneRef` in App.tsx prevents the effect from running twice when auth calls `setUser` twice (cached + API)
- **Focus/reconnect refresh**: `broadcastFullRefresh()` in App.tsx calls `fetchAllData()` (resets flags + re-fetches all data) and dispatches a synthetic `calendar.refreshed` event. Called on `visibilitychange` (hidden→visible), online reconnect, AND SSE reconnect (`meal-planner-realtime-connected`, throttled 10s against flapping) — useRealtime's onopen fires that window event on RE-connections only (module-level `hadConnection` flag; the initial connect coincides with the initial fetch), since events emitted while disconnected are lost with no replay and the focus/online triggers don't fire if the app stayed visible through a server restart
- **Background cache warmer**: App.tsx SSE handler applies data-carrying deltas to localStorage + IndexedDB for inactive tabs (grocery, pantry, stores, meal-ideas). Already-data-carrying events (notes, item, calendar events, hidden events) save directly to IDB. Active tab's hooks handle their own SSE events. No API refetches — all data comes from the SSE payload
- **Calendar single-fetch**: CalendarView init fetches one `getDays` call for the full range (past 2 weeks through future 8 weeks) and one `getEvents` call, instead of separate calls per range
- **Calendar prefetch range**: Module-level `prefetchedStart`/`prefetchedEnd` strings track the pre-fetched date range. `loadNextWeek`/`loadPreviousWeek` skip API calls when the requested range falls within these boundaries — only hit API when scrolling past the prefetched window
- **Calendar remount guard**: `showAllEvents`/`showHolidays` effect uses prev-value refs to only fire on actual changes, not on component remount (prevents redundant API calls on tab switch)
- **Calendar scroll-to-today**: `scrollToElementWithOffset` accounts for nav bar height (`--header-h` CSS var), sticky panels (`.sticky.z-\[9\]`), and a 48px extra offset so "Load previous" button is also visible
- **Calendar load-previous scroll preservation**: `loadPreviousWeek` uses `flushSync` + scroll anchor pattern — captures first visible day card's position, flushes the state update synchronously, then adjusts `window.scrollBy` so the view stays in place while new days appear above

## Testing Patterns
- Mock fetch responses need `headers: { get: () => 'application/json' }` since `fetchAPI` checks content-type for auth-required detection
- `useSync`/`useRealtime` have module-level `_authRequired` flags that leak across tests — call `__resetAuthRequiredForTests()` in `beforeEach`
- `useSync.test.ts` uses `importOriginal` for `api/client` mock to preserve `AuthError` class for `instanceof` checks
- `useSettings.test.ts` mocks `useOnlineStatus` to return `false` (offline) to isolate localStorage behavior from server sync. Also mocks `api/client` with `getSettings`/`putSettings` rejecting to simulate offline
- Backend settings tests use `authenticated_client` fixture (not bare `client`) and mock `broadcast_to_user` with `AsyncMock`
- Hooks with module-level `sessionLoaded` flags need `reset*SessionLoaded()` in `beforeEach` to prevent cross-test pollution. Set `navigator.onLine` before `resetOnlineStatus()` when testing offline scenarios
