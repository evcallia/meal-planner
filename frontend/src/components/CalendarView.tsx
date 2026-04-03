import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { CalendarEvent, DayData } from '../types';
import { DayCard } from './DayCard';
import { getDays, getEvents, updateNotes, toggleItemized, hideCalendarEvent, unhideCalendarEvent, getHiddenCalendarEvents } from '../api/client';
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
  saveLocalHiddenEvents,
  clearLocalHiddenEvents,
  deleteLocalHiddenEvent,
  generateTempId,
  isTempId,
  getTempIdMapping,
} from '../db';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useUndo } from '../contexts/UndoContext';
import { scrollToElementWithOffset } from '../utils/scroll';
import { isPerfEnabled, logDuration, logRenderDuration, perfNow } from '../utils/perf';
import { decodeHtmlEntities } from '../utils/html';

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
    .replace(/<\/div>\s*<div>/gi, '\n')
    .replace(/<div>/gi, '\n')
    .replace(/<\/div>/gi, '')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '');

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

let sessionLoaded = false;
// Track the pre-fetched date range so loadNext/PrevWeek can skip API calls within it
let prefetchedStart: string | null = null;
let prefetchedEnd: string | null = null;
export function resetCalendarSessionLoaded() { sessionLoaded = false; prefetchedStart = null; prefetchedEnd = null; }
export function markCalendarSessionLoaded() { sessionLoaded = true; }

interface CalendarViewProps {
  onTodayRefReady: (ref: HTMLDivElement | null) => void;
  showItemizedColumn?: boolean;
  compactView?: boolean;
  showAllEvents?: boolean;
  showHolidays?: boolean;
  holidayColor?: string;
  calendarColor?: string;
}

// Track which date ranges have finished loading events
type EventsLoadState = 'loading' | 'loaded' | 'error';

