# Server-Side User Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist user settings on the server per-user so they sync across devices via SSE, with offline-first loading from localStorage.

**Architecture:** A `user_settings` table keyed by OIDC `sub` stores a JSON settings blob + `updated_at` timestamp. The `EventBroadcaster` is upgraded to associate queues with user `sub` values, enabling targeted broadcasts. The frontend `useSettings` hook loads from localStorage first (zero delay), then syncs with the server in the background using last-write-wins timestamp comparison.

**Tech Stack:** FastAPI, SQLAlchemy, PostgreSQL (JSON column), React, localStorage, SSE

---

## File Structure

### Backend
- **Modify:** `backend/app/models.py` — add `UserSettings` model
- **Modify:** `backend/app/schemas.py` — add `UserSettingsSchema`, `UserSettingsUpdate`
- **Modify:** `backend/app/realtime.py` — upgrade `EventBroadcaster` with per-user queue tracking
- **Create:** `backend/app/routers/settings.py` — `GET /api/settings`, `PUT /api/settings`
- **Modify:** `backend/app/routers/realtime.py` — pass `user["sub"]` to `subscribe()`
- **Modify:** `backend/app/main.py` — register settings router, add table creation

### Frontend
- **Modify:** `frontend/src/api/client.ts` — add `getSettings`, `putSettings` API functions
- **Modify:** `frontend/src/hooks/useSettings.ts` — server sync, localStorage migration, SSE listener
- **Modify:** `frontend/src/App.tsx` — add `settings.updated` SSE handler

### Tests
- **Modify:** `backend/tests/test_api.py` — add settings endpoint tests
- **Modify:** `frontend/src/hooks/__tests__/useSettings.test.ts` — update for new behavior

---

## Task 1: Add UserSettings model and schema

**Files:**
- Modify: `backend/app/models.py`
- Modify: `backend/app/schemas.py`

- [ ] **Step 1: Add UserSettings model to models.py**

At the end of `backend/app/models.py`, add:

```python
from sqlalchemy import JSON

class UserSettings(Base):
    __tablename__ = "user_settings"

    sub: Mapped[str] = mapped_column(String(255), primary_key=True)
    settings: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
```

Note: `JSON` import needs to be added to the existing import line. The `String`, `DateTime`, `datetime` imports already exist.

- [ ] **Step 2: Add schemas to schemas.py**

At the end of `backend/app/schemas.py`, add:

```python
class UserSettingsResponse(BaseModel):
    settings: dict
    updated_at: datetime | None = None

class UserSettingsUpdate(BaseModel):
    settings: dict
    updated_at: datetime
```

- [ ] **Step 3: Verify backend tests still pass**

Run: `/Users/evan.callia/Desktop/meal-planner/.venv/bin/python -m pytest /Users/evan.callia/Desktop/meal-planner/tests/ -x -q 2>&1`

Expected: All tests pass (no behavioral changes yet).

- [ ] **Step 4: Commit**

```
feat: add UserSettings model and schemas
```

---

## Task 2: Upgrade EventBroadcaster with per-user queue tracking

**Files:**
- Modify: `backend/app/realtime.py`
- Modify: `backend/app/routers/realtime.py`

- [ ] **Step 1: Update EventBroadcaster to track sub per queue**

Replace the entire `backend/app/realtime.py` with:

