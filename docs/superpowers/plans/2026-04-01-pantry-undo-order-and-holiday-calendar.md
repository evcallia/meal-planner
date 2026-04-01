# Pantry Undo Order Preservation & Holiday Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix pantry section delete undo to restore sections at their original position, and add a US holiday calendar feed with a settings toggle (default: enabled).

**Architecture:** Feature 1 captures the deleted section's index and splices it back on undo instead of appending. Feature 2 adds a `showHolidays` setting (client-side, default true), passes `include_holidays` query param to the backend, and the backend fetches/parses Google's public US holidays iCal feed, caching results in the existing `cached_calendar_events` table with `calendar_name = "US Holidays"`.

**Tech Stack:** React, TypeScript, FastAPI, SQLAlchemy, icalendar (Python), localStorage settings

---

## File Structure

### Feature 1: Pantry Undo Order
- **Modify:** `frontend/src/hooks/usePantry.ts` — capture original index, splice on undo
- **Modify:** `frontend/src/hooks/__tests__/usePantry.undo.test.ts` — test order preservation

### Feature 2: Holiday Calendar
- **Modify:** `frontend/src/hooks/useSettings.ts` — add `showHolidays` to Settings interface
- **Modify:** `frontend/src/components/SettingsModal.tsx` — add holiday toggle UI
- **Modify:** `frontend/src/components/CalendarView.tsx` — pass `include_holidays` param
- **Modify:** `frontend/src/api/client.ts` — add `includeHolidays` param to `getEvents`
- **Modify:** `backend/app/ical_service.py` — add holiday feed fetching & caching
- **Modify:** `backend/app/routers/days.py` — accept `include_holidays` query param
- **Modify:** `backend/app/routers/calendar.py` — include holidays in cache refresh broadcast

---

## Task 1: Pantry section delete undo preserves original position

**Files:**
- Modify: `frontend/src/hooks/usePantry.ts:684-741`
- Modify: `frontend/src/hooks/__tests__/usePantry.undo.test.ts:223-238`

- [ ] **Step 1: Update the undo test to assert position preservation**

In `frontend/src/hooks/__tests__/usePantry.undo.test.ts`, update the existing `deleteSection undo restores the section` test to check the restored section appears at its original index:

```typescript
it('deleteSection undo restores the section at original position', async () => {
  mockDeleteSectionAPI.mockResolvedValue({ status: 'ok' });
  mockCreateSectionAPI.mockResolvedValue({ id: 'restored-s1', name: 'Fridge', position: 0, items: [] });
  mockAddAPI.mockImplementation(async (_sectionId, name, quantity) => ({
    id: `restored-${name}`, section_id: 'restored-s1', name, quantity, position: 0, updated_at: '2026-01-03T00:00:00Z',
  }));

  const { result } = renderHook(() => usePantry());
  await waitFor(() => expect(result.current.sections).toHaveLength(2));

  // Capture original order: s1 (Fridge) at index 0, s2 (Pantry) at index 1
  expect(result.current.sections[0].id).toBe('s1');
  expect(result.current.sections[1].id).toBe('s2');

  // Delete first section
  await act(async () => { await result.current.deleteSection('s1'); });
  expect(result.current.sections).toHaveLength(1);
  expect(result.current.sections[0].id).toBe('s2');

  // Undo — should restore at index 0, not append to end
  await act(async () => { await pushActionCalls[0].undo(); });
  expect(result.current.sections).toHaveLength(2);
  expect(result.current.sections[0].name).toBe('Fridge');
  expect(result.current.sections[1].id).toBe('s2');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/hooks/__tests__/usePantry.undo.test.ts -t "deleteSection undo restores the section" 2>&1`

Expected: FAIL — restored section appears at index 1 (appended to end) instead of index 0.

- [ ] **Step 3: Implement order-preserving undo in usePantry.ts**

In `frontend/src/hooks/usePantry.ts`, in the `deleteSection` function (around line 684), capture the original index and use it in both the online and offline undo paths:

Change:
```typescript
  const deleteSection = useCallback(async (sectionId: string) => {
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const deletedSection = { ...section, items: [...section.items] };
    const sectionRef = { id: sectionId };
```

To:
```typescript
  const deleteSection = useCallback(async (sectionId: string) => {
    const section = sections.find(s => s.id === sectionId);
    if (!section) return;

    const deletedSection = { ...section, items: [...section.items] };
    const originalIndex = sections.indexOf(section);
    const sectionRef = { id: sectionId };
```

