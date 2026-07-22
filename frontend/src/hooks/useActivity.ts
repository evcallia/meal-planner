import { useState, useEffect, useCallback, useRef } from 'react';
import { getActivity, markActivitySeen, ActivityEntry } from '../api/client';
import { Settings } from './useSettings';
import { parseServerDate } from '../utils/recency';
import { useOnlineStatus } from './useOnlineStatus';

const FEED_LIMIT = 100;

// Mirrors the server-side notification cascade (push.NotifyPrefs) for LIVE
// entries — the same effective-value logic the toggle UIs use. Fetched
// entries are filtered server-side; this gates only SSE-appended ones.
export function entryVisible(entry: ActivityEntry, s: Settings): boolean {
  switch (entry.category) {
    case 'meals': return s.notifyMealEdits;
    case 'pantry': return s.notifyPantryEdits;
    case 'grocery': return s.notifyGroceryEdits;
    case 'lists':
      return s.notifyListEdits
        && (entry.list_id ? (s.listNotifyOverrides[entry.list_id]?.edits ?? true) : true);
    case 'list-due':
      return s.notifyListsDue
        && (entry.list_id ? (s.listNotifyOverrides[entry.list_id]?.due ?? true) : true)
        && (entry.task_id ? (s.taskNotifyOverrides[entry.task_id]?.due ?? true) : true);
    default:
      return true;
  }
}

/**
 * The "what happened since I last looked" feed. The server renders each entry
 * (phrasing, attribution, audience) and announces it over SSE
 * (`activity.added`), so live updates append directly with no API call; the
 * fetch path remains for catch-up (launch, reconnect, offline-sync drain, and
 * opening the bell — which reconciles anything missed while SSE was down).
 * `unseenCount` drives the bell badge; `markSeen()` clears it.
 */
export function useActivity(enabled: boolean, ownSub?: string, settings?: Settings) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isOnline = useOnlineStatus();
  const ownSubRef = useRef(ownSub);
  ownSubRef.current = ownSub;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const refetchTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { entries, last_seen } = await getActivity();
      setEntries(entries);
      setLastSeen(last_seen);
    } catch {
      // Offline or error — keep whatever we have
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load once authenticated + online (also fires on reconnect)
  useEffect(() => {
    if (enabled && isOnline) {
      load();
    }
  }, [enabled, isOnline, load]);

  // Catch-up on resume: iOS suspends the SSE connection while the app is
  // backgrounded/locked, and missed `activity.added` events are never
  // replayed — without this, a due reminder that fired while suspended
  // never bumps the badge until the bell is opened.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, load]);

  // Live entries arrive fully rendered over SSE; offline-sync drains still
  // trigger a (debounced) refetch since queued edits replay without events
  // reaching this device in order.
  useEffect(() => {
    if (!enabled) return;

    const scheduleRefetch = () => {
      if (refetchTimerRef.current !== null) window.clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = window.setTimeout(() => {
        refetchTimerRef.current = null;
        load();
      }, 5000);
    };

    const onRealtime = (e: Event) => {
      const detail = (e as CustomEvent).detail as { type?: string; payload?: unknown } | undefined;
      if (detail?.type !== 'activity.added') return;
      const payload = detail.payload as { entry?: ActivityEntry; actor_sub?: string } | undefined;
      const entry = payload?.entry;
      if (!entry?.id) return;
      // Own edits never appear (the global broadcast reaches our other devices)
      if (payload?.actor_sub && payload.actor_sub === ownSubRef.current) return;
      // Same preference cascade the server applies to fetched entries
      const s = settingsRef.current;
      if (s && !entryVisible(entry, s)) return;
      setEntries(prev => {
        if (prev.some(e => e.id === entry.id)) return prev;
        return [entry, ...prev].slice(0, FEED_LIMIT);
      });
    };

    window.addEventListener('meal-planner-realtime', onRealtime);
    window.addEventListener('pending-changes-synced', scheduleRefetch);
    // SSE (re)connected: anything emitted while disconnected was lost —
    // refetch to reconcile (covers server restarts, where the due check
    // fires seconds after boot, before clients have reconnected).
    window.addEventListener('meal-planner-realtime-connected', scheduleRefetch);
    return () => {
      window.removeEventListener('meal-planner-realtime', onRealtime);
      window.removeEventListener('pending-changes-synced', scheduleRefetch);
      window.removeEventListener('meal-planner-realtime-connected', scheduleRefetch);
      if (refetchTimerRef.current !== null) window.clearTimeout(refetchTimerRef.current);
    };
  }, [enabled, load]);

  const seenTime = lastSeen ? parseServerDate(lastSeen) : 0;
  const unseenCount = entries.filter(e => parseServerDate(e.at) > seenTime).length;

  const markSeen = useCallback(async () => {
    try {
      const { seen_at } = await markActivitySeen();
      setLastSeen(seen_at);
    } catch {
      // Offline — the badge clears next time we're online and re-mark
    }
  }, []);

  return { entries, lastSeen, unseenCount, loading, load, markSeen };
}
