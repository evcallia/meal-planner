# Meal Reorder Drag & Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable drag-and-drop reordering of meals within a day and precise-position moves between days, replacing the existing HTML5 drag-and-drop system with the `useDragReorder` hook pattern.

**Architecture:** Each DayCard gets a `useDragReorder` instance for its meal lines. CalendarView bridges cross-day moves using the same `crossDrag` state pattern as GroceryListView's cross-section drag. The existing HTML5 drag/drop system (MealItem draggable, DayCard drop zone) is removed.

**Tech Stack:** React, useDragReorder hook (existing), TypeScript

---

### Task 1: Update MealItem to remove HTML5 drag and accept useDragReorder handlers

**Files:**
- Modify: `frontend/src/components/MealItem.tsx`

- [ ] **Step 1: Remove HTML5 drag props and add useDragReorder handler props**

Replace the props interface and component signature. Remove `onDragStart`/`onDragEnd` callbacks (HTML5 drag), add `dragHandleMouseDown` for the desktop grip handle. Remove the `handleDragStart`/`handleDragEnd` callbacks, the touch-based long-press drag logic (lines 85-112 — the `setTimeout` that calls `onDragStart` on long-press), and the `draggable`/`onDragStart`/`onDragEnd` attributes from the outer div. Keep the swipe-to-delete touch handling.

```typescript
// Props: remove these:
//   onDragStart?: (date: string, lineIndex: number, html: string) => void;
//   onDragEnd?: () => void;
// Add this:
//   dragHandleMouseDown?: (e: React.MouseEvent) => void;
```

In the component body:
- Remove `handleDragStart` callback (lines 54-78)
- Remove `handleDragEnd` callback (lines 80-82)
- In `handleTouchStart`: remove the long-press `setTimeout` block (lines 102-109) that calls `onDragStart`
- On the outer `<div ref={dragRef}>`: remove `draggable`, `onDragStart={handleDragStart}`, `onDragEnd={handleDragEnd}`. Remove `cursor-grab active:cursor-grabbing` from className
- On the drag handle SVG wrapper div (line 235): add `onMouseDown={dragHandleMouseDown}` and add `cursor-grab active:cursor-grabbing` classes (move grab cursor to handle only)

- [ ] **Step 2: Run tests**

Run: `npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend`
Expected: Tests pass (MealItem tests, DayCard tests may need updates for removed props)

- [ ] **Step 3: Fix any test failures from removed props**

Update test files that pass `onDragStart`/`onDragEnd` to MealItem to remove those props.

- [ ] **Step 4: Commit**

```
feat: remove HTML5 drag from MealItem, add useDragReorder handle support
```

---

### Task 2: Update DayCard to use useDragReorder for meal lines

**Files:**
- Modify: `frontend/src/components/DayCard.tsx`

- [ ] **Step 1: Replace HTML5 drag props with useDragReorder callbacks**

Update `DayCardProps` interface — remove the old drag props and add new ones:

```typescript
// Remove:
//   onDragStart?: (date: string, lineIndex: number, html: string) => void;
//   onDragEnd?: () => void;
//   onDrop?: (targetDate: string, sourceDate: string, lineIndex: number, html: string) => void;
//   isDragActive?: boolean;
//   dragSourceDate?: string | null;

// Add:
  onMealReorder?: (date: string, fromIndex: number, toIndex: number) => void;
  onMealDropOutside?: (date: string, fromIndex: number, clientY: number) => void;
  onMealDragMove?: (date: string, fromIndex: number, clientY: number) => void;
  onMealDragStart?: () => void;
  onMealDragEnd?: () => void;
  crossDragTargetIndex?: number | null;  // insertion index when this card is a cross-drag target
  crossDragItemHeight?: number;
```

- [ ] **Step 2: Add useDragReorder hook instance**

Import `useDragReorder` and add it inside the DayCard component. Add a container ref for the meal lines.

```typescript
import { useDragReorder } from '../hooks/useDragReorder';

// Inside DayCard component:
const mealContainerRef = useRef<HTMLDivElement>(null);

const { dragState: mealDragState, getDragHandlers: getMealDragHandlers, getHandleMouseDown: getMealHandleMouseDown } = useDragReorder({
  itemCount: lines.length,
  onReorder: (fromIndex, toIndex) => onMealReorder?.(day.date, fromIndex, toIndex),
  containerRef: mealContainerRef,
  onDragStart: onMealDragStart,
  onDragEnd: onMealDragEnd,
  onDropOutside: (fromIndex, clientY) => onMealDropOutside?.(day.date, fromIndex, clientY),
  onDragMove: (fromIndex, clientY) => onMealDragMove?.(day.date, fromIndex, clientY),
});
```

- [ ] **Step 3: Remove HTML5 drop zone handlers**

