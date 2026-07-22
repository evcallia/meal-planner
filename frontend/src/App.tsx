import { useState, useEffect, useRef, useCallback } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { CalendarView, resetCalendarSessionLoaded, markCalendarSessionLoaded } from './components/CalendarView';
import { PantryPanel } from './components/PantryPanel';
import { MealIdeasPanel } from './components/MealIdeasPanel';
import { GroceryListView } from './components/GroceryListView';
import { ListsView } from './components/ListsView';
import { StatusChip, StatusToast } from './components/StatusBar';
import { ReAuthModal } from './components/ReAuthModal';
import { SettingsModal } from './components/SettingsModal';
import { ActivityPanel } from './components/ActivityPanel';
import { UpdateNotification } from './components/UpdateNotification';
import { useSync } from './hooks/useSync';
import { useDarkMode } from './hooks/useDarkMode';
import { useSettings } from './hooks/useSettings';
import { useRealtime } from './hooks/useRealtime';
import { useKeyboardOpen } from './hooks/useKeyboardOpen';
import { useVisualViewportPin } from './hooks/useVisualViewportPin';
import { useActivity } from './hooks/useActivity';
import { ensurePushSubscription } from './utils/push';
import { getCurrentUser, getLoginUrl, logout, getDays, getEvents, updateNotes, getGroceryList, getItemDefaults, getStores as getStoresAPI, getPantryList, getMealIdeas, getHiddenCalendarEvents, refreshCalendarCache, getTrackerLists } from './api/client';
import { UserInfo, GrocerySection, GroceryItem, PantrySection, PantryItem, Store, MealIdea, ConnectionStatus, TrackerList, TrackerTask } from './types';
import { scrollToElementWithOffset } from './utils/scroll';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { resetGrocerySessionLoaded, markGrocerySessionLoaded } from './hooks/useGroceryList';
import { resetPantrySessionLoaded, markPantrySessionLoaded } from './hooks/usePantry';
import { resetStoresSessionLoaded, markStoresSessionLoaded } from './hooks/useStores';
import { resetMealIdeasSessionLoaded, markMealIdeasSessionLoaded } from './hooks/useMealIdeas';
import { resetTrackerSessionLoaded, markTrackerSessionLoaded } from './hooks/useTracker';
import { getLocalNote, queueChange, saveLocalNote, saveLocalGrocerySections, saveLocalGroceryItems, saveLocalStores, saveLocalPantrySections, saveLocalPantryItems, getPendingChanges, saveLocalCalendarEvents, saveLocalHiddenEvent, deleteLocalHiddenEvent, clearAllLocalData, clearLocalMealIdeas, saveLocalMealIdea, deleteLocalMealIdea, saveLocalHiddenEvents, clearLocalHiddenEvents, saveLocalItemDefaults, saveLocalTrackerLists, saveLocalTrackerTasks, saveLocalTrackerList, deleteLocalTrackerList, saveLocalTrackerTask, deleteLocalTrackerTask, getLocalTrackerLists, getLocalTrackerTasks } from './db';
import { UndoProvider, useUndo } from './contexts/UndoContext';

type Page = 'meals' | 'pantry' | 'grocery' | 'lists';

const ALL_PAGES: Page[] = ['meals', 'pantry', 'grocery', 'lists'];
const PAGE_FEATURE_KEYS: Record<Page, 'featureMeals' | 'featurePantry' | 'featureGrocery' | 'featureLists'> = {
  meals: 'featureMeals',
  pantry: 'featurePantry',
  grocery: 'featureGrocery',
  lists: 'featureLists',
};

// Map tracker objects to their IndexedDB shape (keeps recent_logs so offline
// history is cached). Used by the background fetch + inactive-tab cache warmer.
const trackerListToLocal = (l: TrackerList) => ({
  id: l.id, name: l.name, icon: l.icon, color: l.color, position: l.position,
  owner_sub: l.owner_sub, owner_name: l.owner_name, is_owner: l.is_owner, shared_with: l.shared_with,
});
const trackerTaskToLocal = (t: TrackerTask) => ({
  id: t.id, list_id: t.list_id, name: t.name, target_interval_days: t.target_interval_days,
  notes: t.notes, position: t.position, archived: t.archived,
  season_start_month: t.season_start_month, season_end_month: t.season_end_month,
  season_start_day: t.season_start_day, season_end_day: t.season_end_day, snooze_until: t.snooze_until,
  last_done_at: t.last_done_at, last_event_at: t.last_event_at, last_done_by: t.last_done_by, last_note: t.last_note,
  total_count: t.total_count, avg_interval_days: t.avg_interval_days, recent_logs: t.recent_logs,
});

// Throttle server-side iCal feed refreshes triggered on app focus/reconnect
let lastCalendarFeedRefresh = 0;
const CALENDAR_FEED_REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
export function __resetCalendarFeedRefreshForTests() { lastCalendarFeedRefresh = 0; }