Then change the online undo path from:
```typescript
            optimisticVersionRef.current++;
            setSections(prev => [...prev, { ...created, items: restoredItems }]);
```

To:
```typescript
            optimisticVersionRef.current++;
            setSections(prev => {
              const next = [...prev];
              const insertAt = Math.min(originalIndex, next.length);
              next.splice(insertAt, 0, { ...created, items: restoredItems });
              return next.map((s, i) => ({ ...s, position: i }));
            });
```

And change the offline undo path from:
```typescript
          setSections(prev => [...prev, deletedSection]);
```

To:
```typescript
          setSections(prev => {
            const next = [...prev];
            const insertAt = Math.min(originalIndex, next.length);
            next.splice(insertAt, 0, deletedSection);
            return next.map((s, i) => ({ ...s, position: i }));
          });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/hooks/__tests__/usePantry.undo.test.ts -t "deleteSection undo restores the section" 2>&1`

Expected: PASS

- [ ] **Step 5: Run all pantry undo tests to check for regressions**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/hooks/__tests__/usePantry.undo.test.ts 2>&1`

Expected: All tests pass.

- [ ] **Step 6: Also run the reorder API call after online undo to sync position**

After the undo restores the section at the correct position, call `reorderPantrySectionsAPI` to persist the new order on the server. In the online undo path, after `setSections`, add the reorder call.

Change the online undo `try` block to:
```typescript
          try {
            const created = await createPantrySectionAPI(deletedSection.name);
            sectionRef.id = created.id;
            const restoredItems: PantryItem[] = [];
            for (const item of deletedSection.items) {
              const createdItem = await addPantryItemAPI(created.id, item.name, item.quantity);
              restoredItems.push(createdItem);
            }
            optimisticVersionRef.current++;
            let reorderIds: string[] = [];
            setSections(prev => {
              const next = [...prev];
              const insertAt = Math.min(originalIndex, next.length);
              next.splice(insertAt, 0, { ...created, items: restoredItems });
              const reindexed = next.map((s, i) => ({ ...s, position: i }));
              reorderIds = reindexed.map(s => s.id);
              return reindexed;
            });
            await reorderPantrySectionsAPI(reorderIds);
          } catch { /* queue */ }
```

Make sure `reorderPantrySectionsAPI` is imported in `usePantry.ts` (check if it already is — it likely is since drag-and-drop uses it).

- [ ] **Step 7: Run all pantry tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/hooks/__tests__/usePantry.undo.test.ts frontend/src/hooks/__tests__/usePantry.test.ts frontend/src/hooks/__tests__/usePantry.additional.test.ts frontend/src/hooks/__tests__/usePantry.offline.test.ts frontend/src/hooks/__tests__/usePantry.api-errors.test.ts 2>&1`

Expected: All tests pass.

- [ ] **Step 8: Commit**

```
feat: preserve section order when undoing pantry section delete
```

---

## Task 2: Add `showHolidays` setting to frontend

**Files:**
- Modify: `frontend/src/hooks/useSettings.ts`

- [ ] **Step 1: Add `showHolidays` to the Settings interface and defaults**

In `frontend/src/hooks/useSettings.ts`:

Add `showHolidays: boolean` to the `Settings` interface:
```typescript
export interface Settings {
  showItemizedColumn: boolean;
  showMealIdeas: boolean;
  compactView: boolean;
  textScaleStandard: number;
  textScaleCompact: number;
  showAllEvents: boolean;
  showHolidays: boolean;
}
```

Add to `DEFAULT_SETTINGS`:
```typescript
const DEFAULT_SETTINGS: Settings = {
  showItemizedColumn: true,
  showMealIdeas: true,
  compactView: false,
  textScaleStandard: 1,
  textScaleCompact: 1,
  showAllEvents: false,
  showHolidays: true,
};
```

- [ ] **Step 2: Commit**

```
feat: add showHolidays setting (default true)
```

---

## Task 3: Add holiday toggle to Settings Modal

**Files:**
- Modify: `frontend/src/components/SettingsModal.tsx`

- [ ] **Step 1: Add the holiday toggle in SettingsModal**

In `frontend/src/components/SettingsModal.tsx`, add a "US Holidays" toggle in the calendar/events section, just before the "Hidden Events" section (before the `<div className="pt-2 border-t ...">` that contains "Show All Events"). Use the same toggle pattern as the existing `showAllEvents` toggle:

