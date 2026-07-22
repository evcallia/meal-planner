import { useState, useEffect, useCallback, useRef } from 'react';
import { getSettings, putSettings } from '../api/client';
import { useOnlineStatus } from './useOnlineStatus';

export interface Settings {
  // Which tabs (features) exist in the UI — per-user, synced. Purely visual:
  // SSE/cache warming for hidden tabs keeps running. The UI enforces that at
  // least one stays enabled; missing keys count as enabled (safe default).
  featureMeals: boolean;
  featurePantry: boolean;
  featureGrocery: boolean;
  featureLists: boolean;
  showItemizedColumn: boolean;
  showMealIdeas: boolean;
  compactView: boolean;
  textScaleStandard: number;
  textScaleCompact: number;
  showAllEvents: boolean;
  showHolidays: boolean;
  holidayColor: string;
  calendarColor: string;
  editHighlightColor: string;
  // Per-category push notification preferences. The server reads these from
  // user_settings when dispatching (backend/app/push.py PREF_KEYS) — the key
  // names must match. The master on/off is the device's push subscription.
  notifyMealEdits: boolean;
  notifyPantryEdits: boolean;
  notifyGroceryEdits: boolean;
  notifyListEdits: boolean;
  notifyListsDue: boolean;
  // Re-notify daily (max once per 24h) while a task stays due.
  notifyListsDueRepeat: boolean;
  // Daily digest: ONE summary of everything due at a configured local time,
  // instead of alerts as tasks become due. Timezone recorded from the client
  // (IANA name) so the server can honor local time.
  notifyListsDueDigest: boolean;
  notifyListsDueDigestTime: string;
  notifyTimeZone: string;
  // Per-list overrides of the two toggles above, keyed by tracker list id.
  // Missing key/field = inherit the global toggle. The server reads these
  // when dispatching (prefEnabled in backend internal/push).
  listNotifyOverrides: Record<string, { edits?: boolean; due?: boolean }>;
  // Per-task mute of due reminders, keyed by task id (absent = inherit).
  taskNotifyOverrides: Record<string, { due?: boolean }>;
  // Grocery store chip filter — synced per-user so the filter survives app
  // restarts (iOS may evict localStorage) and follows you across devices.
  grocerySelectedStoreIds: string[];
  groceryExcludedStoreIds: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  featureMeals: true,
  featurePantry: true,
  featureGrocery: true,
  featureLists: true,
  showItemizedColumn: true,
  showMealIdeas: true,
  compactView: false,
  textScaleStandard: 1,
  textScaleCompact: 1,
  showAllEvents: false,
  showHolidays: true,
  holidayColor: 'red',
  calendarColor: 'amber',
  editHighlightColor: 'emerald',
  // Notifications are strictly opt-in: everything off until explicitly
  // enabled. These gate pushes AND the bell/activity feed (server-enforced).
  notifyMealEdits: false,
  notifyPantryEdits: false,
  notifyGroceryEdits: false,
  notifyListEdits: false,
  notifyListsDue: false,
  notifyListsDueRepeat: false,
  notifyListsDueDigest: false,
  notifyListsDueDigestTime: '08:00',
  notifyTimeZone: '',
  listNotifyOverrides: {},
  taskNotifyOverrides: {},
  grocerySelectedStoreIds: [],
  groceryExcludedStoreIds: [],
};

const STORAGE_KEY = 'meal-planner-settings';

interface StoredSettings {
  settings: Settings;
  updated_at: string | null;
}

function loadFromLocalStorage(): StoredSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migration: old format was just the settings object (no updated_at wrapper)
      if (parsed && typeof parsed === 'object' && !('settings' in parsed && 'updated_at' in parsed)) {
        // Old format — wrap it
        return { settings: { ...DEFAULT_SETTINGS, ...parsed }, updated_at: null };
      }
      return { settings: { ...DEFAULT_SETTINGS, ...parsed.settings }, updated_at: parsed.updated_at };
    }
  } catch {
    // Ignore parse errors
  }
  return { settings: DEFAULT_SETTINGS, updated_at: null };
}

function saveToLocalStorage(settings: Settings, updatedAt: string | null): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, updated_at: updatedAt }));
  } catch {
    // Ignore storage errors
  }
}

export function useSettings() {
  const initial = loadFromLocalStorage();
  const [settings, setSettings] = useState<Settings>(initial.settings);
  const updatedAtRef = useRef<string | null>(initial.updated_at);
  const isOnline = useOnlineStatus();
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;
  const syncedRef = useRef(false);

  // Sync with server on mount (and when coming back online)
  useEffect(() => {
    if (!isOnline || syncedRef.current) return;

    let cancelled = false;

    (async () => {
      try {
        const server = await getSettings();
        if (cancelled) return;

        const localTime = updatedAtRef.current ? new Date(updatedAtRef.current).getTime() : 0;
        const serverTime = server.updated_at ? new Date(server.updated_at).getTime() : 0;

        if (serverTime > localTime) {
          // Server is newer — apply server settings
          const merged = { ...DEFAULT_SETTINGS, ...server.settings } as Settings;
          setSettings(merged);
          updatedAtRef.current = server.updated_at;
          saveToLocalStorage(merged, server.updated_at);
        } else if (localTime > serverTime) {
          // Local is newer — push to server
          try {
            await putSettings(settings as unknown as Record<string, unknown>, updatedAtRef.current!);
          } catch {
            // Will retry on next sync
          }
        }
        // Equal — no action needed
        syncedRef.current = true;
      } catch {
        // Offline or server error — continue with localStorage settings
      }
    })();

    return () => { cancelled = true; };
  }, [isOnline]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for SSE settings.updated events from other sessions
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.type !== 'settings.updated') return;

      const payload = detail.payload as { settings: Record<string, unknown>; updated_at: string };
      if (!payload?.updated_at) return;

      const incomingTime = new Date(payload.updated_at).getTime();
      const localTime = updatedAtRef.current ? new Date(updatedAtRef.current).getTime() : 0;

      if (incomingTime > localTime) {
        const merged = { ...DEFAULT_SETTINGS, ...payload.settings } as Settings;
        setSettings(merged);
        updatedAtRef.current = payload.updated_at;
        saveToLocalStorage(merged, payload.updated_at);
      }
    };

    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
  }, []);

  const updateSettings = useCallback((updates: Partial<Settings>) => {
    setSettings(prev => {
      // Keep the recorded timezone fresh on every save — the server needs it
      // for the daily digest, and travel/DST/stale blobs shouldn't strand it.
      let tz = prev.notifyTimeZone;
      try {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
      } catch { /* keep previous */ }
      const next = { ...prev, ...updates, notifyTimeZone: tz || '' };
      const now = new Date().toISOString();
      updatedAtRef.current = now;
      saveToLocalStorage(next, now);

      // Fire-and-forget server save
      if (isOnlineRef.current) {
        putSettings(next as unknown as Record<string, unknown>, now).catch(() => {
          // Will sync on next reconnect
        });
      }

      return next;
    });
  }, []);

  return { settings, updateSettings };
}