function PageHeader({
  title,
  user,
  onShowSettings,
  status,
  pendingCount,
  updateAvailable,
  unseenActivity,
  onShowActivity,
}: {
  title: string;
  user: UserInfo;
  onShowSettings: () => void;
  status: string;
  pendingCount: number;
  updateAvailable?: boolean;
  unseenActivity?: number;
  onShowActivity?: () => void;
}) {
  const { canUndo, canRedo, undo, redo } = useUndo();
  const firstName = user.name?.trim().split(/\s+/)[0] || user.email?.split('@')[0] || 'Account';
  // The bell badge covers partner activity AND a pending app update (the
  // update row lives in the Activity panel now, not Settings).
  const bellCount = (unseenActivity ?? 0) + (updateAvailable ? 1 : 0);
  const headerRef = useRef<HTMLElement>(null);
  const showStatus = status !== 'online' && status !== 'auth-required';

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => document.documentElement.style.setProperty('--header-h', `${el.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <header ref={headerRef} className="sticky z-10 mt-2 top-2 max-w-lg mx-auto w-full px-4">
      <div className={`glass-nav rounded-2xl px-5 flex items-center justify-between ${showStatus ? 'py-1.5' : 'h-12'}`}>
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 truncate">{title}</h1>
        <div className="flex flex-col items-end gap-0.5">
          {showStatus && <StatusChip status={status as ConnectionStatus} pendingCount={pendingCount} />}
          <div className="flex items-center gap-2">
          {/* Activity bell */}
          {onShowActivity && (
            <button
              onClick={onShowActivity}
              className="relative p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              aria-label={bellCount ? `Activity (${bellCount} new)` : 'Activity'}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
              {bellCount > 0 && (
                <span className="absolute top-0.5 right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-red-500 rounded-full">
                  {bellCount > 9 ? '9+' : bellCount}
                </span>
              )}
            </button>
          )}
          {/* Refresh button */}
          <button
            onClick={() => window.location.reload()}
            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label="Refresh"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7.05 9.1A7.002 7.002 0 0119.79 10M16.95 14.9A7.002 7.002 0 014.21 14" />
            </svg>
          </button>
          {/* Undo button */}
          <button
            onClick={undo}
            disabled={!canUndo}
            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            aria-label="Undo"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
            </svg>
          </button>
          {/* Redo button */}
          <button
            onClick={redo}
            disabled={!canRedo}
            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-30 disabled:pointer-events-none"
            aria-label="Redo"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4" />
            </svg>
          </button>
          {/* Settings button with the account's first name beneath */}
          <div className="flex flex-col items-center">
            <button
              onClick={onShowSettings}
              className="relative p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              aria-label="Settings"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <span className="text-[10px] leading-none -mt-0.5 text-gray-500 dark:text-gray-400 max-w-[56px] truncate">{firstName}</span>
          </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function BottomNav({ currentPage, onChange, groceryCount, hidden, pages }: { currentPage: Page; onChange: (page: Page) => void; groceryCount: number; hidden?: boolean; pages: Page[] }) {
  // Keep the island glued to the visible bottom edge — iOS can leave the
  // layout viewport panned/stale after the keyboard closes, which floated
  // the fixed nav part-way up the screen.
  const navRef = useVisualViewportPin<HTMLElement>();
  // A single enabled feature needs no navigation at all.
  if (hidden || pages.length <= 1) return null;
  return (
    <nav ref={navRef} className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 safe-area-bottom">
      {/* backdrop-filter lives on this inner (non-fixed) layer — on iOS a fixed
          element that itself has backdrop-filter detaches and drifts during
          momentum scroll. Keeping the fixed element filter-free keeps it locked. */}
      <div className="glass-nav rounded-full px-6 flex gap-7">
        {pages.includes('meals') && (
          <button
            onClick={() => onChange('meals')}
            className={`flex flex-col items-center py-2 transition-colors ${
              currentPage === 'meals'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {/* Calendar icon */}
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-xs mt-0.5 font-medium">Meals</span>
          </button>
        )}
        {pages.includes('pantry') && (
          <button
            onClick={() => onChange('pantry')}
            className={`flex flex-col items-center py-2 transition-colors ${
              currentPage === 'pantry'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {/* Package/pantry icon */}
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            <span className="text-xs mt-0.5 font-medium">Pantry</span>
          </button>
        )}
        {pages.includes('grocery') && (
          <button
            onClick={() => onChange('grocery')}
            className={`flex flex-col items-center py-2 transition-colors ${
              currentPage === 'grocery'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {/* Shopping cart icon */}
            <div className="relative">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" />
              </svg>
              {groceryCount > 0 && (
                <span className="absolute -top-1.5 -right-2.5 min-w-[18px] h-[18px] flex items-center justify-center px-1 text-[10px] font-bold text-white bg-blue-500 rounded-full leading-none">
                  {groceryCount > 99 ? '99+' : groceryCount}
                </span>
              )}
            </div>
            <span className="text-xs mt-0.5 font-medium">Grocery</span>
          </button>
        )}
        {pages.includes('lists') && (
          <button
            onClick={() => onChange('lists')}
            className={`flex flex-col items-center py-2 transition-colors ${
              currentPage === 'lists'
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            {/* Checklist/tasks icon */}
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            <span className="text-xs mt-0.5 font-medium">Lists</span>
          </button>
        )}
      </div>
    </nav>
  );
}

function MealsPage({
  user,
  status,
  pendingCount,
  settings,
  onShowSettings,
  unseenActivity,
  onShowActivity,
  updateAvailable,
}: {
  user: UserInfo;
  status: string;
  pendingCount: number;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onShowSettings: () => void;
  unseenActivity?: number;
  onShowActivity?: () => void;
  updateAvailable?: boolean;
}) {
  const isOnline = useOnlineStatus();
  const fabRef = useVisualViewportPin<HTMLDivElement>();
  const todayRefElement = useRef<HTMLDivElement | null>(null);
  const handleTodayRefReady = useCallback((ref: HTMLDivElement | null) => {
    todayRefElement.current = ref;
  }, []);

  const scrollToToday = () => {
    if (todayRefElement.current) {
      scrollToElementWithOffset(todayRefElement.current, 'smooth');
    }
  };

  const appendMealLine = (notes: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return notes;
    if (!notes) return trimmed;
    const isHtml = notes.includes('<');
    if (isHtml) {
      return `${notes}<div>${trimmed}</div>`;
    }
    return `${notes}\n${trimmed}`;
  };

  const notifyNotesUpdate = (date: string, notes: string) => {
    window.dispatchEvent(new CustomEvent('meal-planner-notes-updated', { detail: { date, notes } }));
  };

  const handleScheduleMeal = async (title: string, date: string): Promise<string> => {
    if (!date) return '';
    let existingNotes = '';

    if (isOnline) {
      try {
        const days = await getDays(date, date);
        existingNotes = days[0]?.meal_note?.notes ?? '';
        const nextNotes = appendMealLine(existingNotes, title);
        const updated = await updateNotes(date, nextNotes);
        notifyNotesUpdate(date, updated.notes ?? nextNotes);
        return existingNotes;
      } catch (error) {
        console.error('Failed to schedule meal online:', error);
        // Fall through to offline fallback — queue for later sync
      }
    }

    // Offline (or online API failed) — save locally and queue
    const local = await getLocalNote(date);
    existingNotes = local?.notes ?? '';
    const nextNotes = appendMealLine(existingNotes, title);
    await saveLocalNote(date, nextNotes, local?.items ?? []);
    await queueChange('notes', date, { notes: nextNotes });
    notifyNotesUpdate(date, nextNotes);
    return existingNotes;
  };

  const handleUnscheduleMeal = async (date: string, prevNotes: string) => {
    if (isOnline) {
      try {
        const updated = await updateNotes(date, prevNotes);
        notifyNotesUpdate(date, updated.notes ?? prevNotes);
        return;
      } catch (error) {
        console.error('Failed to unschedule meal:', error);
      }
    }
    const local = await getLocalNote(date);
    await saveLocalNote(date, prevNotes, local?.items ?? []);
    await queueChange('notes', date, { notes: prevNotes });
    notifyNotesUpdate(date, prevNotes);
  };

  return (
    <>
      <PageHeader title="Meals" user={user} onShowSettings={onShowSettings} status={status} pendingCount={pendingCount} updateAvailable={updateAvailable} unseenActivity={unseenActivity} onShowActivity={onShowActivity} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 pb-28">
        {settings.showMealIdeas && (
          <div className="sticky z-[9] glass rounded-2xl mt-4 mb-2 p-3" style={{ top: 'calc(var(--header-h, 48px) + 24px)' }}>
            <MealIdeasPanel onSchedule={handleScheduleMeal} onUnschedule={handleUnscheduleMeal} compactView={settings.compactView} />
          </div>
        )}
        <CalendarView
          onTodayRefReady={handleTodayRefReady}
          showItemizedColumn={settings.showItemizedColumn}
          compactView={settings.compactView}
          showAllEvents={settings.showAllEvents}
          showHolidays={settings.showHolidays}
          holidayColor={settings.holidayColor}
          calendarColor={settings.calendarColor}
          editHighlightColor={settings.editHighlightColor}
        />
      </main>

      {/* Floating Action Buttons (viewport-pinned like the bottom nav) */}
      <div ref={fabRef} className="fixed bottom-20 right-4 z-20 flex flex-col gap-2">
        <button
          onClick={scrollToToday}
          className="glass-nav rounded-full px-3 py-1.5 transition-all duration-200 hover:scale-105 flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400"
          aria-label="Jump to today"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
          <span className="font-medium">Today</span>
        </button>
      </div>
    </>
  );
}

function GroceryPage({
  user,
  status,
  pendingCount,
  settings,
  onUpdateSettings,
  onShowSettings,
  unseenActivity,
  onShowActivity,
  updateAvailable,
}: {
  user: UserInfo;
  status: string;
  pendingCount: number;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onUpdateSettings: (updates: Partial<ReturnType<typeof import('./hooks/useSettings').useSettings>['settings']>) => void;
  onShowSettings: () => void;
  unseenActivity?: number;
  onShowActivity?: () => void;
  updateAvailable?: boolean;
}) {
  return (
    <>
      <PageHeader title="Grocery" user={user} onShowSettings={onShowSettings} status={status} pendingCount={pendingCount} updateAvailable={updateAvailable} unseenActivity={unseenActivity} onShowActivity={onShowActivity} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 pb-28">
        <GroceryListView
          compactView={settings.compactView}
          editHighlightColor={settings.editHighlightColor}
          selectedStores={settings.grocerySelectedStoreIds}
          excludedStores={settings.groceryExcludedStoreIds}
          onStoreFilterChange={(updates) => onUpdateSettings({
            ...(updates.selected !== undefined ? { grocerySelectedStoreIds: updates.selected } : {}),
            ...(updates.excluded !== undefined ? { groceryExcludedStoreIds: updates.excluded } : {}),
          })}
        />
      </main>
    </>
  );
}

function ListsPage({
  user,
  status,
  pendingCount,
  settings,
  onUpdateSettings,
  onShowSettings,
  unseenActivity,
  onShowActivity,
  updateAvailable,
}: {
  user: UserInfo;
  status: string;
  pendingCount: number;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onUpdateSettings: (updates: Partial<ReturnType<typeof import('./hooks/useSettings').useSettings>['settings']>) => void;
  onShowSettings: () => void;
  unseenActivity?: number;
  onShowActivity?: () => void;
  updateAvailable?: boolean;
}) {
  return (
    <>
      <PageHeader title="Lists" user={user} onShowSettings={onShowSettings} status={status} pendingCount={pendingCount} updateAvailable={updateAvailable} unseenActivity={unseenActivity} onShowActivity={onShowActivity} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 pb-28">
        <ListsView
          user={user}
          editHighlightColor={settings.editHighlightColor}
          notifyDefaults={{ edits: settings.notifyListEdits, due: settings.notifyListsDue }}
          listNotifyOverrides={settings.listNotifyOverrides}
          onSetListNotify={(listId, changes) => onUpdateSettings({
            listNotifyOverrides: {
              ...settings.listNotifyOverrides,
              [listId]: { ...settings.listNotifyOverrides[listId], ...changes },
            },
          })}
          taskNotifyOverrides={settings.taskNotifyOverrides}
          onSetTaskNotify={(taskId, due) => onUpdateSettings({
            taskNotifyOverrides: {
              ...settings.taskNotifyOverrides,
              [taskId]: { ...settings.taskNotifyOverrides[taskId], due },
            },
          })}
        />
      </main>
    </>
  );
}

function PantryPage({
  user,
  status,
  pendingCount,
  settings,
  onShowSettings,
  unseenActivity,
  onShowActivity,
  updateAvailable,
}: {
  user: UserInfo;
  status: string;
  pendingCount: number;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onShowSettings: () => void;
  unseenActivity?: number;
  onShowActivity?: () => void;
  updateAvailable?: boolean;
}) {
  return (
    <>
      <PageHeader title="Pantry" user={user} onShowSettings={onShowSettings} status={status} pendingCount={pendingCount} updateAvailable={updateAvailable} unseenActivity={unseenActivity} onShowActivity={onShowActivity} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 pb-28">
        <PantryPanel editHighlightColor={settings.editHighlightColor} />
      </main>
    </>
  );
}

function AppContent() {
  const [user, setUser] = useState<UserInfo | null>(null);

  // Self-heal the push subscription on launch: app updates can destroy it
  // (the nuclear update path unregisters the SW, deleting its subscriptions),
  // which used to silently reset the device's notification toggle to off.
  const pushEnsuredRef = useRef(false);
  useEffect(() => {
    if (!user || pushEnsuredRef.current) return;
    pushEnsuredRef.current = true;
    ensurePushSubscription();
  }, [user]);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>(() => {
    const saved = sessionStorage.getItem('meal-planner-tab');
    if (saved === 'meals' || saved === 'pantry' || saved === 'grocery' || saved === 'lists') return saved;
    return 'meals';
  });
  const [groceryCount, setGroceryCount] = useState(() => {
    try {
      const cached = localStorage.getItem('meal-planner-grocery');
      if (cached) {
        const sections = JSON.parse(cached);
        if (Array.isArray(sections)) {
          return sections.reduce((sum: number, s: any) => sum + (s.items?.filter((i: any) => !i.checked)?.length ?? 0), 0);
        }
      }
    } catch { /* ignore */ }
    return 0;
  });

  // Listen for grocery count updates from useGroceryList
  useEffect(() => {
    const handler = (e: Event) => {
      setGroceryCount((e as CustomEvent<number>).detail);
    };
    window.addEventListener('grocery-count-changed', handler);
    return () => window.removeEventListener('grocery-count-changed', handler);
  }, []);

  const handlePageChange = useCallback((page: Page) => {
    setCurrentPage(page);
    sessionStorage.setItem('meal-planner-tab', page);
  }, []);
  const { status, pendingCount, clearAllPendingChanges, fetchPendingChanges, getSyncErrors, skipPendingChange } = useSync();
  const { isDark, toggle: toggleDarkMode } = useDarkMode();
  const { settings, updateSettings } = useSettings();

  // Which tabs exist (Features setting). Missing keys count as enabled, and
  // an all-off state (bad synced data) falls back to everything — the UI
  // guarantees at least one, but settings arrive from other devices too.
  const enabledPages = ALL_PAGES.filter(p => settings[PAGE_FEATURE_KEYS[p]] !== false);
  const visiblePages = enabledPages.length > 0 ? enabledPages : ALL_PAGES;

  // If the current tab's feature was just disabled (possibly from another
  // device via settings sync), land on the first enabled tab.
  useEffect(() => {
    if (!visiblePages.includes(currentPage)) {
      handlePageChange(visiblePages[0]);
    }
  }, [visiblePages, currentPage, handlePageChange]);
  const activity = useActivity(!!user, user?.sub, settings);
  const isOnline = useOnlineStatus();
  useRealtime();
  const keyboardOpen = useKeyboardOpen();

  // PWA update detection (SW lifecycle)
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration: ServiceWorkerRegistration | undefined) {
      if (registration) {
        // Check for SW updates every 15 minutes
        setInterval(() => registration.update().catch(() => {}), 15 * 60 * 1000);
        // Check on visibility/focus (critical for iOS standalone)
        const onResume = () => registration.update().catch(() => {});
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') onResume();
        });
        window.addEventListener('focus', onResume);
      }
    },
  });

  // version.json backup detection (for iOS standalone)
  const [versionUpdateAvailable, setVersionUpdateAvailable] = useState(
    () => !!(window as any).__pwaUpdateAvailable
  );
  useEffect(() => {
    if ((window as any).__pwaUpdateAvailable) setVersionUpdateAvailable(true);
    const handler = () => setVersionUpdateAvailable(true);
    window.addEventListener('pwa-update-available', handler);
    return () => window.removeEventListener('pwa-update-available', handler);
  }, []);

  const updateAvailable = needRefresh || versionUpdateAvailable;
  const [updating, setUpdating] = useState(false);

  const applyUpdate = useCallback(() => {
    setUpdating(true);
    let reloading = false;
    const doReload = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    const nuclearUpdate = async () => {
      if (reloading) return;
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(key => caches.delete(key)));
        }
      } catch { /* best effort */ }
      doReload();
    };

    if (needRefresh) {
      // SW path: tell waiting SW to skipWaiting, reload when it takes control
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener(
          'controllerchange', () => doReload(), { once: true }
        );
      }
      updateServiceWorker(true);
      // Fallback: if controllerchange doesn't fire in 2s, go nuclear
      // (unregister SWs + clear caches) to prevent the waiting SW from
      // re-triggering needRefresh after a plain reload
      setTimeout(nuclearUpdate, 2000);
    } else {
      // version.json path: unregister SW, clear caches, reload
      nuclearUpdate();
    }
  }, [needRefresh, updateServiceWorker]);

  useEffect(() => {
    const checkAuth = async () => {
      const cached = localStorage.getItem('meal-planner-user');

      // 1. Load cached user immediately for instant offline startup
      if (cached) {
        try {
          setUser(JSON.parse(cached));
          setLoading(false);
        } catch { /* invalid cache — continue to API */ }
      }

      // 2. Verify with server in background
      try {
        const currentUser = await getCurrentUser();
        if (currentUser) {
          localStorage.setItem('meal-planner-user', JSON.stringify(currentUser));
          setUser(currentUser);
        } else if (!cached) {
          setUser(null);
        }
      } catch (error) {
        console.error('Auth check failed:', error);
        if (!cached) {
          setUser(null);
        }
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, []);

  // Fetch all data and write to local cache so tab switches never need API calls.
  // Called on initial load, focus-return, and online-reconnect.
  const fetchAllData = useCallback(() => {
    // Skip cache-warming for entities with pending offline changes to avoid
    // overwriting optimistic state before sync processes the queued changes.
    getPendingChanges().then(pending => {
      const hasGroceryChanges = pending.some(c => c.type.startsWith('grocery-'));
      const hasPantryChanges = pending.some(c => c.type.startsWith('pantry-'));
      const hasMealIdeaChanges = pending.some(c => c.type.startsWith('meal-idea-'));
      const hasTrackerChanges = pending.some(c => c.type.startsWith('tracker-'));

      if (!hasGroceryChanges) {
        getGroceryList().then(async (data) => {
          try { localStorage.setItem('meal-planner-grocery', JSON.stringify(data)); } catch { /* full */ }
          setGroceryCount(data.reduce((sum, s) => sum + s.items.filter(i => !i.checked).length, 0));
          await saveLocalGrocerySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
          await saveLocalGroceryItems(data.flatMap(s => s.items.map(i => ({
            id: i.id, section_id: i.section_id, name: i.name,
            quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
          }))));
          markGrocerySessionLoaded();
        }).catch(() => { /* best-effort */ });
      }

      getStoresAPI().then(async (stores) => {
        await saveLocalStores(stores.map(s => ({ id: s.id, name: s.name, position: s.position })));
        markStoresSessionLoaded();
      }).catch(() => { /* best-effort */ });

      getItemDefaults().then(async (defaults) => {
        await saveLocalItemDefaults(defaults.map(d => ({ item_name: d.item_name, store_id: d.store_id, section_name: d.section_name })));
      }).catch(() => { /* best-effort */ });

      if (!hasPantryChanges) {
        getPantryList().then(async (data) => {
          try { localStorage.setItem('meal-planner-pantry-sections', JSON.stringify(data)); } catch { /* full */ }
          await saveLocalPantrySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
          await saveLocalPantryItems(data.flatMap(s => s.items.map(i => ({
            id: i.id, section_id: i.section_id, name: i.name,
            quantity: i.quantity, position: i.position, updated_at: i.updated_at,
          }))));
          markPantrySessionLoaded();
        }).catch(() => { /* best-effort */ });
      }

      if (!hasMealIdeaChanges) {
        getMealIdeas().then(async (ideas) => {
          await clearLocalMealIdeas();
          for (const idea of ideas) await saveLocalMealIdea(idea);
          try { localStorage.setItem('meal-planner-meal-ideas', JSON.stringify(ideas)); } catch { /* full */ }
          markMealIdeasSessionLoaded();
        }).catch(() => { /* best-effort */ });
      }

      if (!hasTrackerChanges) {
        getTrackerLists().then(async (lists) => {
          await saveLocalTrackerLists(lists.map(trackerListToLocal));
          await saveLocalTrackerTasks(lists.flatMap(l => l.tasks.map(trackerTaskToLocal)));
          markTrackerSessionLoaded();
        }).catch(() => { /* best-effort */ });
      }

      // Calendar: prefetch days + events for the full range (past 2 weeks, future 8 weeks)
      // Same range as CalendarView.init() so the cache is warm before the user visits Meals
      const calStart = new Date(); calStart.setDate(calStart.getDate() - 14);
      const calEnd = new Date(); calEnd.setDate(calEnd.getDate() + 56);
      const fmt = (d: Date) => d.toISOString().split('T')[0];
      const calStartStr = fmt(calStart);
      const calEndStr = fmt(calEnd);

      getDays(calStartStr, calEndStr).then(async (days) => {
        for (const d of days) {
          if (d.meal_note) {
            saveLocalNote(d.date, d.meal_note.notes, d.meal_note.items);
          }
        }
      }).catch(() => { /* best-effort */ });

      getEvents(calStartStr, calEndStr, true, true).then(async (eventsMap) => {
        for (const [date, events] of Object.entries(eventsMap)) {
          try { saveLocalCalendarEvents(date, events); } catch { /* best-effort */ }
        }
      }).catch(() => { /* best-effort */ });

      getHiddenCalendarEvents().then(async (hidden) => {
        await clearLocalHiddenEvents();
        await saveLocalHiddenEvents(hidden);
        markCalendarSessionLoaded(calStartStr, calEndStr);
      }).catch(() => { /* best-effort */ });

    }).catch(() => { /* best-effort */ });
  }, []);

  // Initial data fetch — guard prevents double-run when auth check
  // calls setUser twice (once from localStorage, once from API).
  const preCacheDoneRef = useRef(false);
  // Mark flags during render (before child effects run) so hooks that
  // mount in this cycle see sessionLoaded=true and skip their own API fetch.
  if (user && isOnline && !preCacheDoneRef.current) {
  }
  useEffect(() => {
    if (!user || !isOnline || preCacheDoneRef.current) return;
    preCacheDoneRef.current = true;
    fetchAllData();
    // Calendar data is fetched by CalendarView on its own first mount
    // (it needs display range context), so we don't pre-fetch it here.
  }, [user, isOnline, fetchAllData]);

  // Keep local cache fresh from realtime events for inactive tabs.
  // When the active tab's hook handles its own events, this also pre-warms
  // the cache for other tabs so data is instant on tab switch.
  const currentPageRef = useRef(currentPage);
  currentPageRef.current = currentPage;
  useEffect(() => {
    if (!user) return;
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.type) return;

      // Focus-refresh events are handled by each tab's own hook — skip here
      if (detail.source_id === '__focus_refresh__') return;

      // Tracker/Lists: warm the IndexedDB cache from realtime events while we're on
      // another tab, so lists + history stay current in the background and are ready
      // to go offline with — same as grocery/pantry. (On the Lists tab, useTracker
      // handles events itself.) Events are already per-user scoped by the server.
      if (detail.type === 'tracker.updated') {
        if (currentPageRef.current === 'lists') return;
        try {
          const pendingT = await getPendingChanges();
          if (pendingT.some(c => c.type.startsWith('tracker-'))) { resetTrackerSessionLoaded(); return; }
          const p = detail.payload as {
            action?: string; list?: TrackerList; listId?: string; task?: TrackerTask; taskId?: string;
            position?: number; tasks?: { id: string; position: number }[];
          };
          switch (p?.action) {
            case 'list-added': case 'list-updated': case 'list-shared':
              if (p.list) {
                await saveLocalTrackerList(trackerListToLocal(p.list));
                await saveLocalTrackerTasks(p.list.tasks.map(trackerTaskToLocal));
              }
              break;
            case 'list-deleted':
              if (p.listId) await deleteLocalTrackerList(p.listId);
              break;
            case 'list-reordered':
              if (p.listId && p.position != null) {
                const l = (await getLocalTrackerLists()).find(x => x.id === p.listId);
                if (l) await saveLocalTrackerList({ ...l, position: p.position });
              }
              break;
            case 'task-added': case 'task-updated': case 'task-logged':
              if (p.task) await saveLocalTrackerTask(trackerTaskToLocal(p.task));
              break;
            case 'task-deleted':
              if (p.taskId) await deleteLocalTrackerTask(p.taskId);
              break;
            case 'tasks-reordered':
              if (p.tasks) {
                const posMap = new Map(p.tasks.map(t => [t.id, t.position]));
                for (const lt of await getLocalTrackerTasks()) {
                  const pos = posMap.get(lt.id);
                  if (pos !== undefined) await saveLocalTrackerTask({ ...lt, position: pos });
                }
              }
              break;
            default:
              resetTrackerSessionLoaded(); // unknown/legacy → refetch on next visit
          }
        } catch { resetTrackerSessionLoaded(); }
        return;
      }

      // Skip if there are pending offline changes — don't overwrite local edits
      try {
        const pending = await getPendingChanges();

        if (detail.type === 'grocery.updated' && currentPageRef.current !== 'grocery') {
          if (pending.some(c => c.type.startsWith('grocery-'))) return;
          const gPayload = detail.payload as { action?: string; sections?: GrocerySection[]; section?: GrocerySection; sectionId?: string; item?: GroceryItem; itemId?: string; fromSectionId?: string; toSectionId?: string; items?: { id: string; position: number }[]; name?: string };
          try {
            const raw = localStorage.getItem('meal-planner-grocery');
            let data: GrocerySection[] = raw ? JSON.parse(raw) : [];
            switch (gPayload?.action) {
              case 'item-added':
                if (gPayload.sectionId && gPayload.item) {
                  data = data.map(s => {
                    if (s.id !== gPayload.sectionId) return s;
                    if (s.items.some(i => i.id === gPayload.item!.id)) return s;
                    return { ...s, items: [...s.items, gPayload.item!] };
                  });
                }
                break;
              case 'item-updated':
                if (gPayload.sectionId && gPayload.item) {
                  data = data.map(s => {
                    if (s.id !== gPayload.sectionId) return s;
                    return { ...s, items: s.items.map(i => i.id === gPayload.item!.id ? gPayload.item! : i) };
                  });
                }
                break;
              case 'item-deleted':
                if (gPayload.sectionId && gPayload.itemId) {
                  data = data.map(s => {
                    if (s.id !== gPayload.sectionId) return s;
                    return { ...s, items: s.items.filter(i => i.id !== gPayload.itemId) };
                  });
                }
                break;
              case 'item-moved':
                if (gPayload.fromSectionId && gPayload.toSectionId && gPayload.item) {
                  data = data.map(s => {
                    if (s.id === gPayload.fromSectionId) return { ...s, items: s.items.filter(i => i.id !== gPayload.item!.id) };
                    if (s.id === gPayload.toSectionId) {
                      if (s.items.some(i => i.id === gPayload.item!.id)) return s;
                      return { ...s, items: [...s.items, gPayload.item!].sort((a, b) => a.position - b.position) };
                    }
                    return s;
                  });
                }
                break;
              case 'section-added':
                if (gPayload.section && !data.some(s => s.id === gPayload.section!.id)) {
                  data = [...data, gPayload.section].sort((a, b) => a.position - b.position);
                }
                break;
              case 'section-renamed':
                if (gPayload.sectionId && gPayload.name) {
                  data = data.map(s => s.id === gPayload.sectionId ? { ...s, name: gPayload.name! } : s);
                }
                break;
              case 'section-deleted':
                if (gPayload.sectionId) data = data.filter(s => s.id !== gPayload.sectionId);
                break;
              case 'section-reordered':
                if (gPayload.sections) {
                  const posMap = new Map((gPayload.sections as { id: string; position: number }[]).map(s => [s.id, s.position]));
                  data = data.map(s => { const p = posMap.get(s.id); return p !== undefined ? { ...s, position: p } : s; }).sort((a, b) => a.position - b.position);
                }
                break;
              case 'items-reordered':
                if (gPayload.sectionId && gPayload.items) {
                  const posMap = new Map(gPayload.items.map(i => [i.id, i.position]));
                  data = data.map(s => {
                    if (s.id !== gPayload.sectionId) return s;
                    return { ...s, items: s.items.map(i => { const p = posMap.get(i.id); return p !== undefined ? { ...i, position: p } : i; }).sort((a, b) => a.position - b.position) };
                  });
                }
                break;
              case 'cleared-checked':
                data = data.map(s => ({ ...s, items: s.items.filter(i => !i.checked) })).filter(s => s.items.length > 0);
                break;
              case 'cleared-all':
                data = [];
                break;
              case 'replaced':
                if (gPayload.sections) data = gPayload.sections as GrocerySection[];
                break;
            }
            try { localStorage.setItem('meal-planner-grocery', JSON.stringify(data)); } catch {}
            setGroceryCount(data.reduce((sum, s) => sum + s.items.filter(i => !i.checked).length, 0));
            await saveLocalGrocerySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
            await saveLocalGroceryItems(data.flatMap(s => s.items.map(i => ({
              id: i.id, section_id: i.section_id, name: i.name,
              quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
            }))));
          } catch {}
        }

        if (detail.type === 'pantry.updated' && currentPageRef.current !== 'pantry') {
          if (pending.some(c => c.type.startsWith('pantry-'))) return;
          const pPayload = detail.payload as { action?: string; sections?: PantrySection[]; section?: PantrySection; sectionId?: string; item?: PantryItem; itemId?: string; fromSectionId?: string; toSectionId?: string; items?: { id: string; position: number }[]; name?: string };
          try {
            const raw = localStorage.getItem('meal-planner-pantry-sections');
            let data: PantrySection[] = raw ? JSON.parse(raw) : [];
            switch (pPayload?.action) {
              case 'item-added':
                if (pPayload.sectionId && pPayload.item) {
                  data = data.map(s => {
                    if (s.id !== pPayload.sectionId) return s;
                    if (s.items.some(i => i.id === pPayload.item!.id)) return s;
                    return { ...s, items: [...s.items, pPayload.item!] };
                  });
                }
                break;
              case 'item-updated':
                if (pPayload.sectionId && pPayload.item) {
                  data = data.map(s => {
                    if (s.id !== pPayload.sectionId) return s;
                    return { ...s, items: s.items.map(i => i.id === pPayload.item!.id ? pPayload.item! : i) };
                  });
                }
                break;
              case 'item-deleted':
                if (pPayload.sectionId && pPayload.itemId) {
                  data = data.map(s => {
                    if (s.id !== pPayload.sectionId) return s;
                    return { ...s, items: s.items.filter(i => i.id !== pPayload.itemId) };
                  });
                }
                break;
              case 'item-moved':
                if (pPayload.fromSectionId && pPayload.toSectionId && pPayload.item) {
                  data = data.map(s => {
                    if (s.id === pPayload.fromSectionId) return { ...s, items: s.items.filter(i => i.id !== pPayload.item!.id) };
                    if (s.id === pPayload.toSectionId) {
                      if (s.items.some(i => i.id === pPayload.item!.id)) return s;
                      return { ...s, items: [...s.items, pPayload.item!].sort((a, b) => a.position - b.position) };
                    }
                    return s;
                  });
                }
                break;
              case 'section-added':
                if (pPayload.section && !data.some(s => s.id === pPayload.section!.id)) {
                  data = [...data, pPayload.section].sort((a, b) => a.position - b.position);
                }
                break;
              case 'section-renamed':
                if (pPayload.sectionId && pPayload.name) {
                  data = data.map(s => s.id === pPayload.sectionId ? { ...s, name: pPayload.name! } : s);
                }
                break;
              case 'section-deleted':
                if (pPayload.sectionId) data = data.filter(s => s.id !== pPayload.sectionId);
                break;
              case 'section-reordered':
                if (pPayload.sections) {
                  const posMap = new Map((pPayload.sections as { id: string; position: number }[]).map(s => [s.id, s.position]));
                  data = data.map(s => { const p = posMap.get(s.id); return p !== undefined ? { ...s, position: p } : s; }).sort((a, b) => a.position - b.position);
                }
                break;
              case 'items-reordered':
                if (pPayload.sectionId && pPayload.items) {
                  const posMap = new Map(pPayload.items.map(i => [i.id, i.position]));
                  data = data.map(s => {
                    if (s.id !== pPayload.sectionId) return s;
                    return { ...s, items: s.items.map(i => { const p = posMap.get(i.id); return p !== undefined ? { ...i, position: p } : i; }).sort((a, b) => a.position - b.position) };
                  });
                }
                break;
              case 'cleared-all':
                data = [];
                break;
              case 'replaced':
                if (pPayload.sections) data = pPayload.sections as PantrySection[];
                break;
            }
            try { localStorage.setItem('meal-planner-pantry-sections', JSON.stringify(data)); } catch {}
            await saveLocalPantrySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
            await saveLocalPantryItems(data.flatMap(s => s.items.map(i => ({
              id: i.id, section_id: i.section_id, name: i.name,
              quantity: i.quantity, position: i.position, updated_at: i.updated_at,
            }))));
          } catch {}
        }

        if (detail.type === 'stores.updated') {
          const payload = detail.payload as { action?: string; store?: Store; storeId?: string; stores?: { id: string; position: number }[] };
          try {
            const raw = localStorage.getItem('meal-planner-stores');
            let stores: Store[] = raw ? JSON.parse(raw) : [];
            switch (payload?.action) {
              case 'added':
                if (payload.store && !stores.some(s => s.id === payload.store!.id)) {
                  stores = [...stores, payload.store].sort((a, b) => a.position - b.position);
                }
                break;
              case 'updated':
                if (payload.store) {
                  stores = stores.map(s => s.id === payload.store!.id ? payload.store! : s);
                }
                break;
              case 'deleted':
                if (payload.storeId) {
                  stores = stores.filter(s => s.id !== payload.storeId);
                }
                break;
              case 'reordered':
                if (payload.stores) {
                  const posMap = new Map(payload.stores.map(s => [s.id, s.position]));
                  stores = stores.map(s => {
                    const pos = posMap.get(s.id);
                    return pos !== undefined ? { ...s, position: pos } : s;
                  }).sort((a, b) => a.position - b.position);
                }
                break;
            }
            await saveLocalStores(stores.map(s => ({ id: s.id, name: s.name, position: s.position })));
            try { localStorage.setItem('meal-planner-stores', JSON.stringify(stores)); } catch {}
          } catch {}
        }

        if (detail.type === 'meal-ideas.updated' && currentPageRef.current !== 'meals') {
          if (pending.some(c => c.type.startsWith('meal-idea-'))) return;
          const mealPayload = detail.payload as { action?: string; idea?: MealIdea; ideaId?: string };
          try {
            const raw = localStorage.getItem('meal-planner-meal-ideas');
            let ideas: MealIdea[] = raw ? JSON.parse(raw) : [];
            switch (mealPayload?.action) {
              case 'added':
                if (mealPayload.idea && !ideas.some(i => i.id === mealPayload.idea!.id)) {
                  ideas = [mealPayload.idea, ...ideas];
                  await saveLocalMealIdea(mealPayload.idea);
                }
                break;
              case 'updated':
                if (mealPayload.idea) {
                  ideas = ideas.map(i => i.id === mealPayload.idea!.id ? mealPayload.idea! : i);
                  await saveLocalMealIdea(mealPayload.idea);
                }
                break;
              case 'deleted':
                if (mealPayload.ideaId) {
                  ideas = ideas.filter(i => i.id !== mealPayload.ideaId);
                  try { await deleteLocalMealIdea(mealPayload.ideaId); } catch {}
                }
                break;
            }
            try { localStorage.setItem('meal-planner-meal-ideas', JSON.stringify(ideas)); } catch {}
          } catch {}
        }

        // Meals tab — save realtime data directly to IndexedDB (no API call needed,
        // the payload carries the data inline)
        if (currentPageRef.current !== 'meals') {
          if (detail.type === 'notes.updated') {
            const payload = detail.payload as { date?: string; meal_note?: { notes: string; items: { line_index: number; itemized: boolean }[] } | null };
            if (payload?.date && payload.meal_note) {
              try { saveLocalNote(payload.date, payload.meal_note.notes, payload.meal_note.items); } catch {}
            }
          }
          if (detail.type === 'item.updated') {
            const payload = detail.payload as { date?: string; line_index?: number; itemized?: boolean };
            if (payload?.date && payload.line_index !== undefined && payload.itemized !== undefined) {
              try {
                const note = await getLocalNote(payload.date);
                if (note) {
                  const items = [...note.items];
                  const idx = items.findIndex(i => i.line_index === payload.line_index);
                  if (idx >= 0) {
                    items[idx] = { ...items[idx], itemized: payload.itemized! };
                  } else {
                    items.push({ line_index: payload.line_index!, itemized: payload.itemized! });
                  }
                  saveLocalNote(payload.date, note.notes, items);
                }
              } catch {}
            }
          }
          if (detail.type === 'calendar.refreshed') {
            const payload = detail.payload as { events_by_date?: Record<string, any[]>; cache_start?: string; cache_end?: string };
            if (payload?.events_by_date) {
              for (const [date, events] of Object.entries(payload.events_by_date)) {
                try { saveLocalCalendarEvents(date, events); } catch {}
              }
              // Dates inside the refreshed window but absent from the payload
              // now have zero events — clear their stale IDB entries.
              if (payload.cache_start && payload.cache_end) {
                for (let d = new Date(payload.cache_start + 'T12:00:00'); ; d.setDate(d.getDate() + 1)) {
                  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                  if (dateStr > payload.cache_end) break;
                  if (!(dateStr in payload.events_by_date)) {
                    try { saveLocalCalendarEvents(dateStr, []); } catch {}
                  }
                }
              }
            }
          }
          if (detail.type === 'calendar.hidden') {
            const payload = detail.payload as { hidden_id?: string; event_uid?: string; calendar_name?: string; title?: string; start_time?: string; end_time?: string | null; all_day?: boolean };
            if (payload?.hidden_id && payload.start_time && payload.title) {
              try {
                saveLocalHiddenEvent({
                  id: payload.hidden_id,
                  event_uid: payload.event_uid ?? '',
                  event_date: payload.start_time.split('T')[0],
                  calendar_name: payload.calendar_name ?? '',
                  title: payload.title,
                  start_time: payload.start_time,
                  end_time: payload.end_time ?? null,
                  all_day: Boolean(payload.all_day),
                });
              } catch {}
            }
          }
          if (detail.type === 'calendar.unhidden') {
            const payload = detail.payload as { hidden_id?: string };
            if (payload?.hidden_id) {
              try { deleteLocalHiddenEvent(payload.hidden_id); } catch {}
            }
          }
        }
      } catch {}
    };
    window.addEventListener('meal-planner-realtime', handler);
    return () => window.removeEventListener('meal-planner-realtime', handler);
  }, [user]);

  // Re-fetch all data (focus-return, online-reconnect).
  // Resets session flags so inactive tabs re-read from cache on next mount,
  // then fetches fresh data for all tabs and dispatches a calendar refresh
  // for the active CalendarView.
  const broadcastFullRefresh = useCallback(() => {
    resetCalendarSessionLoaded();
    resetGrocerySessionLoaded();
    resetPantrySessionLoaded();
    resetStoresSessionLoaded();
    resetMealIdeasSessionLoaded();
    resetTrackerSessionLoaded();
    fetchAllData();
    // Calendar needs a synthetic event since CalendarView manages its own fetch
    window.dispatchEvent(new CustomEvent('meal-planner-realtime', {
      detail: { type: 'calendar.refreshed', payload: {}, source_id: '__focus_refresh__' },
    }));
    // Ask the server to re-pull the iCal feed so upstream deletions/moves
    // propagate on app open/focus. Server-side _refresh_in_progress dedupes;
    // the resulting calendar.refreshed SSE updates all clients.
    if (Date.now() - lastCalendarFeedRefresh > CALENDAR_FEED_REFRESH_COOLDOWN_MS) {
      lastCalendarFeedRefresh = Date.now();
      refreshCalendarCache().catch(() => { /* best-effort */ });
    }
  }, [fetchAllData]);

  // Refresh everything when the SSE stream reconnects: events emitted while
  // disconnected (server deploy, network blip) are lost with no replay, and
  // the focus/online triggers below don't fire if the app stayed visible.
  // Throttled so a flapping connection doesn't hammer the API.
  const lastSseRefreshRef = useRef(0);
  useEffect(() => {
    if (!user) return;
    const onReconnected = () => {
      if (Date.now() - lastSseRefreshRef.current < 10000) return;
      lastSseRefreshRef.current = Date.now();
      broadcastFullRefresh();
    };
    window.addEventListener('meal-planner-realtime-connected', onReconnected);
    return () => window.removeEventListener('meal-planner-realtime-connected', onReconnected);
  }, [user, broadcastFullRefresh]);

  // Refresh when the app regains focus (e.g. returning to PWA or browser tab).
  // SSE may have disconnected while in the background.
  useEffect(() => {
    if (!user) return;
    let hidden = document.hidden;
    const onVisibility = () => {
      if (hidden && !document.hidden) broadcastFullRefresh();
      hidden = document.hidden;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [user, broadcastFullRefresh]);

  // Refresh when reconnecting from offline.
  const prevOnlineRef2 = useRef(isOnline);
  useEffect(() => {
    const wasOffline = !prevOnlineRef2.current;
    prevOnlineRef2.current = isOnline;
    if (user && isOnline && wasOffline) broadcastFullRefresh();
  }, [user, isOnline, broadcastFullRefresh]);

  // After offline sync drains the queue, re-warm caches for inactive tabs.
  // The initial broadcastFullRefresh on reconnect skips entities that had
  // pending changes; this fills that gap once those changes are synced.
  useEffect(() => {
    if (!user) return;
    const handler = () => fetchAllData();
    window.addEventListener('pending-changes-synced', handler);
    return () => window.removeEventListener('pending-changes-synced', handler);
  }, [user, fetchAllData]);

  useEffect(() => {
    const scale = settings.compactView ? settings.textScaleCompact : settings.textScaleStandard;
    const root = document.documentElement;
    const baseSize = 16;
    root.style.fontSize = `${baseSize * scale}px`;
    return () => {
      root.style.fontSize = '';
    };
  }, [settings.compactView, settings.textScaleCompact, settings.textScaleStandard]);

  const handleLogout = useCallback(async (endProviderSession = true) => {
    const endSessionUrl = await logout();
    localStorage.removeItem('meal-planner-user');
    localStorage.removeItem('meal-planner-grocery');
    localStorage.removeItem('meal-planner-settings');
    await clearAllLocalData().catch(() => {});
    setUser(null);
    if (endProviderSession && endSessionUrl) {
      // Check if running as installed PWA (standalone mode)
      const isPWA = window.matchMedia('(display-mode: standalone)').matches
        || (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (isPWA) {
        // PWA: full-page redirect to authentik's invalidation flow.
        // User will need to navigate back to the app after.
        window.location.href = endSessionUrl;
      } else {
        // Desktop browser: open invalidation flow in a popup to kill
        // authentik's session, then close it — user stays on login screen
        const popup = window.open(endSessionUrl, 'authentik_logout', 'width=1,height=1,left=-100,top=-100');
        setTimeout(() => { popup?.close(); }, 3000);
      }
    }
  }, []);

  if (loading) {
    return (
      <div
        className="min-h-screen bg-gray-100 dark:bg-transparent flex items-center justify-center"
        data-testid="app-loading"
        aria-label="Loading"
      >
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-transparent flex items-center justify-center p-4">
        <div className="glass rounded-lg p-8 max-w-sm w-full text-center">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Meal Planner</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-6">Plan your weekly meals with ease</p>
          <a
            href={getLoginUrl()}
            className="inline-block w-full py-3 px-4 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 transition-colors"
          >
            Sign in to continue
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-transparent flex flex-col">
      {/* Transient connection toast (persistent state shown as a header chip) */}
      <StatusToast status={status} pendingCount={pendingCount} />
      {status === 'auth-required' && <ReAuthModal pendingCount={pendingCount} />}

      {/* Page Content — each wrapped in its own UndoProvider for independent undo/redo */}
      {currentPage === 'meals' && (
        <UndoProvider id="meals">
          <MealsPage
            user={user}
            status={status}
            pendingCount={pendingCount}
            settings={settings}
            onShowSettings={() => setShowSettings(true)}
            unseenActivity={showActivity ? 0 : activity.unseenCount}
            onShowActivity={() => { activity.load(); setShowActivity(true); }}
            updateAvailable={updateAvailable}
          />
        </UndoProvider>
      )}
      {currentPage === 'pantry' && (
        <UndoProvider id="pantry">
          <PantryPage
            user={user}
            status={status}
            pendingCount={pendingCount}
            settings={settings}
            onShowSettings={() => setShowSettings(true)}
            unseenActivity={showActivity ? 0 : activity.unseenCount}
            onShowActivity={() => { activity.load(); setShowActivity(true); }}
            updateAvailable={updateAvailable}
          />
        </UndoProvider>
      )}
      {currentPage === 'grocery' && (
        <UndoProvider id="grocery">
          <GroceryPage
            user={user}
            status={status}
            pendingCount={pendingCount}
            settings={settings}
            onUpdateSettings={updateSettings}
            onShowSettings={() => setShowSettings(true)}
            unseenActivity={showActivity ? 0 : activity.unseenCount}
            onShowActivity={() => { activity.load(); setShowActivity(true); }}
            updateAvailable={updateAvailable}
          />
        </UndoProvider>
      )}
      {currentPage === 'lists' && (
        <UndoProvider id="lists">
          <ListsPage
            user={user}
            status={status}
            pendingCount={pendingCount}
            settings={settings}
            onUpdateSettings={updateSettings}
            onShowSettings={() => setShowSettings(true)}
            unseenActivity={showActivity ? 0 : activity.unseenCount}
            onShowActivity={() => { activity.load(); setShowActivity(true); }}
            updateAvailable={updateAvailable}
          />
        </UndoProvider>
      )}

      {/* Settings Modal */}
      {showActivity && (
        <ActivityPanel
          entries={activity.entries}
          lastSeen={activity.lastSeen}
          loading={activity.loading}
          onClose={() => setShowActivity(false)}
          onSeen={activity.markSeen}
          updateAvailable={updateAvailable}
          onApplyUpdate={applyUpdate}
          updating={updating}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={settings}
          onUpdate={updateSettings}
          onClose={() => setShowSettings(false)}
          isDark={isDark}
          onToggleDarkMode={toggleDarkMode}
          accountName={user?.name || user?.email || ''}
          onLogout={handleLogout}
          pendingCount={pendingCount}
          onClearPendingChanges={clearAllPendingChanges}
          onFetchPendingChanges={fetchPendingChanges}
          onGetSyncErrors={getSyncErrors}
          onSkipPendingChange={skipPendingChange}
        />
      )}

      {/* Update Notification */}
      <UpdateNotification updateAvailable={updateAvailable} onApplyUpdate={applyUpdate} updating={updating} />

      {/* Bottom Navigation */}
      <BottomNav currentPage={currentPage} onChange={handlePageChange} groceryCount={groceryCount} hidden={keyboardOpen} pages={visiblePages} />
    </div>
  );
}

function App() {
  return <AppContent />;
}

export default App;
