import { useState, useEffect, useCallback } from 'react';

export interface Settings {
  showItemizedColumn: boolean;
  showMealIdeas: boolean;
  compactView: boolean;
  textScaleStandard: number;
  textScaleCompact: number;
  showAllEvents: boolean;
  showHolidays: boolean;
  holidayColor: string;
}

const DEFAULT_SETTINGS: Settings = {
  showItemizedColumn: true,
  showMealIdeas: true,
  compactView: false,
  textScaleStandard: 1,
  textScaleCompact: 1,
  showAllEvents: false,
  showHolidays: true,
  holidayColor: 'red',
};

const STORAGE_KEY = 'meal-planner-settings';

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
      }
    } catch {
      // Ignore parse errors
    }
    return DEFAULT_SETTINGS;
  });

  // Persist settings to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const updateSettings = useCallback((updates: Partial<Settings>) => {
    setSettings(prev => ({ ...prev, ...updates }));
  }, []);

  return { settings, updateSettings };
}