export function CalendarView({ onTodayRefReady, showItemizedColumn = true, compactView = false, showAllEvents = false, showHolidays = true, holidayColor = 'red', calendarColor = 'amber' }: CalendarViewProps) {
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
  const { pushAction } = useUndo();
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
  const showHolidaysRef = useRef(showHolidays);
  useEffect(() => {
    showHolidaysRef.current = showHolidays;
  }, [showHolidays]);
  const refreshHiddenKeys = useCallback(async () => {
    const hidden = await getLocalHiddenEvents();
    hiddenEventKeysRef.current = new Set(
      hidden.map(item => buildHiddenKey(item.event_uid, item.calendar_name, item.start_time)),
    );
  }, []);

  // Cross-day drag state
  const [crossDrag, setCrossDrag] = useState<{
    sourceDate: string;
    targetDate: string;
    targetIndex: number;
    itemHeight: number;
  } | null>(null);

  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('meal-planner-calendar-collapsed');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  const toggleWeekCollapsed = useCallback((weekKey: string) => {
    setCollapsedWeeks(prev => {
      const next = new Set(prev);
      if (next.has(weekKey)) next.delete(weekKey);
      else next.add(weekKey);
      try { localStorage.setItem('meal-planner-calendar-collapsed', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const today = useRef(formatDate(new Date())).current;

  // Group days into weeks (Sunday-based)
  const weekGroups = useMemo(() => {
    const groups: { key: string; label: string; days: DayData[] }[] = [];
    const todayDate = new Date(today + 'T00:00:00');
    const todaySunday = new Date(todayDate);
    todaySunday.setDate(todayDate.getDate() - todayDate.getDay());

    for (const day of days) {
      const date = new Date(day.date + 'T00:00:00');
      const sunday = new Date(date);
      sunday.setDate(date.getDate() - date.getDay());
      const weekKey = formatDate(sunday);

      if (groups.length === 0 || groups[groups.length - 1].key !== weekKey) {
        // Determine label
        const diff = Math.round((sunday.getTime() - todaySunday.getTime()) / (7 * 24 * 60 * 60 * 1000));
        let label: string;
        if (diff === 0) label = 'This Week';
        else if (diff === 1) label = 'Next Week';
        else if (diff === -1) label = 'Last Week';
        else if (diff > 1) label = `${diff} Weeks Out`;
        else label = `${Math.abs(diff)} Weeks Ago`;

        groups.push({ key: weekKey, label, days: [day] });
      } else {
        groups[groups.length - 1].days.push(day);
      }
    }
    return groups;
  }, [days, today]);

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

  const compareEvents = (a: CalendarEvent, b: CalendarEvent): number => {
    const aHoliday = a.calendar_name === 'US Holidays' ? 0 : 1;
    const bHoliday = b.calendar_name === 'US Holidays' ? 0 : 1;
    if (aHoliday !== bHoliday) return aHoliday - bHoliday;
    return (a.start_time ?? '').localeCompare(b.start_time ?? '');
  };

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
          const dayEvents = (filteredEventsMap[day.date] || []).sort(compareEvents);
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
          return true;
        }
      } catch (dbError) {
        console.error('Failed to load events from IndexedDB:', dbError);
      }
      return false;
    };

    // 1. Load from cache immediately
    await loadFromIndexedDB();

    // 2. If online, fetch from API in background
    if (online) {
      try {
        const requestStart = perfNow();
        const eventsMap = await getEvents(startStr, endStr, true, showHolidaysRef.current);
        logDuration('calendar.events.request', requestStart, { start: startStr, end: endStr });

        for (const [date, events] of Object.entries(eventsMap)) {
          saveLocalCalendarEvents(date, events);
        }

        applyEvents(eventsMap);
      } catch (error) {
        console.error('Failed to load events from API:', error);
      }
    }

    setLoadingEvents(false);
  }, []);

  useEffect(() => {
    refreshHiddenKeys();
    const handleHiddenUpdated = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        date?: string;
        end_time?: string | null;
        all_day?: boolean;
      } | undefined;
      refreshHiddenKeys().then(() => {
        if (detail?.date) {
          const startDate = detail.date;
          let endDate = startDate;
          if (detail.end_time) {
            endDate = detail.end_time.split('T')[0];
            if (detail.all_day && endDate > startDate) {
              const d = new Date(endDate + 'T12:00:00');
              d.setDate(d.getDate() - 1);
              endDate = d.toISOString().split('T')[0];
            }
          }
          const start = new Date(`${startDate}T12:00:00`);
          const end = new Date(`${endDate}T12:00:00`);
          loadEventsForRange(start, end, isOnline);
        }
      });
    };
    window.addEventListener('meal-planner-hidden-updated', handleHiddenUpdated as EventListener);
    return () => {
      window.removeEventListener('meal-planner-hidden-updated', handleHiddenUpdated as EventListener);
    };
  }, [isOnline, loadEventsForRange, refreshHiddenKeys]);

  // Reload events when showAllEvents or showHolidays setting changes (not on mount)
  const prevShowAllEventsRef = useRef(showAllEvents);
  const prevShowHolidaysRef = useRef(showHolidays);
  useEffect(() => {
    if (!initialLoadDone.current) return;
    if (showAllEvents === prevShowAllEventsRef.current && showHolidays === prevShowHolidaysRef.current) return;
    prevShowAllEventsRef.current = showAllEvents;
    prevShowHolidaysRef.current = showHolidays;
    // Reset ALL load states to force fresh reload
    setEventsLoadState({});
    // Force online fetch if available to get fresh data with correct include_hidden / include_holidays
    loadEventsForRange(displayStartRef.current, displayEndRef.current, isOnline);
  }, [showAllEvents, showHolidays, loadEventsForRange, isOnline]);

  // Initial load - use ref to prevent double load in StrictMode
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;

    const init = async () => {
      setLoading(true);
      const startStr = formatDate(displayStartRef.current);
      const endStr = formatDate(displayEndRef.current);

      // 1. Load from cache immediately (generate day structure even if no notes cached)
      try {
        const localNotes = await getLocalNotesForRange(startStr, endStr);
        const data = localNotesToDayData(localNotes, startStr, endStr);
        setDays(data);
        data.forEach(d => daysCache.current.set(d.date, d));
        setLoading(false);

        // Load events from cache too
        loadEventsForRange(displayStartRef.current, displayEndRef.current, false);
      } catch { /* cache failed — will try API */ }

      // 2. If online, fetch from API in background (skip on remount — SSE keeps cache warm)
      //    Single request covers display range + prefetch range (past 2 weeks, future 8 weeks)
      if (isOnline && !sessionLoaded) {
        try {
          const fullStart = addDays(new Date(), -14);
          const fullEnd = addDays(new Date(), 56);
          const fullStartStr = formatDate(fullStart);
          const fullEndStr = formatDate(fullEnd);

          const requestStart = perfNow();
          const allData = await getDays(fullStartStr, fullEndStr);
          logDuration('calendar.days.request', requestStart, {
            start: fullStartStr,
            end: fullEndStr,
          });

          // Split: display range gets rendered, rest goes to cache only
          const displayData = allData.filter(d => d.date >= startStr && d.date <= endStr);
          const renderStart = perfNow();
          setDays(prev => {
            const prevEventsMap = new Map(prev.map(d => [d.date, d.events]));
            return displayData.map(d => ({
              ...d,
              events: d.events.length > 0 ? d.events : (prevEventsMap.get(d.date) ?? []),
            }));
          });
          enqueueRenderLog('calendar.days.render', renderStart, { count: displayData.length });

          // Cache all days (display + prefetch)
          allData.forEach(d => {
            daysCache.current.set(d.date, d);
            if (d.meal_note) {
              saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
            }
          });

          // Sync hidden events from server to IndexedDB for offline use
          try {
            const remoteHidden = await getHiddenCalendarEvents();
            await clearLocalHiddenEvents();
            await saveLocalHiddenEvents(remoteHidden);
            hiddenEventKeysRef.current = new Set(
              remoteHidden.map(item => buildHiddenKey(item.event_uid, item.calendar_name, item.start_time)),
            );
          } catch { /* hidden events sync failed — keep local */ }

          // Single events fetch for the full range
          loadEventsForRange(fullStart, fullEnd, true);
          backgroundCacheDone.current = true;
          prefetchedStart = fullStartStr;
          prefetchedEnd = fullEndStr;
          sessionLoaded = true;
        } catch (error) {
          console.error('Failed to load days from API:', error);
        }
      }

      setLoading(false);
    };
    init();
  }, [loadEventsForRange, isOnline]);

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
          end_time?: string | null;
          all_day?: boolean;
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
        const startDate = payload.start_time.split('T')[0];
        let endDate = startDate;
        if (payload.end_time) {
          endDate = payload.end_time.split('T')[0];
          // All-day events: end date is exclusive per iCal spec
          if (payload.all_day && endDate > startDate) {
            const d = new Date(endDate + 'T12:00:00');
            d.setDate(d.getDate() - 1);
            endDate = d.toISOString().split('T')[0];
          }
        }
        const start = new Date(`${startDate}T12:00:00`);
        const end = new Date(`${endDate}T12:00:00`);
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

  const getEventDates = (event: CalendarEvent): Set<string> => {
    const startDate = event.start_time!.split('T')[0];
    const dates = new Set<string>([startDate]);
    if (event.end_time) {
      let endDate = event.end_time.split('T')[0];
      // All-day events: end date is exclusive per iCal spec
      if (event.all_day && endDate > startDate) {
        const d = new Date(endDate + 'T12:00:00');
        d.setDate(d.getDate() - 1);
        endDate = d.toISOString().split('T')[0];
      }
      const cur = new Date(startDate + 'T12:00:00');
      const end = new Date(endDate + 'T12:00:00');
      while (cur <= end) {
        dates.add(cur.toISOString().split('T')[0]);
        cur.setDate(cur.getDate() + 1);
      }
    }
    return dates;
  };

  const restoreEventToDay = (event: CalendarEvent) => {
    const eventDates = getEventDates(event);
    setDays(prev => prev.map(day => {
      if (!eventDates.has(day.date)) return day;
      const events = [...day.events, event].sort(compareEvents);
      const updated = { ...day, events };
      daysCache.current.set(day.date, updated);
      saveLocalCalendarEvents(day.date, events);
      return updated;
    }));
  };

  const doHideEvent = async (event: CalendarEvent): Promise<string> => {
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
    const hiddenKey = buildHiddenKey(eventUid, calendarName, event.start_time!);

    if (!isOnline) {
      const tempId = generateTempId();
      const eventDate = event.start_time!.split('T')[0];
      hiddenEventKeysRef.current.add(hiddenKey);
      await saveLocalHiddenEvent({
        id: tempId,
        event_uid: eventUid,
        event_date: eventDate,
        calendar_name: calendarName,
        title: event.title,
        start_time: event.start_time!,
        end_time: event.end_time ?? null,
        all_day: event.all_day,
      });
      await queueChange('calendar-hide', eventDate, { tempId, ...payload });
      removeEventById(event.id!, false);
      window.dispatchEvent(new CustomEvent('meal-planner-hidden-updated', { detail: { date: eventDate } }));
      return tempId;
    }

    const hidden = await hideCalendarEvent(payload);
    hiddenEventKeysRef.current.add(buildHiddenKey(hidden.event_uid, hidden.calendar_name, hidden.start_time));
    await saveLocalHiddenEvent({ ...hidden, updatedAt: Date.now() });
    removeEventById(event.id!, false);
    return hidden.id;
  };

  const doUnhideEvent = async (event: CalendarEvent, hiddenId: string) => {
    const eventUid = event.uid ?? event.id;
    const calendarName = event.calendar_name ?? '';
    const hiddenKey = buildHiddenKey(eventUid, calendarName, event.start_time!);
    hiddenEventKeysRef.current.delete(hiddenKey);

    if (!isOnline) {
      const eventDate = event.start_time!.split('T')[0];
      await deleteLocalHiddenEvent(hiddenId);
      await queueChange('calendar-unhide', eventDate, { hiddenId });
    } else {
      const realId = isTempId(hiddenId) ? (await getTempIdMapping(hiddenId)) ?? hiddenId : hiddenId;
      await unhideCalendarEvent(realId);
      await deleteLocalHiddenEvent(realId);
    }
    restoreEventToDay(event);
  };

  const handleHideEvent = async (event: CalendarEvent) => {
    if (!event.id || !event.start_time) return;
    if (lastHiddenEventRef.current === event.id) return;
    lastHiddenEventRef.current = event.id;
    try {
      const hiddenIdRef = { current: '' };
      hiddenIdRef.current = await doHideEvent(event);

      pushAction({
        type: 'hide-calendar-event',
        undo: async () => {
          await doUnhideEvent(event, hiddenIdRef.current);
        },
        redo: async () => {
          hiddenIdRef.current = await doHideEvent(event);
        },
      });
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
      // 1. Load from cache immediately
      await loadFromLocalCache();
      loadEventsForRange(newStart, newEnd, false);

      // 2. If online, fetch from API in background (skip if background cache already covers this range)
      const withinPrefetch = prefetchedStart !== null && prefetchedEnd !== null && startStr >= prefetchedStart && endStr <= prefetchedEnd;
      if (isOnline && !withinPrefetch) {
        try {
          const requestStart = perfNow();
          const data = await getDays(startStr, endStr);
          logDuration('calendar.days.request', requestStart, { start: startStr, end: endStr });

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
        } catch (error) {
          console.error('Failed to load previous week from API:', error);
        }
      }
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
      // 1. Load from cache immediately
      await loadFromLocalCache();
      loadEventsForRange(newStart, newEnd, false);

      // 2. If online, fetch from API in background (skip if background cache already covers this range)
      const withinPrefetch = prefetchedStart !== null && prefetchedEnd !== null && startStr >= prefetchedStart && endStr <= prefetchedEnd;
      if (isOnline && !withinPrefetch) {
        try {
          const requestStart = perfNow();
          const data = await getDays(startStr, endStr);
          logDuration('calendar.days.request', requestStart, { start: startStr, end: endStr });

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
        } catch (error) {
          console.error('Failed to load next week from API:', error);
        }
      }
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

  // Internal helper: restore notes+items for a date (used by undo/redo callbacks)
  const restoreNotesAndItems = async (date: string, notes: string, items: { line_index: number; itemized: boolean }[]) => {
    setDays(prev => prev.map(d => {
      if (d.date === date) {
        const updated = {
          ...d,
          meal_note: d.meal_note
            ? { ...d.meal_note, notes, items }
            : { id: '', date, notes, items, updated_at: new Date().toISOString() },
        };
        daysCache.current.set(date, updated);
        return updated;
      }
      return d;
    }));
    await saveLocalNote(date, notes, items);
    if (isOnline) {
      try {
        await updateNotes(date, notes);
        // Sync itemized states — don't queue failures since notes are the source of truth
        // and items are already saved locally. Stale line indices would just clog the sync queue.
        await Promise.all(items.map(item =>
          toggleItemized(date, item.line_index, item.itemized).catch(err =>
            console.warn(`Failed to sync itemized state for ${date} line ${item.line_index}:`, err)
          )
        ));
      } catch {
        await queueChange('notes', date, { notes });
      }
    } else {
      await queueChange('notes', date, { notes });
    }
  };

  const handleNotesChange = async (date: string, notes: string) => {
    // Get existing items BEFORE updating state
    const existing = days.find(d => d.date === date);
    const existingItems = existing?.meal_note?.items || [];

    // Push undo action immediately (called once per edit session on blur)
    const prevNotes = existing?.meal_note?.notes || '';
    const prevItems = [...existingItems];
    if (prevNotes !== notes) {
      pushAction({
        type: 'edit-notes',
        undo: async () => { await restoreNotesAndItems(date, prevNotes, prevItems); },
        redo: async () => { await restoreNotesAndItems(date, notes, existingItems); },
      });
    }

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
    const prevItems = [...(currentDay?.meal_note?.items || [])];
    const currentItems = [...prevItems];

    // Calculate new items
    const existingIndex = currentItems.findIndex(i => i.line_index === lineIndex);
    if (existingIndex >= 0) {
      currentItems[existingIndex] = { ...currentItems[existingIndex], itemized };
    } else {
      currentItems.push({ line_index: lineIndex, itemized });
    }

    // Push undo action
    pushAction({
      type: 'toggle-itemized',
      undo: async () => { await restoreNotesAndItems(date, currentNotes, prevItems); },
      redo: async () => { await restoreNotesAndItems(date, currentNotes, currentItems); },
    });

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

  // Within-day meal reorder handler
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

  // Cross-day drag helpers
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

  const handleMealDragStart = useCallback(() => {
    setCrossDrag(null);
  }, []);

  const handleMoveMeal = useCallback(async (targetDate: string, sourceDate: string, lineIndex: number, html: string, insertAt?: number) => {
    // Find source and target days
    const sourceDay = days.find(d => d.date === sourceDate);
    const targetDay = days.find(d => d.date === targetDate);

    if (!sourceDay) return;

    // Get source notes and split into lines
    const sourceNotes = sourceDay.meal_note?.notes || '';
    const sourceLines = splitHtmlLines(sourceNotes);

    // Make sure the line index is valid
    if (lineIndex < 0 || lineIndex >= sourceLines.length) return;

    // Capture before state for undo
    const prevSourceNotes = sourceNotes;
    const prevSourceItems = [...(sourceDay.meal_note?.items || [])];
    const prevTargetNotes = targetDay?.meal_note?.notes || '';
    const prevTargetItems = [...(targetDay?.meal_note?.items || [])];

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

    // Push undo action
    pushAction({
      type: 'move-meal',
      undo: async () => {
        await restoreNotesAndItems(sourceDate, prevSourceNotes, prevSourceItems);
        await restoreNotesAndItems(targetDate, prevTargetNotes, prevTargetItems);
      },
      redo: async () => {
        await restoreNotesAndItems(sourceDate, newSourceNotes, newSourceItems);
        await restoreNotesAndItems(targetDate, newTargetNotes, newTargetItems);
      },
    });

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

  }, [days, isOnline, pushAction]);

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

  const handleDeleteMeal = useCallback(async (date: string, lineIndex: number) => {
    const day = days.find(d => d.date === date);
    if (!day) return;

    const currentNotes = day.meal_note?.notes || '';
    const lines = splitHtmlLines(currentNotes);
    if (lineIndex < 0 || lineIndex >= lines.length) return;

    const currentItems = [...(day.meal_note?.items || [])];

    // Capture before state for undo
    const prevNotes = currentNotes;
    const prevItems = currentItems;

    // Remove line and reindex items
    const newLines = lines.filter((_, i) => i !== lineIndex);
    const newNotes = joinHtmlLines(newLines);
    const newItems = currentItems
      .filter(item => item.line_index !== lineIndex)
      .map(item => ({
        ...item,
        line_index: item.line_index > lineIndex ? item.line_index - 1 : item.line_index,
      }));

    // Push undo action
    pushAction({
      type: 'delete-meal',
      undo: async () => { await restoreNotesAndItems(date, prevNotes, prevItems); },
      redo: async () => { await restoreNotesAndItems(date, newNotes, newItems); },
    });

    // Optimistic update
    setDays(prev => prev.map(d => {
      if (d.date === date) {
        const updated = {
          ...d,
          meal_note: d.meal_note
            ? { ...d.meal_note, notes: newNotes, items: newItems }
            : null,
        };
        daysCache.current.set(date, updated);
        return updated;
      }
      return d;
    }));

    // Save locally
    await saveLocalNote(date, newNotes, newItems);

    if (isOnline) {
      try {
        const updated = await updateNotes(date, newNotes);
        setDays(prev => prev.map(d => {
          if (d.date === date) {
            const result = { ...d, meal_note: { ...updated, items: newItems } };
            daysCache.current.set(date, result);
            return result;
          }
          return d;
        }));
      } catch (error) {
        console.error('Failed to delete meal:', error);
        await queueChange('notes', date, { notes: newNotes });
      }
    } else {
      await queueChange('notes', date, { notes: newNotes });
    }
  }, [days, isOnline, pushAction]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="calendar-loading" aria-label="Loading calendar">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div>
      {/* Sticky header: Load Previous Week */}
      <div className="sticky z-[9] bg-gray-100 dark:bg-gray-900 -mx-4 px-4 pt-4 pb-2" style={{ top: 'var(--header-h, 52px)' }}>
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
      </div>

      {/* Week Groups with Day Cards */}
      {weekGroups.map(group => {
        const isCollapsed = collapsedWeeks.has(group.key);
        return (
          <div key={group.key} className={compactView ? 'mt-1' : 'mt-4'}>
            {/* Week header */}
            <button
              onClick={() => toggleWeekCollapsed(group.key)}
              className="w-full flex items-center justify-between px-2 py-2 text-sm font-semibold text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              <span>{group.label}</span>
              <svg
                className={`h-4 w-4 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Day cards */}
            {!isCollapsed && (
              <div className={compactView ? 'space-y-1' : 'space-y-4'}>
                {group.days.map(day => (
                  <div key={day.date} data-date={day.date} data-day-date={day.date} ref={day.date === today ? handleTodayRef : undefined}>
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
              </div>
            )}
          </div>
        );
      })}

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
