# PWA Re-Auth Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Cloudflare-challenge / authentik-session-expiration responses in the PWA, show a blocking re-auth modal that preserves the offline queue, and auto-resume sync after the user signs back in.

**Architecture:** A new `'auth-required'` `ConnectionStatus` state. Defensive detection in `fetchAPI` and `healthFetch` (HTML content-type, 401 from protected endpoints, 403 + HTML). A new `AuthError` class. Window event `auth-required` flips state in `App.tsx`. `useSync` and `useRealtime` pause on the flag. A non-dismissable `ReAuthModal` triggers full-window navigation to `/api/auth/login`. A localStorage flag (`auth-required-pending`) survives the reload and tells `useSync` to refresh queued changes' `createdAt` on first init.

**Tech Stack:** TypeScript, React, Vite, Vitest, Dexie/IndexedDB.

**Spec reference:** `docs/superpowers/specs/2026-05-04-pwa-reauth-flow-design.md`

**Working branch:** `pwa-reauth-flow` (already created)

**Test command (frontend, from project root):** `npm run test:run --prefix frontend 2>&1`

---

## Task 1: Add `'auth-required'` to ConnectionStatus type

**Files:**
- Modify: `frontend/src/types.ts:36`

- [ ] **Step 1: Update the type union**

In `frontend/src/types.ts`, change line 36 from:

```ts
export type ConnectionStatus = 'online' | 'offline' | 'syncing';
```

to:

```ts
export type ConnectionStatus = 'online' | 'offline' | 'syncing' | 'auth-required';
```

- [ ] **Step 2: Verify the codebase still type-checks**

Run: `npm run build --prefix frontend 2>&1 | tail -30`

Expected: build succeeds OR TypeScript reports new errors only in switch statements / conditional logic that need to handle the new state. No errors are okay at this step — Tasks 2-8 will adjust callers. If the build fails for unrelated reasons, stop and investigate.

- [ ] **Step 3: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/types.ts
git -C /Users/evan.callia/Desktop/meal-planner commit -m "feat: add 'auth-required' to ConnectionStatus"
```

---

## Task 2: Add `AuthError` class to api/client.ts

**Files:**
- Modify: `frontend/src/api/client.ts`
- Test: `frontend/src/api/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/api/__tests__/client.test.ts`, inside the existing top-level `describe('API client', ...)` block (after the existing `describe('fetchAPI error handling', ...)` block — same indentation level). At the top of the file, add `AuthError` to the existing import from `'../client'`. Then add this block:

```ts
  describe('AuthError class', () => {
    it('is exported from client and is an Error subclass', async () => {
      const { AuthError } = await import('../client');
      const err = new AuthError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AuthError);
      expect(err.name).toBe('AuthError');
      expect(err.message).toBe('test');
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:run --prefix frontend -- src/api/__tests__/client.test.ts 2>&1 | tail -30`

Expected: FAIL — `AuthError` is not defined / not exported.

- [ ] **Step 3: Implement AuthError**

In `frontend/src/api/client.ts`, just below the `SOURCE_ID` line (after line 6) and above `async function fetchAPI`, add:

```ts
export class AuthError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthError';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:run --prefix frontend -- src/api/__tests__/client.test.ts 2>&1 | tail -30`

Expected: PASS for the new `AuthError class` block. Other existing tests should still pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/api/client.ts frontend/src/api/__tests__/client.test.ts
git -C /Users/evan.callia/Desktop/meal-planner commit -m "feat: add AuthError class to api/client"
```

---

## Task 3: Detect auth-required responses in fetchAPI

**Files:**
- Modify: `frontend/src/api/client.ts:8-60` (the `fetchAPI` function)
- Test: `frontend/src/api/__tests__/client.test.ts`

The detection rules from the spec, restated:
- Status 401, path is **not** `GET /api/auth/me` → AuthError
- Status 403 + `Content-Type` starts with `text/html` → AuthError
- Status 2xx (excluding 204) + `Content-Type` not starting with `application/json` → AuthError

When an AuthError condition is detected, dispatch a `window` event named `'auth-required'`. The existing 401 path that dispatches `'auth-unauthorized'` is replaced.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `frontend/src/api/__tests__/client.test.ts` at the same level as `describe('fetchAPI error handling', ...)`. Note: import `AuthError` at the top of the file (alongside the other imports from `'../client'`).

```ts
  describe('AuthError detection', () => {
    let dispatchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    });

    afterEach(() => {
      dispatchSpy.mockRestore();
    });

    it('throws AuthError on 401 from protected endpoints and dispatches auth-required', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
      });

      await expect(getDays('2024-01-01', '2024-01-07')).rejects.toBeInstanceOf(AuthError);
      const calls = dispatchSpy.mock.calls.map(c => (c[0] as Event).type);
      expect(calls).toContain('auth-required');
    });

    it('throws AuthError on 403 with HTML body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
      });

      await expect(getDays('2024-01-01', '2024-01-07')).rejects.toBeInstanceOf(AuthError);
      const calls = dispatchSpy.mock.calls.map(c => (c[0] as Event).type);
      expect(calls).toContain('auth-required');
    });

    it('throws AuthError on 200 with HTML body (CF interstitial)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null },
        json: () => Promise.reject(new Error('should not parse')),
      });

      await expect(getDays('2024-01-01', '2024-01-07')).rejects.toBeInstanceOf(AuthError);
      const calls = dispatchSpy.mock.calls.map(c => (c[0] as Event).type);
      expect(calls).toContain('auth-required');
    });

    it('does NOT throw AuthError on 401 from /api/auth/me (legitimate logged-out case)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
      });

      const result = await getCurrentUser();
      expect(result).toBeNull();
      const calls = dispatchSpy.mock.calls.map(c => (c[0] as Event).type);
      expect(calls).not.toContain('auth-required');
    });

    it('does NOT throw AuthError on 500 with JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => 'application/json' },
      });

      await expect(getDays('2024-01-01', '2024-01-07')).rejects.toThrow('API error: 500');
      const calls = dispatchSpy.mock.calls.map(c => (c[0] as Event).type);
      expect(calls).not.toContain('auth-required');
    });

    it('does NOT throw AuthError on 204 (no content) with no content-type', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 204,
        headers: { get: () => null },
      });

      // Use deletePantryItem which expects 204 No Content
      const { deletePantryItem } = await import('../client');
      await expect(deletePantryItem('item-123')).resolves.toBeUndefined();
      const calls = dispatchSpy.mock.calls.map(c => (c[0] as Event).type);
      expect(calls).not.toContain('auth-required');
    });
  });