Remove `handleDragOver`, `handleDragLeave`, `handleDropEvent`, `isDragOver` state, and `isValidDropTarget` computed value. Remove `onDragOver`/`onDragLeave`/`onDrop` attributes from both compact and standard view outer divs.

- [ ] **Step 4: Update standard view meal rendering**

Add `data-day-date` attribute to the card's outer div (for cross-day target detection). Wrap meal lines in a container with `ref={mealContainerRef}` and `data-meal-container`. Add `data-drag-index` to each MealItem wrapper. Pass `getDragHandlers` (touch) and `getMealHandleMouseDown` (mouse) to each MealItem. Add shift transforms for non-dragged items during drag.

```tsx
<div data-day-date={day.date} className="...existing classes...">
  {/* ... events, header, etc ... */}
  <div ref={mealContainerRef} data-meal-container>
    {lines.map((line, i) => {
      // Compute shift transform for non-dragged items
      let style: React.CSSProperties | undefined;
      if (mealDragState.isDragging && mealDragState.dragIndex !== i) {
        const { dragIndex, overIndex, itemHeight } = mealDragState;
        if (dragIndex < overIndex && i > dragIndex && i <= overIndex) {
          style = { transform: `translateY(-${itemHeight}px)`, transition: 'transform 200ms ease' };
        } else if (dragIndex > overIndex && i < dragIndex && i >= overIndex) {
          style = { transform: `translateY(${itemHeight}px)`, transition: 'transform 200ms ease' };
        }
      }
      // Cross-drag insertion indicator
      const showInsertBefore = !mealDragState.isDragging && crossDragTargetIndex === i;
      const showInsertAfter = !mealDragState.isDragging && crossDragTargetIndex === lines.length && i === lines.length - 1;

      return (
        <div key={i} data-drag-index={i} style={style} {...getMealDragHandlers(i)}>
          {showInsertBefore && <div className="h-0.5 bg-blue-500 rounded -mt-px" />}
          <MealItem
            html={line}
            itemized={itemsMap.get(i) || false}
            onToggle={() => { ... }}
            onTextClick={enterEditMode}
            onDelete={onDeleteMeal ? () => onDeleteMeal(i) : undefined}
            mealTargetDate={mealTargetAttr}
            showHeader={i === 0}
            showItemizedColumn={showItemizedColumn}
            lineIndex={i}
            date={day.date}
            dragHandleMouseDown={getMealHandleMouseDown(i)}
          />
          {showInsertAfter && <div className="h-0.5 bg-blue-500 rounded mt-px" />}
        </div>
      );
    })}
  </div>
  {/* Cross-drag: insertion line when card is empty and is target */}
  {lines.length === 0 && crossDragTargetIndex === 0 && (
    <div className="h-0.5 bg-blue-500 rounded my-1" />
  )}
</div>
```

- [ ] **Step 5: Update compact view meal rendering**

Same changes as standard view: wrap in `mealContainerRef`/`data-meal-container`, add `data-drag-index`, pass drag handlers, add shift transforms and insertion indicators.

- [ ] **Step 6: Add cross-day hover highlight**

When `crossDragTargetIndex` is not null (this card is a cross-drag target), add a visual ring:

```tsx
className={`
  ...existing...
  ${crossDragTargetIndex !== null ? 'ring-2 ring-blue-500 border-blue-500' : ''}
`}
```

- [ ] **Step 7: Run tests**

Run: `npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend`
Fix any failures from changed props.

- [ ] **Step 8: Commit**

```
feat: add useDragReorder to DayCard for meal line reordering
```

---

### Task 3: Add within-day reorder handler in CalendarView

**Files:**
- Modify: `frontend/src/components/CalendarView.tsx`

- [ ] **Step 1: Add handleMealReorder function**

Add a handler for within-day meal reordering. This splices lines, remaps itemized indices, calls the API, and supports undo.

