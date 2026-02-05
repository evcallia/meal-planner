import { useState, useEffect, useRef, useCallback } from 'react';
import { DayData } from '../types';
import { MealItem } from './MealItem';
import { decodeHtmlEntities } from '../utils/html';
import { RichTextEditor } from './RichTextEditor';

interface DayCardProps {
  day: DayData;
  isToday: boolean;
  onNotesChange: (notes: string) => void;
  onToggleItemized: (lineIndex: number, itemized: boolean) => void;
  eventsLoading?: boolean;
  showItemizedColumn?: boolean;
  compactView?: boolean;
  onDragStart?: (date: string, lineIndex: number, html: string) => void;
  onDragEnd?: () => void;
  onDrop?: (targetDate: string, sourceDate: string, lineIndex: number, html: string) => void;
  isDragActive?: boolean;
  dragSourceDate?: string | null;
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

// Split HTML content into lines, preserving HTML tags within each line
function splitHtmlLines(html: string): string[] {
  // Replace <br>, <br/>, <br /> with newlines, then split
  // Also handle <div> blocks which browsers sometimes use for new lines
  const normalized = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div><div>/gi, '\n')
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '');

  return normalized.split('\n').filter(line => {
    // Check if line has actual content (not just empty tags)
    const textContent = line.replace(/<[^>]*>/g, '').trim();
    return textContent.length > 0;
  });
}

