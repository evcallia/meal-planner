# Meal Reorder via Drag & Drop

## Problem

Meals within a day cannot be reordered. The existing cross-day move always appends to the end of the target day. Users want to reorder meals within a day and drop at a specific position when moving between days.

## Solution

Extend the existing `useDragReorder` hook (used by grocery/pantry) to meal lines within each DayCard. A cross-day bridging layer in CalendarView — following the same pattern as GroceryListView's cross-section drag — enables dragging meals between days with precise insertion positioning.

The existing HTML5 drag-and-drop for cross-day moves is replaced by this unified system.

## Data Flow & API

No new backend endpoints. The existing `PUT /api/days/{date}/notes` accepts reordered HTML and reindexes itemized status via content matching. Since reordering preserves all line content (just at different indices), the backend's content matcher handles this correctly.

**Within-day reorder:**
1. Split `notes` into HTML lines
2. Splice to reorder
3. Rejoin via `joinHtmlLines`
4. Call `updateNotes(date, newNotes)`
5. Backend reindexes `MealItem` records by content matching

**Cross-day move:**
1. Remove line from source day's notes, insert at target position in target day's notes
2. Call `updateNotes` for both source and target days
3. Backend reindexes items for both days

Both paths push undo actions with before/after snapshots of notes and items.

## DayCard Changes

Each DayCard with meal lines gets a `useDragReorder` instance:
- Meal lines container gets a `ref`
- Each MealItem gets `data-drag-index={lineIndex}`
- Desktop: grip handle icon on each meal line (`onMouseDown` for immediate drag)
- Mobile: long-press (300ms) on the meal line itself

DayCard exposes callbacks to CalendarView:
- `onMealReorder(date, fromIndex, toIndex)` — within-day reorder completed
- `onDropOutside(date, fromIndex, clientY)` — dragged outside day bounds
- `onDragMove(date, fromIndex, clientY)` — live position during drag
- `onDragStart()` / `onDragEnd()` — drag lifecycle

The existing HTML5 `draggable`/`onDragStart` attributes on MealItem are removed since `useDragReorder` handles both touch and mouse.

## CalendarView Cross-Day Bridging

Follows the same cross-section pattern as GroceryListView. CalendarView maintains `crossDrag` state tracking source day/index and current hover position.

**During drag (`onDragMove`):**
1. Query `[data-day-date]` elements to find which day the cursor is over
2. If different day, query that day's `[data-meal-container]` children rects to compute insertion index
3. Update visual indicators (day highlight, insertion line)

**On drop (`onDropOutside`):**
1. Detect target day and insertion index (same rect logic as onDragMove)
2. Remove meal line from source day's notes (splice + rejoin HTML)
3. Insert at computed position in target day's notes
4. Capture moved line's itemized status, remap indices for both days
5. Call `updateNotes` for both days
6. Push undo action with before/after snapshots of both days
7. Offline: queue changes via `queueChange`

**Within-day reorder (`onMealReorder`):**
1. Split notes into lines, reorder via splice
2. Rejoin HTML, remap itemized indices to match new order
3. Call `updateNotes` for that day
4. Push undo action
5. Offline: queue change via `queueChange`

## Visual Feedback

- **Ghost element**: Clone of the meal line follows cursor/finger (standard useDragReorder behavior)
- **Within-day**: Non-dragged items shift with `translateY` to show insertion point
- **Cross-day hover**: Target day gets a subtle highlight (ring/border); horizontal insertion line appears between meals at the computed drop position
- **Source day**: Shows gap where the item was removed
- **Drag handles**: Desktop shows grip icon (`cursor-grab active:cursor-grabbing`); mobile uses long-press on the entire meal line

## Undo/Redo

Both within-day reorder and cross-day move push undo actions with full before/after snapshots of `notes` and `items` for all affected days. Undo/redo calls `updateNotes` to persist, following the existing pattern used by delete-meal and move-meal.

## Files to Modify

- **`DayCard.tsx`**: Add `useDragReorder` instance, `data-drag-index` attributes, drag handle UI, expose callbacks
- **`MealItem.tsx`**: Add drag handle icon for desktop, remove HTML5 `draggable`/`onDragStart`/`onDragEnd`
- **`CalendarView.tsx`**: Add cross-day bridging (crossDrag state, onDragMove/onDropOutside handlers), within-day reorder handler. Remove existing HTML5 cross-day move logic (`handleMoveMeal`, `handleDragStart`, drag state, related drop handlers)
- **`DayCard.tsx`**: Remove HTML5 drop zone (`onDragOver`/`onDrop`/`handleDropEvent`), replaced by useDragReorder + CalendarView bridging. Add insertion line indicator and day highlight styles for cross-day hover
