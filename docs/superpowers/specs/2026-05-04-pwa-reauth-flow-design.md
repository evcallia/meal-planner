# PWA Re-Auth Flow Design

**Date:** 2026-05-04
**Status:** Approved, pending implementation plan

## Problem

When the meal planner PWA on mobile loses its auth credentials mid-session — either Cloudflare Access requires email re-verification, or the authentik session expires — the PWA is already loaded and cannot be hard-refreshed. API requests start failing silently. Mutations queue up but never sync because the user has no way to re-authenticate.

The current 401 handler makes this worse: it dispatches an `auth-unauthorized` event that calls `handleLogout(false)`, which calls `clearAllLocalData()` and **wipes the offline queue.** Any work done since the session expired is destroyed.

## Goals

1. **Detect** auth-required state for both authentik session expiration and Cloudflare challenges, without false-positives on routine offline conditions.
2. **Block** the user from making further changes once auth-required is detected (per user direction — multi-user safety preference: get back online ASAP rather than queue more potentially-conflicting offline edits).
3. **Preserve** the existing offline queue across the re-auth flow. No silent data loss.
4. **Auto-resume** sync after the user signs back in, with no manual action required beyond the actual sign-in.

## Non-Goals

- Persisting in-memory UI state (current page, scroll position, in-progress text inputs) across re-auth. The user navigates back to where they were manually.
- Replacing the 1-hour stale-discard rule in `useSync` with a retry-count-based approach. This is a known weakness deferred to a future session — see the project memory `project_sync_retry_count_followup.md`. We apply a band-aid here.
- Adding a popup-style re-auth flow for desktop. The mobile PWA reality (separate cookie jars on iOS) makes full-window navigation the only universally-reliable path. We design for that path on all platforms.

## High-Level Approach

**Detection → state machine → modal → sign-in navigation → fresh app boot → queue drains.**

1. `fetchAPI` and `healthFetch` detect auth-required responses defensively (HTML content-type, 401 from protected endpoints, 403 with HTML body).
2. A new `auth-required` window event flips a sticky state in `App.tsx`. `ConnectionStatus` gains a fourth state, `'auth-required'`.
3. `useSync` and `useRealtime` pause when in this state. **No changes are removed from the queue. No stale-discard timer fires.**
4. A blocking `ReAuthModal` appears with a single "Sign in" button that performs `window.location.href = '/api/auth/login'`.
5. After CF + authentik flows complete, the user lands at `/` and the PWA boots fresh. IndexedDB queue is intact. `useSync`'s normal interval drains it.

## Detection

A response triggers auth-required when **any** of the following hold:

| Condition | Notes |
|---|---|
| Status 401, path is **not** `GET /api/auth/me` | `/auth/me` legitimately 401s for the "not logged in yet" boot case |
| Status 403 + `Content-Type` starts with `text/html` | CF challenge denial |
| Status 2xx + `Content-Type` not starting with `application/json` (excluding 204) | CF interstitial that proxies through with success status but HTML body |

These checks live in `fetchAPI` (in `api/client.ts`). On match:
- Throw a new `AuthError` (exported class) instead of generic `Error`.
- Dispatch a `window` event `'auth-required'`.

The same content-type heuristic is added to `healthFetch` in `useOnlineStatus.ts`. Today it only checks `response.ok`; a CF HTML page returns 200, so the app currently thinks it's "online" while every other call fails. With the fix, an HTML body on `/api/health` dispatches `auth-required` and returns `false` (does not transition to "offline" — auth-required is a separate state).

## State Machine

`ConnectionStatus` adds a fourth state: `'auth-required'`.

**Entry transitions** (any of `online`, `offline`, `syncing` → `auth-required`):
- An `auth-required` event arrives.

**Exit transitions:** `auth-required` is terminal within the current app instance. The only escape is a full-window navigation to `/api/auth/login`, after which the app reloads from scratch and starts in `'online'` (or whatever the fresh boot determines). There is no in-process exit transition in this design — the modal cannot be dismissed without navigation.

**Stickiness:** Once `auth-required` is set, no other state-change event clears it. Health checks during this period do not transition to `online`. This prevents modal flicker.

**Cross-reload signal:** Entering `auth-required` writes a flag to `localStorage` (`'auth-required-pending'`). On the next app boot, `useSync` reads this flag to decide whether to refresh queued changes' `createdAt` (see Sync Hook Changes below). The flag is then cleared.

## Re-Auth Modal

A new component, `frontend/src/components/ReAuthModal.tsx`. Rendered by `App.tsx` when `status === 'auth-required'`.

- Full-screen overlay using existing `glass` styling for visual consistency.
- Non-dismissable: no backdrop click, no escape key, no close button.
- Copy:
  > **Sign in to keep using Meal Planner**
  >
  > Your session has expired. Sign in again to continue.
  >
  > _Your unsaved changes are saved on this device and will sync after sign-in._
- Conditional pending-count line, when `pendingCount > 0`: "N changes waiting to sync."
- Single primary button: **Sign in** → `window.location.href = getLoginUrl()`.
- No Logout / Cancel options. Logout would lose the queue; the only path forward is re-auth.

## Sync Hook Changes (`useSync.ts`)

**Module-level flag.** A new `_authRequired: boolean` is set to `true` by a window listener for the `auth-required` event. It is never cleared in-process — full-window navigation rebuilds the module fresh, with `_authRequired` defaulting to `false`.