```

The existing test on lines 33-40 of `client.test.ts` (`'should handle 401 unauthorized errors'`) needs updating because the error type changes from `Error('Unauthorized')` to `AuthError`. Update it to:

```ts
    it('should throw AuthError on 401 unauthorized', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
      });

      const { AuthError } = await import('../client');
      await expect(getDays('2024-01-01', '2024-01-07')).rejects.toBeInstanceOf(AuthError);
    });
```

Also update the test on lines 42-49 ('should handle other API errors') to include the headers stub:

```ts
    it('should handle other API errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => 'application/json' },
      });

      await expect(getDays('2024-01-01', '2024-01-07')).rejects.toThrow('API error: 500');
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:run --prefix frontend -- src/api/__tests__/client.test.ts 2>&1 | tail -50`

Expected: FAIL on the new `AuthError detection` tests (auth-required event not dispatched, AuthError not thrown for HTML responses). The two updated tests (`should throw AuthError on 401` and `should handle other API errors`) will fail until the implementation lands.

- [ ] **Step 3: Update fetchAPI to detect auth-required responses**

Replace the entire body of `fetchAPI` (lines 8-60) in `frontend/src/api/client.ts` with:

```ts
async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method ?? 'GET';
  const requestStart = perfNow();
  let response: Response;

  // Create an AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Source-Id': SOURCE_ID,
        ...options?.headers,
      },
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    logDuration('api.request_error', requestStart, { path, method });
    throw error;
  }

  clearTimeout(timeoutId);

  logDuration('api.request', requestStart, { path, method, status: response.status });

  const contentType = response.headers.get('content-type') ?? '';
  const isHtml = contentType.toLowerCase().startsWith('text/html');

  // Detect auth-required conditions:
  //   - 401 from any path except GET /api/auth/me
  //   - 403 + HTML body (CF challenge denial)
  //   - 2xx + HTML body, excluding 204 (CF interstitial proxied as success)
  const is401Protected = response.status === 401 && path !== '/auth/me';
  const is403Html = response.status === 403 && isHtml;
  const is2xxHtml = response.ok && response.status !== 204 && isHtml;

  if (is401Protected || is403Html || is2xxHtml) {
    window.dispatchEvent(new CustomEvent('auth-required'));
    throw new AuthError();
  }

  // Any successful response proves we're online — notify the status hook
  if (response.ok) {
    window.dispatchEvent(new Event('api-request-succeeded'));
  }

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  if (response.status === 204) {
    logPerf('api.response', { path, method, status: 204 });
    return undefined as T;
  }
  const parseStart = perfNow();
  const data = await response.json();
  logPerf('api.response', { path, method, status: response.status });
  logDuration('api.parse', parseStart, { path, method });
  return data;
}
```

Note: The `'auth-unauthorized'` event dispatch is gone. The `'auth-required'` event replaces it. Other listeners (anything still expecting `'auth-unauthorized'`) are addressed in Task 7.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:run --prefix frontend -- src/api/__tests__/client.test.ts 2>&1 | tail -50`

