import { useState, useEffect, useRef, useCallback } from 'react';
import { CalendarEvent, DayData } from '../types';
import { DayCard } from './DayCard';
import { getDays, getEvents, updateNotes, toggleItemized, hideCalendarEvent } from '../api/client';
import {
  saveLocalNote,
  queueChange,
  getLocalNotesForRange,
  LocalMealNote,
  saveLocalCalendarEvents,
  getLocalCalendarEventsForRange,
  LocalCalendarEvent,
  getLocalHiddenEvents,
  saveLocalHiddenEvent,
  deleteLocalHiddenEvent,
  generateTempId,
} from '../db';
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

// Split HTML content into lines (same as DayCard)
function splitHtmlLines(html: string): string[] {
  const normalized = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div><div>/gi, '\n')
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '');

  return normalized.split('\n').filter(line => {
    const textContent = line.replace(/<[^>]*>/g, '').trim();
    return textContent.length > 0;
  });
}

// Join lines back into HTML format
function joinHtmlLines(lines: string[]): string {
  if (lines.length === 0) return '';
  if (lines.length === 1) return lines[0];
  return lines.map((line, i) => i === 0 ? line : `<div>${line}</div>`).join('');
}

function ensureCalendarEventId(event: CalendarEvent | LocalCalendarEvent): CalendarEvent {
  if (event.id) {
    return event as CalendarEvent;
  }
  const fallbackId = `${event.uid ?? event.title}-${event.start_time}`;
  return { ...event, id: fallbackId };
}

function normalizeEventsMap(eventsMap: Record<string, LocalCalendarEvent[]>): Record<string, CalendarEvent[]> {
  const normalized: Record<string, CalendarEvent[]> = {};
  for (const [date, events] of Object.entries(eventsMap)) {
    normalized[date] = events.map(ensureCalendarEventId);
  }
  return normalized;
}

function buildHiddenKey(eventUid: string, calendarName: string, startTime: string): string {
  return `${eventUid}|${calendarName}|${startTime}`;
}

function getEventHiddenKey(event: CalendarEvent | LocalCalendarEvent): string {
  const eventUid = event.uid ?? event.id ?? '';
  const calendarName = event.calendar_name ?? '';
  return buildHiddenKey(eventUid, calendarName, event.start_time);
}

function filterEventsMap(
  eventsMap: Record<string, CalendarEvent[]>,
  hiddenKeys: Set<string>,
): Record<string, CalendarEvent[]> {
  if (hiddenKeys.size === 0) return eventsMap;
  const filtered: Record<string, CalendarEvent[]> = {};
  for (const [date, events] of Object.entries(eventsMap)) {
    filtered[date] = events.filter(event => !hiddenKeys.has(getEventHiddenKey(event)));
  }
  return filtered;
}

// Convert local IndexedDB notes to DayData format
function localNotesToDayData(localNotes: LocalMealNote[], startDate: string, endDate: string): DayData[] {
  const notesByDate = new Map(localNotes.map(n => [n.date, n]));
  const days: DayData[] = [];

  // Generate all dates in range
  const start = new Date(startDate + 'T12:00:00');
  const end = new Date(endDate + 'T12:00:00');

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = formatDate(d);
    const localNote = notesByDate.get(dateStr);

    days.push({
      date: dateStr,
      events: [], // Events won't be available offline
      meal_note: localNote ? {
        id: '', // Local notes don't have server IDs
        date: dateStr,
        notes: localNote.notes,
        items: localNote.items,
        updated_at: new Date(localNote.updatedAt).toISOString(),
      } : null,
    });
  }

  return days;
}

interface CalendarViewProps {
  onTodayRefReady: (ref: HTMLDivElement | null) => void;
  showItemizedColumn?: boolean;
  compactView?: boolean;
  showAllEvents?: boolean;
}

// Track which date ranges have finished loading events
type EventsLoadState = 'loading' | 'loaded' | 'error';