**Pause both sync drivers.** Both `useEffect`s that drive sync (the `isOnline`-change effect and the 5-second polling effect) gain `if (_authRequired) return;` guards. No sync attempts run while the modal is up.

**AuthError handling inside the per-change try/catch.** If `instanceof AuthError`:
- Dispatch `auth-required` (idempotent).
- Break out of the change-processing loop.
- Do **not** call `removePendingChange` for the failing change — it stays at the head of the queue.
- Do **not** apply the 1-hour stale-discard rule for this failure.

**Band-aid: refresh `createdAt` on boot when the cross-reload flag is set.** On `useSync` initialization, check `localStorage.getItem('auth-required-pending')`. If set, iterate all queued changes in IndexedDB and update `createdAt = Date.now()`, then clear the flag. This protects the queue from the 1-hour stale-discard rule on the first retry after the post-sign-in reload. The deeper fix (replacing the age rule with a retry-count rule) is deferred — see the followup memory.

## Realtime Hook Changes (`useRealtime.ts`)

When `_authRequired` is true (set by a window listener for the `auth-required` event), pause EventSource reconnect attempts and close any open connection. The current behavior would cause a tight retry loop against a CF-challenged endpoint, burning battery on mobile. After the post-sign-in reload, the module re-initializes fresh and the EventSource opens normally.

## App-Level Changes (`App.tsx`)

**Remove the destructive listener.** The current `auth-unauthorized` listener (lines 1015-1019) calls `handleLogout(false)` which wipes local data. This listener and the `auth-unauthorized` event itself are removed entirely. Hard logout now happens only via the user explicitly tapping Logout in settings.

**Add the auth-required listener.** Sets `status = 'auth-required'` and writes the cross-reload flag (`localStorage.setItem('auth-required-pending', '1')`). Idempotent.

**Render the modal.** When `status === 'auth-required'`, render `<ReAuthModal />` in the App root, above all other UI.

**Post-sign-in boot is automatic.** After the user completes the auth flow, the auth provider redirects them back to `/`. The App mounts fresh; `getCurrentUser()` resolves to a real user; status starts as `'online'`; `useSync` reads the cross-reload flag, refreshes queued changes' `createdAt`, clears the flag, and the normal sync interval drains the queue. No App-level "auth-resumed" handler is needed.

## Service Worker

The existing `cacheWillUpdate` plugin already rejects HTML responses for API routes — it prevents CF challenge pages from polluting the runtime cache. This design relies on that behavior; no changes needed.

## File-Level Change Summary

| File | Change |
|---|---|
| `frontend/src/api/client.ts` | Add `AuthError` class. Update `fetchAPI` detection logic. Remove `auth-unauthorized` dispatch. |
| `frontend/src/hooks/useOnlineStatus.ts` | Add JSON content-type check to `healthFetch`. Dispatch `auth-required` on HTML. |
| `frontend/src/types.ts` | `ConnectionStatus` adds `'auth-required'`. |
| `frontend/src/hooks/useSync.ts` | `_authRequired` module flag, guarded `useEffect`s, `AuthError` catch, `createdAt` refresh on init when cross-reload flag is set. |
| `frontend/src/hooks/useRealtime.ts` | Pause EventSource reconnect and close connection when `_authRequired`. |
| `frontend/src/App.tsx` | Remove `auth-unauthorized` listener, add `auth-required` listener (sets status + writes cross-reload flag), render modal. |
| `frontend/src/components/ReAuthModal.tsx` | New file. |

## Test Plan

| File | Cases |
|---|---|
| `api/__tests__/client.test.ts` | `AuthError` thrown on HTML 200 response, 401 (non-`/auth/me`), 403 + HTML; not thrown on `/auth/me` 401, JSON error responses. |
| `hooks/__tests__/useSync.test.ts` | Sync paused while `_authRequired` is true; pending changes remain in queue when `AuthError` thrown; `createdAt` refreshed on init when cross-reload flag set; `AuthError` does not increment stale-discard. |
| `hooks/__tests__/useOnlineStatus.test.ts` | HTML response from `/api/health` does not transition to `online`; dispatches `auth-required`. |
| `App.test.tsx` (or new integration test) | `ReAuthModal` renders when status is `auth-required`; `clearAllLocalData` is not called on auth-required event; cross-reload flag is set in localStorage. |
| `components/__tests__/ReAuthModal.test.tsx` | New file. Renders title/body/button; pending-count line shown when count > 0; sign-in button navigates to login URL. |

## Open Risks

- **Detection false positives.** A user behind a misbehaving proxy might receive HTML responses that aren't CF challenges. The defensive detection would put them into auth-required state. Mitigation: low likelihood, and the failure mode (modal asking them to sign in) is recoverable.
- **CF challenge during the sign-in flow itself.** If the user taps "Sign in" but CF challenges them again before authentik completes, they're already mid-navigation and the flow handles it natively — the modal isn't visible during navigation.
- **Slow CF email delivery.** The user may stare at a CF email-verification page for several minutes before clicking the link. The PWA is at the auth URL during this time, not in the modal. No issue.

## Future Work (Out of Scope)

- Replace `useSync`'s 1-hour absolute-age stale-discard rule with a per-change retry-count rule. Tracked in the project memory `project_sync_retry_count_followup.md`.
- Persist `currentPage` (and possibly scroll position) across re-auth navigation, so the user lands back where they were.
- Optional desktop-only popup-style re-auth flow that preserves UI state, gated on platform detection.