Expected: PASS for all tests in `client.test.ts`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/api/client.ts frontend/src/api/__tests__/client.test.ts
git -C /Users/evan.callia/Desktop/meal-planner commit -m "feat: detect auth-required responses in fetchAPI"
```

---

## Task 4: Detect HTML responses in healthFetch (useOnlineStatus)

**Files:**
- Modify: `frontend/src/hooks/useOnlineStatus.ts`
- Test: `frontend/src/hooks/__tests__/useOnlineStatus.test.ts`

The current `healthFetch` (`useOnlineStatus.ts:42-58`) only checks `response.ok`. A CF challenge page returns 200 with HTML, so the current code thinks the app is online. We add a JSON content-type check; on HTML, we dispatch `'auth-required'` and treat the request as failed.

- [ ] **Step 1: Write the failing test**

Append the following test to `frontend/src/hooks/__tests__/useOnlineStatus.test.ts` at the bottom of the existing `describe('useOnlineStatus', ...)` block (before the closing `})`):

```ts
  it('dispatches auth-required and stays not-online when /api/health returns HTML', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
    });

    const { result } = renderHook(() => useOnlineStatus());

    // The first health check dispatches auth-required; isOnline should not flip to true via this response
    await waitFor(() => {
      const types = dispatchSpy.mock.calls.map(c => (c[0] as Event).type);
      expect(types).toContain('auth-required');
    });

    // navigator.onLine starts true so result.current is true initially; we don't assert on it here
    // (the goal of this test is to ensure HTML response is not treated as a successful health check
    // and that auth-required fires).
    dispatchSpy.mockRestore();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:run --prefix frontend -- src/hooks/__tests__/useOnlineStatus.test.ts 2>&1 | tail -30`

Expected: FAIL — `auth-required` event is never dispatched.

- [ ] **Step 3: Update healthFetch**

Replace the `healthFetch` function in `frontend/src/hooks/useOnlineStatus.ts` (lines 42-58) with:

```ts
async function healthFetch(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = _isOnline ? 2000 : TIMEOUT_OFFLINE;
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch('/api/health', {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeoutId);
    if (!response.ok) return false;
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.startsWith('text/html')) {
      // Cloudflare challenge or similar — health endpoint is being intercepted
      window.dispatchEvent(new CustomEvent('auth-required'));
      return false;
    }
    return true;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:run --prefix frontend -- src/hooks/__tests__/useOnlineStatus.test.ts 2>&1 | tail -30`

Expected: PASS for the new test. The pre-existing tests should still pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/hooks/useOnlineStatus.ts frontend/src/hooks/__tests__/useOnlineStatus.test.ts
git -C /Users/evan.callia/Desktop/meal-planner commit -m "feat: detect HTML responses in healthFetch"
```

---

## Task 5: Pause sync and refresh `createdAt` on auth-required (useSync)

**Files:**
- Modify: `frontend/src/hooks/useSync.ts`
- Test: `frontend/src/hooks/__tests__/useSync.test.ts`

Three behaviors:
1. A module-level `_authRequired` flag listens for the `'auth-required'` window event and goes true. It is never cleared in-process — full-window navigation rebuilds the module fresh.
2. Both sync-driving `useEffect`s skip when `_authRequired` is true.
3. On `useSync` first init: if `localStorage.getItem('auth-required-pending')` is set, iterate IndexedDB queued changes and update `createdAt = Date.now()`, then `localStorage.removeItem('auth-required-pending')`.

`AuthError` handling inside the per-change try/catch is added in this same task: catch it specifically, dispatch `'auth-required'`, break the loop, do not remove the change, do not apply the stale-discard rule for this failure.

- [ ] **Step 1: Write failing tests**

Append a new `describe('auth-required handling', ...)` block at the end of the top-level `describe('useSync', ...)` in `frontend/src/hooks/__tests__/useSync.test.ts` (just before its closing `})`).

The existing mock for `'../../db'` does **not** include `db` (the Dexie instance) or `pendingChanges` table. We need to add a mock for the pending-changes update path. Update the existing `vi.mock('../../db', ...)` block at the top of the file to include `pendingChanges` write surface. Find the existing mock (currently:

```ts
vi.mock('../../db', () => ({
  getPendingChanges: vi.fn(),
  removePendingChange: vi.fn(),
  isTempId: vi.fn(),
  ...
}));
```

) and add `db: { pendingChanges: { toArray: vi.fn(), update: vi.fn() } }` to that mock-object.

Also update the existing import statement near the top of the file — find:

```ts
import {
  getPendingChanges,
  ...
} from '../../db';
```

and add `db` to that import list.

Then add the new tests:

```ts
  describe('auth-required handling', () => {
    beforeEach(() => {
      // Clean up the localStorage flag and the module's _authRequired between tests.
      // The module is loaded once; we reset its state via the public events.
      window.localStorage.removeItem('auth-required-pending');
    });

    afterEach(() => {
      window.localStorage.removeItem('auth-required-pending');
    });

    it('does not sync when auth-required event has fired', async () => {
      mockUseOnlineStatus.mockReturnValue(true);
      mockGetPendingChanges.mockResolvedValue([
        { id: 1, type: 'notes', date: '2024-01-01', payload: { notes: 'x' }, createdAt: Date.now() } as any,
      ]);

      // Fire auth-required BEFORE rendering the hook
      act(() => { window.dispatchEvent(new CustomEvent('auth-required')); });

      renderHook(() => useSync());

      // Give it a moment — sync should not run
      await new Promise(r => setTimeout(r, 50));

      expect(mockUpdateNotes).not.toHaveBeenCalled();
      expect(mockRemovePendingChange).not.toHaveBeenCalled();
    });

    it('refreshes createdAt for pending changes on init when auth-required-pending flag is set', async () => {
      const { db } = await import('../../db');
      const mockToArray = vi.mocked(db.pendingChanges.toArray);
      const mockUpdate = vi.mocked(db.pendingChanges.update);
      const oldTime = Date.now() - 60 * 60 * 1000 * 2; // 2h ago
      mockToArray.mockResolvedValue([
        { id: 10, type: 'notes', date: '2024-01-01', payload: {}, createdAt: oldTime },
        { id: 11, type: 'pantry-add', date: '2024-01-01', payload: {}, createdAt: oldTime },
      ] as any);
      mockUpdate.mockResolvedValue(1);

      window.localStorage.setItem('auth-required-pending', '1');
      mockUseOnlineStatus.mockReturnValue(false); // skip the actual sync drain
      mockGetPendingChanges.mockResolvedValue([]);

      renderHook(() => useSync());

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledTimes(2);
      });
      expect(window.localStorage.getItem('auth-required-pending')).toBeNull();
    });

    it('does NOT refresh createdAt on init when flag is absent', async () => {
      const { db } = await import('../../db');
      const mockToArray = vi.mocked(db.pendingChanges.toArray);
      const mockUpdate = vi.mocked(db.pendingChanges.update);
      mockToArray.mockResolvedValue([]);
      mockUpdate.mockResolvedValue(1);

      mockUseOnlineStatus.mockReturnValue(false);
      mockGetPendingChanges.mockResolvedValue([]);

      renderHook(() => useSync());

      await new Promise(r => setTimeout(r, 50));

      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run --prefix frontend -- src/hooks/__tests__/useSync.test.ts 2>&1 | tail -50`

Expected: FAIL — `_authRequired` does not exist; createdAt refresh not implemented; `db.pendingChanges` may surface as undefined depending on prior test imports.

- [ ] **Step 3: Implement the changes**

In `frontend/src/hooks/useSync.ts`:

**3a.** Add the module-level flag, the `'auth-required'` listener, and the `AuthError` import. At the top of the file, with the other imports:

```ts
import { db } from '../db';
import { AuthError } from '../api/client';
```

Below the imports and above `function extractErrorMessage`, add:

```ts
let _authRequired = false;

if (typeof window !== 'undefined') {
  window.addEventListener('auth-required', () => {
    _authRequired = true;
  });
}

async function refreshPendingChangeTimestamps() {
  const all = await db.pendingChanges.toArray();
  const now = Date.now();
  await Promise.all(all.map(c => c.id !== undefined ? db.pendingChanges.update(c.id, { createdAt: now }) : Promise.resolve()));
}
```

**3b.** At the very top of the `useSync` function body, add a one-time init effect that runs the cross-reload refresh:

```ts
export function useSync() {
  const isOnline = useOnlineStatus();
  const [status, setStatus] = useState<ConnectionStatus>(isOnline ? 'online' : 'offline');
  const [pendingCount, setPendingCount] = useState(0);
  const syncErrorsRef = useRef<Map<number, string>>(new Map());

  // On first mount, if a previous instance flagged auth-required-pending, refresh
  // queued changes' createdAt so they get a fresh hour against the stale-discard rule.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem('auth-required-pending') === '1') {
      window.localStorage.removeItem('auth-required-pending');
      refreshPendingChangeTimestamps().catch(err => console.warn('Failed to refresh pending change timestamps:', err));
    }
  }, []);

  // ... rest of the existing useSync body unchanged below this point until we add the guards
```

**3c.** Add `_authRequired` guards to the two sync-driving `useEffect`s. Find the effect at lines 574-581:

```ts
  // Update status when online state changes
  useEffect(() => {
    if (!isOnline) {
      setStatus('offline');
    } else {
      // When coming online, try to sync
      syncPendingChanges();
    }
  }, [isOnline, syncPendingChanges]);
```

Replace with:

```ts
  // Update status when online state changes
  useEffect(() => {
    if (_authRequired) return;
    if (!isOnline) {
      setStatus('offline');
    } else {
      // When coming online, try to sync
      syncPendingChanges();
    }
  }, [isOnline, syncPendingChanges]);
```

Find the polling effect at lines 586-598:

```ts
  // Check pending count periodically and sync if needed
  const syncRef = useRef(syncPendingChanges);
  syncRef.current = syncPendingChanges;
  useEffect(() => {
    const checkPending = async () => {
      const changes = await getPendingChanges();
      setPendingCount(changes.length);
      // Auto-sync if there are pending changes
      if (changes.length > 0) {
        syncRef.current();
      }
    };
    checkPending();
    const interval = setInterval(checkPending, 5000);
    return () => clearInterval(interval);
  }, []);
```

Replace with:

```ts
  // Check pending count periodically and sync if needed
  const syncRef = useRef(syncPendingChanges);
  syncRef.current = syncPendingChanges;
  useEffect(() => {
    const checkPending = async () => {
      const changes = await getPendingChanges();
      setPendingCount(changes.length);
      // Auto-sync if there are pending changes (and we're not in auth-required state)
      if (changes.length > 0 && !_authRequired) {
        syncRef.current();
      }
    };
    checkPending();
    const interval = setInterval(checkPending, 5000);
    return () => clearInterval(interval);
  }, []);
```

Also add a guard at the top of `syncPendingChanges` so that direct callers (e.g., the online-event effect) don't sync. Find at line 84:

```ts
  const syncPendingChanges = useCallback(async () => {
    if (!isOnline) return;
```

Replace with:

```ts
  const syncPendingChanges = useCallback(async () => {
    if (!isOnline) return;
    if (_authRequired) return;
```

**3d.** Add `AuthError` handling inside the per-change `catch` block. Find lines 537-554:

```ts
      } catch (error) {
        console.error('Failed to sync change:', error);
        if (change.id) {
          syncErrorsRef.current.set(change.id, extractErrorMessage(error));
        }
        // If change is older than 1 hour, discard it — it's likely stale
        const ONE_HOUR = 60 * 60 * 1000;
        if (change.createdAt && Date.now() - change.createdAt > ONE_HOUR) {
          console.warn('Discarding stale pending change (>1h old):', change.type, change.date);
          if (change.id) {
            await removePendingChange(change.id);
          }
          setPendingCount(prev => prev - 1);
          continue;
        }
        // For recent changes, stop and retry later
        break;
      }
```

Replace with:

```ts
      } catch (error) {
        if (error instanceof AuthError) {
          // Auth required — pause the entire sync. Do not remove the change,
          // do not apply the stale-discard rule. The auth-required listener has
          // already flipped _authRequired; calls into syncPendingChanges below
          // will short-circuit until the user signs back in (which forces a reload).
          window.dispatchEvent(new CustomEvent('auth-required'));
          break;
        }
        console.error('Failed to sync change:', error);
        if (change.id) {
          syncErrorsRef.current.set(change.id, extractErrorMessage(error));
        }
        // If change is older than 1 hour, discard it — it's likely stale
        const ONE_HOUR = 60 * 60 * 1000;
        if (change.createdAt && Date.now() - change.createdAt > ONE_HOUR) {
          console.warn('Discarding stale pending change (>1h old):', change.type, change.date);
          if (change.id) {
            await removePendingChange(change.id);
          }
          setPendingCount(prev => prev - 1);
          continue;
        }
        // For recent changes, stop and retry later
        break;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run --prefix frontend -- src/hooks/__tests__/useSync.test.ts 2>&1 | tail -50`

Expected: PASS for the new `auth-required handling` block. The pre-existing tests should still pass.

NOTE: The `_authRequired` flag is module-level and set by a window event listener attached at module load. Once a test fires `auth-required`, every subsequent test in the same file sees `_authRequired === true`. If pre-existing tests now fail because of this leak, add `_authRequired = false` reset to the existing `beforeEach` of the top-level `describe('useSync', ...)` block. Since the variable is private, expose a test-only reset by adding to `useSync.ts`:

```ts
export function __resetAuthRequiredForTests() {
  _authRequired = false;
}
```

…and call it in the top-level `beforeEach`:

```ts
import { useSync, __resetAuthRequiredForTests } from '../useSync';
...
beforeEach(() => {
  __resetAuthRequiredForTests();
  ...
});
```

Add the import to the test file as well. Re-run the test command and confirm PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/hooks/useSync.ts frontend/src/hooks/__tests__/useSync.test.ts
git -C /Users/evan.callia/Desktop/meal-planner commit -m "feat: pause useSync and refresh createdAt on auth-required"
```

---

## Task 6: Pause useRealtime EventSource on auth-required

**Files:**
- Modify: `frontend/src/hooks/useRealtime.ts`
- Test: `frontend/src/hooks/__tests__/useRealtime.test.ts`

When `auth-required` fires, close any open EventSource and prevent further reconnect attempts. The module-level state will reset on the next full-window navigation reload.

- [ ] **Step 1: Write the failing test**

Append the following to the bottom of the existing top-level `describe('useRealtime', ...)` block in `frontend/src/hooks/__tests__/useRealtime.test.ts` (before its closing `})`). The test installs its own EventSource mock at runtime and restores the original after — this avoids stomping on whatever pattern the file already uses.

```ts
  it('closes the EventSource and stops reconnecting when auth-required fires', async () => {
    const originalEventSource = (globalThis as any).EventSource;
    const constructorSpy = vi.fn();
    class MockEventSource {
      readyState = 0;
      close = vi.fn();
      addEventListener = vi.fn();
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(url: string, opts?: EventSourceInit) {
        constructorSpy(url, opts);
      }
    }
    (globalThis as any).EventSource = MockEventSource;

    try {
      const { unmount } = renderHook(() => useRealtime());
      await waitFor(() => expect(constructorSpy).toHaveBeenCalledTimes(1));

      act(() => { window.dispatchEvent(new CustomEvent('auth-required')); });

      // Give the listener a moment, then assert no second connection attempt
      await new Promise(r => setTimeout(r, 100));
      expect(constructorSpy).toHaveBeenCalledTimes(1);

      unmount();
    } finally {
      (globalThis as any).EventSource = originalEventSource;
    }
  });
