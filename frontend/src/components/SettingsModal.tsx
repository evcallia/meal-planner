import { useState, useEffect, useCallback } from 'react';
import { Settings } from '../hooks/useSettings';
import { getCalendarCacheStatus, refreshCalendarCache, CalendarCacheStatus, getHiddenCalendarEvents, unhideCalendarEvent, HiddenCalendarEvent } from '../api/client';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import {
  getLocalHiddenEvents,
  saveLocalHiddenEvent,
  saveLocalHiddenEvents,
  clearLocalHiddenEvents,
  deleteLocalHiddenEvent,
  queueChange,
  getPendingChanges,
  removePendingChange,
  getCalendarCacheTimestamp,
  getLocalGroceryItems,
  getLocalPantryItems,
  getLocalMealIdeas,
  getLocalGrocerySections,
  getLocalPantrySections,
  PendingChange,
  ChangeType,
  LocalGroceryItem,
  LocalPantryItem,
  LocalMealIdea,
  LocalGrocerySection,
  LocalPantrySection,
} from '../db';

interface SettingsModalProps {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => void;
  onClose: () => void;
  isDark: boolean;
  onToggleDarkMode: () => void;
  updateAvailable?: boolean;
  onApplyUpdate?: () => void;
  updating?: boolean;
  pendingCount?: number;
  onClearPendingChanges?: () => void;
  onFetchPendingChanges?: () => Promise<PendingChange[]>;
  onGetSyncErrors?: () => Map<number, string>;
  onSkipPendingChange?: (id: number) => Promise<void>;
}

interface EnrichedPendingChange extends PendingChange {
  operation: string;
  detail: string;
  error?: string;
}

const typeLabels: Record<ChangeType, string> = {
  'notes': 'Update notes',
  'itemized': 'Toggle itemized',
  'pantry-add': 'Add to pantry',
  'pantry-update': 'Update pantry item',
  'pantry-delete': 'Delete from pantry',
  'pantry-replace': 'Replace pantry list',
  'pantry-reorder-sections': 'Reorder pantry sections',
  'pantry-reorder-items': 'Reorder pantry items',
  'pantry-rename-section': 'Rename pantry section',
  'meal-idea-add': 'Add meal idea',
  'meal-idea-update': 'Update meal idea',
  'meal-idea-delete': 'Delete meal idea',
  'calendar-hide': 'Hide calendar event',
  'calendar-unhide': 'Unhide calendar event',
  'grocery-replace': 'Replace grocery list',
  'grocery-check': 'Check grocery item',
  'grocery-add': 'Add to grocery list',
  'grocery-delete': 'Delete from grocery list',
  'grocery-edit': 'Edit grocery item',
  'grocery-clear': 'Clear grocery items',
  'grocery-reorder-sections': 'Reorder grocery sections',
  'grocery-reorder-items': 'Reorder grocery items',
  'grocery-rename-section': 'Rename grocery section',
  'grocery-move-item': 'Move grocery item',
  'pantry-move-item': 'Move pantry item',
};

