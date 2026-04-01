import { useState, useEffect, useRef, useCallback } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { CalendarView } from './components/CalendarView';
import { PantryPanel } from './components/PantryPanel';
import { MealIdeasPanel } from './components/MealIdeasPanel';
import { GroceryListView } from './components/GroceryListView';
import { StatusBar } from './components/StatusBar';
import { SettingsModal } from './components/SettingsModal';
import { UpdateNotification } from './components/UpdateNotification';
import { useSync } from './hooks/useSync';
import { useDarkMode } from './hooks/useDarkMode';
import { useSettings } from './hooks/useSettings';
import { useRealtime } from './hooks/useRealtime';
import { getCurrentUser, getLoginUrl, logout, getDays, updateNotes, getGroceryList, getStores as getStoresAPI, getPantryList, getMealIdeas } from './api/client';
import { UserInfo } from './types';
import { scrollToElementWithOffset } from './utils/scroll';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { getLocalNote, queueChange, saveLocalNote, saveLocalGrocerySections, saveLocalGroceryItems, saveLocalStores, saveLocalPantrySections, saveLocalPantryItems, getPendingChanges, saveLocalCalendarEvents, saveLocalHiddenEvent, deleteLocalHiddenEvent, clearAllLocalData, clearLocalMealIdeas, saveLocalMealIdea } from './db';
import { UndoProvider, useUndo } from './contexts/UndoContext';

type Page = 'meals' | 'pantry' | 'grocery';

function PageHeader({
  title,
  user,
  onLogout,
  onShowSettings,
  status,
  updateAvailable,
}: {
  title: string;
  user: UserInfo;
  onLogout: () => void;
  onShowSettings: () => void;
  status: string;
  updateAvailable?: boolean;
}) {
  const { canUndo, canRedo, undo, redo } = useUndo();

  return (
    <header className={`bg-white dark:bg-gray-800 shadow-sm sticky z-10 ${status !== 'online' ? 'top-10' : 'top-0'}`}>
      <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
        <div className="flex items-center gap-3">
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
          {/* Settings button */}
          <button
            onClick={onShowSettings}
            className="relative p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label={updateAvailable ? "Settings (update available)" : "Settings"}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {updateAvailable && (
              <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-blue-500 rounded-full ring-2 ring-white dark:ring-gray-800" />
            )}
          </button>
          <span className="text-sm text-gray-600 dark:text-gray-400 hidden sm:inline">{user.name || user.email}</span>
          <button
            onClick={onLogout}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}

