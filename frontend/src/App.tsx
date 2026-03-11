import { useState, useEffect, useRef, useCallback } from 'react';
import { CalendarView } from './components/CalendarView';
import { PantryPanel } from './components/PantryPanel';
import { MealIdeasPanel } from './components/MealIdeasPanel';
import { GroceryListView } from './components/GroceryListView';
import { StatusBar } from './components/StatusBar';
import { SettingsModal } from './components/SettingsModal';
import { useSync } from './hooks/useSync';
import { useDarkMode } from './hooks/useDarkMode';
import { useSettings } from './hooks/useSettings';
import { useRealtime } from './hooks/useRealtime';
import { getCurrentUser, getLoginUrl, logout, getDays, updateNotes } from './api/client';
import { UserInfo } from './types';
import { scrollToElementWithOffset } from './utils/scroll';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { getLocalNote, queueChange, saveLocalNote } from './db';
import { UndoProvider, useUndo } from './contexts/UndoContext';

type Page = 'meals' | 'grocery';

function PageHeader({
  title,
  user,
  onLogout,
  onShowSettings,
  status,
}: {
  title: string;
  user: UserInfo;
  onLogout: () => void;
  onShowSettings: () => void;
  status: string;
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
            className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            aria-label="Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
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

function BottomNav({ currentPage, onChange }: { currentPage: Page; onChange: (page: Page) => void }) {
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
          onClick={() => onChange('grocery')}
          className={`flex-1 flex flex-col items-center py-2 transition-colors ${
            currentPage === 'grocery'
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          {/* Shopping cart icon */}
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 100 4 2 2 0 000-4z" />
          </svg>
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
}: {
  user: UserInfo;
  status: string;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onShowSettings: () => void;
  onLogout: () => void;
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
      <PageHeader title="Meal Planner" user={user} onLogout={onLogout} onShowSettings={onShowSettings} status={status} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-4 pb-20 space-y-6">
        <div ref={topSectionRef} />
        {settings.showMealIdeas && <MealIdeasPanel onSchedule={handleScheduleMeal} onUnschedule={handleUnscheduleMeal} compactView={settings.compactView} />}
        {settings.showPantry && <PantryPanel compactView={settings.compactView} />}
        <CalendarView
          onTodayRefReady={handleTodayRefReady}
          showItemizedColumn={settings.showItemizedColumn}
          compactView={settings.compactView}
          showAllEvents={settings.showAllEvents}
        />
      </main>

      {/* Floating Action Buttons */}
      <div className="fixed bottom-16 right-4 z-20 flex flex-col gap-2">
        {(settings.showPantry || settings.showMealIdeas) && (
          <button
            onClick={scrollToTopSection}
            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-full px-3 py-1.5 shadow-lg transition-all duration-200 hover:scale-105 flex items-center gap-1.5 text-sm"
            aria-label="Jump to pantry"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
            <span className="font-medium">Pantry</span>
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
}: {
  user: UserInfo;
  status: string;
  settings: ReturnType<typeof import('./hooks/useSettings').useSettings>['settings'];
  onShowSettings: () => void;
  onLogout: () => void;
}) {
  return (
    <>
      <PageHeader title="Grocery List" user={user} onLogout={onLogout} onShowSettings={onShowSettings} status={status} />
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-4 pb-20 space-y-6">
        <GroceryListView compactView={settings.compactView} />
      </main>
    </>
  );
}

function AppContent() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [currentPage, setCurrentPage] = useState<Page>('meals');
  const { status, pendingCount } = useSync();
  const { isDark, toggle: toggleDarkMode } = useDarkMode();
  const { settings, updateSettings } = useSettings();
  useRealtime();

  useEffect(() => {
    const checkAuth = async () => {
      const cached = localStorage.getItem('meal-planner-user');

      try {
        const currentUser = await getCurrentUser();
        if (currentUser) {
          localStorage.setItem('meal-planner-user', JSON.stringify(currentUser));
          setUser(currentUser);
        } else {
          if (cached) {
            try {
              setUser(JSON.parse(cached));
            } catch {
              setUser(null);
            }
          } else {
            setUser(null);
          }
        }
      } catch (error) {
        console.error('Auth check failed:', error);
        if (cached) {
          try {
            setUser(JSON.parse(cached));
          } catch {
            setUser(null);
          }
        } else {
          setUser(null);
        }
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, []);

  useEffect(() => {
    const scale = settings.compactView ? settings.textScaleCompact : settings.textScaleStandard;
    const root = document.documentElement;
    const baseSize = 16;
    root.style.fontSize = `${baseSize * scale}px`;
    return () => {
      root.style.fontSize = '';
    };
  }, [settings.compactView, settings.textScaleCompact, settings.textScaleStandard]);

  const handleLogout = async () => {
    await logout();
    localStorage.removeItem('meal-planner-user');
    setUser(null);
  };

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
      {currentPage === 'meals' ? (
        <UndoProvider>
          <MealsPage
            user={user}
            status={status}
            settings={settings}
            onShowSettings={() => setShowSettings(true)}
            onLogout={handleLogout}
          />
        </UndoProvider>
      ) : (
        <UndoProvider>
          <GroceryPage
            user={user}
            status={status}
            settings={settings}
            onShowSettings={() => setShowSettings(true)}
            onLogout={handleLogout}
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
        />
      )}

      {/* Bottom Navigation */}
      <BottomNav currentPage={currentPage} onChange={setCurrentPage} />
    </div>
  );
}

function App() {
  return <AppContent />;
}

export default App;