```

Make sure `act`, `waitFor`, and `renderHook` are imported at the top of the test file. If any are missing, add them: `import { renderHook, act, waitFor } from '@testing-library/react';`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:run --prefix frontend -- src/hooks/__tests__/useRealtime.test.ts 2>&1 | tail -40`

Expected: FAIL — auth-required event has no effect.

- [ ] **Step 3: Update useRealtime to react to auth-required**

In `frontend/src/hooks/useRealtime.ts`, after the `BASE_RECONNECT_DELAY` constant (around line 16), add:

```ts
let _authRequired = false;

if (typeof window !== 'undefined') {
  window.addEventListener('auth-required', () => {
    _authRequired = true;
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  });
}
```

Update `createSource` to bail early if `_authRequired`. At the top of the function (line 30, immediately after `closeSource();`), add:

```ts
const createSource = () => {
  // Clean up any existing connection first
  closeSource();
  if (_authRequired) return;
  ...
```

Update the reconnect block inside `eventSource.onerror` (around lines 57-69) to bail when `_authRequired`. Find:

```ts
    // Only reconnect if we still have subscribers and haven't exceeded attempts
    if (subscriberCount > 0 && !reconnectTimeout) {
```

Replace with:

```ts
    // Only reconnect if we still have subscribers and we're not in auth-required state
    if (subscriberCount > 0 && !reconnectTimeout && !_authRequired) {
```