```typescript
const handleMealReorder = useCallback(async (date: string, fromIndex: number, toIndex: number) => {
  if (fromIndex === toIndex) return;
  const day = days.find(d => d.date === date);
  if (!day) return;

  const currentNotes = day.meal_note?.notes || '';
  const currentItems = [...(day.meal_note?.items || [])];
  const lines = splitHtmlLines(currentNotes);
  if (fromIndex < 0 || fromIndex >= lines.length) return;

  // Reorder lines
  const [moved] = lines.splice(fromIndex, 1);
  lines.splice(toIndex, 0, moved);
  const newNotes = joinHtmlLines(lines);

  // Remap itemized indices: build old index → itemized map, then remap
  const itemizedByOldIndex = new Map(currentItems.map(item => [item.line_index, item.itemized]));
  const oldIndices = Array.from({ length: lines.length + 1 }, (_, i) => i);
  // Compute the mapping: after removing fromIndex and inserting at toIndex
  oldIndices.splice(fromIndex, 1);
  oldIndices.splice(toIndex, 0, fromIndex);
  // newItems[newIdx] = itemizedByOldIndex[oldIndices[newIdx]]
  const newItems: { line_index: number; itemized: boolean }[] = [];
  for (let newIdx = 0; newIdx < lines.length; newIdx++) {
    const oldIdx = oldIndices[newIdx];
    const wasItemized = itemizedByOldIndex.get(oldIdx);
    if (wasItemized !== undefined) {
      newItems.push({ line_index: newIdx, itemized: wasItemized });
    }
  }

  // Push undo
  pushAction({
    type: 'reorder-meal',
    undo: async () => { await restoreNotesAndItems(date, currentNotes, currentItems); },
    redo: async () => { await restoreNotesAndItems(date, newNotes, newItems); },
  });

  // Optimistic update
  setDays(prev => prev.map(d => {
    if (d.date !== date) return d;
    const updated = {
      ...d,
      meal_note: d.meal_note
        ? { ...d.meal_note, notes: newNotes, items: newItems }
        : { id: '', date, notes: newNotes, items: newItems, updated_at: new Date().toISOString() },
    };
    daysCache.current.set(date, updated);
    return updated;
  }));

  await saveLocalNote(date, newNotes, newItems);

  if (isOnline) {
    try {
      await updateNotes(date, newNotes);
      await Promise.all(newItems.map(item =>
        toggleItemized(date, item.line_index, item.itemized).catch(err =>
          console.warn(`Failed to sync itemized state for ${date} line ${item.line_index}:`, err)
        )
      ));
    } catch {
      await queueChange('notes', date, { notes: newNotes });
    }
  } else {
    await queueChange('notes', date, { notes: newNotes });
  }
}, [days, isOnline, pushAction]);
```

- [ ] **Step 2: Run tests**