```tsx
{/* US Holidays */}
<div className="pt-2 border-t border-gray-200 dark:border-gray-700">
  <label className="flex items-center justify-between gap-3 cursor-pointer">
    <div className="flex-1 min-w-0">
      <span className="text-gray-900 dark:text-gray-100 font-medium">US Holidays</span>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Show US holidays on the calendar
      </p>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={settings.showHolidays}
      onClick={() => onUpdate({ showHolidays: !settings.showHolidays })}
      className={`
        flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors
        ${settings.showHolidays ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
      `}
    >
      <span
        className={`
          inline-block h-4 w-4 transform rounded-full bg-white transition-transform
          ${settings.showHolidays ? 'translate-x-6' : 'translate-x-1'}
        `}
      />
    </button>
  </label>
</div>
```

- [ ] **Step 2: Commit**

```
feat: add US Holidays toggle to settings modal
```

---

## Task 4: Backend holiday feed fetching and caching

**Files:**
- Modify: `backend/app/ical_service.py`

- [ ] **Step 1: Add holiday feed constants and fetcher to ical_service.py**

At the top of `backend/app/ical_service.py`, after the existing constants (around line 35), add:

```python
# US Holidays iCal feed (Google public calendar)
US_HOLIDAYS_ICAL_URL = "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics"
US_HOLIDAYS_CALENDAR_NAME = "US Holidays"

# In-memory cache for holiday feed (avoid re-fetching on every request)
_holidays_cache: tuple[float, list[CalendarEventWithSource]] = (0, [])
HOLIDAYS_CACHE_TTL = 86400  # 24 hours — holidays don't change often
```

Add a new function to fetch and parse the holiday iCal feed:

```python
import urllib.request

def _fetch_holidays_sync(start_date: date, end_date: date) -> list[CalendarEventWithSource]:
    """Fetch US holidays from Google's public iCal feed."""
    global _holidays_cache
    now = time.time()

    cached_time, cached_events = _holidays_cache
    if cached_events and (now - cached_time) < HOLIDAYS_CACHE_TTL:
        # Filter cached events to requested range
        return [
            e for e in cached_events
            if start_date <= e.event.start_time.date() <= end_date
        ]

    _log("[Holidays] Fetching US holidays from Google...")
    t1 = time.time()

    try:
        req = urllib.request.Request(US_HOLIDAYS_ICAL_URL, headers={"User-Agent": "meal-planner/1.0"})
        with urllib.request.urlopen(req, timeout=15) as response:
            ical_data = response.read()

        cal = Calendar.from_ical(ical_data)
        all_events: list[CalendarEventWithSource] = []

        for component in cal.walk():
            if component.name != "VEVENT":
                continue

            dtstart = component.get("dtstart")
            dtend = component.get("dtend")
            summary = str(component.get("summary", ""))
            uid = component.get("uid")

            if not dtstart:
                continue

            event_start = _parse_ical_date(dtstart)
            event_end = _parse_ical_date(dtend) if dtend else None
            event_uid = _normalize_uid(
                str(uid) if uid is not None else None,
                US_HOLIDAYS_CALENDAR_NAME,
                event_start,
                summary,
            )

            event = CalendarEvent(
                id=_event_key(event_uid, US_HOLIDAYS_CALENDAR_NAME, event_start),
                uid=event_uid,
                calendar_name=US_HOLIDAYS_CALENDAR_NAME,
                title=summary,
                start_time=event_start,
                end_time=event_end,
                all_day=_is_all_day(component),
            )
            all_events.append(CalendarEventWithSource(event, US_HOLIDAYS_CALENDAR_NAME))

        all_events.sort(key=lambda e: e.event.start_time)
        _holidays_cache = (now, all_events)

        t2 = time.time()
        _log(f"[Holidays] Fetched {len(all_events)} holidays in {t2-t1:.2f}s")

        return [
            e for e in all_events
            if start_date <= e.event.start_time.date() <= end_date
        ]

    except Exception as e:
        _log(f"[Holidays] Error fetching holidays: {e}")
        return []
```

- [ ] **Step 2: Cache holidays in the DB alongside CalDAV events**

In `_refresh_db_cache_sync()`, after caching CalDAV events and before `_prune_hidden_events`, add holiday caching:

```python
        # Fetch and cache holiday events
        holiday_events = _fetch_holidays_sync(start, end)
        # Delete old holiday cache in this range
        db.query(CachedCalendarEvent).filter(
            CachedCalendarEvent.event_date >= start,
            CachedCalendarEvent.event_date <= end,
            CachedCalendarEvent.calendar_name == US_HOLIDAYS_CALENDAR_NAME,
        ).delete()
        for event_with_source in holiday_events:
            event = event_with_source.event
            cached_event = CachedCalendarEvent(
                event_date=event.start_time.date(),
                event_uid=event.uid or "",
                calendar_name=US_HOLIDAYS_CALENDAR_NAME,
                title=event.title,
                start_time=event.start_time,
                end_time=event.end_time,
                all_day=event.all_day,
            )
            db.add(cached_event)
        events_with_source.extend(holiday_events)
```

Wait — the existing `_refresh_db_cache_sync` deletes *all* cached events in the range first, then inserts CalDAV events. We need to be careful: the initial delete wipes holiday events too. The simplest fix: after inserting CalDAV events, also insert holiday events. Since the delete already cleared the range, we just need to add them.

Actually, looking more carefully at the code: the delete on line 315-318 deletes ALL cached events in the range (no calendar_name filter). So holidays would get deleted too. Then we insert CalDAV events. We just need to also insert holiday events afterward. No need for a separate delete. Updated approach:

After the CalDAV event insertion loop (after line 332), add:

```python
        # Also cache US holiday events
        holiday_events = _fetch_holidays_sync(start, end)
        for event_with_source in holiday_events:
            event = event_with_source.event
            cached_event = CachedCalendarEvent(
                event_date=event.start_time.date(),
                event_uid=event.uid or "",
                calendar_name=US_HOLIDAYS_CALENDAR_NAME,
                title=event.title,
                start_time=event.start_time,
                end_time=event.end_time,
                all_day=event.all_day,
            )
            db.add(cached_event)
```

- [ ] **Step 3: Modify `fetch_ical_events` to accept `include_holidays` param**

Update the signature of `fetch_ical_events`:

```python
async def fetch_ical_events(
    start_date: date,
    end_date: date,
    include_hidden: bool = False,
    include_holidays: bool = True,
) -> list[CalendarEvent]:
```

At the end, before returning, filter out holiday events if `include_holidays` is False. Add a helper filter after `maybe_filter`:

```python
    def maybe_filter_holidays(events: list[CalendarEvent]) -> list[CalendarEvent]:
        if include_holidays:
            return events
        return [e for e in events if e.calendar_name != US_HOLIDAYS_CALENDAR_NAME]
```

Apply `maybe_filter_holidays` after `maybe_filter` in each return path. The cleanest approach: compose them. Replace the existing `maybe_filter` with:

```python
    def apply_filters(events: list[CalendarEvent]) -> list[CalendarEvent]:
        if not include_hidden:
            events = _filter_hidden_events(events, start_date, end_date)
        if not include_holidays:
            events = [e for e in events if e.calendar_name != US_HOLIDAYS_CALENDAR_NAME]
        return events
```

Then replace all `maybe_filter(...)` calls with `apply_filters(...)`.

- [ ] **Step 4: Also handle holidays in `_fetch_and_cache_events_sync`**

In `_fetch_and_cache_events_sync` (used for partial cache misses), after caching CalDAV events, also cache holiday events for that range:

After the CalDAV event insertion loop, add:

```python
        # Also cache holidays for this range
        holiday_events = _fetch_holidays_sync(start_date, end_date)
        for event_with_source in holiday_events:
            event = event_with_source.event
            cached_event = CachedCalendarEvent(
                event_date=event.start_time.date(),
                event_uid=event.uid or "",
                calendar_name=US_HOLIDAYS_CALENDAR_NAME,
                title=event.title,
                start_time=event.start_time,
                end_time=event.end_time,
                all_day=event.all_day,
            )
            db.add(cached_event)
```

And update the return to include holiday events:

```python
    return [e.event for e in events_with_source] + [e.event for e in holiday_events]
```

- [ ] **Step 5: Commit**

```
feat: add US holiday feed fetching and caching in ical_service
```

---

## Task 5: Wire `include_holidays` through the API endpoints

**Files:**
- Modify: `backend/app/routers/days.py:93-115`

- [ ] **Step 1: Add `include_holidays` query param to `/api/days/events`**

In `backend/app/routers/days.py`, update the `get_events` endpoint:

```python
@router.get("/events", response_model=dict[str, list[CalendarEvent]])
async def get_events(
    start_date: date = Query(...),
    end_date: date = Query(...),
    include_hidden: bool = Query(False),
    include_holidays: bool = Query(True),
    user: dict = Depends(get_current_user),
):
    """Get calendar events for a date range (separate endpoint for lazy loading)."""
    t1 = time.time()
    events = await fetch_ical_events(start_date, end_date, include_hidden=include_hidden, include_holidays=include_holidays)
    t2 = time.time()
    _log(f"[CalDAV] fetch_ical_events ({start_date} to {end_date}, include_hidden={include_hidden}, include_holidays={include_holidays}) completed in {t2-t1:.3f}s")
```

The rest of the endpoint stays the same.

- [ ] **Step 2: Also update the `get_days` endpoint to pass through `include_holidays`**

In `get_days`, add the `include_holidays` query param and pass it through:

```python
@router.get("", response_model=list[DayData])
async def get_days(
    start_date: date = Query(...),
    end_date: date = Query(...),
    include_events: bool = Query(default=False),
    include_holidays: bool = Query(default=True),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
```

And update the events fetch:
```python
    if include_events:
        events = await fetch_ical_events(start_date, end_date, include_holidays=include_holidays)
```

- [ ] **Step 3: Commit**

```
feat: add include_holidays query param to days API endpoints
```

---

## Task 6: Wire `showHolidays` through frontend API and CalendarView

**Files:**
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/components/CalendarView.tsx`

- [ ] **Step 1: Add `includeHolidays` param to `getEvents` in client.ts**

Find the `getEvents` function in `frontend/src/api/client.ts` and add the parameter:

```typescript
export async function getEvents(
  startDate: string,
  endDate: string,
  includeHidden: boolean = false,
  includeHolidays: boolean = true,
): Promise<Record<string, CalendarEvent[]>> {
  return fetchAPI<Record<string, CalendarEvent[]>>(
    `/days/events?start_date=${startDate}&end_date=${endDate}&include_hidden=${includeHidden}&include_holidays=${includeHolidays}`
  );
}
```

- [ ] **Step 2: Add `showHolidays` prop to CalendarView and pass it to `getEvents`**

In `frontend/src/components/CalendarView.tsx`, add to the props interface:

```typescript
interface CalendarViewProps {
  onTodayRefReady: (ref: HTMLDivElement | null) => void;
  showItemizedColumn?: boolean;
  compactView?: boolean;
  showAllEvents?: boolean;
  showHolidays?: boolean;
}
```

Destructure it from props (default `true`):
```typescript
const { onTodayRefReady, showItemizedColumn, compactView, showAllEvents, showHolidays = true } = props;
```

Find where `getEvents` is called in the component and pass `showHolidays`:
```typescript
const eventsMap = await getEvents(startStr, endStr, false, showHolidays);
```

Add `showHolidays` to the dependency array of the effect that fetches events so it refetches when the toggle changes.

- [ ] **Step 3: Pass `showHolidays` from App.tsx (or wherever CalendarView is rendered)**

Find where `CalendarView` is rendered and pass `settings.showHolidays`:

```tsx
<CalendarView
  ...
  showHolidays={settings.showHolidays}
/>
```

- [ ] **Step 4: Commit**

```
feat: wire showHolidays setting through frontend to API
```

---

## Task 7: Include holidays in calendar cache refresh broadcast

**Files:**
- Modify: `backend/app/routers/calendar.py`

- [ ] **Step 1: Ensure holiday events are included in the `calendar.refreshed` SSE broadcast**

In `backend/app/routers/calendar.py`, the refresh endpoint calls `_refresh_db_cache_sync()` which now caches holidays. The broadcast reads from the DB cache, so holidays will naturally be included if they're in `cached_calendar_events`. Verify this by reading the refresh endpoint code and confirming the broadcast pulls from the DB after refresh.

If the broadcast constructs `events_by_date` by calling `fetch_ical_events`, holidays will be included by default since `include_holidays` defaults to `True`. No changes should be needed — just verify.

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/evan.callia/Desktop/meal-planner && bash run-tests.sh 2>&1`

Expected: All tests pass.

- [ ] **Step 3: Commit if any changes were needed**

```
feat: ensure holidays included in calendar refresh broadcast
```

---

## Task 8: Final integration verification

- [ ] **Step 1: Run all frontend tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npm run test:run 2>&1`

Expected: All tests pass.

- [ ] **Step 2: Run all backend tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && .venv/bin/python -m pytest tests/ 2>&1`

Expected: All tests pass.

- [ ] **Step 3: Build frontend**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npm run build 2>&1`

Expected: Build succeeds with no TypeScript errors.