Update the second `useEffect` reconnect-on-online to also bail. Find lines 96-103:

```ts
  // Reconnect when coming back online
  useEffect(() => {
    if (isOnline && subscriberCount > 0 && !eventSource) {
      reconnectAttempts = 0; // Reset on online status change
      createSource();
    } else if (!isOnline) {
      closeSource();
    }
  }, [isOnline]);
```

Replace with:

```ts
  // Reconnect when coming back online
  useEffect(() => {
    if (_authRequired) return;
    if (isOnline && subscriberCount > 0 && !eventSource) {
      reconnectAttempts = 0; // Reset on online status change
      createSource();
    } else if (!isOnline) {
      closeSource();
    }
  }, [isOnline]);
```

Add a test-only reset (mirrors Task 5):

```ts
export function __resetAuthRequiredForTests() {
  _authRequired = false;
}
```

…and import + call this in `beforeEach` of the existing test file's top-level describe.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:run --prefix frontend -- src/hooks/__tests__/useRealtime.test.ts 2>&1 | tail -40`

Expected: PASS for the new test. Pre-existing tests should still pass.

- [ ] **Step 5: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/hooks/useRealtime.ts frontend/src/hooks/__tests__/useRealtime.test.ts
git -C /Users/evan.callia/Desktop/meal-planner commit -m "feat: pause useRealtime EventSource on auth-required"
```

---

## Task 7: Create the ReAuthModal component

**Files:**
- Create: `frontend/src/components/ReAuthModal.tsx`
- Create: `frontend/src/components/__tests__/ReAuthModal.test.tsx`

A non-dismissable full-screen modal with copy explaining the situation and a single "Sign in" button that performs `window.location.href = getLoginUrl()`. Pending count rendered conditionally.

- [ ] **Step 1: Write failing tests**

Create `frontend/src/components/__tests__/ReAuthModal.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../api/client', () => ({
  getLoginUrl: () => '/api/auth/login',
}));

