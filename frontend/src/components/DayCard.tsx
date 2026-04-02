import { useState, useEffect, useRef } from 'react';
import { DayData } from '../types';
import { MealItem } from './MealItem';
import { decodeHtmlEntities } from '../utils/html';
import { RichTextEditor } from './RichTextEditor';
import { useDragReorder } from '../hooks/useDragReorder';

interface DayCardProps {
  day: DayData;
  isToday: boolean;
  onNotesChange: (notes: string) => void;
  onToggleItemized: (lineIndex: number, itemized: boolean) => void;
  onHideEvent?: (event: DayData['events'][number]) => void;
  eventsLoading?: boolean;
  showItemizedColumn?: boolean;
  compactView?: boolean;
  showAllEvents?: boolean;
  onMealReorder?: (date: string, fromIndex: number, toIndex: number) => void;
  onMealDropOutside?: (date: string, fromIndex: number, clientY: number) => void;
  onMealDragMove?: (date: string, fromIndex: number, clientY: number) => void;
  onMealDragStart?: () => void;
  onMealDragEnd?: () => void;
  crossDragTargetIndex?: number | null;
  crossDragItemHeight?: number;
  onDeleteMeal?: (lineIndex: number) => void;
  holidayColor?: string;
  calendarColor?: string;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDate(dateString: string, compact = false): { dayName: string; dateDisplay: string; isWeekend: boolean } {
  const date = new Date(dateString + 'T12:00:00');
  const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
  return {
    dayName: date.toLocaleDateString('en-US', { weekday: compact ? 'short' : 'long' }),
    dateDisplay: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
  };
}

// Event color presets — maps setting value to Tailwind classes
const EVENT_COLORS: Record<string, { text: string; textDark: string; textStrong: string; textStrongDark: string; bg: string; bgDark: string; border: string; borderDark: string; hover: string; hoverDark: string }> = {
  red:    { text: 'text-red-700',    textDark: 'dark:text-red-400',    textStrong: 'text-red-800',    textStrongDark: 'dark:text-red-200',    bg: 'bg-red-50',    bgDark: 'dark:bg-red-900/20',    border: 'border-red-100',    borderDark: 'dark:border-red-800/30',    hover: 'hover:bg-red-100/80',    hoverDark: 'dark:hover:bg-red-900/40' },
  blue:   { text: 'text-blue-700',   textDark: 'dark:text-blue-400',   textStrong: 'text-blue-800',   textStrongDark: 'dark:text-blue-200',   bg: 'bg-blue-50',   bgDark: 'dark:bg-blue-900/20',   border: 'border-blue-100',   borderDark: 'dark:border-blue-800/30',   hover: 'hover:bg-blue-100/80',   hoverDark: 'dark:hover:bg-blue-900/40' },
  green:  { text: 'text-green-700',  textDark: 'dark:text-green-400',  textStrong: 'text-green-800',  textStrongDark: 'dark:text-green-200',  bg: 'bg-green-50',  bgDark: 'dark:bg-green-900/20',  border: 'border-green-100',  borderDark: 'dark:border-green-800/30',  hover: 'hover:bg-green-100/80',  hoverDark: 'dark:hover:bg-green-900/40' },
  purple: { text: 'text-purple-700', textDark: 'dark:text-purple-400', textStrong: 'text-purple-800', textStrongDark: 'dark:text-purple-200', bg: 'bg-purple-50', bgDark: 'dark:bg-purple-900/20', border: 'border-purple-100', borderDark: 'dark:border-purple-800/30', hover: 'hover:bg-purple-100/80', hoverDark: 'dark:hover:bg-purple-900/40' },
  pink:   { text: 'text-pink-700',   textDark: 'dark:text-pink-400',   textStrong: 'text-pink-800',   textStrongDark: 'dark:text-pink-200',   bg: 'bg-pink-50',   bgDark: 'dark:bg-pink-900/20',   border: 'border-pink-100',   borderDark: 'dark:border-pink-800/30',   hover: 'hover:bg-pink-100/80',   hoverDark: 'dark:hover:bg-pink-900/40' },
  amber:  { text: 'text-amber-700',  textDark: 'dark:text-amber-400',  textStrong: 'text-amber-800',  textStrongDark: 'dark:text-amber-200',  bg: 'bg-amber-50',  bgDark: 'dark:bg-amber-900/20',  border: 'border-amber-100',  borderDark: 'dark:border-amber-800/30',  hover: 'hover:bg-amber-100/80',  hoverDark: 'dark:hover:bg-amber-900/40' },
};

function isHolidayEvent(event: { calendar_name?: string | null }): boolean {
  return event.calendar_name === 'US Holidays';
}

// Split HTML content into lines, preserving HTML tags within each line
function splitHtmlLines(html: string): string[] {
  // Replace <br>, <br/>, <br /> with newlines, then split
  // Also handle <div> and <p> blocks which browsers sometimes use for new lines
  const normalized = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>\s*<div>/gi, '\n')
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '');

  return normalized.split('\n').filter(line => {
    // Check if line has actual content (not just empty tags)
    const textContent = line.replace(/<[^>]*>/g, '').trim();
    return textContent.length > 0;
  });
}