async function enrichPendingChanges(changes: PendingChange[]): Promise<EnrichedPendingChange[]> {
  // Build lookup maps for resolving IDs to names — each wrapped so one failure doesn't break all
  const safe = async <T,>(fn: () => Promise<T[]>): Promise<T[]> => {
    try { return await fn(); } catch { return []; }
  };
  const groceryItemMap = new Map((await safe<LocalGroceryItem>(getLocalGroceryItems)).map(i => [i.id, i.name]));
  const pantryItemMap = new Map((await safe<LocalPantryItem>(getLocalPantryItems)).map(i => [i.id, i.name]));
  const mealIdeaMap = new Map((await safe<LocalMealIdea>(getLocalMealIdeas)).map(i => [i.id, i.title]));
  const grocerySectionMap = new Map((await safe<LocalGrocerySection>(getLocalGrocerySections)).map(s => [s.id, s.name]));
  const pantrySectionMap = new Map((await safe<LocalPantrySection>(getLocalPantrySections)).map(s => [s.id, s.name]));

  return changes.map(change => {
    const payload = change.payload as Record<string, unknown>;
    const operation = typeLabels[change.type] || change.type;
    let detail = '';

    try { switch (change.type) {
      case 'notes':
        detail = change.date;
        break;
      case 'itemized':
        detail = `${change.date}, line ${(payload?.lineIndex as number) + 1}`;
        break;
      case 'pantry-add':
        detail = payload?.name as string || '';
        if (payload?.quantity) detail += ` (x${payload.quantity})`;
        break;
      case 'pantry-update': {
        const pName = pantryItemMap.get(payload?.id as string) || (payload?.name as string) || '';
        const fields: string[] = [];
        if (payload?.name) fields.push(`name: ${payload.name}`);
        if (payload?.quantity !== undefined) fields.push(`qty: ${payload.quantity}`);
        detail = pName + (fields.length ? ` — ${fields.join(', ')}` : '');
        break;
      }
      case 'pantry-delete':
        detail = pantryItemMap.get(payload?.id as string) || (payload?.id as string) || '';
        break;
      case 'pantry-replace': {
        const sections = payload?.sections as { name: string; items: unknown[] }[] | undefined;
        if (sections) {
          const itemCount = sections.reduce((sum, s) => sum + s.items.length, 0);
          detail = `${sections.length} section${sections.length === 1 ? '' : 's'}, ${itemCount} item${itemCount === 1 ? '' : 's'}`;
        }
        break;
      }
      case 'pantry-rename-section':
        detail = payload?.name as string || '';
        break;
      case 'pantry-reorder-sections':
        detail = `${((payload?.sectionIds as string[]) || []).length} sections`;
        break;
      case 'pantry-reorder-items': {
        const secName = pantrySectionMap.get(payload?.sectionId as string) || '';
        const count = ((payload?.itemIds as string[]) || []).length;
        detail = secName ? `${secName} (${count} items)` : `${count} items`;
        break;
      }
      case 'pantry-move-item':
        detail = pantryItemMap.get(payload?.id as string) || '';
        break;
      case 'meal-idea-add':
        detail = payload?.title as string || '';
        break;
      case 'meal-idea-update': {
        const ideaName = mealIdeaMap.get(payload?.id as string) || '';
        detail = payload?.title as string || ideaName;
        break;
      }
      case 'meal-idea-delete':
        detail = mealIdeaMap.get(payload?.id as string) || '';
        break;
      case 'calendar-hide':
        detail = payload?.title as string || '';
        break;
      case 'calendar-unhide':
        detail = payload?.hiddenId as string || '';
        break;
      case 'grocery-add':
        detail = payload?.name as string || '';
        if (payload?.quantity) detail += ` (${payload.quantity})`;
        break;
      case 'grocery-delete':
        detail = groceryItemMap.get(payload?.id as string) || '';
        break;
      case 'grocery-check': {
        const itemName = groceryItemMap.get(payload?.id as string) || '';
        const checked = payload?.checked ? 'check' : 'uncheck';
        detail = itemName ? `${checked} "${itemName}"` : checked;
        break;
      }
      case 'grocery-edit': {
        const gName = groceryItemMap.get(payload?.id as string) || '';
        const edits: string[] = [];
        if (payload?.name) edits.push(`name: ${payload.name}`);
        if (payload?.quantity !== undefined) edits.push(`qty: ${payload.quantity || 'none'}`);
        if (payload?.store_id !== undefined) edits.push('store changed');
        detail = gName + (edits.length ? ` — ${edits.join(', ')}` : '');
        break;
      }
      case 'grocery-replace': {
        const gSections = payload?.sections as { name: string; items: unknown[] }[] | undefined;
        if (gSections) {
          const gItemCount = gSections.reduce((sum, s) => sum + s.items.length, 0);
          detail = `${gSections.length} section${gSections.length === 1 ? '' : 's'}, ${gItemCount} item${gItemCount === 1 ? '' : 's'}`;
        }
        break;
      }
      case 'grocery-clear':
        detail = (payload?.mode as string) === 'checked' ? 'checked items' : 'all items';
        break;
      case 'grocery-rename-section':
        detail = payload?.name as string || '';
        break;
      case 'grocery-reorder-sections':
        detail = `${((payload?.sectionIds as string[]) || []).length} sections`;
        break;
      case 'grocery-reorder-items': {
        const gSecName = grocerySectionMap.get(payload?.sectionId as string) || '';
        const gCount = ((payload?.itemIds as string[]) || []).length;
        detail = gSecName ? `${gSecName} (${gCount} items)` : `${gCount} items`;
        break;
      }
      case 'grocery-move-item':
        detail = groceryItemMap.get(payload?.id as string) || '';
        break;
      case 'pantry-move-item':
        detail = pantryItemMap.get(payload?.id as string) || '';
        break;
    }
    } catch { /* detail stays empty on error */ }

    return { ...change, operation, detail };
  });
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

export function SettingsModal({ settings, onUpdate, onClose, isDark, onToggleDarkMode, updateAvailable, onApplyUpdate, updating, pendingCount, onClearPendingChanges, onFetchPendingChanges, onGetSyncErrors, onSkipPendingChange }: SettingsModalProps) {
  const [cacheStatus, setCacheStatus] = useState<CalendarCacheStatus | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [hiddenEvents, setHiddenEvents] = useState<HiddenCalendarEvent[]>([]);
  const [hiddenLoading, setHiddenLoading] = useState(false);
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState<EnrichedPendingChange[]>([]);
  const [showPendingList, setShowPendingList] = useState(false);
  const isOnline = useOnlineStatus();

  // Load cache status on mount
  useEffect(() => {
    const loadCacheStatus = async () => {
      if (isOnline) {
        try {
          const status = await getCalendarCacheStatus();
          setCacheStatus(status);
        } catch (error) {
          console.error('Failed to load cache status:', error);
        }
      } else {
        // When offline, get the timestamp from local IndexedDB cache
        try {
          const timestamp = await getCalendarCacheTimestamp();
          if (timestamp) {
            setCacheStatus({
              last_refresh: new Date(timestamp).toISOString(),
              cache_start: null,
              cache_end: null,
              is_refreshing: false,
            });
          }
        } catch (error) {
          console.error('Failed to load local cache timestamp:', error);
        }
      }
    };
    loadCacheStatus();
  }, [isOnline]);

  const loadHiddenEvents = useCallback(async () => {
    setHiddenLoading(true);
    setHiddenError(null);

    // 1. Load from cache immediately
    try {
      const localHidden = await getLocalHiddenEvents();
      if (localHidden.length > 0) {
        setHiddenEvents(localHidden);
        setHiddenLoading(false);
      }
    } catch { /* cache failed — continue to API */ }

    // 2. If online, fetch from API in background
    if (isOnline) {
      try {
        const remoteHidden = await getHiddenCalendarEvents();
        setHiddenEvents(remoteHidden);
        await clearLocalHiddenEvents();
        await saveLocalHiddenEvents(remoteHidden);
      } catch { /* API failed — keep cached data */ }
    }

    setHiddenLoading(false);
  }, [isOnline]);

  useEffect(() => {
    loadHiddenEvents();
  }, [loadHiddenEvents]);

  useEffect(() => {
    const handleRealtime = (event: Event) => {
      const detail = (event as CustomEvent).detail as { type?: string; payload?: any } | undefined;
      if (!detail?.type) return;
      if (detail.type === 'calendar.hidden') {
        const payload = detail.payload as {
          hidden_id?: string;
          event_uid?: string;
          calendar_name?: string;
          title?: string;
          start_time?: string;
          end_time?: string | null;
          all_day?: boolean;
        };
        const hiddenId = payload?.hidden_id;
        const title = payload?.title;
        const startTime = payload?.start_time;
        if (!hiddenId || !startTime || !title) return;
        setHiddenEvents(prev => {
          if (prev.some(event => event.id === hiddenId)) return prev;
          return [
            {
              id: hiddenId,
              event_uid: payload.event_uid || '',
              event_date: startTime.split('T')[0],
              calendar_name: payload.calendar_name || '',
              title,
              start_time: startTime,
              end_time: payload.end_time ?? null,
              all_day: Boolean(payload.all_day),
            },
            ...prev,
          ];
        });
        saveLocalHiddenEvent({
          id: hiddenId,
          event_uid: payload.event_uid || '',
          event_date: startTime.split('T')[0],
          calendar_name: payload.calendar_name || '',
          title,
          start_time: startTime,
          end_time: payload.end_time ?? null,
          all_day: Boolean(payload.all_day),
        });
      }
      if (detail.type === 'calendar.unhidden') {
        const payload = detail.payload as { hidden_id?: string };
        if (!payload?.hidden_id) return;
        setHiddenEvents(prev => prev.filter(event => event.id !== payload.hidden_id));
        deleteLocalHiddenEvent(payload.hidden_id);
      }
    };

    window.addEventListener('meal-planner-realtime', handleRealtime as EventListener);
    return () => {
      window.removeEventListener('meal-planner-realtime', handleRealtime as EventListener);
    };
  }, []);

  useEffect(() => {
    const handleHiddenUpdated = () => {
      loadHiddenEvents();
    };
    window.addEventListener('meal-planner-hidden-updated', handleHiddenUpdated as EventListener);
    return () => {
      window.removeEventListener('meal-planner-hidden-updated', handleHiddenUpdated as EventListener);
    };
  }, [loadHiddenEvents]);

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

  const handleUnhide = async (hiddenId: string) => {
    try {
      if (!isOnline) {
        const hiddenEvent = hiddenEvents.find(event => event.id === hiddenId);
        const eventDate = hiddenEvent?.event_date || new Date().toISOString().split('T')[0];
        setHiddenEvents(prev => prev.filter(event => event.id !== hiddenId));
        await deleteLocalHiddenEvent(hiddenId);
        const pending = await getPendingChanges();
        const pendingHide = pending.find(change =>
          change.type === 'calendar-hide'
          && (change.payload as { tempId?: string }).tempId === hiddenId
        );
        if (pendingHide?.id) {
          await removePendingChange(pendingHide.id);
        } else {
          await queueChange('calendar-unhide', eventDate, { hiddenId });
        }
        window.dispatchEvent(new CustomEvent('meal-planner-hidden-updated', { detail: { date: eventDate } }));
        return;
      }
      await unhideCalendarEvent(hiddenId);
      setHiddenEvents(prev => prev.filter(event => event.id !== hiddenId));
      await deleteLocalHiddenEvent(hiddenId);
      const hiddenEvent = hiddenEvents.find(event => event.id === hiddenId);
      const eventDate = hiddenEvent?.event_date;
      window.dispatchEvent(new CustomEvent('meal-planner-hidden-updated', { detail: { date: eventDate } }));
    } catch (error) {
      console.error('Failed to unhide event:', error);
      setHiddenError('Failed to unhide event');
    }
  };

  const clampScale = (value: number) => Math.min(1.5, Math.max(0.75, value));

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
          {/* Update Available */}
          {updateAvailable && onApplyUpdate && (
            <div className="pb-4 border-b border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 bg-blue-500 rounded-full shrink-0" />
                  <div>
                    <span className="text-gray-900 dark:text-gray-100 font-medium">Update Available</span>
                    <p className="text-sm text-gray-500 dark:text-gray-400">A new version is ready to install</p>
                  </div>
                </div>
                <button
                  onClick={onApplyUpdate}
                  disabled={updating}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white rounded-lg transition-colors shrink-0 ${updating ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600'}`}
                >
                  {updating && (
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {updating ? 'Updating…' : 'Update'}
                </button>
              </div>
            </div>
          )}

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
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div className="flex-1 min-w-0">
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
                flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors
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
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div className="flex-1 min-w-0">
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
                flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors
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

          {/* Itemized Column Toggle */}
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div className="flex-1 min-w-0">
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
                flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors
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
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div className="flex-1 min-w-0">
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
                flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors
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

          {/* Text Scaling */}
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-gray-900 dark:text-gray-100 font-medium">Text size (standard view)</span>
                <span className="text-sm text-gray-500 dark:text-gray-400">{Math.round(settings.textScaleStandard * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.85"
                max="1.3"
                step="0.05"
                value={settings.textScaleStandard}
                onChange={(e) => onUpdate({ textScaleStandard: clampScale(Number(e.target.value)) })}
                className="mt-2 w-full"
              />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-gray-900 dark:text-gray-100 font-medium">Text size (compact view)</span>
                <span className="text-sm text-gray-500 dark:text-gray-400">{Math.round(settings.textScaleCompact * 100)}%</span>
              </div>
              <input
                type="range"
                min="0.85"
                max="1.3"
                step="0.05"
                value={settings.textScaleCompact}
                onChange={(e) => onUpdate({ textScaleCompact: clampScale(Number(e.target.value)) })}
                className="mt-2 w-full"
              />
            </div>
          </div>

          {/* Hidden Events */}
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-3">
            {/* Show All Events Toggle */}
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div className="flex-1 min-w-0">
                <span className="text-gray-900 dark:text-gray-100 font-medium">Show All Events</span>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Show hidden events on the calendar
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.showAllEvents}
                onClick={() => onUpdate({ showAllEvents: !settings.showAllEvents })}
                className={`
                  flex-shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                  ${settings.showAllEvents ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}
                `}
              >
                <span
                  className={`
                    inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                    ${settings.showAllEvents ? 'translate-x-6' : 'translate-x-1'}
                  `}
                />
              </button>
            </label>

            <div className="flex items-center justify-between">
              <span className="text-gray-900 dark:text-gray-100 font-medium">Hidden events</span>
              <span className="text-sm text-gray-500 dark:text-gray-400">{hiddenEvents.length}</span>
            </div>
            {hiddenLoading ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading hidden events…</p>
            ) : hiddenEvents.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">No hidden events.</p>
            ) : (
              <div className="space-y-2">
                {hiddenEvents.map(event => (
                  <div key={event.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{event.title}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {new Date(event.start_time).toLocaleString()}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleUnhide(event.id)}
                      className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700"
                    >
                      Unhide
                    </button>
                  </div>
                ))}
              </div>
            )}
            {hiddenError && (
              <p className="text-sm text-red-500">{hiddenError}</p>
            )}
          </div>

          {/* Pending Changes */}
          {pendingCount != null && pendingCount > 0 && onClearPendingChanges && (
            <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-gray-900 dark:text-gray-100 font-medium">Pending Changes</span>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {pendingCount} change{pendingCount === 1 ? '' : 's'} waiting to sync
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {onFetchPendingChanges && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (showPendingList) {
                          setShowPendingList(false);
                        } else {
                          const changes = await onFetchPendingChanges();
                          const errors = onGetSyncErrors ? onGetSyncErrors() : new Map<number, string>();
                          let enriched: EnrichedPendingChange[];
                          try {
                            enriched = await enrichPendingChanges(changes);
                          } catch {
                            enriched = changes.map(c => ({
                              ...c,
                              operation: typeLabels[c.type] || c.type,
                              detail: '',
                            }));
                          }
                          enriched = enriched.map(c => ({
                            ...c,
                            error: c.id != null ? errors.get(c.id) : undefined,
                          }));
                          setPendingChanges(enriched);
                          setShowPendingList(true);
                        }
                      }}
                      className="px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                    >
                      {showPendingList ? 'Hide' : 'View'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onClearPendingChanges();
                      setShowPendingList(false);
                      setPendingChanges([]);
                    }}
                    className="px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors"
                  >
                    Clear All
                  </button>
                </div>
              </div>
              {showPendingList && pendingChanges.length > 0 && onSkipPendingChange && (
                <div className="mt-3 space-y-2">
                  {pendingChanges.map(change => (
                      <div key={change.id} className={`flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg ${change.error ? 'bg-red-50 dark:bg-red-900/20' : 'bg-gray-50 dark:bg-gray-700/50'}`}>
                        <div className="min-w-0">
                          <p className="text-sm text-gray-900 dark:text-gray-100">{change.operation}</p>
                          {change.detail && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{change.detail}</p>
                          )}
                          {change.error && (
                            <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{change.error}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            if (change.id != null) {
                              await onSkipPendingChange(change.id);
                              setPendingChanges(prev => prev.filter(c => c.id !== change.id));
                            }
                          }}
                          className="shrink-0 px-2 py-1 text-xs font-medium text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/30 rounded hover:bg-orange-100 dark:hover:bg-orange-900/50 transition-colors"
                        >
                          Skip
                        </button>
                      </div>
                  ))}
                </div>
              )}
            </div>
          )}
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