import { ReAuthModal } from '../ReAuthModal';

describe('ReAuthModal', () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, href: '' },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('renders the title and body copy', () => {
    render(<ReAuthModal pendingCount={0} />);
    expect(screen.getByText(/sign in to keep using meal planner/i)).toBeInTheDocument();
    expect(screen.getByText(/your session has expired/i)).toBeInTheDocument();
    expect(screen.getByText(/your unsaved changes are saved on this device/i)).toBeInTheDocument();
  });

  it('does not show the pending-count line when count is 0', () => {
    render(<ReAuthModal pendingCount={0} />);
    expect(screen.queryByText(/changes waiting to sync/i)).not.toBeInTheDocument();
  });

  it('shows the pending-count line when count > 0', () => {
    render(<ReAuthModal pendingCount={3} />);
    expect(screen.getByText(/3 changes waiting to sync/i)).toBeInTheDocument();
  });

  it('navigates to the login URL when Sign in is clicked', () => {
    render(<ReAuthModal pendingCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(window.location.href).toBe('/api/auth/login');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run --prefix frontend -- src/components/__tests__/ReAuthModal.test.tsx 2>&1 | tail -30`

Expected: FAIL — `ReAuthModal` does not exist.

- [ ] **Step 3: Implement ReAuthModal**

Create `frontend/src/components/ReAuthModal.tsx`:

```tsx
import { getLoginUrl } from '../api/client';

interface ReAuthModalProps {
  pendingCount: number;
}

export function ReAuthModal({ pendingCount }: ReAuthModalProps) {
  const handleSignIn = () => {
    window.location.href = getLoginUrl();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
    >
      <div className="glass rounded-2xl max-w-sm w-full p-6 text-center">
        <h2
          id="reauth-title"
          className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-3"
        >
          Sign in to keep using Meal Planner
        </h2>
        <p className="text-gray-700 dark:text-gray-300 mb-3">
          Your session has expired. Sign in again to continue.
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 italic mb-5">
          Your unsaved changes are saved on this device and will sync after sign-in.
        </p>
        {pendingCount > 0 && (
          <p className="text-sm text-gray-700 dark:text-gray-300 mb-5">
            {pendingCount} {pendingCount === 1 ? 'change' : 'changes'} waiting to sync.
          </p>
        )}
        <button
          onClick={handleSignIn}
          className="w-full py-3 px-4 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 transition-colors"
        >
          Sign in
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run --prefix frontend -- src/components/__tests__/ReAuthModal.test.tsx 2>&1 | tail -30`

Expected: PASS for all four tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/components/ReAuthModal.tsx frontend/src/components/__tests__/ReAuthModal.test.tsx
git -C /Users/evan.callia/Desktop/meal-planner commit -m "feat: add ReAuthModal component"
```

---

## Task 8: Wire up auth-required in App.tsx (remove destructive listener, render modal)

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/StatusBar.tsx`

Three changes:
1. Remove the existing `auth-unauthorized` listener (lines 1015-1019) and stop dispatching `auth-unauthorized` anywhere. The new `auth-required` event drives the modal — it does NOT call `clearAllLocalData`.
2. Add a new `auth-required` listener that sets `status = 'auth-required'` and writes the cross-reload flag to localStorage.
3. Render `<ReAuthModal />` when `status === 'auth-required'`. Make `StatusBar` return `null` for that state too (we don't want the offline banner under the modal).

- [ ] **Step 1: Update StatusBar to skip 'auth-required'**

In `frontend/src/components/StatusBar.tsx`, change line 9 from:

```ts
  if (status === 'online') {
    return null;
  }
```

to:

```ts
  if (status === 'online' || status === 'auth-required') {
    return null;
  }
```

- [ ] **Step 2: Add the auth-required listener inside useSync**

The `status` state lives in `useSync.ts` (it's what App.tsx reads). The cleanest place for the listener is inside the hook itself.

In `frontend/src/hooks/useSync.ts`, inside the `useSync` function body, add this `useEffect` immediately after the existing `useState`/`useRef` declarations (and after the `auth-required-pending` init effect added in Task 5):

```ts
  useEffect(() => {
    const handler = () => {
      setStatus('auth-required');
      try {
        window.localStorage.setItem('auth-required-pending', '1');
      } catch {
        // localStorage might be unavailable; ignore.
      }
    };
    window.addEventListener('auth-required', handler);
    return () => window.removeEventListener('auth-required', handler);
  }, []);
```

The `_authRequired` guard added in Task 5 to the `isOnline`-change `useEffect` already prevents the offline/online flow from overwriting `'auth-required'`.

- [ ] **Step 3: Remove the old auth-unauthorized listener from App.tsx**

In `frontend/src/App.tsx`, find lines 1013-1019:

```tsx
  // Log out when any API call returns 401 — don't redirect to provider
  // since the session is already gone (avoids redirect loop)
  useEffect(() => {
    const handler = () => { handleLogout(false); };
    window.addEventListener('auth-unauthorized', handler);
    return () => window.removeEventListener('auth-unauthorized', handler);
  }, [handleLogout]);
```

Delete this block entirely. The `auth-required` event is now handled inside `useSync`; App.tsx just reads the resulting `status`.

- [ ] **Step 4: Add the ReAuthModal import and render it**

In `frontend/src/App.tsx`, add the import near the existing component imports (around line 9):

```ts
import { ReAuthModal } from './components/ReAuthModal';
```

Find where `<StatusBar status={status} pendingCount={pendingCount} />` is rendered (around line 1053). Just below that line, add:

```tsx
      {status === 'auth-required' && <ReAuthModal pendingCount={pendingCount} />}
```

- [ ] **Step 5: Add an integration test for the wiring**

This is best validated by an existing test, but a focused unit-style test of the wiring is fine. Add to `frontend/src/hooks/__tests__/useSync.test.ts`, inside the `auth-required handling` describe added in Task 5:

```ts
    it('sets status to auth-required when the event fires and writes the localStorage flag', async () => {
      mockUseOnlineStatus.mockReturnValue(true);
      mockGetPendingChanges.mockResolvedValue([]);
      window.localStorage.removeItem('auth-required-pending');

      const { result } = renderHook(() => useSync());

      // Initially should be 'online' (mocked)
      await waitFor(() => expect(result.current.status).toBe('online'));

      act(() => { window.dispatchEvent(new CustomEvent('auth-required')); });

      await waitFor(() => expect(result.current.status).toBe('auth-required'));
      expect(window.localStorage.getItem('auth-required-pending')).toBe('1');
    });
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:run --prefix frontend -- src/hooks/__tests__/useSync.test.ts 2>&1 | tail -50`

Expected: PASS. Also run the full suite to catch any incidental breakage:

Run: `npm run test:run --prefix frontend 2>&1 | tail -30`

Expected: All tests pass.

- [ ] **Step 7: Verify auth-unauthorized is fully removed**

Run a quick sanity check via grep:

```bash
grep -n "auth-unauthorized" /Users/evan.callia/Desktop/meal-planner/frontend/src/
```

Expected: no results in `src/` (the event is fully removed). If any references remain, they need to be migrated to `auth-required` or deleted.

```bash
grep -rn "auth-unauthorized" /Users/evan.callia/Desktop/meal-planner/frontend/src/
```

Expected: empty.

- [ ] **Step 8: Commit**

```bash
git -C /Users/evan.callia/Desktop/meal-planner add frontend/src/App.tsx frontend/src/hooks/useSync.ts frontend/src/components/StatusBar.tsx frontend/src/hooks/__tests__/useSync.test.ts
git -C /Users/evan.callia/Desktop/meal-planner commit -m "feat: render ReAuthModal on auth-required, remove destructive 401 handler"
```

---

## Task 9: End-to-end verification

**Files:** none — verification only.

- [ ] **Step 1: Run the full frontend test suite**

Run: `npm run test:run --prefix frontend 2>&1 | tail -50`

Expected: All tests pass. If any test fails because of leaked module-level `_authRequired` state between describe blocks, ensure `__resetAuthRequiredForTests()` is called in the relevant `beforeEach`.

- [ ] **Step 2: Type-check / build**

Run: `npm run build --prefix frontend 2>&1 | tail -30`

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 3: Run backend tests (sanity — no backend changes here, but confirm nothing accidentally landed)**

Run: `bash /Users/evan.callia/Desktop/meal-planner/run-tests.sh 2>&1 | tail -40`

Expected: passes. If it fails for unrelated reasons, ignore.

- [ ] **Step 4: Manual smoke test (user-driven, optional but recommended)**

The author should:
1. Restart the Docker dev environment: `docker-compose -f /Users/evan.callia/Desktop/meal-planner/docker-compose.yml up -d --build`
2. Open the app, sign in via dev-login (`/api/auth/dev-login`).
3. Open dev tools → Application → Cookies → delete the session cookie.
4. Make a change (e.g., add a grocery item). Confirm the modal appears within ~5 seconds and the item shows as queued (not synced).
5. Click "Sign in." Confirm the page navigates to `/api/auth/login`, then back to `/` after dev-login flow.
6. After reload, confirm the queued item appears synced (and not lost).
7. Confirm the modal does not reappear unless the cookie is cleared again.

If any of the manual steps fail, file the gap as a follow-up.

- [ ] **Step 5: Final commit (if any cleanup happened during verification)**

If Steps 1-3 pass cleanly, no commit is needed. Otherwise, commit any small fixes:

```bash
git -C /Users/evan.callia/Desktop/meal-planner status
# inspect, stage relevant files
git -C /Users/evan.callia/Desktop/meal-planner commit -m "fix: <whatever was needed>"
```

- [ ] **Step 6: Push the branch and open a PR**

```bash
git -C /Users/evan.callia/Desktop/meal-planner push -u origin pwa-reauth-flow
gh -R "$(cd /Users/evan.callia/Desktop/meal-planner && gh repo view --json nameWithOwner -q .nameWithOwner)" pr create --title "PWA re-auth flow with offline-queue preservation" --body "$(cat <<'EOF'
## Summary
- Adds `'auth-required'` ConnectionStatus state and detection for both authentik session expiry and Cloudflare challenges
- New blocking ReAuthModal preserves the offline queue across the sign-in flow
- Removes the destructive 401 handler that was wiping `clearAllLocalData()` on session expiration

## Test plan
- [ ] Run `npm run test:run --prefix frontend`
- [ ] Manual smoke test: clear session cookie mid-session, make a change, verify modal appears, sign back in, verify queued change syncs.

See `docs/superpowers/specs/2026-05-04-pwa-reauth-flow-design.md` for the full design.
EOF
)"
```

---

## Self-Review Notes

**Spec coverage check:**
- Detection rules (3 conditions): Task 3 ✓
- Health check HTML detection: Task 4 ✓
- ConnectionStatus state: Task 1 ✓
- AuthError class: Task 2 ✓
- Sync pause + AuthError catch + createdAt refresh: Task 5 ✓
- Realtime pause: Task 6 ✓
- Modal rendering + state listener + remove destructive handler: Tasks 7-8 ✓
- Test plan (client, useSync, useOnlineStatus, App, ReAuthModal): Tasks 2, 3, 4, 5, 6, 7, 8 ✓
- Service worker (no changes needed): noted in design, no task required ✓
- Cross-reload localStorage flag: Tasks 5 (read), 8 (write) ✓

**Type consistency:**
- `_authRequired` and `__resetAuthRequiredForTests` used consistently in both useSync and useRealtime.
- `'auth-required'` event name consistent everywhere.
- `'auth-required-pending'` localStorage key consistent.
- `AuthError` named consistently.
- `ReAuthModal` props `pendingCount` consistent.

**Known acceptable risks:**
- `__resetAuthRequiredForTests` exports test-only state-reset. Marked clearly as test-only.
- The `auth-required` event listener at module level cannot be unregistered. This is intentional — it lives for the lifetime of the page and is reset only by full-window navigation, which matches the design.
