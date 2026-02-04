import { useState, useEffect, useRef, useCallback } from 'react';
import { CalendarEvent, DayData } from '../types';
import { DayCard } from './DayCard';
import { getDays, getEvents, updateNotes, toggleItemized } from '../api/client';
import { saveLocalNote, queueChange } from '../db';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { scrollToElementWithOffset } from '../utils/scroll';
import { isPerfEnabled, logDuration, logRenderDuration, perfNow } from '../utils/perf';

function formatDate(date: Date): string {
  // Use local date to avoid timezone issues (toISOString uses UTC)
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

interface CalendarViewProps {
  onTodayRefReady: (ref: HTMLDivElement | null) => void;
  showItemizedColumn?: boolean;
}

// Track which date ranges have finished loading events
type EventsLoadState = 'loading' | 'loaded' | 'error';

export function CalendarView({ onTodayRefReady, showItemizedColumn = true }: CalendarViewProps) {
  const [days, setDays] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingMore, setLoadingMore] = useState<'prev' | 'next' | null>(null);
  const endDateRef = useRef<Date>(addDays(new Date(), 6));
  const startDateRef = useRef<Date>(new Date());
  const todayRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isOnline = useOnlineStatus();
  const initialLoadDone = useRef(false);
  const notifiedTodayRef = useRef<string | null>(null);
  const [, setEventsLoadState] = useState<Record<string, EventsLoadState>>({});
  const pendingRenderLogsRef = useRef<Array<{ label: string; start: number; payload?: Record<string, unknown> }>>([]);

  const today = useRef(formatDate(new Date())).current;
  const handleTodayRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      todayRef.current = node;
      onTodayRefReady(node);
    }
  }, [onTodayRefReady]);

  useEffect(() => {
    if (loading) return;
    if (notifiedTodayRef.current === today) return;
    const element = todayRef.current
      ?? document.querySelector<HTMLDivElement>(`[data-date="${today}"]`)
      ?? document.querySelector<HTMLDivElement>('[data-date]');
    if (!element) return;
    notifiedTodayRef.current = today;
    onTodayRefReady(element);
  }, [loading, days, onTodayRefReady, today]);

  // Load events for a date range (non-blocking)
  const loadEventsForRange = useCallback(async (start: Date, end: Date) => {
    const rangeKey = `${formatDate(start)}_${formatDate(end)}`;
    const startStr = formatDate(start);
    const endStr = formatDate(end);

    setEventsLoadState(prev => {
      if (prev[rangeKey]) return prev; // Already loading or loaded
      return { ...prev, [rangeKey]: 'loading' };
    });

    // Check if already loaded
    setEventsLoadState(prev => {
      if (prev[rangeKey] === 'loaded') return prev;
      return { ...prev, [rangeKey]: 'loading' };
    });

    setLoadingEvents(true);

    try {
      const requestStart = perfNow();
      const eventsMap = await getEvents(startStr, endStr);
      logDuration('calendar.events.request', requestStart, { start: startStr, end: endStr });
      const renderStart = perfNow();
      setDays(prev => prev.map(day => {
        // Only update days within the loaded range
        if (day.date >= startStr && day.date <= endStr) {
          const dayEvents = eventsMap[day.date] || [];
          return { ...day, events: dayEvents };
        }
        // Keep existing events for days outside the range
        return day;
      }));
      enqueueRenderLog('calendar.events.render', renderStart, { rangeKey });
      setEventsLoadState(prev => ({ ...prev, [rangeKey]: 'loaded' }));
    } catch (error) {
      console.error('Failed to load events:', error);
      setEventsLoadState(prev => ({ ...prev, [rangeKey]: 'error' }));
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  // Initial load - use ref to prevent double load in StrictMode
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const init = async () => {
      setLoading(true);
      try {
        // Load days without events first (fast)
        const requestStart = perfNow();
        const data = await getDays(formatDate(startDateRef.current), formatDate(endDateRef.current));
        logDuration('calendar.days.request', requestStart, {
          start: formatDate(startDateRef.current),
          end: formatDate(endDateRef.current),
        });
        const renderStart = perfNow();
        setDays(data);
        enqueueRenderLog('calendar.days.render', renderStart, { count: data.length });
        setLoading(false);

        // Then load events separately (slow, but non-blocking)
        loadEventsForRange(startDateRef.current, endDateRef.current);
      } catch (error) {
        console.error('Failed to load days:', error);
        setLoading(false);
      }
    };
    init();
  }, [loadEventsForRange]);

  // Scroll to today after initial load
  useEffect(() => {
    if (!loading && todayRef.current) {
      scrollToElementWithOffset(todayRef.current, 'auto');
    }
  }, [loading]);

  const enqueueRenderLog = (label: string, start: number, payload?: Record<string, unknown>) => {
    if (!isPerfEnabled()) return;
    pendingRenderLogsRef.current.push({ label, start, payload });
  };

  useEffect(() => {
    if (!isPerfEnabled() || pendingRenderLogsRef.current.length === 0) return;
    const pending = pendingRenderLogsRef.current.splice(0);
    pending.forEach(entry => {
      logRenderDuration(entry.label, entry.start, {
        ...entry.payload,
        daysCount: days.length,
      });
    });
  }, [days]);

  // Listen for external note updates (e.g., scheduled meal ideas)
  useEffect(() => {
    const handleExternalUpdate = (event: Event) => {
      const detail = (event as CustomEvent).detail as { date?: string; notes?: string } | undefined;
      const date = detail?.date;
      const notes = detail?.notes;
      if (!date || notes === undefined) return;
      setDays(prev => prev.map(day => {
        if (day.date !== date) return day;
        return {
          ...day,
          meal_note: day.meal_note
            ? { ...day.meal_note, notes }
            : { id: '', date, notes, items: [], updated_at: new Date().toISOString() },
        };
      }));
    };

    window.addEventListener('meal-planner-notes-updated', handleExternalUpdate as EventListener);
    return () => {
      window.removeEventListener('meal-planner-notes-updated', handleExternalUpdate as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleRealtime = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string; payload?: any } | undefined;
      if (!detail?.type) return;
      if (detail.type === 'notes.updated') {
        const payload = detail.payload as { date?: string; meal_note?: DayData['meal_note'] };
        const date = payload?.date;
        const mealNote = payload?.meal_note;
        if (!date || mealNote === undefined) return;
        setDays(prev => prev.map(day => {
          if (day.date !== date) return day;
          return { ...day, meal_note: mealNote ?? null };
        }));
      }
      if (detail.type === 'item.updated') {
        const payload = detail.payload as { date?: string; line_index?: number; itemized?: boolean };
        const date = payload?.date;
        const lineIndex = payload?.line_index;
        const itemized = payload?.itemized;
        if (!date || lineIndex === undefined || itemized === undefined) return;
        setDays(prev => prev.map(day => {
          if (day.date !== date || !day.meal_note) return day;
          const items = [...day.meal_note.items];
          const existing = items.findIndex(item => item.line_index === lineIndex);
          if (existing >= 0) {
            items[existing] = { ...items[existing], itemized };
          } else {
            items.push({ line_index: lineIndex, itemized });
          }
          return { ...day, meal_note: { ...day.meal_note, items } };
        }));
      }
      if (detail.type === 'calendar.refreshed') {
        const payload = detail.payload as { events_by_date?: Record<string, CalendarEvent[]> };
        const eventsByDate = payload?.events_by_date;
        if (!eventsByDate) return;
        setDays(prev => prev.map(day => {
          const dayEvents = eventsByDate[day.date];
          if (dayEvents !== undefined) {
            return { ...day, events: dayEvents };
          }
          // If not in the refreshed data, keep existing events
          return day;
        }));
      }
    };

    window.addEventListener('meal-planner-realtime', handleRealtime as EventListener);
    return () => {
      window.removeEventListener('meal-planner-realtime', handleRealtime as EventListener);
    };
  }, []);

  const loadPreviousWeek = async () => {
    if (loadingMore) return;
    setLoadingMore('prev');
    const newStart = addDays(startDateRef.current, -7);
    const newEnd = addDays(startDateRef.current, -1);
    try {
      const requestStart = perfNow();
      const data = await getDays(formatDate(newStart), formatDate(newEnd));
      logDuration('calendar.days.request', requestStart, {
        start: formatDate(newStart),
        end: formatDate(newEnd),
      });
      const renderStart = perfNow();
      setDays(prev => [...data, ...prev]);
      enqueueRenderLog('calendar.days.render', renderStart, { count: data.length, direction: 'prev' });
      startDateRef.current = newStart;
      // Load events for the new range
      loadEventsForRange(newStart, newEnd);
    } catch (error) {
      console.error('Failed to load previous week:', error);
    } finally {
      setLoadingMore(null);
    }
  };

  const loadNextWeek = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore('next');
    const newStart = addDays(endDateRef.current, 1);
    const newEnd = addDays(endDateRef.current, 7);
    try {
      const requestStart = perfNow();
      const data = await getDays(formatDate(newStart), formatDate(newEnd));
      logDuration('calendar.days.request', requestStart, {
        start: formatDate(newStart),
        end: formatDate(newEnd),
      });
      const renderStart = perfNow();
      setDays(prev => [...prev, ...data]);
      enqueueRenderLog('calendar.days.render', renderStart, { count: data.length, direction: 'next' });
      endDateRef.current = newEnd;
      // Load events for the new range
      loadEventsForRange(newStart, newEnd);
    } catch (error) {
      console.error('Failed to load next week:', error);
    } finally {
      setLoadingMore(null);
    }
  }, [loadingMore, loadEventsForRange]);

  // Infinite scroll - load more when bottom is visible
  useEffect(() => {
    if (!bottomRef.current || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMore) {
          loadNextWeek();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(bottomRef.current);
    return () => observer.disconnect();
  }, [loadNextWeek, loadingMore, loading]);

  const handleNotesChange = async (date: string, notes: string) => {
    // Optimistic update
    setDays(prev => prev.map(d => {
      if (d.date === date) {
        return {
          ...d,
          meal_note: d.meal_note
            ? { ...d.meal_note, notes }
            : { id: '', date, notes, items: [], updated_at: new Date().toISOString() }
        };
      }
      return d;
    }));

    // Save locally
    const existing = days.find(d => d.date === date);
    await saveLocalNote(date, notes, existing?.meal_note?.items || []);

    if (isOnline) {
      try {
        const updated = await updateNotes(date, notes);
        setDays(prev => prev.map(d => d.date === date ? { ...d, meal_note: updated } : d));
      } catch (error) {
        console.error('Failed to save notes:', error);
        await queueChange('notes', date, { notes });
      }
    } else {
      await queueChange('notes', date, { notes });
    }
  };

  const handleToggleItemized = async (date: string, lineIndex: number, itemized: boolean) => {
    // Optimistic update
    setDays(prev => prev.map(d => {
      if (d.date === date && d.meal_note) {
        const items = [...d.meal_note.items];
        const existingIndex = items.findIndex(i => i.line_index === lineIndex);
        if (existingIndex >= 0) {
          items[existingIndex] = { ...items[existingIndex], itemized };
        } else {
          items.push({ line_index: lineIndex, itemized });
        }
        return { ...d, meal_note: { ...d.meal_note, items } };
      }
      return d;
    }));

    if (isOnline) {
      try {
        await toggleItemized(date, lineIndex, itemized);
      } catch (error) {
        console.error('Failed to toggle itemized:', error);
        await queueChange('itemized', date, { lineIndex, itemized });
      }
    } else {
      await queueChange('itemized', date, { lineIndex, itemized });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="calendar-loading" aria-label="Loading calendar">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Load Previous Week Button */}
      <button
        onClick={loadPreviousWeek}
        disabled={loadingMore === 'prev'}
        className="w-full py-3 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 transition-colors"
      >
        {loadingMore === 'prev' ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Loading...
          </span>
        ) : (
          'Load previous week'
        )}
      </button>

      {/* Day Cards */}
      {days.map(day => (
        <div key={day.date} data-date={day.date} ref={day.date === today ? handleTodayRef : undefined}>
          <DayCard
            day={day}
            isToday={day.date === today}
            onNotesChange={(notes) => handleNotesChange(day.date, notes)}
            onToggleItemized={(lineIndex, itemized) => handleToggleItemized(day.date, lineIndex, itemized)}
            eventsLoading={loadingEvents && day.events.length === 0}
            showItemizedColumn={showItemizedColumn}
          />
        </div>
      ))}

      {/* Infinite scroll trigger / loading indicator */}
      <div ref={bottomRef} className="py-4 flex items-center justify-center">
        {loadingMore === 'next' ? (
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Loading more...</span>
          </div>
        ) : (
          <div className="h-4" />
        )}
      </div>
    </div>
  );
}