Run: `npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend`
Expected: Passes (handler isn't wired up yet).

- [ ] **Step 3: Commit**

```
feat: add handleMealReorder for within-day meal reordering
```

---

### Task 4: Add cross-day drag bridging in CalendarView

**Files:**
- Modify: `frontend/src/components/CalendarView.tsx`

- [ ] **Step 1: Add crossDrag state and findMealDropTarget helper**

```typescript
const [crossDrag, setCrossDrag] = useState<{
  sourceDate: string;
  targetDate: string;
  targetIndex: number;
  itemHeight: number;
} | null>(null);

const findMealDropTarget = useCallback((sourceDate: string, clientY: number) => {
  const dayEls = document.querySelectorAll('[data-day-date]');
  for (const el of dayEls) {
    const date = (el as HTMLElement).dataset.dayDate;
    if (!date || date === sourceDate) continue;
    const rect = el.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      const mealContainer = el.querySelector('[data-meal-container]');
      let targetIndex = 0;
      let itemHeight = 36;
      if (mealContainer) {
        const itemEls = mealContainer.querySelectorAll(':scope > [data-drag-index]');
        targetIndex = itemEls.length;
        for (let i = 0; i < itemEls.length; i++) {
          const itemRect = itemEls[i].getBoundingClientRect();
          if (itemRect.height > 0) {
            itemHeight = itemRect.height;
            if (clientY < itemRect.top + itemRect.height / 2) {
              targetIndex = i;
              break;
            }
          }
        }
      }
      return { date, targetIndex, itemHeight };
    }
  }
  return null;
}, []);
```

- [ ] **Step 2: Add handleMealDragMove and handleMealDragEnd**

```typescript
const handleMealDragMove = useCallback((sourceDate: string, _fromIndex: number, clientY: number) => {
  const target = findMealDropTarget(sourceDate, clientY);
  setCrossDrag(prev => {
    if (!target) return prev ? null : prev;
    if (prev?.targetDate === target.date && prev?.targetIndex === target.targetIndex) return prev;
    return { sourceDate, targetDate: target.date, targetIndex: target.targetIndex, itemHeight: target.itemHeight };
  });
}, [findMealDropTarget]);

const handleMealDragEnd = useCallback(() => {
  setCrossDrag(null);
}, []);
```

- [ ] **Step 3: Update handleMoveMeal to accept a target insertion index**

Modify the existing `handleMoveMeal` to insert at a specific position rather than always appending. Change the signature:

```typescript
const handleMoveMeal = useCallback(async (
  targetDate: string, sourceDate: string, lineIndex: number, html: string, insertAt?: number
) => {
```

Replace the section that adds line to target (around line 1116-1121):

```typescript
// Add line to target at the specified position (or end)
const targetNotes = targetDay?.meal_note?.notes || '';
const targetLines = splitHtmlLines(targetNotes);
const newTargetLineIndex = insertAt !== undefined ? Math.min(insertAt, targetLines.length) : targetLines.length;
targetLines.splice(newTargetLineIndex, 0, html);
const newTargetNotes = joinHtmlLines(targetLines);

// Update target items: shift existing items at or after insertion point, add moved item
const targetItems = targetDay?.meal_note?.items || [];
const newTargetItems = targetItems.map(item => ({
  ...item,
  line_index: item.line_index >= newTargetLineIndex ? item.line_index + 1 : item.line_index,
}));
if (wasItemized) {
  newTargetItems.push({ line_index: newTargetLineIndex, itemized: true });
}
```

- [ ] **Step 4: Add handleMealDropOutside**

```typescript
const handleMealDropOutside = useCallback((sourceDate: string, fromIndex: number, clientY: number) => {
  const target = findMealDropTarget(sourceDate, clientY);
  setCrossDrag(null);
  if (!target) return;

  const day = days.find(d => d.date === sourceDate);
  if (!day) return;
  const lines = splitHtmlLines(day.meal_note?.notes || '');
  if (fromIndex < 0 || fromIndex >= lines.length) return;
  const html = decodeHtmlEntities(lines[fromIndex]);

  handleMoveMeal(target.date, sourceDate, fromIndex, html, target.targetIndex);
}, [days, findMealDropTarget, handleMoveMeal]);
```

Import `decodeHtmlEntities` from `../utils/html` at the top of the file if not already imported.

- [ ] **Step 5: Run tests**

Run: `npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend`

- [ ] **Step 6: Commit**

```
feat: add cross-day drag bridging with precise insertion positioning
```

---

### Task 5: Wire up DayCard props in CalendarView and remove old drag system

**Files:**
- Modify: `frontend/src/components/CalendarView.tsx`

- [ ] **Step 1: Remove old drag state and handlers**

Remove:
- `isDragActive` state (line 188)
- `dragSourceDate` state (line 189)
- `handleDragStart` callback (lines 1069-1072)
- `handleDragEnd` callback (lines 1074-1077)

These are replaced by `useDragReorder` instances in each DayCard and the `crossDrag` state.

- [ ] **Step 2: Add handleMealDragStart callback**

```typescript
const handleMealDragStart = useCallback(() => {
  setCrossDrag(null);
}, []);
```

- [ ] **Step 3: Update DayCard rendering to use new props**

```tsx
{days.map(day => (
  <div key={day.date} data-date={day.date} ref={day.date === today ? handleTodayRef : undefined}>
    <DayCard
      day={day}
      isToday={day.date === today}
      onNotesChange={(notes) => handleNotesChange(day.date, notes)}
      onToggleItemized={(lineIndex, itemized) => handleToggleItemized(day.date, lineIndex, itemized)}
      onHideEvent={handleHideEvent}
      eventsLoading={loadingEvents && day.events.length === 0}
      showItemizedColumn={showItemizedColumn}
      compactView={compactView}
      showAllEvents={showAllEvents}
      onMealReorder={handleMealReorder}
      onMealDropOutside={handleMealDropOutside}
      onMealDragMove={handleMealDragMove}
      onMealDragStart={handleMealDragStart}
      onMealDragEnd={handleMealDragEnd}
      crossDragTargetIndex={crossDrag?.targetDate === day.date ? crossDrag.targetIndex : null}
      crossDragItemHeight={crossDrag?.targetDate === day.date ? crossDrag.itemHeight : undefined}
      onDeleteMeal={(lineIndex) => handleDeleteMeal(day.date, lineIndex)}
      holidayColor={holidayColor}
      calendarColor={calendarColor}
    />
  </div>
))}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend`
Fix any failures from removed/changed props in CalendarView tests and DayCard tests.

- [ ] **Step 5: Build check**

Run: `npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend`
Expected: Clean build, no TypeScript errors.

- [ ] **Step 6: Commit**

```
feat: wire up meal drag-and-drop, remove old HTML5 drag system
```

---

### Task 6: Run all tests and fix issues

**Files:**
- Modify: test files as needed

- [ ] **Step 1: Run full frontend test suite**

Run: `npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend`

- [ ] **Step 2: Run full backend test suite**

Run: `bash /Users/evan.callia/Desktop/meal-planner/run-tests.sh --skip-deps --backend-only`

- [ ] **Step 3: Fix any failures**

Common expected fixes:
- DayCard tests passing old drag props (`onDragStart`, `onDragEnd`, `onDrop`, `isDragActive`, `dragSourceDate`)
- CalendarView tests referencing `handleMoveMeal` with old 4-arg signature (now has optional 5th arg `insertAt`)
- MealItem tests passing `onDragStart`/`onDragEnd` props

- [ ] **Step 4: Build verification**

Run: `npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend`
Expected: Clean build.

- [ ] **Step 5: Commit**

```
fix: update tests for new meal drag-and-drop system
```
