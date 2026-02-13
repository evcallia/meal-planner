# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack meal planner PWA with offline-first architecture. React/TypeScript frontend, Python/FastAPI backend, PostgreSQL database. Designed as a mobile-focused progressive web app with CalDAV (Apple Calendar) integration.

## Commands

### Unified Test Runner
```bash
./run-tests.sh              # Run all tests (frontend + backend)
./run-tests.sh --frontend-only
./run-tests.sh --backend-only
./run-tests.sh --skip-deps  # Skip dependency installation
```

### Frontend (from `frontend/`)
```bash
npm run dev                 # Vite dev server on :5173, proxies /api to :8000
npm run build               # TypeScript check + Vite production build
npm run test:run            # Run all tests once
npm test                    # Watch mode
npm run test:coverage       # Coverage report (>90% statements, >85% branches)
npx vitest run src/components/__tests__/DayCard.test.tsx  # Single test file
```

### Backend (from `backend/`)
```bash
.venv/bin/python -m pytest tests/              # All tests
.venv/bin/python -m pytest tests/ -k "test_auth"  # Pattern match
.venv/bin/python -m pytest -m unit             # Unit tests only
.venv/bin/python -m pytest -m integration      # Integration tests only
```
Coverage minimum: 85% backend, 85% frontend.

### Docker
```bash
docker compose up --build   # Full stack (db + app)
docker compose up db        # PostgreSQL only (for local dev)
```

## Architecture

### Frontend (`frontend/src/`)
- **React 18 + TypeScript + Vite + Tailwind CSS**
- `App.tsx` — main container, auth check, layout
- `components/CalendarView.tsx` — main calendar grid, drag-and-drop between days
- `components/DayCard.tsx` — individual day: meal notes, itemization checkboxes, events. Has both compact and standard rendering paths
- `components/RichTextEditor.tsx` — contentEditable div for meal note editing
- `db.ts` — Dexie IndexedDB schema: mealNotes, pendingChanges, pantryItems, mealIdeas, calendarDays, etc.
- `api/client.ts` — fetch wrapper with 5s timeout and retry logic
- `hooks/useSync.ts` — offline queue processing: pending changes → API sync with temp ID → real ID mapping
- `hooks/useRealtime.ts` — SSE listener for concurrent edit detection

### Backend (`backend/app/`)
- **FastAPI + SQLAlchemy + PostgreSQL**
- `main.py` — FastAPI app with lifespan hooks (table creation, migrations, calendar cache init)
- `routers/days.py` — meal notes CRUD, itemized toggle, line splitting logic (`_split_note_lines`)
- `routers/calendar.py` — CalDAV event fetching, caching, hide/unhide
- `routers/auth.py` — OIDC login/callback/logout via Authentik
- `routers/realtime.py` — SSE endpoint via custom EventBroadcaster
- `ical_service.py` — CalDAV integration with background refresh every 5 minutes
- `models.py` — MealNote, MealItem (line_index + itemized), PantryItem, MealIdea, CachedCalendarEvent

### Data Flow
1. Frontend proxies `/api/*` to backend (dev) or backend serves static build (production)
2. Changes queue in IndexedDB when offline; `useSync` processes on reconnect
3. Backend broadcasts changes via SSE; other clients receive real-time updates
4. CalDAV events are cached in PostgreSQL to avoid slow Apple Calendar API calls

## Key Patterns

### Line Splitting (duplicated in 3 places — must stay in sync)
- `frontend/src/components/DayCard.tsx` — `splitHtmlLines()`
- `frontend/src/components/CalendarView.tsx` — `splitHtmlLines()`
- `backend/app/routers/days.py` — `_split_note_lines()`

These convert HTML from contentEditable (`<div>`, `<br>`, `<p>` tags) into separate lines. Each line gets a `MealItem` with `line_index` for itemization tracking. When updating notes, the backend matches old line content to new lines to preserve itemized state.

### Offline-First Sync
Dexie `pendingChanges` table queues all mutations. `useSync` processes them on reconnect, mapping temporary local IDs to server-assigned IDs via `tempIdMap` table.

### Authentication
OIDC via Authentik. Backend manages sessions; frontend caches user info in localStorage for offline access. Security validation in `config.py` enforces HTTPS/secure cookies in production.

### Mobile Focus Proxy
DayCard uses a hidden `<textarea>` as a focus proxy. On tap, it's focused synchronously (within the gesture handler) so mobile browsers open the virtual keyboard. RichTextEditor then transfers focus to the contentEditable on mount.

## Testing

- **Frontend**: Vitest + React Testing Library + happy-dom environment. Tests in `__tests__/` directories alongside source.
- **Backend**: pytest with SQLite in-memory. Tests in `backend/tests/`. Fixtures in `conftest.py` override DB dependency.
- **CI**: GitHub Actions runs both on push to main and PRs, uploads coverage to Codecov.
