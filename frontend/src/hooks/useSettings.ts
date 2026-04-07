import { useState, useEffect, useCallback, useRef } from 'react';
import { getSettings, putSettings } from '../api/client';
import { useOnlineStatus } from './useOnlineStatus';

export interface Settings {
  showItemizedColumn: boolean;
  showMealIdeas: boolean;
  compactView: boolean;
  textScaleStandard: number;
  textScaleCompact: number;
  showAllEvents: boolean;
  showHolidays: boolean;
  holidayColor: string;
  calendarColor: string;
}

export const DEFAULT_SETTINGS: Settings = {
  showItemizedColumn: true,
  showMealIdeas: true,
  compactView: false,
  textScaleStandard: 1,
  textScaleCompact: 1,
  showAllEvents: false,
  showHolidays: true,
  holidayColor: 'red',
  calendarColor: 'amber',
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
      const next = { ...prev, ...updates };
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
