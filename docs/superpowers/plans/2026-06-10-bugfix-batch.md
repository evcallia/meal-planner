# June 2026 Bugfix Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six bugs/UX issues and add configurable meal-history retention, per the approved spec at `docs/superpowers/specs/2026-06-09-bugfix-batch-design.md`.

**Architecture:** Seven independent tasks (Task 4 depends on Task 1). Backend is FastAPI + SQLAlchemy (`backend/`), frontend is React 18 + TypeScript + Vite (`frontend/`). Frontend state hooks follow the optimistic-update + offline-queue patterns documented in CLAUDE.md — reuse existing mutation functions (`moveItem`, `createGrocerySectionAPI`) rather than inventing new flows.

**Tech Stack:** Python 3 / pytest (backend), React + vitest + @testing-library/react (frontend), IndexedDB via `frontend/src/db.ts`.

**Commands** (from repo root; on macOS export `PATH="/opt/homebrew/bin:$PATH"` if npm not found):
- Backend tests: `cd backend && .venv/bin/python -m pytest tests/<file> -v 2>&1`
- Frontend tests: `cd frontend && npm run test:run -- src/<path-to-test> 2>&1`
- Everything: `bash run-tests.sh`

---

## Task 1: Preserve itemized checkbox state via sequence alignment (spec item 3)

The bug: `PUT /api/days/{date}/notes` rebuilds all `MealItem` rows by matching normalized line *content* in a dict — duplicates clobber each other and any text edit resets that line's checkbox.

**Files:**
- Modify: `backend/app/routers/days.py` (helper after `_split_note_lines` at line 25-45; matching logic at lines 147-167)
- Create: `backend/tests/test_itemized_alignment.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_itemized_alignment.py`. Note: the notes blob is split on `\n` (and HTML breaks) by `_split_note_lines`, so plain `\n`-separated text works in tests. `authenticated_client` and `db_session` fixtures come from `backend/tests/conftest.py`.

```python
"""Itemized-state preservation across meal note edits (PUT /api/days/{date}/notes)."""
from fastapi.testclient import TestClient

DATE = "2026-06-15"


def put_notes(client: TestClient, notes: str) -> dict:
    resp = client.put(f"/api/days/{DATE}/notes", json={"notes": notes})
    assert resp.status_code == 200
    return resp.json()


def set_itemized(client: TestClient, line_index: int, itemized: bool = True) -> None:
    resp = client.patch(
        f"/api/days/{DATE}/items/{line_index}", json={"itemized": itemized}
    )
    assert resp.status_code == 200


def items_map(note: dict) -> dict[int, bool]:
    return {item["line_index"]: item["itemized"] for item in note["items"]}


class TestItemizedAlignment:
    def test_appending_meal_preserves_other_lines(self, authenticated_client):
        put_notes(authenticated_client, "Tacos\nPizza")
        set_itemized(authenticated_client, 0)
        note = put_notes(authenticated_client, "Tacos\nPizza\nSalad")
        assert items_map(note) == {0: True, 1: False, 2: False}

    def test_editing_line_in_place_keeps_its_state(self, authenticated_client):
        put_notes(authenticated_client, "Tacos\nPizza")
        set_itemized(authenticated_client, 1)
        note = put_notes(authenticated_client, "Tacos\nPizza night")
        assert items_map(note) == {0: False, 1: True}

    def test_inserting_line_above_shifts_state(self, authenticated_client):
        put_notes(authenticated_client, "Tacos\nPizza")
        set_itemized(authenticated_client, 1)
        note = put_notes(authenticated_client, "Soup\nTacos\nPizza")
        assert items_map(note) == {0: False, 1: False, 2: True}

    def test_duplicate_lines_keep_individual_state(self, authenticated_client):
        put_notes(authenticated_client, "Tacos\nTacos")
        set_itemized(authenticated_client, 0)
        note = put_notes(authenticated_client, "Tacos\nTacos\nPizza")
        assert items_map(note) == {0: True, 1: False, 2: False}

    def test_deleting_line_drops_state_and_shifts_rest(self, authenticated_client):
        put_notes(authenticated_client, "Eggs\nBacon\nToast")
        set_itemized(authenticated_client, 2)
        note = put_notes(authenticated_client, "Eggs\nToast")
        assert items_map(note) == {0: False, 1: True}

    def test_reordering_lines_carries_state(self, authenticated_client):
        put_notes(authenticated_client, "Tacos\nPizza")
        set_itemized(authenticated_client, 0)
        note = put_notes(authenticated_client, "Pizza\nTacos")
        assert items_map(note) == {0: False, 1: True}

    def test_html_lines_align_like_frontend(self, authenticated_client):
        put_notes(authenticated_client, "<div>Tacos</div><div>Pizza</div>")
        set_itemized(authenticated_client, 1)
        note = put_notes(
            authenticated_client, "<div>Tacos</div><div>Pizza</div><div>Salad</div>"
        )
        assert items_map(note) == {0: False, 1: True, 2: False}
```

- [ ] **Step 2: Run tests to verify the right ones fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_itemized_alignment.py -v 2>&1`

Expected: `test_editing_line_in_place_keeps_its_state` and `test_duplicate_lines_keep_individual_state` FAIL (content matching loses them). The append/insert/delete/reorder/html tests may pass with the old code — that's fine; they're regression guards.

- [ ] **Step 3: Implement sequence alignment in days.py**

In `backend/app/routers/days.py`, add `import difflib` to the imports at the top of the file. Then add after `_split_note_lines` (after line 45):

```python
def _normalize_line(line: str) -> str:
    return re.sub(r"<[^>]*>", "", line).strip().lower()