```python
import asyncio
import json
from typing import Any, Dict, Optional, Set


def _format_sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


shutdown_event = asyncio.Event()


class EventBroadcaster:
    def __init__(self, max_queue_size: int = 100) -> None:
        self._queues: Set[asyncio.Queue[Optional[str]]] = set()
        self._queue_subs: Dict[asyncio.Queue[Optional[str]], str | None] = {}
        self._max_queue_size = max_queue_size
        self._closed = False

    def subscribe(self, sub: str | None = None) -> asyncio.Queue[Optional[str]]:
        queue: asyncio.Queue[Optional[str]] = asyncio.Queue(maxsize=self._max_queue_size)
        if self._closed:
            try:
                queue.put_nowait(None)
            except Exception:
                pass
        self._queues.add(queue)
        self._queue_subs[queue] = sub
        return queue

    def unsubscribe(self, queue: asyncio.Queue[Optional[str]]) -> None:
        self._queues.discard(queue)
        self._queue_subs.pop(queue, None)

    def _send_to_queue(self, queue: asyncio.Queue[Optional[str]], message: str, dead: Set[asyncio.Queue[Optional[str]]]) -> None:
        try:
            queue.put_nowait(message)
        except asyncio.QueueFull:
            try:
                _ = queue.get_nowait()
                queue.put_nowait(message)
            except Exception:
                dead.add(queue)
        except Exception:
            dead.add(queue)

    def _cleanup_dead(self, dead: Set[asyncio.Queue[Optional[str]]]) -> None:
        for queue in dead:
            self._queues.discard(queue)
            self._queue_subs.pop(queue, None)

    async def publish(self, payload: Dict[str, Any]) -> None:
        if self._closed:
            return
        message = _format_sse(payload)
        dead: Set[asyncio.Queue[Optional[str]]] = set()
        for queue in self._queues:
            self._send_to_queue(queue, message, dead)
        self._cleanup_dead(dead)

    async def publish_to_user(self, sub: str, payload: Dict[str, Any], exclude_queue: asyncio.Queue[Optional[str]] | None = None) -> None:
        if self._closed:
            return
        message = _format_sse(payload)
        dead: Set[asyncio.Queue[Optional[str]]] = set()
        for queue in self._queues:
            if self._queue_subs.get(queue) == sub and queue is not exclude_queue:
                self._send_to_queue(queue, message, dead)
        self._cleanup_dead(dead)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for queue in list(self._queues):
            try:
                while True:
                    try:
                        queue.put_nowait(None)
                        break
                    except asyncio.QueueFull:
                        try:
                            _ = queue.get_nowait()
                        except Exception:
                            break
            except Exception:
                pass


broadcaster = EventBroadcaster()


async def broadcast_event(event_type: str, payload: Dict[str, Any], source_id: str | None = None) -> None:
    msg: Dict[str, Any] = {"type": event_type, "payload": payload}
    if source_id:
        msg["source_id"] = source_id
    await broadcaster.publish(msg)


async def broadcast_to_user(sub: str, event_type: str, payload: Dict[str, Any], source_id: str | None = None) -> None:
    msg: Dict[str, Any] = {"type": event_type, "payload": payload}
    if source_id:
        msg["source_id"] = source_id
    await broadcaster.publish_to_user(sub, msg)
```

- [ ] **Step 2: Update SSE endpoint to pass user sub**

In `backend/app/routers/realtime.py`, change line 17 from:

```python
    queue = broadcaster.subscribe()
```

To:

```python
    queue = broadcaster.subscribe(sub=user.get("sub"))
```

- [ ] **Step 3: Run backend tests**

Run: `/Users/evan.callia/Desktop/meal-planner/.venv/bin/python -m pytest /Users/evan.callia/Desktop/meal-planner/tests/ -x -q 2>&1`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```
feat: upgrade EventBroadcaster with per-user queue targeting
```

---

## Task 3: Create settings API endpoints