export function DayCard({
  day,
  isToday,
  onNotesChange,
  onToggleItemized,
  eventsLoading,
  showItemizedColumn = true,
  compactView = false,
  onDragStart,
  onDragEnd,
  onDrop,
  isDragActive,
  dragSourceDate,
}: DayCardProps) {
  const normalizeNotes = (value?: string | null) => decodeHtmlEntities(value ?? '');
  const [notes, setNotes] = useState(() => normalizeNotes(day.meal_note?.notes));
  const [isEditing, setIsEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [isDragOver, setIsDragOver] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const { dayName, dateDisplay, isWeekend } = formatDate(day.date, compactView);

  // Build items map from meal_note
  const itemsMap = new Map<number, boolean>();
  day.meal_note?.items.forEach(item => {
    itemsMap.set(item.line_index, item.itemized);
  });

  // Parse lines for display (now handles HTML)
  const lines = splitHtmlLines(notes);

  // Sync notes when day data changes (e.g., from server)
  useEffect(() => {
    if (!isEditing) {
      setNotes(normalizeNotes(day.meal_note?.notes));
    }
  }, [day.meal_note?.notes, isEditing]);

  const handleNotesChange = (value: string) => {
    setNotes(value);
    setSaveStatus('saving');

    // Debounce save
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      onNotesChange(value);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 1500);
    }, 500);
  };

  const handleBlur = () => {
    setIsEditing(false);
  };

  const enterEditMode = () => {
    setIsEditing(true);
  };

  // Drag and drop handlers
  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // Only show drag over state if dragging from a different day
      if (dragSourceDate && dragSourceDate !== day.date) {
        setIsDragOver(true);
      }
    },
    [day.date, dragSourceDate]
  );

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only hide if we're actually leaving the card (not just moving between children)
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!e.currentTarget.contains(relatedTarget)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDropEvent = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);

      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data.date && data.date !== day.date && data.html !== undefined) {
          onDrop?.(day.date, data.date, data.lineIndex, data.html);
        }
      } catch (err) {
        console.error('Failed to parse drop data:', err);
      }
    },
    [day.date, onDrop]
  );

  // Determine if this card is a valid drop target
  const isValidDropTarget = isDragActive && dragSourceDate && dragSourceDate !== day.date;

  // Compact view - condensed display
  if (compactView) {
    // Combine events into comma-separated string (no times)
    const eventsText = day.events.map(e => e.title).join(', ');

    return (
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDropEvent}
        className={`
          bg-white dark:bg-gray-800 rounded-md shadow-sm border overflow-hidden transition-all duration-200
          ${isToday ? 'border-blue-400 ring-1 ring-blue-100 dark:ring-blue-900' : 'border-gray-200 dark:border-gray-700'}
          ${isDragOver ? 'ring-2 ring-blue-500 border-blue-500 bg-blue-50 dark:bg-blue-900/20' : ''}
          ${isValidDropTarget && !isDragOver ? 'ring-1 ring-blue-300 dark:ring-blue-700' : ''}
        `}
      >
        {/* Compact Header - inline with content */}
        <div className={`
          px-2 py-1.5 flex items-start gap-2
          ${isToday ? 'bg-blue-50 dark:bg-blue-900/30' : ''}
          ${isDragOver ? 'bg-blue-100 dark:bg-blue-900/40' : ''}
        `}>
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
            {/* Events - always visible, comma separated, wraps to new lines */}
            {eventsText && (
              <div className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1 mb-0.5">
                <svg className="w-3 h-3 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>{eventsText}</span>
              </div>
            )}

            {isEditing ? (
              <div>
                <RichTextEditor
                  value={notes}
                  onChange={handleNotesChange}
                  onBlur={handleBlur}
                  placeholder="Add meals..."
                  autoFocus={true}
                />
              </div>
            ) : (
              <div>
                {/* Meals - each on its own line, with checkbox inline */}
                {lines.length > 0 ? (
                  <div className="space-y-0">
                    {lines.map((line, i) => {
                      const isItemized = itemsMap.get(i) || false;
                      return (
                        <div key={i} className="flex items-center gap-1.5">
                          {/* Inline checkbox */}
                          {showItemizedColumn && (
                            <button
                              type="button"
                              onClick={() => onToggleItemized(i, !isItemized)}
                              className={`
                                flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center
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
                              showHeader={false}
                              showItemizedColumn={false}
                              compact={true}
                              lineIndex={i}
                              date={day.date}
                              onDragStart={onDragStart}
                              onDragEnd={onDragEnd}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    onClick={enterEditMode}
                    className={`text-xs italic cursor-pointer ${isDragOver ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500'}`}
                  >
                    {isDragOver ? 'Drop here' : 'Tap to add...'}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Standard view - full display
  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDropEvent}
      className={`
        bg-white dark:bg-gray-800 rounded-lg shadow-sm border overflow-hidden transition-all duration-200
        ${isToday ? 'border-blue-400 ring-1 ring-blue-100 dark:ring-blue-900' : 'border-gray-200 dark:border-gray-700'}
        ${isDragOver ? 'ring-2 ring-blue-500 border-blue-500 bg-blue-50 dark:bg-blue-900/20' : ''}
        ${isValidDropTarget && !isDragOver ? 'ring-1 ring-blue-300 dark:ring-blue-700' : ''}
      `}
    >
      {/* Header */}
      <div className={`
        px-4 py-3 border-b
        ${isToday
          ? 'bg-blue-50 border-blue-100 dark:bg-blue-900/30 dark:border-blue-800'
          : 'bg-gray-50 border-gray-100 dark:bg-gray-800 dark:border-gray-700'}
        ${isDragOver ? 'bg-blue-100 dark:bg-blue-900/40' : ''}
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
          {isDragOver && (
            <span className="px-2 py-0.5 text-xs font-medium bg-blue-500 text-white rounded-full animate-pulse">
              Drop here
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
      {!eventsLoading && day.events.length > 0 && (
        <div className="px-4 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-800/30">
          {day.events.map((event, i) => (
            <div key={i} className="flex items-center gap-2 text-sm py-1">
              <svg className="w-4 h-4 text-amber-600 dark:text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="text-amber-800 dark:text-amber-200 font-medium">{event.title}</span>
              {!event.all_day && (
                <span className="text-amber-600 dark:text-amber-400">{formatTime(event.start_time)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Meal Notes */}
      <div className="p-4">
        {isEditing ? (
          <div>
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
        ) : (
          <div className="min-h-[60px]">
            {lines.length > 0 ? (
              <div className="space-y-0">
                {lines.map((line, i) => (
                  <MealItem
                    key={i}
                    html={line}
                    itemized={itemsMap.get(i) || false}
                    onToggle={() => {
                      const current = itemsMap.get(i) || false;
                      onToggleItemized(i, !current);
                    }}
                    onTextClick={enterEditMode}
                    showHeader={i === 0}
                    showItemizedColumn={showItemizedColumn}
                    lineIndex={i}
                    date={day.date}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                  />
                ))}
              </div>
            ) : (
              <p
                onClick={enterEditMode}
                className={`text-gray-400 dark:text-gray-500 italic cursor-text ${isDragOver ? 'text-blue-500' : ''}`}
              >
                {isDragOver ? 'Drop meal here' : 'Tap to add meals...'}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