export function CalendarView({ onTodayRefReady, showItemizedColumn = true, compactView = false, showAllEvents = false }: CalendarViewProps) {
  // days = what's displayed in the UI
  const [days, setDays] = useState<DayData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingMore, setLoadingMore] = useState<'prev' | 'next' | null>(null);
  // Display range: today + 6 days (1 week) - controls what's shown in UI
  const displayEndRef = useRef<Date>(addDays(new Date(), 6));
  const displayStartRef = useRef<Date>(new Date());
  // In-memory cache for pre-fetched data (separate from displayed days)
  const daysCache = useRef<Map<string, DayData>>(new Map());
  const backgroundCacheDone = useRef(false);
  const todayRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const isOnline = useOnlineStatus();
  const initialLoadDone = useRef(false);
  const notifiedTodayRef = useRef<string | null>(null);
  const [, setEventsLoadState] = useState<Record<string, EventsLoadState>>({});
  const pendingRenderLogsRef = useRef<Array<{ label: string; start: number; payload?: Record<string, unknown> }>>([]);
  const lastHiddenEventRef = useRef<string | null>(null);
  const hiddenEventKeysRef = useRef<Set<string>>(new Set());
  const showAllEventsRef = useRef(showAllEvents);
  // Keep the ref in sync with the prop for use in event handlers
  useEffect(() => {
    showAllEventsRef.current = showAllEvents;
  }, [showAllEvents]);
  const refreshHiddenKeys = useCallback(async () => {
    const hidden = await getLocalHiddenEvents();
    hiddenEventKeysRef.current = new Set(
      hidden.map(item => buildHiddenKey(item.event_uid, item.calendar_name, item.start_time)),
    );
  }, []);

  // Drag and drop state
  const [isDragActive, setIsDragActive] = useState(false);
  const [dragSourceDate, setDragSourceDate] = useState<string | null>(null);

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
  // Also updates the in-memory cache with event data
  // Pass online=false to skip API and load from IndexedDB directly (for offline)
  const loadEventsForRange = useCallback(async (start: Date, end: Date, online: boolean = true) => {
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

    // Helper to apply events to state
    const applyEvents = (eventsMap: Record<string, CalendarEvent[]>) => {
      const filteredEventsMap = showAllEventsRef.current ? eventsMap : filterEventsMap(eventsMap, hiddenEventKeysRef.current);
      // Update memory cache with events
      for (const [date, events] of Object.entries(filteredEventsMap)) {
        const cached = daysCache.current.get(date);
        if (cached) {
          daysCache.current.set(date, { ...cached, events });
        }
      }

      const renderStart = perfNow();
      setDays(prev => prev.map(day => {
        // Only update days within the loaded range
        if (day.date >= startStr && day.date <= endStr) {
          const dayEvents = filteredEventsMap[day.date] || [];
          return { ...day, events: dayEvents };
        }
        // Keep existing events for days outside the range
        return day;
      }));
      enqueueRenderLog('calendar.events.render', renderStart, { rangeKey });
      setEventsLoadState(prev => ({ ...prev, [rangeKey]: 'loaded' }));
    };

    // Helper to load from IndexedDB
    const loadFromIndexedDB = async () => {
      try {
        await refreshHiddenKeys();
        const localEvents = await getLocalCalendarEventsForRange(startStr, endStr);
        if (Object.keys(localEvents).length > 0) {
          applyEvents(normalizeEventsMap(localEvents));
        } else {
          setEventsLoadState(prev => ({ ...prev, [rangeKey]: 'error' }));
        }
      } catch (dbError) {
        console.error('Failed to load events from IndexedDB:', dbError);
        setEventsLoadState(prev => ({ ...prev, [rangeKey]: 'error' }));
      }
    };

    // If offline, skip API and load directly from IndexedDB
    if (!online) {
      await loadFromIndexedDB();
      setLoadingEvents(false);
      return;
    }

    try {
      const requestStart = perfNow();
      // Always fetch all events (including hidden) so IndexedDB has complete data for offline
      const eventsMap = await getEvents(startStr, endStr, true);
      logDuration('calendar.events.request', requestStart, { start: startStr, end: endStr });

      // Save ALL events to IndexedDB for offline access (filtering happens client-side)
      for (const [date, events] of Object.entries(eventsMap)) {
        saveLocalCalendarEvents(date, events);
      }

      // applyEvents handles client-side filtering based on showAllEvents
      applyEvents(eventsMap);
    } catch (error) {
      console.error('Failed to load events from API, trying local cache:', error);
      await loadFromIndexedDB();
    } finally {
      setLoadingEvents(false);
    }
  }, []);

  useEffect(() => {
    refreshHiddenKeys();
    const handleHiddenUpdated = (event: Event) => {
      const detail = (event as CustomEvent).detail as { date?: string } | undefined;
      refreshHiddenKeys().then(() => {
        if (detail?.date) {
          const start = new Date(`${detail.date}T12:00:00`);
          const end = new Date(`${detail.date}T12:00:00`);
          loadEventsForRange(start, end, isOnline);
        }
      });
    };
    window.addEventListener('meal-planner-hidden-updated', handleHiddenUpdated as EventListener);
    return () => {
      window.removeEventListener('meal-planner-hidden-updated', handleHiddenUpdated as EventListener);
    };
  }, [isOnline, loadEventsForRange, refreshHiddenKeys]);

  // Reload events when showAllEvents setting changes
  useEffect(() => {
    if (!initialLoadDone.current) return;
    // Reset ALL load states to force fresh reload
    setEventsLoadState({});
    // Force online fetch if available to get fresh data with correct include_hidden
    loadEventsForRange(displayStartRef.current, displayEndRef.current, isOnline);
  }, [showAllEvents, loadEventsForRange, isOnline]);

  // Pre-fetch extended cache range in background (for offline support)
  // This caches data but does NOT display it - data is added to UI only when user scrolls
  const prefetchCacheRange = useCallback(async () => {
    if (backgroundCacheDone.current) return;
    backgroundCacheDone.current = true;

    try {
      // Fetch past 2 weeks
      const pastStart = addDays(new Date(), -14);
      const pastEnd = addDays(new Date(), -1);
      if (pastEnd >= pastStart) {
        const pastData = await getDays(formatDate(pastStart), formatDate(pastEnd));
        // Store in memory cache and IndexedDB, don't display
        pastData.forEach(d => {
          if (!daysCache.current.has(d.date)) {
            daysCache.current.set(d.date, d);
          }
          // Save to IndexedDB for offline access
          if (d.meal_note) {
            saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
          }
        });
        // Pre-fetch events for cached data (populates service worker cache)
        loadEventsForRange(pastStart, pastEnd, true);
      }

      // Fetch future 8 weeks (56 days from today)
      const futureStart = addDays(displayEndRef.current, 1);
      const futureEnd = addDays(new Date(), 56);
      if (futureEnd >= futureStart) {
        const futureData = await getDays(formatDate(futureStart), formatDate(futureEnd));
        // Store in memory cache and IndexedDB, don't display
        futureData.forEach(d => {
          if (!daysCache.current.has(d.date)) {
            daysCache.current.set(d.date, d);
          }
          // Save to IndexedDB for offline access
          if (d.meal_note) {
            saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
          }
        });
        // Pre-fetch events for cached data (populates service worker cache)
        loadEventsForRange(futureStart, futureEnd, true);
      }
    } catch (error) {
      // Background caching failed - not critical, user can still load on demand
      console.error('Background cache prefetch failed:', error);
    }
  }, [loadEventsForRange]);

  // Initial load - use ref to prevent double load in StrictMode
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const init = async () => {
      setLoading(true);
      const startStr = formatDate(displayStartRef.current);
      const endStr = formatDate(displayEndRef.current);

      try {
        // Load days without events first (fast) - only the display range (1 week)
        const requestStart = perfNow();
        const data = await getDays(startStr, endStr);
        logDuration('calendar.days.request', requestStart, {
          start: startStr,
          end: endStr,
        });
        const renderStart = perfNow();
        setDays(data);
        // Also add to cache
        data.forEach(d => daysCache.current.set(d.date, d));
        // Save to IndexedDB for offline access
        data.forEach(d => {
          if (d.meal_note) {
            saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
          }
        });
        enqueueRenderLog('calendar.days.render', renderStart, { count: data.length });
        setLoading(false);

        // Then load events separately (slow, but non-blocking)
        loadEventsForRange(displayStartRef.current, displayEndRef.current, true);

        // Pre-fetch extended cache range in background after a short delay
        // This caches 2 weeks past and 8 weeks future for offline support
        // Data is cached but NOT displayed until user scrolls
        setTimeout(() => prefetchCacheRange(), 500);
      } catch (error) {
        console.error('Failed to load days from API, trying local cache:', error);

        // Try to load from IndexedDB when API fails (offline)
        try {
          const localNotes = await getLocalNotesForRange(startStr, endStr);
          const data = localNotesToDayData(localNotes, startStr, endStr);
          setDays(data);
          data.forEach(d => daysCache.current.set(d.date, d));
          console.log('Loaded from local cache:', data.length, 'days');

          // Also try to load events from local cache (offline mode)
          loadEventsForRange(displayStartRef.current, displayEndRef.current, false);
        } catch (dbError) {
          console.error('Failed to load from local cache:', dbError);
        }
        setLoading(false);
      }
    };
    init();
  }, [loadEventsForRange, prefetchCacheRange]);

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
        // Save all events to IndexedDB for offline access
        for (const [date, events] of Object.entries(eventsByDate)) {
          saveLocalCalendarEvents(date, events);
        }
        // Update display with client-side filtering based on showAllEvents
        setDays(prev => prev.map(day => {
          const dayEvents = eventsByDate[day.date];
          if (dayEvents !== undefined) {
            const filtered = showAllEventsRef.current
              ? dayEvents
              : dayEvents.filter(event => !hiddenEventKeysRef.current.has(getEventHiddenKey(event)));
            return { ...day, events: filtered };
          }
          // If not in the refreshed data, keep existing events
          return day;
        }));
      }
      if (detail.type === 'calendar.hidden') {
        const payload = detail.payload as {
          event_id?: string;
          hidden_id?: string;
          event_uid?: string;
          calendar_name?: string;
          title?: string;
          start_time?: string;
          end_time?: string | null;
          all_day?: boolean;
        };
        if (payload?.hidden_id && payload.start_time && payload.title) {
          const eventUid = payload.event_uid ?? '';
          const calendarName = payload.calendar_name ?? '';
          hiddenEventKeysRef.current.add(buildHiddenKey(eventUid, calendarName, payload.start_time));
          saveLocalHiddenEvent({
            id: payload.hidden_id,
            event_uid: eventUid,
            event_date: payload.start_time.split('T')[0],
            calendar_name: calendarName,
            title: payload.title,
            start_time: payload.start_time,
            end_time: payload.end_time ?? null,
            all_day: Boolean(payload.all_day),
          });
        }
        // Don't remove events from UI when showAllEvents is enabled
        if (showAllEventsRef.current) return;
        if (!payload?.event_id) return;
        removeEventById(payload.event_id, false);
      }
      if (detail.type === 'calendar.unhidden') {
        const payload = detail.payload as {
          hidden_id?: string;
          event_uid?: string;
          calendar_name?: string;
          start_time?: string;
        };
        if (payload?.hidden_id) {
          deleteLocalHiddenEvent(payload.hidden_id);
        }
        if (payload?.event_uid && payload.calendar_name && payload.start_time) {
          hiddenEventKeysRef.current.delete(
            buildHiddenKey(payload.event_uid, payload.calendar_name, payload.start_time),
          );
        }
        if (!payload?.start_time) return;
        const date = payload.start_time.split('T')[0];
        const start = new Date(`${date}T12:00:00`);
        const end = new Date(`${date}T12:00:00`);
        loadEventsForRange(start, end, isOnline);
      }
    };

    window.addEventListener('meal-planner-realtime', handleRealtime as EventListener);
    return () => {
      window.removeEventListener('meal-planner-realtime', handleRealtime as EventListener);
    };
  }, []);

  const removeEventById = (eventId: string, persistLocal = true) => {
    setDays(prev => prev.map(day => {
      const nextEvents = day.events.filter(event => event.id !== eventId);
      if (nextEvents.length === day.events.length) return day;
      const updated = { ...day, events: nextEvents };
      daysCache.current.set(day.date, updated);
      if (persistLocal) {
        saveLocalCalendarEvents(day.date, nextEvents);
      }
      return updated;
    }));
  };

  const handleHideEvent = async (event: CalendarEvent) => {
    if (!event.id || !event.start_time) return;
    if (lastHiddenEventRef.current === event.id) return;
    lastHiddenEventRef.current = event.id;
    try {
      const eventUid = event.uid ?? event.id;
      const calendarName = event.calendar_name ?? '';
      const payload = {
        event_uid: eventUid,
        calendar_name: calendarName,
        title: event.title,
        start_time: event.start_time,
        end_time: event.end_time,
        all_day: event.all_day,
      };

      if (!isOnline) {
        const tempId = generateTempId();
        const eventDate = event.start_time.split('T')[0];
        hiddenEventKeysRef.current.add(buildHiddenKey(eventUid, calendarName, event.start_time));
        await saveLocalHiddenEvent({
          id: tempId,
          event_uid: eventUid,
          event_date: eventDate,
          calendar_name: calendarName,
          title: event.title,
          start_time: event.start_time,
          end_time: event.end_time ?? null,
          all_day: event.all_day,
        });
        await queueChange('calendar-hide', eventDate, { tempId, ...payload });
        removeEventById(event.id, false);
        window.dispatchEvent(new CustomEvent('meal-planner-hidden-updated', { detail: { date: eventDate } }));
        return;
      }

      const hidden = await hideCalendarEvent(payload);
      hiddenEventKeysRef.current.add(buildHiddenKey(hidden.event_uid, hidden.calendar_name, hidden.start_time));
      await saveLocalHiddenEvent({ ...hidden, updatedAt: Date.now() });
      removeEventById(event.id, false);
    } catch (error) {
      console.error('Failed to hide event:', error);
    } finally {
      setTimeout(() => {
        if (lastHiddenEventRef.current === event.id) {
          lastHiddenEventRef.current = null;
        }
      }, 300);
    }
  };

  const loadPreviousWeek = async () => {
    if (loadingMore) return;
    setLoadingMore('prev');
    const newStart = addDays(displayStartRef.current, -7);
    const newEnd = addDays(displayStartRef.current, -1);
    const startStr = formatDate(newStart);
    const endStr = formatDate(newEnd);

    // Check which dates we have in memory cache
    const daysFromMemCache: DayData[] = [];
    for (let d = new Date(newStart); d <= newEnd; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDate(d);
      const cached = daysCache.current.get(dateStr);
      if (cached) {
        daysFromMemCache.push(cached);
      }
    }

    // Helper to add days to display
    const addDaysToDisplay = (newDays: DayData[]) => {
      setDays(prev => {
        const existingMap = new Map(prev.map(d => [d.date, d]));
        newDays.forEach(d => existingMap.set(d.date, d));
        return Array.from(existingMap.values()).sort((a, b) => a.date.localeCompare(b.date));
      });
      displayStartRef.current = newStart;
    };

    // Helper to load from local cache (IndexedDB)
    const loadFromLocalCache = async () => {
      // First check memory cache
      if (daysFromMemCache.length === 7) {
        addDaysToDisplay(daysFromMemCache);
        return true;
      }
      // Then try IndexedDB
      try {
        const localNotes = await getLocalNotesForRange(startStr, endStr);
        const data = localNotesToDayData(localNotes, startStr, endStr);
        data.forEach(d => daysCache.current.set(d.date, d));
        addDaysToDisplay(data);
        return true;
      } catch (dbError) {
        console.error('Failed to load from IndexedDB:', dbError);
        // Last resort: use partial memory cache
        if (daysFromMemCache.length > 0) {
          addDaysToDisplay(daysFromMemCache);
          return true;
        }
        return false;
      }
    };

    try {
      if (isOnline) {
        // Online: try API first
        const requestStart = perfNow();
        const data = await getDays(startStr, endStr);
        logDuration('calendar.days.request', requestStart, { start: startStr, end: endStr });

        // Update memory cache and IndexedDB
        data.forEach(d => {
          daysCache.current.set(d.date, d);
          if (d.meal_note) {
            saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
          }
        });

        const renderStart = perfNow();
        addDaysToDisplay(data);
        enqueueRenderLog('calendar.days.render', renderStart, { count: data.length, direction: 'prev' });
        loadEventsForRange(newStart, newEnd, true);
      } else {
        // Offline: use local cache
        await loadFromLocalCache();
        // Also load events from local cache (offline mode - instant)
        loadEventsForRange(newStart, newEnd, false);
      }
    } catch (error) {
      console.error('Failed to load previous week from API, trying local cache:', error);
      // API failed - try local cache
      await loadFromLocalCache();
      // Also try to load events from local cache (offline mode - instant)
      loadEventsForRange(newStart, newEnd, false);
    } finally {
      setLoadingMore(null);
    }
  };

  const loadNextWeek = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore('next');
    const newStart = addDays(displayEndRef.current, 1);
    const newEnd = addDays(displayEndRef.current, 7);
    const startStr = formatDate(newStart);
    const endStr = formatDate(newEnd);

    // Check which dates we have in memory cache
    const daysFromMemCache: DayData[] = [];
    for (let d = new Date(newStart); d <= newEnd; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDate(d);
      const cached = daysCache.current.get(dateStr);
      if (cached) {
        daysFromMemCache.push(cached);
      }
    }

    // Helper to add days to display
    const addDaysToDisplay = (newDays: DayData[]) => {
      setDays(prev => {
        const existingMap = new Map(prev.map(d => [d.date, d]));
        newDays.forEach(d => existingMap.set(d.date, d));
        return Array.from(existingMap.values()).sort((a, b) => a.date.localeCompare(b.date));
      });
      displayEndRef.current = newEnd;
    };

    // Helper to load from local cache (IndexedDB)
    const loadFromLocalCache = async () => {
      // First check memory cache
      if (daysFromMemCache.length === 7) {
        addDaysToDisplay(daysFromMemCache);
        return true;
      }
      // Then try IndexedDB
      try {
        const localNotes = await getLocalNotesForRange(startStr, endStr);
        const data = localNotesToDayData(localNotes, startStr, endStr);
        data.forEach(d => daysCache.current.set(d.date, d));
        addDaysToDisplay(data);
        return true;
      } catch (dbError) {
        console.error('Failed to load from IndexedDB:', dbError);
        // Last resort: use partial memory cache
        if (daysFromMemCache.length > 0) {
          addDaysToDisplay(daysFromMemCache);
          return true;
        }
        return false;
      }
    };

    try {
      if (isOnline) {
        // Online: try API first
        const requestStart = perfNow();
        const data = await getDays(startStr, endStr);
        logDuration('calendar.days.request', requestStart, { start: startStr, end: endStr });

        // Update memory cache and IndexedDB
        data.forEach(d => {
          daysCache.current.set(d.date, d);
          if (d.meal_note) {
            saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
          }
        });

        const renderStart = perfNow();
        addDaysToDisplay(data);
        enqueueRenderLog('calendar.days.render', renderStart, { count: data.length, direction: 'next' });
        loadEventsForRange(newStart, newEnd, true);
      } else {
        // Offline: use local cache
        await loadFromLocalCache();
        // Also load events from local cache (offline mode - instant)
        loadEventsForRange(newStart, newEnd, false);
      }
    } catch (error) {
      console.error('Failed to load next week from API, trying local cache:', error);
      // API failed - try local cache
      await loadFromLocalCache();
      // Also try to load events from local cache (offline mode - instant)
      loadEventsForRange(newStart, newEnd, false);
    } finally {
      setLoadingMore(null);
    }
  }, [loadingMore, loadEventsForRange, isOnline]);

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
    // Get existing items BEFORE updating state
    const existing = days.find(d => d.date === date);
    const existingItems = existing?.meal_note?.items || [];

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

    // Also update cache
    const cachedDay = daysCache.current.get(date);
    if (cachedDay) {
      daysCache.current.set(date, {
        ...cachedDay,
        meal_note: cachedDay.meal_note
          ? { ...cachedDay.meal_note, notes }
          : { id: '', date, notes, items: [], updated_at: new Date().toISOString() }
      });
    }

    // Save locally with existing items preserved
    await saveLocalNote(date, notes, existingItems);

    if (isOnline) {
      try {
        const updated = await updateNotes(date, notes);
        setDays(prev => prev.map(d => d.date === date ? { ...d, meal_note: updated } : d));
        // Update cache with server response
        const day = daysCache.current.get(date);
        if (day) {
          daysCache.current.set(date, { ...day, meal_note: updated });
        }
        // Also update local DB with server response
        if (updated) {
          await saveLocalNote(date, updated.notes, updated.items);
        }
      } catch (error) {
        console.error('Failed to save notes:', error);
        await queueChange('notes', date, { notes });
      }
    } else {
      await queueChange('notes', date, { notes });
    }
  };

  const handleToggleItemized = async (date: string, lineIndex: number, itemized: boolean) => {
    // Get current day data for updating local DB
    const currentDay = days.find(d => d.date === date);
    const currentNotes = currentDay?.meal_note?.notes || '';
    const currentItems = [...(currentDay?.meal_note?.items || [])];

    // Calculate new items
    const existingIndex = currentItems.findIndex(i => i.line_index === lineIndex);
    if (existingIndex >= 0) {
      currentItems[existingIndex] = { ...currentItems[existingIndex], itemized };
    } else {
      currentItems.push({ line_index: lineIndex, itemized });
    }

    // Optimistic update
    setDays(prev => prev.map(d => {
      if (d.date === date && d.meal_note) {
        return { ...d, meal_note: { ...d.meal_note, items: currentItems } };
      }
      return d;
    }));

    // Update cache
    const cachedDay = daysCache.current.get(date);
    if (cachedDay && cachedDay.meal_note) {
      daysCache.current.set(date, {
        ...cachedDay,
        meal_note: { ...cachedDay.meal_note, items: currentItems }
      });
    }

    // Save to local DB
    await saveLocalNote(date, currentNotes, currentItems);

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

  // Drag and drop handlers
  const handleDragStart = useCallback((date: string) => {
    setIsDragActive(true);
    setDragSourceDate(date);
  }, []);

  const handleDragEnd = useCallback(() => {
    setIsDragActive(false);
    setDragSourceDate(null);
  }, []);

  const handleMoveMeal = useCallback(async (targetDate: string, sourceDate: string, lineIndex: number, html: string) => {
    // Find source and target days
    const sourceDay = days.find(d => d.date === sourceDate);
    const targetDay = days.find(d => d.date === targetDate);

    if (!sourceDay) return;

    // Get source notes and split into lines
    const sourceNotes = sourceDay.meal_note?.notes || '';
    const sourceLines = splitHtmlLines(sourceNotes);

    // Make sure the line index is valid
    if (lineIndex < 0 || lineIndex >= sourceLines.length) return;

    // Check if the moved item was itemized
    const sourceItems = sourceDay.meal_note?.items || [];
    const movedItemStatus = sourceItems.find(item => item.line_index === lineIndex);
    const wasItemized = movedItemStatus?.itemized ?? false;

    // Update source items: remove the moved item and reindex remaining items
    const newSourceItems = sourceItems
      .filter(item => item.line_index !== lineIndex)
      .map(item => ({
        ...item,
        line_index: item.line_index > lineIndex ? item.line_index - 1 : item.line_index
      }));

    // Remove line from source
    const newSourceLines = sourceLines.filter((_, i) => i !== lineIndex);
    const newSourceNotes = joinHtmlLines(newSourceLines);

    // Add line to target
    const targetNotes = targetDay?.meal_note?.notes || '';
    const targetLines = splitHtmlLines(targetNotes);
    const newTargetLineIndex = targetLines.length; // The new item will be at the end
    targetLines.push(html);
    const newTargetNotes = joinHtmlLines(targetLines);

    // Update target items: add the moved item's itemized status if it was itemized
    const targetItems = targetDay?.meal_note?.items || [];
    const newTargetItems = wasItemized
      ? [...targetItems, { line_index: newTargetLineIndex, itemized: true }]
      : targetItems;

    // Optimistic update for both days
    setDays(prev => prev.map(d => {
      if (d.date === sourceDate) {
        const updated = {
          ...d,
          meal_note: d.meal_note
            ? { ...d.meal_note, notes: newSourceNotes, items: newSourceItems }
            : null
        };
        // Also update cache
        daysCache.current.set(sourceDate, updated);
        return updated;
      }
      if (d.date === targetDate) {
        const updated = {
          ...d,
          meal_note: d.meal_note
            ? { ...d.meal_note, notes: newTargetNotes, items: newTargetItems }
            : { id: '', date: targetDate, notes: newTargetNotes, items: newTargetItems, updated_at: new Date().toISOString() }
        };
        // Also update cache
        daysCache.current.set(targetDate, updated);
        return updated;
      }
      return d;
    }));

    // Save both updates locally
    await saveLocalNote(sourceDate, newSourceNotes, newSourceItems);
    await saveLocalNote(targetDate, newTargetNotes, newTargetItems);

    if (isOnline) {
      try {
        // Update notes for both days in parallel
        const [updatedSource, updatedTarget] = await Promise.all([
          updateNotes(sourceDate, newSourceNotes),
          updateNotes(targetDate, newTargetNotes),
        ]);

        // If the item was itemized, update the itemized status on the target
        if (wasItemized) {
          await toggleItemized(targetDate, newTargetLineIndex, true);
        }

        setDays(prev => prev.map(d => {
          if (d.date === sourceDate) {
            const updated = { ...d, meal_note: { ...updatedSource, items: newSourceItems } };
            daysCache.current.set(sourceDate, updated);
            return updated;
          }
          if (d.date === targetDate) {
            const updated = { ...d, meal_note: { ...updatedTarget, items: newTargetItems } };
            daysCache.current.set(targetDate, updated);
            return updated;
          }
          return d;
        }));
      } catch (error) {
        console.error('Failed to move meal:', error);
        // Queue changes for later sync
        await queueChange('notes', sourceDate, { notes: newSourceNotes });
        await queueChange('notes', targetDate, { notes: newTargetNotes });
        if (wasItemized) {
          await queueChange('itemized', targetDate, { lineIndex: newTargetLineIndex, itemized: true });
        }
      }
    } else {
      // Queue for offline sync
      await queueChange('notes', sourceDate, { notes: newSourceNotes });
      await queueChange('notes', targetDate, { notes: newTargetNotes });
      if (wasItemized) {
        await queueChange('itemized', targetDate, { lineIndex: newTargetLineIndex, itemized: true });
      }
    }

    // Clear drag state
    setIsDragActive(false);
    setDragSourceDate(null);
  }, [days, isOnline]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="calendar-loading" aria-label="Loading calendar">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className={compactView ? 'space-y-1' : 'space-y-4'}>
      {/* Load Previous Week Button */}
      <button
        onClick={loadPreviousWeek}
        disabled={loadingMore === 'prev'}
        className={`
          w-full font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 transition-colors
          ${compactView ? 'py-1.5 text-xs' : 'py-3 text-sm'}
        `}
      >
        {loadingMore === 'prev' ? (
          <span className="flex items-center justify-center gap-2">
            <svg className={`animate-spin ${compactView ? 'h-3 w-3' : 'h-4 w-4'}`} fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Loading...
          </span>
        ) : (
          compactView ? 'Load previous' : 'Load previous week'
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
            onHideEvent={handleHideEvent}
            eventsLoading={loadingEvents && day.events.length === 0}
            showItemizedColumn={showItemizedColumn}
            compactView={compactView}
            showAllEvents={showAllEvents}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDrop={handleMoveMeal}
            isDragActive={isDragActive}
            dragSourceDate={dragSourceDate}
          />
        </div>
      ))}

      {/* Infinite scroll trigger / loading indicator */}
      <div ref={bottomRef} className={`flex items-center justify-center ${compactView ? 'py-2' : 'py-4'}`}>
        {loadingMore === 'next' ? (
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <svg className={`animate-spin ${compactView ? 'h-4 w-4' : 'h-5 w-5'}`} fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm">Loading more...</span>
          </div>
        ) : (
          <div className={compactView ? 'h-2' : 'h-4'} />
        )}
      </div>
    </div>
  );
}