function BottomNav({ currentPage, onChange, groceryCount }: { currentPage: Page; onChange: (page: Page) => void; groceryCount: number }) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 safe-area-bottom">
      <div className="max-w-lg mx-auto flex">
        <button
          onClick={() => onChange('meals')}
          className={`flex-1 flex flex-col items-center py-2 transition-colors ${
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
        <button
          onClick={() => onChange('pantry')}
          className={`flex-1 flex flex-col items-center py-2 transition-colors ${
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
        <button
          onClick={() => onChange('grocery')}
          className={`flex-1 flex flex-col items-center py-2 transition-colors ${
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
      </div>
    </nav>
  );
}

function MealsPage({
  user,
  status,
  settings,
  onShowSettings,
  onLogout,
  updateAvailable,
}: {
  user: UserInfo;
  status: string;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onShowSettings: () => void;
  onLogout: () => void;
  updateAvailable?: boolean;
}) {
  const isOnline = useOnlineStatus();
  const todayRefElement = useRef<HTMLDivElement | null>(null);
  const topSectionRef = useRef<HTMLDivElement | null>(null);

  const handleTodayRefReady = useCallback((ref: HTMLDivElement | null) => {
    todayRefElement.current = ref;
  }, []);

  const scrollToToday = () => {
    if (todayRefElement.current) {
      scrollToElementWithOffset(todayRefElement.current, 'smooth');
    }
  };

  const scrollToTopSection = () => {
    if (topSectionRef.current) {
      scrollToElementWithOffset(topSectionRef.current, 'smooth');
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
      }
    }

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
      <PageHeader title="Meal Planner" user={user} onLogout={onLogout} onShowSettings={onShowSettings} status={status} updateAvailable={updateAvailable} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-4 pb-20 space-y-6">
        <div ref={topSectionRef} />
        {settings.showMealIdeas && <MealIdeasPanel onSchedule={handleScheduleMeal} onUnschedule={handleUnscheduleMeal} compactView={settings.compactView} />}
        <CalendarView
          onTodayRefReady={handleTodayRefReady}
          showItemizedColumn={settings.showItemizedColumn}
          compactView={settings.compactView}
          showAllEvents={settings.showAllEvents}
          showHolidays={settings.showHolidays}
          holidayColor={settings.holidayColor}
        />
      </main>

      {/* Floating Action Buttons */}
      <div className="fixed bottom-16 right-4 z-20 flex flex-col gap-2">
        {settings.showMealIdeas && (
          <button
            onClick={scrollToTopSection}
            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-full px-3 py-1.5 shadow-lg transition-all duration-200 hover:scale-105 flex items-center gap-1.5 text-sm"
            aria-label="Jump to meal ideas"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
            <span className="font-medium">Ideas</span>
          </button>
        )}
        <button
          onClick={scrollToToday}
          className="bg-blue-500 hover:bg-blue-600 text-white rounded-full px-3 py-1.5 shadow-lg transition-all duration-200 hover:scale-105 flex items-center gap-1.5 text-sm"
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
  settings,
  onShowSettings,
  onLogout,
  updateAvailable,
}: {
  user: UserInfo;
  status: string;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onShowSettings: () => void;
  onLogout: () => void;
  updateAvailable?: boolean;
}) {
  return (
    <>
      <PageHeader title="Grocery List" user={user} onLogout={onLogout} onShowSettings={onShowSettings} status={status} updateAvailable={updateAvailable} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-4 pb-20 space-y-6">
        <GroceryListView compactView={settings.compactView} />
      </main>
    </>
  );
}

function PantryPage({
  user,
  status,
  settings: _settings,
  onShowSettings,
  onLogout,
  updateAvailable,
}: {
  user: UserInfo;
  status: string;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onShowSettings: () => void;
  onLogout: () => void;
  updateAvailable?: boolean;
}) {
  return (
    <>
      <PageHeader title="Pantry" user={user} onLogout={onLogout} onShowSettings={onShowSettings} status={status} updateAvailable={updateAvailable} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-4 pb-20 space-y-6">
        <PantryPanel />
      </main>
    </>
  );
}

function AppContent() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>(() => {
    const saved = sessionStorage.getItem('meal-planner-tab');
    if (saved === 'meals' || saved === 'pantry' || saved === 'grocery') return saved;
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
  const isOnline = useOnlineStatus();
  useRealtime();

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

  // Pre-cache grocery list and stores for offline use
  useEffect(() => {
    if (!user || !isOnline) return;
    getGroceryList().then(async (data) => {
      try { localStorage.setItem('meal-planner-grocery', JSON.stringify(data)); } catch { /* full */ }
      setGroceryCount(data.reduce((sum, s) => sum + s.items.filter(i => !i.checked).length, 0));
      await saveLocalGrocerySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
      await saveLocalGroceryItems(data.flatMap(s => s.items.map(i => ({
        id: i.id, section_id: i.section_id, name: i.name,
        quantity: i.quantity, checked: i.checked, position: i.position, store_id: i.store_id, updated_at: i.updated_at,
      }))));
    }).catch(() => { /* best-effort */ });
    getStoresAPI().then(async (stores) => {
      await saveLocalStores(stores.map(s => ({ id: s.id, name: s.name, position: s.position })));
    }).catch(() => { /* best-effort */ });
  }, [user, isOnline]);

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

      // Skip if there are pending offline changes — don't overwrite local edits
      try {
        const pending = await getPendingChanges();

        if (detail.type === 'grocery.updated' && currentPageRef.current !== 'grocery') {
          if (pending.some(c => c.type.startsWith('grocery-'))) return;
          try {
            const data = await getGroceryList();
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
          try {
            const data = await getPantryList();
            try { localStorage.setItem('meal-planner-pantry-sections', JSON.stringify(data)); } catch {}
            await saveLocalPantrySections(data.map(s => ({ id: s.id, name: s.name, position: s.position })));
            await saveLocalPantryItems(data.flatMap(s => s.items.map(i => ({
              id: i.id, section_id: i.section_id, name: i.name,
              quantity: i.quantity, position: i.position, updated_at: i.updated_at,
            }))));
          } catch {}
        }

        if (detail.type === 'stores.updated') {
          try {
            const stores = await getStoresAPI();
            await saveLocalStores(stores.map(s => ({ id: s.id, name: s.name, position: s.position })));
            try { localStorage.setItem('meal-planner-stores', JSON.stringify(stores)); } catch {}
          } catch {}
        }

        if (detail.type === 'meal-ideas.updated' && currentPageRef.current !== 'meals') {
          if (pending.some(c => c.type.startsWith('meal-idea-'))) return;
          try {
            const ideas = await getMealIdeas();
            await clearLocalMealIdeas();
            for (const idea of ideas) {
              await saveLocalMealIdea(idea);
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
          if (detail.type === 'calendar.refreshed') {
            const payload = detail.payload as { events_by_date?: Record<string, any[]> };
            if (payload?.events_by_date) {
              for (const [date, events] of Object.entries(payload.events_by_date)) {
                try { saveLocalCalendarEvents(date, events); } catch {}
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

  useEffect(() => {
    const scale = settings.compactView ? settings.textScaleCompact : settings.textScaleStandard;
    const root = document.documentElement;
    const baseSize = 16;
    root.style.fontSize = `${baseSize * scale}px`;
    return () => {
      root.style.fontSize = '';
    };
  }, [settings.compactView, settings.textScaleCompact, settings.textScaleStandard]);

  const handleLogout = useCallback(async () => {
    await logout();
    localStorage.removeItem('meal-planner-user');
    localStorage.removeItem('meal-planner-grocery');
    localStorage.removeItem('meal-planner-settings');
    await clearAllLocalData().catch(() => {});
    setUser(null);
  }, []);

  // Log out when any API call returns 401
  useEffect(() => {
    const handler = () => { handleLogout(); };
    window.addEventListener('auth-unauthorized', handler);
    return () => window.removeEventListener('auth-unauthorized', handler);
  }, [handleLogout]);

  if (loading) {
    return (
      <div
        className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center"
        data-testid="app-loading"
        aria-label="Loading"
      >
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 max-w-sm w-full text-center">
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
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex flex-col">
      {/* Status Bar */}
      <StatusBar status={status} pendingCount={pendingCount} />

      {/* Page Content — each wrapped in its own UndoProvider for independent undo/redo */}
      {currentPage === 'meals' && (
        <UndoProvider>
          <MealsPage
            user={user}
            status={status}
            settings={settings}
            onShowSettings={() => setShowSettings(true)}
            onLogout={handleLogout}
            updateAvailable={updateAvailable}
          />
        </UndoProvider>
      )}
      {currentPage === 'pantry' && (
        <UndoProvider>
          <PantryPage
            user={user}
            status={status}
            settings={settings}
            onShowSettings={() => setShowSettings(true)}
            onLogout={handleLogout}
            updateAvailable={updateAvailable}
          />
        </UndoProvider>
      )}
      {currentPage === 'grocery' && (
        <UndoProvider>
          <GroceryPage
            user={user}
            status={status}
            settings={settings}
            onShowSettings={() => setShowSettings(true)}
            onLogout={handleLogout}
            updateAvailable={updateAvailable}
          />
        </UndoProvider>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          onUpdate={updateSettings}
          onClose={() => setShowSettings(false)}
          isDark={isDark}
          onToggleDarkMode={toggleDarkMode}
          updateAvailable={updateAvailable}
          onApplyUpdate={applyUpdate}
          updating={updating}
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
      <BottomNav currentPage={currentPage} onChange={handlePageChange} groceryCount={groceryCount} />
    </div>
  );
}

function App() {
  return <AppContent />;
}

export default App;
