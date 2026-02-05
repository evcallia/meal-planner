import { useState, useEffect } from 'react';
import { Settings } from '../hooks/useSettings';
import { getCalendarCacheStatus, refreshCalendarCache, CalendarCacheStatus } from '../api/client';

interface SettingsModalProps {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => void;
  onClose: () => void;
  isDark: boolean;
  onToggleDarkMode: () => void;
}

function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return 'Never';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

export function SettingsModal({ settings, onUpdate, onClose, isDark, onToggleDarkMode }: SettingsModalProps) {
  const [cacheStatus, setCacheStatus] = useState<CalendarCacheStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);

  // Load cache status on mount
  useEffect(() => {
    getCalendarCacheStatus()
      .then(setCacheStatus)
      .catch(console.error);
  }, []);

  // Poll for status while refreshing
  useEffect(() => {
    if (!isRefreshing) return;

    const interval = setInterval(async () => {
      try {
        const status = await getCalendarCacheStatus();
        setCacheStatus(status);
        if (!status.is_refreshing) {
          setIsRefreshing(false);
          setRefreshMessage('Calendar refreshed!');
          setTimeout(() => setRefreshMessage(null), 3000);
        }
      } catch (e) {
        console.error('Failed to poll cache status:', e);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [isRefreshing]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshMessage(null);
    try {
      await refreshCalendarCache();
    } catch (e) {
      console.error('Failed to trigger refresh:', e);
      setIsRefreshing(false);
      setRefreshMessage('Failed to refresh');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Calendar Sync Section */}
          <div className="pb-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <span className="text-gray-900 dark:text-gray-100 font-medium">Calendar Sync</span>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing || cacheStatus?.is_refreshing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isRefreshing || cacheStatus?.is_refreshing ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Refreshing...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Refresh Now
                  </>
                )}
              </button>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Last updated: {formatRelativeTime(cacheStatus?.last_refresh ?? null)}
            </p>
            {refreshMessage && (
              <p className="text-sm text-green-600 dark:text-green-400 mt-1">
                {refreshMessage}
              </p>
            )}
          </div>

          {/* Dark Mode Toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-gray-900 dark:text-gray-100 font-medium">Dark Mode</span>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Use dark theme for the interface
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isDark}
              onClick={onToggleDarkMode}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${isDark ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
              `}
            >
              <span
                className={`
                  inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                  ${isDark ? 'translate-x-6' : 'translate-x-1'}
                `}
              />
            </button>
          </label>

          {/* Meal Ideas Toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-gray-900 dark:text-gray-100 font-medium">Show Future Meals</span>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Keep a list of meals to schedule later
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showMealIdeas}
              onClick={() => onUpdate({ showMealIdeas: !settings.showMealIdeas })}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${settings.showMealIdeas ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
              `}
            >
              <span
                className={`
                  inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                  ${settings.showMealIdeas ? 'translate-x-6' : 'translate-x-1'}
                `}
              />
            </button>
          </label>

          {/* Pantry Toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-gray-900 dark:text-gray-100 font-medium">Show Pantry</span>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Keep pantry inventory visible below the calendar
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showPantry}
              onClick={() => onUpdate({ showPantry: !settings.showPantry })}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${settings.showPantry ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
              `}
            >
              <span
                className={`
                  inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                  ${settings.showPantry ? 'translate-x-6' : 'translate-x-1'}
                `}
              />
            </button>
          </label>

          {/* Itemized Column Toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-gray-900 dark:text-gray-100 font-medium">Show Itemized Column</span>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Show checkboxes to mark meals as added to shopping list
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showItemizedColumn}
              onClick={() => onUpdate({ showItemizedColumn: !settings.showItemizedColumn })}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${settings.showItemizedColumn ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
              `}
            >
              <span
                className={`
                  inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                  ${settings.showItemizedColumn ? 'translate-x-6' : 'translate-x-1'}
                `}
              />
            </button>
          </label>

          {/* Compact View Toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-gray-900 dark:text-gray-100 font-medium">Compact View</span>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Fit a full week on screen with condensed cards
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.compactView}
              onClick={() => onUpdate({ compactView: !settings.compactView })}
              className={`
                relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                ${settings.compactView ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
              `}
            >
              <span
                className={`
                  inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                  ${settings.compactView ? 'translate-x-6' : 'translate-x-1'}
                `}
              />
            </button>
          </label>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={onClose}
            className="w-full py-2 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