def _carry_itemized_state(
    old_lines: list[str], new_lines: list[str], old_itemized: dict[int, bool]
) -> list[bool]:
    """Map itemized state from old line positions to new line positions.

    Sequence alignment handles unchanged lines, insertions, deletions, and
    in-place edits (positional pairing inside `replace` blocks). A second
    content-matching pass over the leftovers handles moved/reordered lines.
    """
    old_norm = [_normalize_line(line) for line in old_lines]
    new_norm = [_normalize_line(line) for line in new_lines]
    result = [False] * len(new_norm)
    matched_old: set[int] = set()
    matched_new: set[int] = set()

    matcher = difflib.SequenceMatcher(a=old_norm, b=new_norm, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                result[j1 + k] = old_itemized.get(i1 + k, False)
                matched_old.add(i1 + k)
                matched_new.add(j1 + k)
        elif tag == "replace":
            for k in range(min(i2 - i1, j2 - j1)):
                result[j1 + k] = old_itemized.get(i1 + k, False)
                matched_old.add(i1 + k)
                matched_new.add(j1 + k)

    remaining_old: dict[str, list[int]] = {}
    for i, text in enumerate(old_norm):
        if i not in matched_old:
            remaining_old.setdefault(text, []).append(i)
    for j, text in enumerate(new_norm):
        if j in matched_new:
            continue
        candidates = remaining_old.get(text)
        if candidates:
            result[j] = old_itemized.get(candidates.pop(0), False)

    return result
```

Then in `update_notes`, replace lines 147-167 (everything from the `# Build a mapping of old line content...` comment through the item-recreation loop) with:

```python
    old_itemized = {item.line_index: item.itemized for item in meal_note.items}
    itemized_by_index = _carry_itemized_state(old_lines, new_lines, old_itemized)

    # Delete all existing items - we'll recreate with correct indices
    for item in list(meal_note.items):
        db.delete(item)
    db.flush()

    for i in range(len(new_lines)):
        db.add(MealItem(meal_note=meal_note, line_index=i, itemized=itemized_by_index[i]))
```

(The `old_items` dict and `old_line_to_itemized` loop are deleted. `re` stays imported — `_normalize_line` and `_split_note_lines` use it.)

- [ ] **Step 4: Run the alignment tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_itemized_alignment.py -v 2>&1`
Expected: all 7 PASS

- [ ] **Step 5: Run the full backend suite (existing days tests must not regress)**

Run: `cd backend && .venv/bin/python -m pytest -v 2>&1`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/days.py backend/tests/test_itemized_alignment.py
git commit -m "fix: preserve itemized checkbox state across meal edits via sequence alignment"
```

---

## Task 2: Missing second week on meals tab (spec item 6)

The bug: CalendarView's init API handler (CalendarView.tsx:404-413) **replaces** `days` filtered to the mount-time 1-week range. If infinite scroll already appended week 2 while the fetch was in flight, week 2 is wiped — and `displayEndRef` still points past it, so it never reloads.

**Files:**
- Modify: `frontend/src/components/CalendarView.tsx:404-413`
- Test: `frontend/src/components/__tests__/CalendarView.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/components/__tests__/CalendarView.test.tsx` (reuse the file's existing mocks, `formatDate`/`addDays` helpers, and `beforeEach` with `resetCalendarSessionLoaded()`; render with the same props existing tests use):

```tsx
it('keeps days appended by infinite scroll when the initial fetch resolves later', async () => {
  let ioCallback: IntersectionObserverCallback | null = null;
  vi.stubGlobal('IntersectionObserver', vi.fn((cb: IntersectionObserverCallback) => {
    ioCallback = cb;
    return { observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn() };
  }));

  // Capture one resolver per getDays call so we control resolution order
  const dayResolvers: Array<(v: unknown) => void> = [];
  vi.mocked(getDays).mockImplementation(
    () => new Promise(resolve => { dayResolvers.push(resolve); }) as never
  );
  vi.mocked(getEvents).mockResolvedValue({});

  render(<CalendarView onTodayRefReady={() => {}} />);

  const today = formatDate(new Date());
  await waitFor(() => expect(screen.getByTestId(`day-card-${today}`)).toBeInTheDocument());

  // Infinite scroll fires while the init fetch (dayResolvers[0]) is still pending
  await act(async () => {
    ioCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
  const week2Day = formatDate(addDays(new Date(), 7));
  await waitFor(() => expect(screen.getByTestId(`day-card-${week2Day}`)).toBeInTheDocument());

  // Resolve loadNextWeek's own API call (second), then the init fetch (first)
  await act(async () => { dayResolvers[1]?.([]); });
  await act(async () => { dayResolvers[0]?.([]); });

  // Week 1 and week 2 cards must both still be displayed
  expect(screen.getByTestId(`day-card-${today}`)).toBeInTheDocument();
  expect(screen.getByTestId(`day-card-${week2Day}`)).toBeInTheDocument();
  expect(screen.getByTestId(`day-card-${formatDate(addDays(new Date(), 13))}`)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && npm run test:run -- src/components/__tests__/CalendarView.test.tsx 2>&1`
Expected: the new test FAILS — after `dayResolvers[0]` resolves, the replace-style `setDays` drops the week-2 cards.

- [ ] **Step 3: Implement the merge fix**

In `frontend/src/components/CalendarView.tsx`, replace lines 404-413 (`// Split: display range...` through the `setDays(...)` call) with:

```tsx
          // Split: display range gets rendered, rest goes to cache only.
          // Read display bounds from the refs at resolution time and MERGE into
          // existing days — loadNextWeek may have appended more days while this
          // fetch was in flight (replacing would wipe them).
          const displayStartStr = formatDate(displayStartRef.current);
          const displayEndStr = formatDate(displayEndRef.current);
          const displayData = allData.filter(d => d.date >= displayStartStr && d.date <= displayEndStr);
          const renderStart = perfNow();
          setDays(prev => {
            const merged = new Map(prev.map(d => [d.date, d]));
            for (const d of displayData) {
              const existing = merged.get(d.date);
              merged.set(d.date, {
                ...d,
                events: d.events.length > 0 ? d.events : (existing?.events ?? []),
              });
            }
            return Array.from(merged.values()).sort((a, b) => a.date.localeCompare(b.date));
          });
```

(The unused `startStr`/`endStr` filter variables from the old code are gone; `startStr`/`endStr` remain in scope for the cache-first block above — leave those.)

- [ ] **Step 4: Run the CalendarView suite**

Run: `cd frontend && npm run test:run -- src/components/__tests__/CalendarView.test.tsx 2>&1`
Expected: all PASS (new test + no regressions)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CalendarView.tsx frontend/src/components/__tests__/CalendarView.test.tsx
git commit -m "fix: merge initial calendar fetch into displayed days instead of replacing (missing week 2)"
```

---

## Task 3: Stale external calendar events (spec item 2)

The backend refresh loop is healthy; the bug is that `GET /api/days/events` and the `calendar.refreshed` SSE payload omit dates with zero events, and every frontend consumer treats "absent date" as "keep existing" — so deleted upstream events persist in React state and IndexedDB forever. Also wire app-focus to the existing (currently unused) `POST /api/calendar/refresh` with a cooldown.

**Files:**
- Modify: `backend/app/routers/calendar.py:95-98` (broadcast payload)
- Modify: `frontend/src/components/CalendarView.tsx` (~307-309 IDB save loop; ~529-548 `calendar.refreshed` handler)
- Modify: `frontend/src/App.tsx` (~894-899 cache warmer; `broadcastFullRefresh` for the focus-triggered refresh)
- Test: `backend/tests/test_calendar_api.py`, `frontend/src/components/__tests__/CalendarView.test.tsx`

- [ ] **Step 1: Write failing backend test for cache bounds in broadcast**

Add to `backend/tests/test_calendar_api.py` (follow the file's existing import/fixture conventions):

```python
from unittest.mock import AsyncMock, patch


def test_refresh_broadcast_includes_cache_bounds(authenticated_client):
    with patch("app.routers.calendar._refresh_db_cache_sync"), \
         patch("app.routers.calendar._get_events_from_db", return_value=[]), \
         patch("app.routers.calendar.broadcast_event", new_callable=AsyncMock) as mock_broadcast:
        response = authenticated_client.post("/api/calendar/refresh")
        assert response.status_code == 200

    # TestClient runs background tasks before returning
    assert mock_broadcast.call_count == 1
    event_type, payload = mock_broadcast.call_args[0][0], mock_broadcast.call_args[0][1]
    assert event_type == "calendar.refreshed"
    assert "events_by_date" in payload
    assert payload["cache_start"] is not None
    assert payload["cache_end"] is not None
    # ISO date strings, cache_start before cache_end
    assert payload["cache_start"] < payload["cache_end"]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_calendar_api.py -v 2>&1`
Expected: new test FAILS with `KeyError: 'cache_start'`

- [ ] **Step 3: Add cache bounds to the broadcast payload**

In `backend/app/routers/calendar.py`, the function `_do_refresh_and_broadcast` already computes `start, end = _get_cache_range()` (line 60). Change the broadcast call (lines 95-98) to:

```python
        loop.run_until_complete(broadcast_event("calendar.refreshed", {
            "events_by_date": events_by_date,
            "cache_start": start.isoformat(),
            "cache_end": end.isoformat(),
            "last_refresh": last_refresh,
        }))
```

- [ ] **Step 4: Run backend tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_calendar_api.py -v 2>&1`
Expected: all PASS

- [ ] **Step 5: Commit backend half**

```bash
git add backend/app/routers/calendar.py backend/tests/test_calendar_api.py
git commit -m "feat: include cache window bounds in calendar.refreshed broadcast"
```

- [ ] **Step 6: Write failing frontend test for in-window clearing**

Add to `frontend/src/components/__tests__/CalendarView.test.tsx`. The component listens for `meal-planner-realtime` window events (CalendarView.tsx:616) with `detail: { type, payload, source_id }`. Render, wait for day cards, seed an event via the existing `getEvents` mock, then dispatch a `calendar.refreshed` whose `events_by_date` omits that date:

```tsx
it('clears events for in-window dates absent from calendar.refreshed payload', async () => {
  const today = formatDate(new Date());
  vi.mocked(getDays).mockResolvedValue([]);
  vi.mocked(getEvents).mockResolvedValue({
    [today]: [{
      id: 'ev-1', uid: 'uid-1', calendar_name: 'Personal', title: 'Dentist',
      start_time: `${today}T10:00:00`, end_time: `${today}T11:00:00`, all_day: false,
    }],
  });

  render(<CalendarView onTodayRefReady={() => {}} />);
  await waitFor(() => expect(screen.getByTestId(`events-count-${today}`)).toHaveTextContent('1 events'));

  // Upstream deletion: refresh payload covers the window but omits today's date
  const windowStart = formatDate(addDays(new Date(), -28));
  const windowEnd = formatDate(addDays(new Date(), 56));
  await act(async () => {
    window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
      detail: {
        type: 'calendar.refreshed',
        payload: { events_by_date: {}, cache_start: windowStart, cache_end: windowEnd },
        source_id: 'other-client',
      },
    }));
  });

  await waitFor(() => expect(screen.queryByTestId(`events-count-${today}`)).not.toBeInTheDocument());
  // IDB cache cleared for the absent date too
  expect(vi.mocked(saveLocalCalendarEvents)).toHaveBeenCalledWith(today, []);
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd frontend && npm run test:run -- src/components/__tests__/CalendarView.test.tsx 2>&1`
Expected: new test FAILS — the handler keeps existing events for dates absent from the payload.

- [ ] **Step 8: Implement frontend clearing in CalendarView**

(a) In `frontend/src/components/CalendarView.tsx`, replace the IDB save loop inside `loadEventsForRange`'s online branch (lines ~307-309):

```tsx
        // Write every date in the requested range — dates absent from the
        // response have zero events; writing [] clears stale entries left by
        // upstream deletions/moves.
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dateStr = formatDate(d);
          saveLocalCalendarEvents(dateStr, eventsMap[dateStr] ?? []);
        }
```

Note: `new Date(start)` clones so the caller's `start` isn't mutated.

(b) Replace the `calendar.refreshed` branch of the realtime handler (lines ~529-548):

```tsx
      if (detail.type === 'calendar.refreshed') {
        const payload = detail.payload as {
          events_by_date?: Record<string, CalendarEvent[]>;
          cache_start?: string;
          cache_end?: string;
        };
        const eventsByDate = payload?.events_by_date;
        if (!eventsByDate) return;
        const { cache_start: cacheStart, cache_end: cacheEnd } = payload;
        const inWindow = (date: string) =>
          cacheStart !== undefined && cacheEnd !== undefined && date >= cacheStart && date <= cacheEnd;
        // Save all events to IndexedDB for offline access
        for (const [date, events] of Object.entries(eventsByDate)) {
          saveLocalCalendarEvents(date, events);
        }
        // Dates inside the refreshed window but absent from the payload now
        // have zero events — clear their stale IDB entries.
        if (cacheStart && cacheEnd) {
          for (let d = new Date(cacheStart + 'T12:00:00'); formatDate(d) <= cacheEnd; d.setDate(d.getDate() + 1)) {
            const dateStr = formatDate(d);
            if (!(dateStr in eventsByDate)) {
              saveLocalCalendarEvents(dateStr, []);
            }
          }
        }
        // Update display with client-side filtering based on showAllEvents
        setDays(prev => prev.map(day => {
          const dayEvents = eventsByDate[day.date] ?? (inWindow(day.date) ? [] : undefined);
          if (dayEvents !== undefined) {
            const filtered = showAllEventsRef.current
              ? dayEvents
              : dayEvents.filter(event => !hiddenEventKeysRef.current.has(getEventHiddenKey(event)));
            return { ...day, events: filtered };
          }
          // If not in the refreshed data and outside the window, keep existing events
          return day;
        }));
      }
```

- [ ] **Step 9: Run the CalendarView suite**

Run: `cd frontend && npm run test:run -- src/components/__tests__/CalendarView.test.tsx 2>&1`
Expected: all PASS

- [ ] **Step 10: Mirror the clearing in App.tsx cache warmer + add focus-triggered refresh**

(a) In `frontend/src/App.tsx`, find the SSE cache-warmer branch for `calendar.refreshed` (~lines 894-899) and replace it with (match the surrounding try/catch style):

```tsx
          if (detail.type === 'calendar.refreshed') {
            const payload = detail.payload as {
              events_by_date?: Record<string, unknown[]>;
              cache_start?: string;
              cache_end?: string;
            };
            if (payload?.events_by_date) {
              for (const [date, events] of Object.entries(payload.events_by_date)) {
                try { saveLocalCalendarEvents(date, events as never); } catch {}
              }
              if (payload.cache_start && payload.cache_end) {
                for (let d = new Date(payload.cache_start + 'T12:00:00');; d.setDate(d.getDate() + 1)) {
                  const dateStr = d.toISOString().split('T')[0];
                  if (dateStr > payload.cache_end) break;
                  if (!(dateStr in payload.events_by_date)) {
                    try { saveLocalCalendarEvents(dateStr, []); } catch {}
                  }
                }
              }
            }
          }
```

(b) Still in `App.tsx`: import `refreshCalendarCache` from `./api/client`, add module-level state near the top of the file:

```tsx
let lastCalendarFeedRefresh = 0;
const CALENDAR_FEED_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
```

and inside `broadcastFullRefresh` (before or after the `fetchAllData()` call), add:

```tsx
    // Ask the server to re-pull the iCal feed so upstream deletions/moves
    // propagate on app open/focus. Server-side _refresh_in_progress dedupes;
    // the resulting calendar.refreshed SSE updates all clients.
    if (Date.now() - lastCalendarFeedRefresh > CALENDAR_FEED_REFRESH_COOLDOWN_MS) {
      lastCalendarFeedRefresh = Date.now();
      refreshCalendarCache().catch(() => { /* best-effort */ });
    }
```

- [ ] **Step 11: Run the full frontend suite and build**

Run: `cd frontend && npm run test:run 2>&1` — expected: all PASS
Run: `npm run build --prefix frontend 2>&1` — expected: build succeeds (catches TS errors in App.tsx)

- [ ] **Step 12: Commit frontend half**

```bash
git add frontend/src/components/CalendarView.tsx frontend/src/App.tsx frontend/src/components/__tests__/CalendarView.test.tsx
git commit -m "fix: clear stale calendar events for dates absent from refresh payloads; refresh feed on app focus"
```

---

## Task 4: Meal auto-save (spec item 5 — requires Task 1)

DayCard saves on blur/unmount only; a backgrounded/killed PWA with the editor focused loses the edit. Add a 1.5s debounced auto-save plus immediate flush on `visibilitychange`→hidden and `pagehide`.

**Files:**
- Modify: `frontend/src/components/DayCard.tsx` (around `handleNotesChange` line 193, `handleBlur` line 199, unmount effect line 180)
- Create: `frontend/src/components/__tests__/DayCard.autosave.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/__tests__/DayCard.autosave.test.tsx`. Copy the `RichTextEditor` mock, `mockDayData`, and `defaultProps` setup from the top of `DayCard.test.tsx` (the mock renders a `<textarea data-testid="rich-text-editor">`). Check `DayCard.test.tsx` for how existing tests enter edit mode (clicking the meal notes area) and reuse that helper/pattern.

```tsx
describe('DayCard auto-save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderAndEdit(props = defaultProps) {
    render(<DayCard {...props} />);
    // Enter edit mode the same way DayCard.test.tsx does (click on the notes area)
    fireEvent.click(screen.getByText(/Oatmeal/));
    return screen.getByTestId('rich-text-editor');
  }

  it('auto-saves 1.5s after typing stops', async () => {
    const onNotesChange = vi.fn();
    const editor = await renderAndEdit({ ...defaultProps, onNotesChange });
    fireEvent.change(editor, { target: { value: 'Updated meal' } });

    act(() => { vi.advanceTimersByTime(1000); });
    expect(onNotesChange).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(600); });
    expect(onNotesChange).toHaveBeenCalledTimes(1);
    expect(onNotesChange).toHaveBeenCalledWith('Updated meal');
  });

  it('debounce resets while typing continues', async () => {
    const onNotesChange = vi.fn();
    const editor = await renderAndEdit({ ...defaultProps, onNotesChange });
    fireEvent.change(editor, { target: { value: 'a' } });
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.change(editor, { target: { value: 'ab' } });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onNotesChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(600); });
    expect(onNotesChange).toHaveBeenCalledTimes(1);
    expect(onNotesChange).toHaveBeenCalledWith('ab');
  });

  it('flushes immediately when the page is hidden', async () => {
    const onNotesChange = vi.fn();
    const editor = await renderAndEdit({ ...defaultProps, onNotesChange });
    fireEvent.change(editor, { target: { value: 'Half-typed' } });

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    fireEvent(document, new Event('visibilitychange'));

    expect(onNotesChange).toHaveBeenCalledWith('Half-typed');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('flushes on pagehide', async () => {
    const onNotesChange = vi.fn();
    const editor = await renderAndEdit({ ...defaultProps, onNotesChange });
    fireEvent.change(editor, { target: { value: 'Half-typed' } });
    fireEvent(window, new Event('pagehide'));
    expect(onNotesChange).toHaveBeenCalledWith('Half-typed');
  });

  it('does not save when nothing changed', async () => {
    const onNotesChange = vi.fn();
    await renderAndEdit({ ...defaultProps, onNotesChange });
    act(() => { vi.advanceTimersByTime(3000); });
    fireEvent(window, new Event('pagehide'));
    expect(onNotesChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd frontend && npm run test:run -- src/components/__tests__/DayCard.autosave.test.tsx 2>&1`
Expected: the auto-save / visibility / pagehide tests FAIL (no save fires); the "does not save" test passes.

- [ ] **Step 3: Implement in DayCard.tsx**

(a) Near the other refs, add:

```tsx
const AUTOSAVE_DEBOUNCE_MS = 1500;
```

(module-level constant, outside the component) and inside the component:

```tsx
  const autosaveTimerRef = useRef<number | null>(null);

  const flushSave = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (dirtyRef.current) {
      dirtyRef.current = false;
      onNotesChangeRef.current(notesRef.current);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 1500);
    }
  }, []);
```

(b) In `handleNotesChange` (line 193), after `setSaveStatus('saving')` add:

```tsx
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      flushSave();
    }, AUTOSAVE_DEBOUNCE_MS);
```

(c) In `handleBlur` (line 199), replace the `if (dirtyRef.current) { ... }` block with a call to `flushSave();` (keep the spacer/`pendingEditDate` logic below it unchanged).

(d) In the unmount cleanup effect (lines 180-191), add timer cleanup before the existing dirty-save:

```tsx
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current);
      }
```

(e) Add a new effect for visibility/pagehide flushing (only active while editing):

```tsx
  // Flush pending edits when the PWA is backgrounded or the page unloads —
  // blur never fires if the app is killed with the editor focused.
  useEffect(() => {
    if (!isEditing) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flushSave();
    };
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pagehide', flushSave);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isEditing, flushSave]);
```

Note: `dirtyRef`, `notesRef`, `onNotesChangeRef`, and `setSaveStatus` already exist in DayCard.

- [ ] **Step 4: Run the DayCard suites**

Run: `cd frontend && npm run test:run -- src/components/__tests__/DayCard.autosave.test.tsx src/components/__tests__/DayCard.test.tsx src/components/__tests__/DayCard.edge-cases.test.tsx 2>&1`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/DayCard.tsx frontend/src/components/__tests__/DayCard.autosave.test.tsx
git commit -m "feat: auto-save meal edits after 1.5s idle and on page hide"
```

---

## Task 5: Keep edited item visible when the keyboard opens (spec item 1)

On iOS the keyboard opening scrolls the page and hides the inline edit form on grocery/pantry rows. Scroll the form into the visual viewport when editing starts and when the viewport resizes.

**Files:**
- Create: `frontend/src/hooks/useScrollIntoViewOnEdit.ts`
- Create: `frontend/src/hooks/__tests__/useScrollIntoViewOnEdit.test.ts`
- Modify: `frontend/src/components/GroceryListView.tsx` (`GroceryItemRow`, edit form at lines 1285-1340)
- Modify: `frontend/src/components/PantryPanel.tsx` (`PantryItemRow`, edit form at lines 590-617)

- [ ] **Step 1: Write the failing hook test**

Create `frontend/src/hooks/__tests__/useScrollIntoViewOnEdit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollIntoViewOnEdit } from '../useScrollIntoViewOnEdit';

describe('useScrollIntoViewOnEdit', () => {
  const scrollIntoView = vi.fn();
  const ref = { current: { scrollIntoView } as unknown as HTMLElement };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls the element into view shortly after editing starts', () => {
    renderHook(({ editing }) => useScrollIntoViewOnEdit(ref, editing), {
      initialProps: { editing: true },
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('does nothing when not editing', () => {
    renderHook(({ editing }) => useScrollIntoViewOnEdit(ref, editing), {
      initialProps: { editing: false },
    });
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('cancels the pending scroll when editing ends', () => {
    const { rerender } = renderHook(
      ({ editing }) => useScrollIntoViewOnEdit(ref, editing),
      { initialProps: { editing: true } },
    );
    rerender({ editing: false });
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npm run test:run -- src/hooks/__tests__/useScrollIntoViewOnEdit.test.ts 2>&1`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `frontend/src/hooks/useScrollIntoViewOnEdit.ts`:

```ts
import { useEffect, type RefObject } from 'react';

// Keeps an inline edit form visible on mobile: when the iOS keyboard opens it
// shrinks the visual viewport and the browser may scroll the row off-screen.
export function useScrollIntoViewOnEdit(ref: RefObject<HTMLElement | null>, isEditing: boolean) {
  useEffect(() => {
    if (!isEditing) return;

    const scrollIntoView = () => {
      ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    // After the keyboard begins opening / layout settles (same delay DayCard uses)
    const timer = window.setTimeout(scrollIntoView, 350);

    // Re-scroll when the visual viewport resizes (keyboard open/close animation)
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', scrollIntoView);

    return () => {
      window.clearTimeout(timer);
      viewport?.removeEventListener('resize', scrollIntoView);
    };
  }, [isEditing, ref]);
}
```

- [ ] **Step 4: Run hook tests**

Run: `cd frontend && npm run test:run -- src/hooks/__tests__/useScrollIntoViewOnEdit.test.ts 2>&1`
Expected: all PASS

- [ ] **Step 5: Wire into GroceryItemRow and PantryItemRow**

In `frontend/src/components/GroceryListView.tsx`, inside `GroceryItemRow`:
- Import: `import { useScrollIntoViewOnEdit } from '../hooks/useScrollIntoViewOnEdit';`
- Add near the other refs (line ~1226): `const editFormRef = useRef<HTMLDivElement>(null);`
- Add after `isEditing` is derived (line 1220): `useScrollIntoViewOnEdit(editFormRef, isEditing);`
- Add `ref={editFormRef}` to the edit form's outer `<div className="px-4 py-1.5 bg-blue-50 ...">` (line 1288).

In `frontend/src/components/PantryPanel.tsx`, inside `PantryItemRow` (same pattern):
- `const editFormRef = useRef<HTMLDivElement>(null);` next to `nameInputRef` (line 560)
- `useScrollIntoViewOnEdit(editFormRef, isEditing);`
- `ref={editFormRef}` on the edit form `<div className="flex items-center gap-2 px-4 py-1.5 bg-blue-50 ...">` (line 592).

- [ ] **Step 6: Run both component suites + build**

Run: `cd frontend && npm run test:run -- src/components/__tests__/GroceryListView.test.tsx src/components/__tests__/PantryPanel.test.tsx src/components/__tests__/PantryPanel.editing.test.tsx 2>&1`
Expected: all PASS (jsdom lacks `scrollIntoView`/`visualViewport` — the hook guards with `?.`, so existing tests must not crash; if any test fails on `scrollIntoView` being undefined, add `Element.prototype.scrollIntoView = vi.fn()` to that file's setup).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useScrollIntoViewOnEdit.ts frontend/src/hooks/__tests__/useScrollIntoViewOnEdit.test.ts frontend/src/components/GroceryListView.tsx frontend/src/components/PantryPanel.tsx
git commit -m "fix: keep grocery/pantry edit form visible when mobile keyboard opens"
```

---

## Task 6: Change section from the grocery item edit menu (spec item 4)

The edit form exposes name/qty/store only. Add a section combobox; on save with a changed section, move via the existing `moveItem` (undo + offline come free). New section names create the section first.

**Files:**
- Modify: `frontend/src/hooks/useGroceryList.ts` (new exported `createSection`)
- Modify: `frontend/src/components/GroceryListView.tsx` (new `SectionCombobox` component; `GroceryItemRow` edit form; parent wiring)
- Test: `frontend/src/components/__tests__/GroceryListView.sectionedit.test.tsx` (create)

- [ ] **Step 1: Add `createSection` to useGroceryList**

In `frontend/src/hooks/useGroceryList.ts`, add a new function (place near `deleteSection`, ~line 1590). It mirrors the existing restore path in `deleteSection`'s undo (lines 1608-1633) — same temp-ID, IDB, queue, and remap conventions:

```ts
  const createSection = useCallback(async (name: string): Promise<GrocerySection> => {
    const position = sections.length;
    const tempId = generateTempId();
    const newSection: GrocerySection = { id: tempId, name, position, items: [] };

    optimisticVersionRef.current++;
    pendingMutationsRef.current++;
    const nextSections = [...sections, newSection];
    setSections(nextSections);
    await saveLocalGrocerySections(nextSections.map(s => ({ id: s.id, name: s.name, position: s.position })));

    let resultSection = newSection;
    if (isOnlineRef.current) {
      try {
        const created = await createGrocerySectionAPI(name, position);
        remapId(tempId, created.id);
        await saveTempIdMapping(tempId, created.id);
        optimisticVersionRef.current++;
        setSections(prev => prev.map(s => (s.id === tempId ? { ...s, id: created.id } : s)));
        resultSection = { ...newSection, id: created.id };
      } catch {
        await queueChange('grocery-create-section', '', { tempId, name, position });
      }
    } else {
      await queueChange('grocery-create-section', '', { tempId, name, position });
    }
    settleMutation();
    return resultSection;
  }, [sections]);
```

Export it: add `createSection` to the hook's return object (currently `return { sections, loading, mergeList, ... }`).

Check the exact signature of `saveTempIdMapping` used elsewhere in this file (line 1623 uses `saveTempIdMapping(tempId, created.id)`) and match it.

- [ ] **Step 2: Write the failing component test**

Create `frontend/src/components/__tests__/GroceryListView.sectionedit.test.tsx`. GroceryListView calls `useGroceryList()` itself (GroceryListView.tsx:18), so mock the hook module. Copy the mock scaffolding (`useStores`, `useOnlineStatus`, `UndoContext`, etc.) from `GroceryListView.test.tsx` and adjust:

```tsx
const moveItem = vi.fn();
const createSection = vi.fn();
const editItem = vi.fn();

const sections = [
  {
    id: 'sec-produce', name: 'Produce', position: 0,
    items: [{ id: 'item-1', name: 'Apples', quantity: null, checked: false, position: 0, store_id: null }],
  },
  { id: 'sec-dairy', name: 'Dairy', position: 1, items: [] },
];

vi.mock('../../hooks/useGroceryList', () => ({
  useGroceryList: () => ({
    sections, loading: false,
    mergeList: vi.fn(), toggleItem: vi.fn(), addItem: vi.fn(), deleteItem: vi.fn(),
    editItem, clearChecked: vi.fn(), clearAll: vi.fn(), reorderSections: vi.fn(),
    reorderItems: vi.fn(), renameSection: vi.fn(), deleteSection: vi.fn(),
    moveItem, createSection: createSection.mockResolvedValue({ id: 'sec-new', name: 'Frozen', position: 2, items: [] }),
    batchUpdateStoreId: vi.fn(), itemDefaultsMap: new Map(), removeItemDefault: vi.fn(),
  }),
}));

it('moves the item when its section is changed in the edit form', async () => {
  render(<GroceryListView />);
  // Open the edit form (same interaction GroceryListView.test.tsx uses to edit an item)
  fireEvent.click(screen.getByText('Apples'));
  const sectionInput = await screen.findByPlaceholderText('Section');
  fireEvent.change(sectionInput, { target: { value: 'Dairy' } });
  fireEvent.click(screen.getByText('Save'));

  await waitFor(() => {
    expect(moveItem).toHaveBeenCalledWith('sec-produce', 0, 'sec-dairy', 0);
  });
});

it('creates a new section then moves when the name does not match', async () => {
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Apples'));
  const sectionInput = await screen.findByPlaceholderText('Section');
  fireEvent.change(sectionInput, { target: { value: 'Frozen' } });
  fireEvent.click(screen.getByText('Save'));

  await waitFor(() => {
    expect(createSection).toHaveBeenCalledWith('Frozen');
    expect(moveItem).toHaveBeenCalledWith('sec-produce', 0, 'sec-new', 0);
  });
});

it('does not move when the section is unchanged', async () => {
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Apples'));
  await screen.findByPlaceholderText('Section');
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(editItem).not.toHaveBeenCalled());
  expect(moveItem).not.toHaveBeenCalled();
  expect(createSection).not.toHaveBeenCalled();
});
```

Important: check how `GroceryListView.test.tsx` opens an item's edit form (tap/click on the item name row) and mirror it exactly — adjust the `fireEvent.click(screen.getByText('Apples'))` line if the real trigger differs (e.g. it may require `startEditing` via a different element).

- [ ] **Step 3: Run to verify failure**

Run: `cd frontend && npm run test:run -- src/components/__tests__/GroceryListView.sectionedit.test.tsx 2>&1`
Expected: FAIL — no element with placeholder "Section".

- [ ] **Step 4: Implement SectionCombobox + edit form wiring**

(a) In `frontend/src/components/GroceryListView.tsx`, add a module-level component (near `GroceryItemRow`):

```tsx
function SectionCombobox({ sections, value, onChange }: {
  sections: { id: string; name: string }[];
  value: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const sorted = [...sections].sort((a, b) => a.name.localeCompare(b.name));
    const q = value.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(s => s.name.toLowerCase().includes(q));
  }, [sections, value]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        placeholder="Section"
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        className="w-full bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-sm py-0.5 px-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      {open && matches.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 glass-menu rounded-lg shadow-lg z-20 max-h-40 overflow-y-auto">
          {matches.map(s => (
            <button
              key={s.id}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(s.name); setOpen(false); }}
              className="block w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

(b) `GroceryItemRow` changes:
- Add props to `GroceryItemRowProps`: `sectionName: string;`, `allSections: { id: string; name: string }[];`, `onChangeSection: (itemId: string, targetSectionName: string) => void;`
- Add edit state: `const [editSectionName, setEditSectionName] = useState(sectionName);`
- In `startEditing`, add `setEditSectionName(sectionName);`
- In `commitEdit`, after the existing `if (Object.keys(updates).length > 0) { onEdit(...) }`, add:

```tsx
    const trimmedSection = editSectionName.trim();
    if (trimmedSection && trimmedSection.toLowerCase() !== sectionName.toLowerCase()) {
      onChangeSection(item.id, trimmedSection);
    }
```

(and add `editSectionName`, `sectionName`, `onChangeSection` to the `useCallback` deps)
- In the edit form JSX, insert between the name-input row and `<StoreAutocomplete>`:

```tsx
        <SectionCombobox
          sections={allSections}
          value={editSectionName}
          onChange={setEditSectionName}
        />
```

(c) Parent wiring in `GroceryListView`:
- Destructure `createSection` from `useGroceryList()` (line 18).
- Add the handler (near the other item handlers):

```tsx
  const handleChangeItemSection = useCallback(async (itemId: string, targetName: string) => {
    const fromSection = sections.find(s => s.items.some(i => i.id === itemId));
    if (!fromSection) return;
    const fromIndex = fromSection.items.findIndex(i => i.id === itemId);
    const trimmed = toTitleCase(targetName.trim());
    if (!trimmed || trimmed.toLowerCase() === fromSection.name.toLowerCase()) return;

    let target = sections.find(s => s.name.toLowerCase() === trimmed.toLowerCase());
    if (!target) {
      target = await createSection(trimmed);
    }
    // moveItem expects unfiltered indices; append to the end of the target section
    await moveItem(fromSection.id, fromIndex, target.id, target.items.length);
  }, [sections, createSection, moveItem]);
```

(`toTitleCase` is already used in this file for section names — reuse the existing import/helper.)
- Pass to every `<GroceryItemRow ...>` render site: `sectionName={section.name}`, `allSections={sections}`, `onChangeSection={handleChangeItemSection}`.

- [ ] **Step 5: Run the new test + existing grocery suites**

Run: `cd frontend && npm run test:run -- src/components/__tests__/GroceryListView.sectionedit.test.tsx src/components/__tests__/GroceryListView.test.tsx src/components/__tests__/GroceryListView.additional.test.tsx 2>&1`
Expected: all PASS. (Existing GroceryListView tests mock `useGroceryList` — their mock return objects need `createSection: vi.fn()` added if the destructure makes them throw.)

- [ ] **Step 6: Run hook suites (createSection touches useGroceryList)**

Run: `cd frontend && npm run test:run -- src/hooks/__tests__ 2>&1`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/useGroceryList.ts frontend/src/components/GroceryListView.tsx frontend/src/components/__tests__/GroceryListView.sectionedit.test.tsx
git commit -m "feat: change grocery item section from the edit form"
```

---

## Task 7: Configurable meal history retention (spec item 7)

`cleanup_old_data()` (backend/app/main.py:72-87) hard-deletes meal notes older than 30 days at startup. Make the meal-note cutoff configurable via `MEAL_HISTORY_RETENTION_DAYS` (default 365); cached calendar events stay at 30 days.

**Files:**
- Modify: `backend/app/config.py` (Settings class, "# App" block)
- Modify: `backend/app/main.py:72-87`
- Create: `backend/tests/test_cleanup.py`
- Test: `backend/tests/test_config.py` (add default check)

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/test_config.py` (follow the file's existing pattern for constructing `Settings`, including any env isolation it uses):

```python
def test_meal_history_retention_defaults_to_one_year(self):
    settings = Settings()
    assert settings.meal_history_retention_days == 365


def test_meal_history_retention_env_override(self, monkeypatch):
    monkeypatch.setenv("MEAL_HISTORY_RETENTION_DAYS", "30")
    settings = Settings()
    assert settings.meal_history_retention_days == 30
```

Create `backend/tests/test_cleanup.py` (uses the `db_session` fixture; `cleanup_old_data` opens its own `SessionLocal` — check how `backend/tests/conftest.py` binds the test database and follow `test_database.py`'s conventions if direct `SessionLocal` use needs patching):

```python
from datetime import date, timedelta

from app import main as main_module
from app.main import cleanup_old_data
from app.models import CachedCalendarEvent, MealNote


def test_cleanup_uses_retention_setting_for_meal_notes(db_session, monkeypatch):
    monkeypatch.setattr(main_module.settings, "meal_history_retention_days", 100)
    old_note = MealNote(date=date.today() - timedelta(days=101), notes="too old")
    kept_note = MealNote(date=date.today() - timedelta(days=99), notes="kept")
    db_session.add_all([old_note, kept_note])
    db_session.commit()

    cleanup_old_data()

    remaining = {n.notes for n in db_session.query(MealNote).all()}
    assert remaining == {"kept"}


def test_cleanup_keeps_30_day_cutoff_for_cached_events(db_session, monkeypatch):
    from datetime import datetime
    monkeypatch.setattr(main_module.settings, "meal_history_retention_days", 365)
    old_event_date = date.today() - timedelta(days=31)
    kept_event_date = date.today() - timedelta(days=29)
    for event_date, title in [(old_event_date, "old"), (kept_event_date, "kept")]:
        db_session.add(CachedCalendarEvent(
            event_date=event_date,
            event_uid=f"uid-{title}",
            calendar_name="Personal",
            title=title,
            start_time=datetime.combine(event_date, datetime.min.time()),
            end_time=datetime.combine(event_date, datetime.max.time()),
            all_day=True,
        ))
    db_session.commit()

    cleanup_old_data()

    remaining = {e.title for e in db_session.query(CachedCalendarEvent).all()}
    assert remaining == {"kept"}
```

- [ ] **Step 2: Run to verify failures**

Run: `cd backend && .venv/bin/python -m pytest tests/test_cleanup.py tests/test_config.py -v 2>&1`
Expected: config tests FAIL (`Settings` has no `meal_history_retention_days`); `test_cleanup_uses_retention_setting_for_meal_notes` FAILS (notes deleted at 30 days regardless).

- [ ] **Step 3: Implement**

(a) In `backend/app/config.py`, add to the `# App` block of `Settings`:

```python
    meal_history_retention_days: int = 365  # how long to keep past meal notes
```

(b) In `backend/app/main.py`, replace `cleanup_old_data` (lines 72-87) with:

```python
def cleanup_old_data():
    """Delete old meal notes (configurable retention) and stale cached calendar events."""
    db = SessionLocal()
    try:
        notes_cutoff = date.today() - timedelta(days=settings.meal_history_retention_days)
        events_cutoff = date.today() - timedelta(days=30)

        notes_deleted = db.execute(delete(MealNote).where(MealNote.date < notes_cutoff))
        events_deleted = db.execute(
            delete(CachedCalendarEvent).where(CachedCalendarEvent.event_date < events_cutoff)
        )

        db.commit()
        print(
            f"Cleaned up {notes_deleted.rowcount} meal notes older than {notes_cutoff} "
            f"and {events_deleted.rowcount} cached events older than {events_cutoff}"
        )
    finally:
        db.close()
```

(`settings = get_settings()` already exists at main.py:26.)

- [ ] **Step 4: Run the tests**

Run: `cd backend && .venv/bin/python -m pytest tests/test_cleanup.py tests/test_config.py -v 2>&1`
Expected: all PASS

- [ ] **Step 5: Document the env var**

Add `MEAL_HISTORY_RETENTION_DAYS` to wherever existing env vars are documented — check for a `.env.example` or README section listing `POSTGRES_*`/`OIDC_*`; if none exists, skip this step.

- [ ] **Step 6: Commit**

```bash
git add backend/app/config.py backend/app/main.py backend/tests/test_cleanup.py backend/tests/test_config.py
git commit -m "feat: configurable meal history retention via MEAL_HISTORY_RETENTION_DAYS (default 1 year)"
```

---

## Final verification

- [ ] Run the full suite: `bash run-tests.sh` — everything green.
- [ ] Browser verification (items 1, 4, 5 — UI behaviors tests can't fully cover): start the dev stack per CLAUDE.md "Preview / Local Dev Auth" (uvicorn from project root with `--app-dir backend`, `OIDC_ISSUER=` empty, frontend dev server; sign in via `/api/auth/dev-login`). With mobile viewport emulation:
  - Grocery + pantry: tap edit on an item far down the list — the form scrolls to center and stays visible.
  - Grocery edit form: change an item's section (existing + brand-new name) — item moves; undo restores it.
  - Meals: type a meal, wait ~2s without tapping done — "Saved" indicator appears and the meal persists on reload; background the tab mid-edit and verify the save fires.
  - Meals: check an itemized box, edit that meal's text, add another meal — the box stays checked.
- [ ] Use superpowers:finishing-a-development-branch to wrap up.