**Files:**
- Create: `backend/app/routers/settings.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Create settings router**

Create `backend/app/routers/settings.py`:

```python
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import UserSettings
from app.schemas import UserSettingsResponse, UserSettingsUpdate
from app.realtime import broadcast_to_user

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=UserSettingsResponse)
async def get_settings(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    row = db.query(UserSettings).filter(UserSettings.sub == sub).first()
    if not row:
        return UserSettingsResponse(settings={}, updated_at=None)
    return UserSettingsResponse(settings=row.settings, updated_at=row.updated_at)


@router.put("", response_model=UserSettingsResponse)
async def put_settings(
    payload: UserSettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    row = db.query(UserSettings).filter(UserSettings.sub == sub).first()
    if row:
        row.settings = payload.settings
        row.updated_at = payload.updated_at
    else:
        row = UserSettings(sub=sub, settings=payload.settings, updated_at=payload.updated_at)
        db.add(row)
    db.commit()
    db.refresh(row)

    await broadcast_to_user(
        sub,
        "settings.updated",
        {"settings": row.settings, "updated_at": row.updated_at.isoformat()},
        source_id=request.headers.get("x-source-id"),
    )

    return UserSettingsResponse(settings=row.settings, updated_at=row.updated_at)
```

- [ ] **Step 2: Register router and ensure table creation in main.py**

In `backend/app/main.py`, add the import alongside the other router imports:

```python
from app.routers import settings as settings_router
```

And add the router registration alongside the others:

```python
app.include_router(settings_router.router)
```

The `user_settings` table will be created automatically by `Base.metadata.create_all(bind=engine)` which already runs in the lifespan. No migration function changes needed.

- [ ] **Step 3: Add backend tests for settings endpoints**

Add to `backend/tests/test_api.py` (at the end of the file, or in a new test class):

```python
def test_get_settings_empty(client):
    """GET /api/settings returns empty when no settings saved."""
    response = client.get("/api/settings")
    assert response.status_code == 200
    data = response.json()
    assert data["settings"] == {}
    assert data["updated_at"] is None


def test_put_and_get_settings(client):
    """PUT /api/settings saves and GET retrieves."""
    settings_payload = {
        "settings": {"compactView": True, "calendarColor": "blue"},
        "updated_at": "2026-04-01T12:00:00",
    }
    response = client.put("/api/settings", json=settings_payload)
    assert response.status_code == 200
    data = response.json()
    assert data["settings"]["compactView"] is True
    assert data["settings"]["calendarColor"] == "blue"
    assert data["updated_at"] is not None

    # GET should return the same
    response = client.get("/api/settings")
    assert response.status_code == 200
    data = response.json()
    assert data["settings"]["compactView"] is True


def test_put_settings_upsert(client):
    """PUT /api/settings twice overwrites."""
    client.put("/api/settings", json={
        "settings": {"compactView": True},
        "updated_at": "2026-04-01T12:00:00",
    })
    client.put("/api/settings", json={
        "settings": {"compactView": False, "holidayColor": "green"},
        "updated_at": "2026-04-01T13:00:00",
    })
    response = client.get("/api/settings")
    data = response.json()
    assert data["settings"]["compactView"] is False
    assert data["settings"]["holidayColor"] == "green"
```

- [ ] **Step 4: Run backend tests**

Run: `/Users/evan.callia/Desktop/meal-planner/.venv/bin/python -m pytest /Users/evan.callia/Desktop/meal-planner/tests/ -x -q 2>&1`

Expected: All tests pass including the new ones.

- [ ] **Step 5: Commit**

```
feat: add GET/PUT /api/settings endpoints with per-user SSE broadcast
```

---

## Task 4: Add frontend API functions for settings

**Files:**
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: Add getSettings and putSettings to client.ts**

Add these functions to `frontend/src/api/client.ts` alongside the other API functions:

```typescript
export async function getSettings(): Promise<{ settings: Record<string, unknown>; updated_at: string | null }> {
  return fetchAPI<{ settings: Record<string, unknown>; updated_at: string | null }>('/settings');
}

export async function putSettings(settings: Record<string, unknown>, updatedAt: string): Promise<{ settings: Record<string, unknown>; updated_at: string }> {
  return fetchAPI<{ settings: Record<string, unknown>; updated_at: string }>('/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings, updated_at: updatedAt }),
  });
}
```

- [ ] **Step 2: Build frontend to verify TypeScript compiles**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```
feat: add getSettings and putSettings API client functions
```

---

## Task 5: Upgrade useSettings hook with server sync

**Files:**
- Modify: `frontend/src/hooks/useSettings.ts`

- [ ] **Step 1: Rewrite useSettings with server sync and localStorage migration**

Replace the entire `frontend/src/hooks/useSettings.ts` with:

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import { getSettings, putSettings } from '../api/client';
import { useOnlineStatus } from './useOnlineStatus';

export interface Settings {
  showItemizedColumn: boolean;
  showMealIdeas: boolean;
  compactView: boolean;
  textScaleStandard: number;
  textScaleCompact: number;
  showAllEvents: boolean;
  showHolidays: boolean;
  holidayColor: string;
  calendarColor: string;
}

export const DEFAULT_SETTINGS: Settings = {
  showItemizedColumn: true,
  showMealIdeas: true,
  compactView: false,
  textScaleStandard: 1,
  textScaleCompact: 1,
  showAllEvents: false,
  showHolidays: true,
  holidayColor: 'red',
  calendarColor: 'amber',
};

const STORAGE_KEY = 'meal-planner-settings';

interface StoredSettings {
  settings: Settings;
  updated_at: string | null;
}

function loadFromLocalStorage(): StoredSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migration: old format was just the settings object (no updated_at wrapper)
      if (parsed && typeof parsed === 'object' && !('settings' in parsed && 'updated_at' in parsed)) {
        // Old format — wrap it
        return { settings: { ...DEFAULT_SETTINGS, ...parsed }, updated_at: null };
      }
      return { settings: { ...DEFAULT_SETTINGS, ...parsed.settings }, updated_at: parsed.updated_at };
    }
  } catch {
    // Ignore parse errors
  }
  return { settings: DEFAULT_SETTINGS, updated_at: null };
}

function saveToLocalStorage(settings: Settings, updatedAt: string | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, updated_at: updatedAt }));
  } catch {
    // Ignore storage errors
  }
}

export function useSettings() {
  const initial = loadFromLocalStorage();
  const [settings, setSettings] = useState<Settings>(initial.settings);
  const updatedAtRef = useRef<string | null>(initial.updated_at);
  const isOnline = useOnlineStatus();
  const syncedRef = useRef(false);

  // Sync with server on mount (and when coming back online)
  useEffect(() => {
    if (!isOnline || syncedRef.current) return;

    let cancelled = false;

    (async () => {
      try {
        const server = await getSettings();
        if (cancelled) return;

        const localTime = updatedAtRef.current ? new Date(updatedAtRef.current).getTime() : 0;
        const serverTime = server.updated_at ? new Date(server.updated_at).getTime() : 0;

        if (serverTime > localTime) {
          // Server is newer — apply server settings
          const merged = { ...DEFAULT_SETTINGS, ...server.settings } as Settings;
          setSettings(merged);
          updatedAtRef.current = server.updated_at;
          saveToLocalStorage(merged, server.updated_at);
        } else if (localTime > serverTime) {
          // Local is newer — push to server
          try {
            await putSettings(settings as unknown as Record<string, unknown>, updatedAtRef.current!);
          } catch {
            // Will retry on next sync
          }
        }
        // Equal — no action needed
        syncedRef.current = true;
      } catch {
        // Offline or server error — continue with localStorage settings
      }
    })();

    return () => { cancelled = true; };
  }, [isOnline]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for SSE settings.updated events from other sessions
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type !== 'settings.updated') return;

      const payload = detail.payload as { settings: Record<string, unknown>; updated_at: string };
      if (!payload?.updated_at) return;

      const incomingTime = new Date(payload.updated_at).getTime();
      const localTime = updatedAtRef.current ? new Date(updatedAtRef.current).getTime() : 0;

      if (incomingTime > localTime) {
        const merged = { ...DEFAULT_SETTINGS, ...payload.settings } as Settings;
        setSettings(merged);
        updatedAtRef.current = payload.updated_at;
        saveToLocalStorage(merged, payload.updated_at);
      }
    };

    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
  }, []);

  const updateSettings = useCallback((updates: Partial<Settings>) => {
    setSettings(prev => {
      const next = { ...prev, ...updates };
      const now = new Date().toISOString();
      updatedAtRef.current = now;
      saveToLocalStorage(next, now);

      // Fire-and-forget server save
      if (navigator.onLine) {
        putSettings(next as unknown as Record<string, unknown>, now).catch(() => {
          // Will sync on next reconnect
        });
      }

      return next;
    });
  }, []);

  return { settings, updateSettings };
}
```

- [ ] **Step 2: Build frontend to verify TypeScript compiles**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```
feat: upgrade useSettings with server sync and offline-first loading
```

---

## Task 6: Update useSettings tests

**Files:**
- Modify: `frontend/src/hooks/__tests__/useSettings.test.ts`

- [ ] **Step 1: Update tests for new localStorage format and server sync**

Replace `frontend/src/hooks/__tests__/useSettings.test.ts` with:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSettings, DEFAULT_SETTINGS } from '../useSettings'