const LONG_PRESS_MS = 350;
const DOUBLE_TAP_MS = 250;
const MOVE_THRESHOLD = 12;

// Module-level state for cross-card editor switching.
// Set by a global touchstart/mousedown listener that fires before blur.
let pendingEditDate: string | null = null;

// Detect taps on meal click-targets early (before blur can fire) by using
// a capturing listener on the document.  Works on iOS Safari where
// component-level onPointerDown may not fire before blur.
if (typeof window !== 'undefined') {
  const handler = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Walk up from the touch target to find a meal click-target marker
    const mealTarget = target.closest('[data-meal-target]') as HTMLElement | null;
    if (mealTarget) {
      pendingEditDate = mealTarget.getAttribute('data-meal-target');
    }
  };
  // Capture phase ensures this runs before any blur handler.
  document.addEventListener('touchstart', handler, { capture: true, passive: true });
  document.addEventListener('mousedown', handler, { capture: true });
}

export function DayCard({
  day,
  isToday,
  onNotesChange,
  onToggleItemized,
  onHideEvent,
  eventsLoading,
  showItemizedColumn = true,
  compactView = false,
  showAllEvents = false,
  onMealReorder,
  onMealDropOutside,
  onMealDragMove,
  onMealDragStart,
  onMealDragEnd,
  crossDragTargetIndex,
  onDeleteMeal,
  holidayColor = 'red',
  calendarColor = 'amber',
}: DayCardProps) {
  const normalizeNotes = (value?: string | null) => decodeHtmlEntities(value ?? '');
  const [notes, setNotes] = useState(() => normalizeNotes(day.meal_note?.notes));
  const [isEditing, setIsEditing] = useState(false);
  // Height of the editor when it was open, used to hold a spacer during
  // collapse so cards below don't shift and swallow the pending click.
  const [collapseHeight, setCollapseHeight] = useState<number | null>(null);
  const editorWrapperRef = useRef<HTMLDivElement>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [contextMenu, setContextMenu] = useState<{ event: DayData['events'][number]; x: number; y: number } | null>(null);
  const dirtyRef = useRef(false);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const onNotesChangeRef = useRef(onNotesChange);
  onNotesChangeRef.current = onNotesChange;
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const longPressTriggeredRef = useRef(false);
  const focusProxyRef = useRef<HTMLTextAreaElement>(null);

  const { dayName, dateDisplay, isWeekend } = formatDate(day.date, compactView);

  // Build items map from meal_note
  const itemsMap = new Map<number, boolean>();
  day.meal_note?.items.forEach(item => {
    itemsMap.set(item.line_index, item.itemized);
  });

  // Parse lines for display (now handles HTML)
  const lines = splitHtmlLines(notes);

  // Drag reorder for meal lines
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

  // Sync notes when day data changes (e.g., from server)
  useEffect(() => {
    if (!isEditing) {
      setNotes(normalizeNotes(day.meal_note?.notes));
    }
  }, [day.meal_note?.notes, isEditing]);

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
      // Save unsaved changes on unmount (e.g., navigating away)
      if (dirtyRef.current) {
        dirtyRef.current = false;
        onNotesChangeRef.current(notesRef.current);
      }
    };
  }, []);

  const handleNotesChange = (value: string) => {
    setNotes(value);
    dirtyRef.current = true;
    setSaveStatus('saving');
  };

  const handleBlur = () => {
    // Save unsaved changes on blur
    if (dirtyRef.current) {
      dirtyRef.current = false;
      onNotesChange(notesRef.current);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 1500);
    }

    // If the user tapped another card's meal area, hold a spacer at the
    // editor's current height so cards below don't shift and swallow the
    // pending click event.  The spacer is removed once the target card's
    // enterEditMode clears it, or after a safety timeout.
    if (pendingEditDate && pendingEditDate !== day.date) {
      const h = editorWrapperRef.current?.offsetHeight ?? null;
      setIsEditing(false);
      if (h) {
        setCollapseHeight(h);
        // Safety: clear the spacer after 300ms in case the click never fires.
        setTimeout(() => setCollapseHeight(null), 300);
      }
    } else {
      setIsEditing(false);
    }
  };

  const enterEditMode = () => {
    // Focus proxy textarea synchronously within the tap/click handler so
    // mobile browsers open the virtual keyboard immediately.
    focusProxyRef.current?.focus();
    setIsEditing(true);
    // Clear any spacer held by the previously-editing card.
    pendingEditDate = null;
    window.dispatchEvent(new CustomEvent('meal-planner-clear-spacer'));
  };

  // Listen for spacer-clear requests from the card that just entered edit mode.
  useEffect(() => {
    const handleClearSpacer = () => {
      setCollapseHeight(null);
    };
    window.addEventListener('meal-planner-clear-spacer', handleClearSpacer);
    return () => {
      window.removeEventListener('meal-planner-clear-spacer', handleClearSpacer);
    };
  }, []);

  // data-meal-target attribute value for click targets in this card.
  // A global touchstart/mousedown listener reads this to set pendingEditDate
  // before blur fires (see module-level code above).
  const mealTargetAttr = day.date;

  const isSameEvent = (a: DayData['events'][number], b: DayData['events'][number]) => {
    if (a.id && b.id) return a.id === b.id;
    const aKey = `${a.uid ?? ''}|${a.start_time ?? ''}|${a.title ?? ''}`;
    const bKey = `${b.uid ?? ''}|${b.start_time ?? ''}|${b.title ?? ''}`;
    return aKey === bKey;
  };

  const openEventActionsFromTarget = (event: DayData['events'][number], target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    openEventActions(event, rect.left, rect.top + rect.height / 2);
  };

  const openEventActions = (event: DayData['events'][number], x: number, y: number) => {
    if (!onHideEvent) return;
    const menuWidth = 200;
    const menuHeight = 52;
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - menuWidth - margin);
    const maxY = Math.max(margin, window.innerHeight - menuHeight - margin);
    const preferredLeft = x - menuWidth - margin;
    const preferredRight = x + margin;
    const resolvedX = preferredLeft >= margin
      ? preferredLeft
      : Math.min(Math.max(preferredRight, margin), maxX);
    setContextMenu({
      event,
      x: resolvedX,
      y: Math.min(Math.max(y, margin), maxY),
    });
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }
    longPressTimerRef.current = null;
    touchStartRef.current = null;
  };

  const startLongPress = (event: DayData['events'][number], x: number, y: number) => {
    if (!onHideEvent) return;
    clearLongPress();
    touchStartRef.current = { x, y };
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      openEventActions(event, x, y);
    }, LONG_PRESS_MS);
  };

  const handleTapEnd = (event: DayData['events'][number], x: number, y: number) => {
    if (!onHideEvent) return;
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      lastTapRef.current = null;
      return;
    }
    const now = Date.now();
    const lastTap = lastTapRef.current;
    if (lastTap) {
      const delta = now - lastTap.time;
      const dx = x - lastTap.x;
      const dy = y - lastTap.y;
      if (delta <= DOUBLE_TAP_MS && Math.hypot(dx, dy) <= MOVE_THRESHOLD) {
        lastTapRef.current = null;
        openEventActions(event, x, y);
        return;
      }
    }
    lastTapRef.current = { x, y, time: now };
  };

  type TouchLike = { clientX: number; clientY: number };
  type TouchListLike = { length: number; item?: (index: number) => TouchLike | null; [index: number]: TouchLike | undefined };
  const getTouchPoint = (touches?: TouchListLike | null) => {
    if (!touches || touches.length === 0) return null;
    const touch = touches.item ? touches.item(0) ?? touches[0] : touches[0];
    if (!touch) return null;
    return { x: touch.clientX, y: touch.clientY };
  };

  const createEventGestureHandlers = (event: DayData['events'][number]) => {
    if (!onHideEvent) return {};
    return {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        if ((e.target as HTMLElement | null)?.closest('button[aria-label="Event options"]')) return;
        e.preventDefault();
        startLongPress(event, e.clientX, e.clientY);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        if (!touchStartRef.current) return;
        const dx = e.clientX - touchStartRef.current.x;
        const dy = e.clientY - touchStartRef.current.y;
        if (Math.hypot(dx, dy) > MOVE_THRESHOLD) {
          clearLongPress();
        }
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (e.pointerType !== 'touch') return;
        clearLongPress();
        handleTapEnd(event, e.clientX, e.clientY);
      },
      onPointerCancel: () => {
        clearLongPress();
      },
      onTouchStart: (e: React.TouchEvent) => {
        if ((e.target as HTMLElement | null)?.closest('button[aria-label="Event options"]')) return;
        const point = getTouchPoint(e.touches);
        if (!point) return;
        startLongPress(event, point.x, point.y);
      },
      onTouchMove: (e: React.TouchEvent) => {
        const point = getTouchPoint(e.touches);
        if (!point || !touchStartRef.current) return;
        const dx = point.x - touchStartRef.current.x;
        const dy = point.y - touchStartRef.current.y;
        if (Math.hypot(dx, dy) > MOVE_THRESHOLD) {
          clearLongPress();
        }
      },
      onTouchEnd: (e: React.TouchEvent) => {
        const point = getTouchPoint(e.changedTouches);
        clearLongPress();
        if (point) {
          handleTapEnd(event, point.x, point.y);
        }
      },
      onTouchCancel: () => {
        clearLongPress();
      },
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
      },
    };
  };

  useEffect(() => {
    if (!contextMenu) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target || !contextMenuRef.current) {
        setContextMenu(null);
        return;
      }
      if (!contextMenuRef.current.contains(target)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null);
      }
    };
    const handleScroll = () => setContextMenu(null);

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [contextMenu]);

  // Compact view - condensed display
  if (compactView) {
    return (
      <>
        <div
          data-day-date={day.date}
          className={`
            bg-white dark:bg-gray-800 rounded-md shadow-sm border overflow-hidden transition-all duration-200
            ${isToday ? 'border-blue-400 ring-1 ring-blue-100 dark:ring-blue-900' : 'border-gray-200 dark:border-gray-700'}
            ${crossDragTargetIndex != null ? 'ring-2 ring-blue-500 border-blue-500' : ''}
          `}
        >
          {/* Compact Header - inline with content */}
          <div className="px-2 py-1.5 flex items-start gap-2">
            {/* Date column */}
            <div className={`
              flex-shrink-0 w-10 text-center
              ${isToday
                ? 'text-blue-600 dark:text-blue-400'
                : isWeekend
                  ? 'text-purple-600 dark:text-purple-400'
                  : 'text-gray-600 dark:text-gray-400'}
            `}>
              <div className="text-xs font-semibold uppercase">{dayName}</div>
              <div className="text-sm">{dateDisplay}</div>
            </div>

            {/* Content column */}
            <div className="flex-1 min-w-0 py-0.5">
              {/* Events - compact list */}
              {day.events.length > 0 && (
                <div className="space-y-0.5 mb-0.5">
                  {day.events.map(event => {
                    const isSelected = contextMenu ? isSameEvent(contextMenu.event, event) : false;
                    const gestureHandlers = createEventGestureHandlers(event);
                    const ec = EVENT_COLORS[isHolidayEvent(event) ? holidayColor : calendarColor] || EVENT_COLORS.amber;
                    return (
                    <div
                      key={event.id || `${event.title}-${event.start_time}`}
                      className={`text-xs ${ec.text} ${ec.textDark} flex items-start gap-1 select-none transition-opacity ${isSelected ? 'opacity-60' : ''}`}
                      aria-selected={isSelected}
                      {...gestureHandlers}
                    >
                      <button
                        type="button"
                        aria-label="Event options"
                        className={`flex-shrink-0 p-0.5 -ml-0.5 rounded ${ec.hover} ${ec.hoverDark}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => openEventActionsFromTarget(event, e.currentTarget)}
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <div className="flex-1 min-w-0">
                        <span className="block truncate">{event.title}</span>
                      </div>
                      {!event.all_day && (
                        <span className={`flex-shrink-0 ${ec.text} ${ec.textDark}`}>{formatTime(event.start_time)}</span>
                      )}
                    </div>
                  );
                  })}
                </div>
              )}

            {/* Hidden proxy that receives focus synchronously on tap so mobile keyboards open */}
            <textarea
              ref={focusProxyRef}
              aria-hidden
              tabIndex={-1}
              className="absolute opacity-0 w-0 h-0 p-0 m-0 border-0 overflow-hidden"
              style={{ pointerEvents: 'none' }}
            />
            {isEditing ? (
              <div ref={editorWrapperRef}>
                <RichTextEditor
                  value={notes}
                  onChange={handleNotesChange}
                  onBlur={handleBlur}
                  placeholder="Add meals..."
                  autoFocus={true}
                />
              </div>
            ) : collapseHeight !== null ? (
              <div style={{ height: collapseHeight }} />
            ) : (
              <div>
                {/* Meals - each on its own line, with checkbox inline */}
                {lines.length > 0 ? (
                  <div ref={mealContainerRef} data-meal-container className="space-y-0">
                    {lines.map((line, i) => {
                      const isItemized = itemsMap.get(i) || false;
                      const dragHandlers = getMealDragHandlers(i);
                      const isDraggedItem = mealDragState.isDragging && mealDragState.dragIndex === i;
                      let style: React.CSSProperties | undefined;
                      if (isDraggedItem) {
                        style = { opacity: 0, pointerEvents: 'none' };
                      } else if (mealDragState.isDragging) {
                        const { dragIndex, overIndex, itemHeight } = mealDragState;
                        if (dragIndex !== null && overIndex !== null) {
                          if (dragIndex < overIndex && i > dragIndex && i <= overIndex) {
                            style = { transform: `translateY(-${itemHeight}px)`, transition: 'transform 200ms ease' };
                          } else if (dragIndex > overIndex && i < dragIndex && i >= overIndex) {
                            style = { transform: `translateY(${itemHeight}px)`, transition: 'transform 200ms ease' };
                          }
                        }
                      }
                      const showInsertBefore = !mealDragState.isDragging && crossDragTargetIndex === i;
                      const showInsertAfter = !mealDragState.isDragging && crossDragTargetIndex === lines.length && i === lines.length - 1;
                      return (
                        <div key={i} data-drag-index={i} style={style} {...dragHandlers}>
                          {showInsertBefore && <div className="h-0.5 bg-blue-500 rounded" />}
                          <div className="flex items-start gap-1.5">
                            {/* Inline checkbox */}
                            {showItemizedColumn && (
                              <button
                                type="button"
                                onClick={() => onToggleItemized(i, !isItemized)}
                                className={`
                                  flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center mt-[5px]
                                  transition-colors duration-150
                                  ${isItemized
                                    ? 'bg-green-500 border-green-500 dark:bg-green-600 dark:border-green-600'
                                    : 'border-gray-300 hover:border-gray-400 dark:border-gray-600 dark:hover:border-gray-500'
                                  }
                                `}
                                title={isItemized ? 'Itemized' : 'Not itemized'}
                              >
                                {isItemized && (
                                  <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </button>
                            )}
                            {/* Meal item */}
                            <div className="flex-1 min-w-0">
                              <MealItem
                                html={line}
                                itemized={isItemized}
                                onToggle={() => onToggleItemized(i, !isItemized)}
                                onTextClick={enterEditMode}
                                onDelete={onDeleteMeal ? () => onDeleteMeal(i) : undefined}
                                mealTargetDate={mealTargetAttr}
                                showHeader={false}
                                showItemizedColumn={false}
                                compact={true}
                                dragHandleMouseDown={getMealHandleMouseDown(i)}
                              />
                            </div>
                          </div>
                          {showInsertAfter && <div className="h-0.5 bg-blue-500 rounded" />}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div>
                    {crossDragTargetIndex === 0 && lines.length === 0 && (
                      <div className="h-0.5 bg-blue-500 rounded" />
                    )}
                    <div
                      onClick={enterEditMode}
                      data-meal-target={mealTargetAttr}
                      className="text-xs italic cursor-pointer text-gray-400 dark:text-gray-500"
                    >
                      Tap to add...
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          </div>
        </div>
        {contextMenu && onHideEvent && (
          <div
            ref={contextMenuRef}
            className="fixed z-50 min-w-[180px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1 text-sm"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
          >
            {showAllEvents ? (
              <div className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">
                <p className="font-medium text-gray-600 dark:text-gray-300 mb-1">Can't hide events</p>
                <p>"Show All Events" is enabled in Settings</p>
              </div>
            ) : (
              <button
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-red-600 dark:text-red-400"
                onClick={() => {
                  onHideEvent(contextMenu.event);
                  setContextMenu(null);
                }}
              >
                Hide event
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  // Standard view - full display
  return (
    <>
      <div
        data-day-date={day.date}
        className={`
          bg-white dark:bg-gray-800 rounded-lg shadow-sm border overflow-hidden transition-all duration-200
          ${isToday ? 'border-blue-400 ring-1 ring-blue-100 dark:ring-blue-900' : 'border-gray-200 dark:border-gray-700'}
          ${crossDragTargetIndex != null ? 'ring-2 ring-blue-500 border-blue-500' : ''}
        `}
      >
        {/* Header */}
        <div className={`
          px-4 py-3 border-b
          ${isToday
            ? 'bg-blue-50 border-blue-100 dark:bg-blue-900/30 dark:border-blue-800'
            : 'bg-gray-50 border-gray-100 dark:bg-gray-800 dark:border-gray-700'}
        `}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`font-semibold ${isWeekend ? 'text-purple-700 dark:text-purple-400' : 'text-gray-900 dark:text-gray-100'}`}>{dayName}</span>
              <span className={isWeekend ? 'text-purple-500 dark:text-purple-400' : 'text-gray-500 dark:text-gray-400'}>{dateDisplay}</span>
            </div>
            {isToday && (
              <span className="px-2 py-0.5 text-xs font-medium bg-blue-500 text-white rounded-full">
                TODAY
              </span>
            )}
          </div>
        </div>

      {/* Events Loading Skeleton */}
      {eventsLoading && (
        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-2 text-sm py-1 animate-pulse">
            <div className="w-4 h-4 bg-gray-200 dark:bg-gray-600 rounded" />
            <div className="h-4 bg-gray-200 dark:bg-gray-600 rounded w-32" />
          </div>
        </div>
      )}

      {/* Events */}
        {!eventsLoading && day.events.length > 0 && (() => {
          const cc = EVENT_COLORS[calendarColor] || EVENT_COLORS.amber;
          return (
          <div className={`px-4 py-2 ${cc.bg} ${cc.bgDark} border-b ${cc.border} ${cc.borderDark}`}>
            {day.events.map((event, i) => {
              const isSelected = contextMenu ? isSameEvent(contextMenu.event, event) : false;
              const gestureHandlers = createEventGestureHandlers(event);
              const ec = EVENT_COLORS[isHolidayEvent(event) ? holidayColor : calendarColor] || EVENT_COLORS.amber;
              return (
              <div
                key={event.id || i}
                className={`flex items-center gap-2 text-sm py-1 select-none transition-opacity ${isSelected ? 'opacity-60' : ''}`}
                aria-selected={isSelected}
                {...gestureHandlers}
              >
                <button
                  type="button"
                  aria-label="Event options"
                  className={`flex-shrink-0 p-1 -ml-1 rounded ${ec.hover} ${ec.hoverDark} ${ec.text} ${ec.textDark}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  onClick={(e) => openEventActionsFromTarget(event, e.currentTarget)}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </button>
                <div className="flex-1 min-w-0 overflow-hidden">
                  <span className={`${ec.textStrong} ${ec.textStrongDark} font-medium break-words`}>{event.title}</span>
                </div>
                {!event.all_day && (
                  <span className={`${ec.text} ${ec.textDark}`}>{formatTime(event.start_time)}</span>
                )}
              </div>
            );
            })}
          </div>
          );
        })()}

        {/* Meal Notes */}
        <div className="p-4">
          {/* Hidden proxy that receives focus synchronously on tap so mobile keyboards open */}
          <textarea
            ref={focusProxyRef}
            aria-hidden
            tabIndex={-1}
            className="absolute opacity-0 w-0 h-0 p-0 m-0 border-0 overflow-hidden"
            style={{ pointerEvents: 'none' }}
          />
          {isEditing ? (
            <div ref={editorWrapperRef}>
              <RichTextEditor
                value={notes}
                onChange={handleNotesChange}
                onBlur={handleBlur}
                placeholder="Add meals for this day..."
                autoFocus={true}
              />
              {saveStatus !== 'idle' && (
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                  {saveStatus === 'saving' ? 'Saving...' : 'Saved'}
                </div>
              )}
            </div>
          ) : collapseHeight !== null ? (
            <div style={{ height: collapseHeight }} />
          ) : (
            <div className="min-h-[60px]">
              {lines.length > 0 ? (
                <div ref={mealContainerRef} data-meal-container className="space-y-0">
                  {lines.map((line, i) => {
                    const dragHandlers = getMealDragHandlers(i);
                    const isDraggedItem = mealDragState.isDragging && mealDragState.dragIndex === i;
                    let style: React.CSSProperties | undefined;
                    if (isDraggedItem) {
                      style = { opacity: 0, pointerEvents: 'none' };
                    } else if (mealDragState.isDragging) {
                      const { dragIndex, overIndex, itemHeight } = mealDragState;
                      if (dragIndex !== null && overIndex !== null) {
                        if (dragIndex < overIndex && i > dragIndex && i <= overIndex) {
                          style = { transform: `translateY(-${itemHeight}px)`, transition: 'transform 200ms ease' };
                        } else if (dragIndex > overIndex && i < dragIndex && i >= overIndex) {
                          style = { transform: `translateY(${itemHeight}px)`, transition: 'transform 200ms ease' };
                        }
                      }
                    }
                    const showInsertBefore = !mealDragState.isDragging && crossDragTargetIndex === i;
                    const showInsertAfter = !mealDragState.isDragging && crossDragTargetIndex === lines.length && i === lines.length - 1;
                    return (
                      <div key={i} data-drag-index={i} style={style} {...dragHandlers}>
                        {showInsertBefore && <div className="h-0.5 bg-blue-500 rounded" />}
                        <MealItem
                          html={line}
                          itemized={itemsMap.get(i) || false}
                          onToggle={() => {
                            const current = itemsMap.get(i) || false;
                            onToggleItemized(i, !current);
                          }}
                          onTextClick={enterEditMode}
                          onDelete={onDeleteMeal ? () => onDeleteMeal(i) : undefined}
                          mealTargetDate={mealTargetAttr}
                          showHeader={i === 0}
                          showItemizedColumn={showItemizedColumn}
                          dragHandleMouseDown={getMealHandleMouseDown(i)}
                        />
                        {showInsertAfter && <div className="h-0.5 bg-blue-500 rounded" />}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div>
                  {crossDragTargetIndex === 0 && lines.length === 0 && (
                    <div className="h-0.5 bg-blue-500 rounded" />
                  )}
                  <p
                    onClick={enterEditMode}
                    data-meal-target={mealTargetAttr}
                    className="text-gray-400 dark:text-gray-500 italic cursor-text"
                  >
                    Tap to add meals...
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {contextMenu && onHideEvent && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[180px] rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1 text-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {showAllEvents ? (
            <div className="px-3 py-2 text-gray-500 dark:text-gray-400 text-xs">
              <p className="font-medium text-gray-600 dark:text-gray-300 mb-1">Can't hide events</p>
              <p>"Show All Events" is enabled in Settings</p>
            </div>
          ) : (
            <button
              type="button"
              className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-red-600 dark:text-red-400"
              onClick={() => {
                onHideEvent(contextMenu.event);
                setContextMenu(null);
              }}
            >
              Hide event
            </button>
          )}
        </div>
      )}
    </>
  );
}
