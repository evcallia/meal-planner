import { useState, useEffect, useRef } from 'react';
import { DayData } from '../types';
import { MealItem } from './MealItem';

interface DayCardProps {
  day: DayData;
  isToday: boolean;
  onNotesChange: (notes: string) => void;
  onToggleItemized: (lineIndex: number, itemized: boolean) => void;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDate(dateString: string): { dayName: string; dateDisplay: string } {
  const date = new Date(dateString + 'T12:00:00');
  return {
    dayName: date.toLocaleDateString('en-US', { weekday: 'long' }),
    dateDisplay: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  };
}

export function DayCard({ day, isToday, onNotesChange, onToggleItemized }: DayCardProps) {
  const [notes, setNotes] = useState(day.meal_note?.notes || '');
  const [isEditing, setIsEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const { dayName, dateDisplay } = formatDate(day.date);

  // Build items map from meal_note
  const itemsMap = new Map<number, boolean>();
  day.meal_note?.items.forEach(item => {
    itemsMap.set(item.line_index, item.itemized);
  });

  // Parse lines for display
  const lines = notes.split('\n').filter(l => l.trim());

  // Sync notes when day data changes (e.g., from server)
  useEffect(() => {
    if (!isEditing) {
      setNotes(day.meal_note?.notes || '');
    }
  }, [day.meal_note?.notes, isEditing]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current && isEditing) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [notes, isEditing]);

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

  return (
    <div className={`
      bg-white dark:bg-gray-800 rounded-lg shadow-sm border overflow-hidden
      ${isToday ? 'border-blue-400 ring-1 ring-blue-100 dark:ring-blue-900' : 'border-gray-200 dark:border-gray-700'}
    `}>
      {/* Header */}
      <div className={`
        px-4 py-3 border-b
        ${isToday
          ? 'bg-blue-50 border-blue-100 dark:bg-blue-900/30 dark:border-blue-800'
          : 'bg-gray-50 border-gray-100 dark:bg-gray-800 dark:border-gray-700'}
      `}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-gray-100">{dayName}</span>
            <span className="text-gray-500 dark:text-gray-400">{dateDisplay}</span>
          </div>
          {isToday && (
            <span className="px-2 py-0.5 text-xs font-medium bg-blue-500 text-white rounded-full">
              TODAY
            </span>
          )}
        </div>
      </div>

      {/* Events */}
      {day.events.length > 0 && (
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
            <textarea
              ref={textareaRef}
              value={notes}
              onChange={(e) => handleNotesChange(e.target.value)}
              onBlur={handleBlur}
              placeholder="Add meals for this day..."
              className="w-full resize-none border-0 focus:ring-0 p-0 text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none bg-transparent"
              autoFocus
              rows={3}
            />
            {saveStatus !== 'idle' && (
              <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
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
                    text={line}
                    itemized={itemsMap.get(i) || false}
                    onToggle={() => {
                      const current = itemsMap.get(i) || false;
                      onToggleItemized(i, !current);
                    }}
                    onTextClick={enterEditMode}
                    showHeader={i === 0}
                  />
                ))}
              </div>
            ) : (
              <p
                onClick={enterEditMode}
                className="text-gray-400 dark:text-gray-500 italic cursor-text"
              >
                Tap to add meals...
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
