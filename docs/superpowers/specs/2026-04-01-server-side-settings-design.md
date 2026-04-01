# Server-Side User Settings — Design Spec

## Goal

Persist user settings (compact view, calendar colors, etc.) on the server so they sync across devices for the same user. Different users on the same deployment get independent settings.

## Architecture

Settings move from browser-only (localStorage) to server-backed with localStorage as a cache. The frontend remains offline-first: localStorage loads immediately, server state merges in the background. Conflicts resolve via last-write-wins using `updated_at` timestamps.

SSE broadcasts are upgraded to support per-user targeting so settings changes push to the same user's other sessions without leaking to other users.

## Data Model

New `user_settings` table:

| Column | Type | Notes |
|--------|------|-------|
| `sub` | Text, PK | OIDC subject identifier (stable user ID) |
| `settings` | JSON | Full settings object |
| `updated_at` | DateTime (UTC) | Last modification timestamp |

No foreign keys — the `sub` comes from the OIDC session, not a `users` table. The JSON column stores the complete `Settings` object so adding new settings requires no migrations.

Auto-created on first write (upsert pattern). `GET` on a user with no row returns defaults.

## API Endpoints

### `GET /api/settings`

- Auth: `get_current_user` (existing dependency)
- Returns: `{ settings: {...}, updated_at: "ISO8601" }`
- If no row exists for user's `sub`: return `{ settings: {}, updated_at: null }`
- Frontend merges returned settings with its defaults (same `{ ...DEFAULTS, ...server }` pattern already used for localStorage)

### `PUT /api/settings`

- Auth: `get_current_user`
- Body: `{ settings: {...}, updated_at: "ISO8601" }`
- Upserts the row for the user's `sub`
- Sets `updated_at` to the value from the request body (preserving the client's timestamp so offline edits retain their original time)
- After DB write: broadcasts `settings.updated` to the user's other sessions (excluding the source via `source_id`)
- Returns: `{ settings: {...}, updated_at: "ISO8601" }`

## SSE Per-User Targeting

### EventBroadcaster Changes

Currently `EventBroadcaster` maintains a flat set of queues and publishes to all of them. Changes:

- `subscribe(sub: str | None)` — associates the queue with a user `sub`. Passing `None` means the queue receives all broadcasts (backward compatible for non-user events).
- New method: `publish_to_user(sub: str, payload, exclude_queue=None)` — publishes only to queues registered under that `sub`. The `exclude_queue` param lets us skip the source session.
- Existing `publish()` method unchanged — continues to broadcast to ALL queues (used for `grocery.updated`, `pantry.updated`, `calendar.refreshed`, etc. which are shared data).

### SSE Endpoint Changes

The `/ws` (SSE) endpoint already has access to the authenticated user. Pass `user["sub"]` to `broadcaster.subscribe(sub)` so the queue is tagged.

### broadcast_to_user helper

New function alongside `broadcast_event`:

```python
async def broadcast_to_user(
    sub: str,
    event_type: str,
    payload: dict,
    source_id: str | None = None,
) -> None:
```

Constructs the message (same format as `broadcast_event`) and calls `broadcaster.publish_to_user(sub, msg, ...)`. Events where `source_id` matches are skipped by the source client (existing frontend pattern).

## Frontend Changes

### useSettings Hook

**On mount (offline-first):**
1. Load from localStorage immediately (existing behavior — zero delay)
2. If online, fetch `GET /api/settings` in background
3. Compare timestamps:
   - Server `updated_at` > local `updated_at` → apply server settings to state and localStorage
   - Local `updated_at` > server `updated_at` (or server returns null) → push local settings to server via `PUT`
   - Equal → no action

**On setting change:**
1. Update React state immediately
2. Save to localStorage with `updated_at = new Date().toISOString()`
3. If online, `PUT /api/settings` with the new settings and `updated_at`
4. If offline, the settings persist in localStorage; they'll sync on next online mount

**SSE listener:**
- Listen for `settings.updated` events
- Compare incoming `updated_at` with local `updated_at`
- If incoming is newer, apply to state and localStorage
- If local is newer, ignore (user made a more recent change on this device)

### localStorage Schema Change

Currently stores: `meal-planner-settings` → `JSON.stringify(settings)`

New format: `meal-planner-settings` → `JSON.stringify({ settings: {...}, updated_at: "ISO8601" })`

The hook handles migration: if the stored value doesn't have `updated_at`, treat it as the old format, wrap it, and assign `updated_at = null` (so the server version wins on first sync).

## Migration

The `user_settings` table is created via the existing inline migration pattern in `main.py` (check if table exists, create if not). No Alembic needed.

## Testing

- Backend: test `GET/PUT /api/settings` endpoints, upsert behavior, timestamp handling
- Backend: test `publish_to_user` only targets correct queues
- Frontend: test localStorage migration from old format to new `{ settings, updated_at }` format
- Frontend: test timestamp comparison logic (server newer wins, local newer wins, equal no-op)
