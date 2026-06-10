# Bugfix Batch — June 2026 — Design

Seven small bugs/changes, designed together, implementable independently.

## 1. Keep edited item visible when keyboard opens (grocery + pantry)

**Symptom:** On mobile (iOS PWA), tapping edit on a grocery or pantry item opens the
keyboard, the page scrolls, and the edit input ends up off-screen. Focus is retained
but the user can't see what they're typing.

**Fix:** Scroll the edit form into the visual viewport when a row enters edit mode.

- New shared hook `useScrollIntoViewOnEdit(ref, isEditing)` in `frontend/src/hooks/`:
  - When `isEditing` becomes true, call `ref.current.scrollIntoView({ block: 'center', behavior: 'smooth' })`
  - Also listen for `visualViewport` `resize` events while editing (keyboard open/close
    animation changes the visual viewport) and re-scroll the form into view
  - Remove the listener when editing ends or on unmount
- Use it in `GroceryItemRow` (GroceryListView.tsx) and `PantryItemRow` (PantryPanel.tsx),
  with the ref on the edit form container.

**Rejected alternative:** DayCard-style focus-proxy + spacer system — built for a
full-screen editor, far heavier than a one-row inline form needs.

**Verification:** in-browser (mobile viewport emulation); no unit test (DOM scroll behavior).

## 2. Stale external calendar events

**Symptom:** Events deleted or moved in the upstream iCal calendar keep showing in the app.

**Root cause:** `_refresh_db_cache_sync()` (backend/app/ical_service.py) correctly
delete-and-reinserts the rolling cache window (-4/+8 weeks), but only runs when the
24h TTL expires. Rows outside the rolling window are never reconciled.

**Fix:**
- Shorten the feed-refresh cooldown from 24h to **15 minutes** (module constant in
  `ical_service.py`). Refresh remains request-driven, so feed traffic stays low; the
  existing `broadcastFullRefresh` on app focus/reopen re-requests events, which now
  triggers a fresh feed pull if the cache is older than 15 min.
- During each cache refresh, also delete `cached_calendar_events` rows **outside** the
  rolling window (event_date < window start or > window end), so ancient rows can't
  resurface. (The 30-day cached-events startup cleanup in main.py stays as a backstop;
  see item 7.)

**Tests (pytest):** refresh prunes out-of-window rows; cache served within cooldown;
re-fetch after cooldown expiry.

## 3. Itemized checkboxes reset on meal edit/add

**Symptom:** Editing a meal's text unchecks its itemized checkbox; even adding a new
meal to a day resets other meals' checkboxes.

**Root cause:** `PUT /api/days/{date}/notes` (backend/app/routers/days.py:143-167)
deletes all `MealItem` rows and re-matches checkbox state by normalized line *content*:
duplicate lines clobber each other in the dict, and any text change defaults that line
to `itemized=False`.

**Fix:** Replace content-matching with sequence alignment using
`difflib.SequenceMatcher` over the old and new line lists (normalized: HTML-stripped,
trimmed, lowercased):

- `equal` opcode blocks → carry itemized state by position (adding, deleting, or
  reordering other meals never resets unchanged lines)
- `replace` opcode blocks → carry state positionally within the block, pairing old/new
  lines in order while both sides last (a meal whose text was edited in place keeps its
  checkbox; if the block sizes differ, unpaired new lines default to unchecked)
- `insert` → new lines unchecked; `delete` → state dropped

**Tests (pytest):** append meal preserves others; reorder preserves; single-line edit
preserves that line's state; duplicate line text handled; insert+edit combined;
deleted line's state dropped.

## 4. Change section from grocery item edit menu

**Current:** The inline edit form (GroceryListView.tsx `GroceryItemRow`) exposes
name, quantity, store — section changes are drag-and-drop only.

**Fix:**
- Add the section combobox (same component/behavior as the quick-add form: filters
  existing sections, creates a new section for unmatched input, alphabetical) to the
  edit form, pre-populated with the item's current section.
- On save with a changed section:
  - Existing target: resolve the item's and target's **unfiltered** indices (same
    pattern as `handleItemDropOutside`) and call the existing `moveItem(fromSectionId,
    fromIndex, toSectionId, toIndex)`, appending to the end of the target section's
    unchecked items. Undo/redo and offline queueing come free via `moveItem`.
  - New section name: create the section first (existing create path from quick-add),
    then `moveItem` into it.
- Name/qty/store edits continue through `editItem` unchanged; if both field edits and
  a section change occur, apply `editItem` first, then `moveItem`.

**Tests (vitest):** save with changed section calls moveItem with correct unfiltered
indices; unchanged section does not call moveItem; new-section path creates then moves.

## 5. Meal auto-save

**Current:** DayCard saves on blur and unmount only. If the PWA is backgrounded or
killed with the editor focused, no blur fires and the edit is lost.

**Fix (in DayCard.tsx):**
- Debounced auto-save: ~1.5s after typing stops, flush `notesRef.current` through the
  existing `onNotesChange` path. Skip if content unchanged since last save (track last
  saved value to avoid redundant PUTs).
- Flush immediately on `visibilitychange` → hidden and on `pagehide` while editing.
- Blur/unmount save behavior unchanged; iOS keyboard "done" unchanged.
- Depends on #3: mid-edit auto-saves no longer reset itemized state.

**Tests (vitest):** debounce fires once after typing stops; no save when unchanged;
visibilitychange flush; pagehide flush.

## 6. Missing second week on meals tab

**Symptom:** Often the meals tab shows only the current week; next week's day cards are
entirely absent until refresh.

**Root cause:** Race in CalendarView.tsx init (lines ~405-413). Sequence: init renders
week 1 from IndexedDB → infinite scroll fires `loadNextWeek`, appending week 2 and
advancing `displayEndRef` → init's API response resolves and **replaces** `days` with
only the mount-time range (week 1), wiping week 2 — while `displayEndRef` still points
at week 2's end, so infinite scroll never reloads it.

**Fix:** In the init's API-response handler:
- Compute the display range from `displayStartRef.current` / `displayEndRef.current`
  **at resolution time**, not the values captured at mount.
- **Merge** the filtered API data into existing `days` (same `existingMap` + sort
  pattern as `addDaysToDisplay`) instead of replacing the array, preserving the
  per-day events fallback for days the API response lacks events for.

**Tests (vitest):** simulate loadNextWeek completing before the init fetch resolves —
both weeks present afterward; events fallback preserved.

## 7. Configurable meal history retention

**Current:** `cleanup_old_data()` (backend/app/main.py:72-87) runs at startup and
deletes `MealNote` and `CachedCalendarEvent` rows older than a hard-coded 30 days.

**Fix:**
- New pydantic setting in `config.py`: `MEAL_HISTORY_RETENTION_DAYS`, int, default **365**.
- `cleanup_old_data()` uses it for the `MealNote` cutoff.
- `CachedCalendarEvent` cutoff stays at 30 days — it's a feed cache (item 2 adds
  in-refresh pruning); retaining a year of cached events serves no purpose.

**Tests (pytest):** custom env value respected; default 365 when unset; events cutoff
unaffected.

## Cross-cutting notes

- Items are independent except #5's dependence on #3 (implement #3 first).
- No schema migrations required.
- Offline behavior: #4 reuses existing offline-queued `moveItem`/section-create paths;
  #5's auto-save flows through the existing queue-on-offline `onNotesChange` path.
- All frontend changes follow existing optimistic-update patterns; no new change types
  in `db.ts` are needed.