// Mock the API client
vi.mock('../../api/client', () => ({
  getSettings: vi.fn().mockRejectedValue(new Error('offline')),
  putSettings: vi.fn().mockRejectedValue(new Error('offline')),
  SOURCE_ID: 'test-source',
}))

// Mock useOnlineStatus
vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn().mockReturnValue(false),
}))

// Mock localStorage
const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}

Object.defineProperty(global, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
})

describe('useSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns default settings when localStorage is empty', () => {
    mockLocalStorage.getItem.mockReturnValue(null)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('migrates old localStorage format (no updated_at wrapper)', () => {
    // Old format: just the settings object
    const oldFormat = JSON.stringify({
      showItemizedColumn: false,
      compactView: true,
    })
    mockLocalStorage.getItem.mockReturnValue(oldFormat)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings.showItemizedColumn).toBe(false)
    expect(result.current.settings.compactView).toBe(true)
    // Defaults should be merged in
    expect(result.current.settings.showHolidays).toBe(true)
  })

  it('loads new localStorage format with updated_at', () => {
    const newFormat = JSON.stringify({
      settings: { compactView: true, calendarColor: 'blue' },
      updated_at: '2026-04-01T12:00:00.000Z',
    })
    mockLocalStorage.getItem.mockReturnValue(newFormat)

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings.compactView).toBe(true)
    expect(result.current.settings.calendarColor).toBe('blue')
    // Defaults merged
    expect(result.current.settings.showMealIdeas).toBe(true)
  })

  it('handles malformed localStorage data gracefully', () => {
    mockLocalStorage.getItem.mockReturnValue('invalid json')

    const { result } = renderHook(() => useSettings())

    expect(result.current.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('updates settings and saves to localStorage in new format', () => {
    mockLocalStorage.getItem.mockReturnValue(null)

    const { result } = renderHook(() => useSettings())

    act(() => {
      result.current.updateSettings({ showItemizedColumn: false })
    })

    expect(result.current.settings.showItemizedColumn).toBe(false)
    // Verify localStorage was called with the new wrapped format
    const lastCall = mockLocalStorage.setItem.mock.calls.find(
      (call: [string, string]) => call[0] === 'meal-planner-settings'
    )
    expect(lastCall).toBeTruthy()
    const stored = JSON.parse(lastCall![1])
    expect(stored.settings.showItemizedColumn).toBe(false)
    expect(stored.updated_at).toBeTruthy()
  })

  it('allows partial updates', () => {
    mockLocalStorage.getItem.mockReturnValue(null)

    const { result } = renderHook(() => useSettings())

    act(() => {
      result.current.updateSettings({ compactView: true })
    })

    expect(result.current.settings.compactView).toBe(true)
    // Other settings unchanged
    expect(result.current.settings.showItemizedColumn).toBe(true)
    expect(result.current.settings.showMealIdeas).toBe(true)
  })
})
```

- [ ] **Step 2: Run frontend tests**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`

Expected: All tests pass.

- [ ] **Step 3: Commit**

```
test: update useSettings tests for server sync and localStorage migration
```

---

## Task 7: Final integration verification

- [ ] **Step 1: Run all frontend tests**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`

Expected: All 556+ tests pass.

- [ ] **Step 2: Run all backend tests**

Run: `bash /Users/evan.callia/Desktop/meal-planner/run-tests.sh 2>&1`

Expected: All tests pass.

- [ ] **Step 3: Build frontend**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`

Expected: Build succeeds with no TypeScript errors.
