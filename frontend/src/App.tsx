import { useState, useEffect, useRef, useCallback } from 'react';
import { CalendarView } from './components/CalendarView';
import { PantryPanel } from './components/PantryPanel';
import { MealIdeasPanel } from './components/MealIdeasPanel';
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

function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const { status, pendingCount } = useSync();
  const { isDark, toggle: toggleDarkMode } = useDarkMode();
  const { settings, updateSettings } = useSettings();
  useRealtime();
  const isOnline = useOnlineStatus();
  const todayRefElement = useRef<HTMLDivElement | null>(null);
  const topSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      const cached = localStorage.getItem('meal-planner-user');

      try {
        const currentUser = await getCurrentUser();
        if (currentUser) {
          // Cache user info for offline use
          localStorage.setItem('meal-planner-user', JSON.stringify(currentUser));
          setUser(currentUser);
        } else {
          // API returned null - either not logged in, or request failed/timed out
          // If we have cached user, use it (likely offline or timeout)
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
        // Request threw an error (network error, timeout, etc)
        // Use cached user if available
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

  const handleLogout = async () => {
    await logout();
    localStorage.removeItem('meal-planner-user');
    setUser(null);
  };

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

  const handleScheduleMeal = async (title: string, date: string) => {
    if (!date) return;
    let existingNotes = '';

    if (isOnline) {
      try {
        const days = await getDays(date, date);
        existingNotes = days[0]?.meal_note?.notes ?? '';
        const nextNotes = appendMealLine(existingNotes, title);
        const updated = await updateNotes(date, nextNotes);
        notifyNotesUpdate(date, updated.notes ?? nextNotes);
        return;
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

      {/* Header */}
      <header className="bg-white dark:bg-gray-800 shadow-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Meal Planner</h1>
          <div className="flex items-center gap-3">
            {/* Settings button */}
            <button
              onClick={() => setShowSettings(true)}
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
              onClick={handleLogout}
              className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-4 space-y-6">
        <div ref={topSectionRef} />
        {settings.showMealIdeas && <MealIdeasPanel onSchedule={handleScheduleMeal} compactView={settings.compactView} />}
        {settings.showPantry && <PantryPanel compactView={settings.compactView} />}
        <CalendarView
          onTodayRefReady={handleTodayRefReady}
          showItemizedColumn={settings.showItemizedColumn}
          compactView={settings.compactView}
        />
      </main>

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

      {/* Floating Action Buttons */}
      <div className="fixed bottom-6 right-6 z-20 flex flex-col gap-3">
        {(settings.showPantry || settings.showMealIdeas) && (
          <button
            onClick={scrollToTopSection}
            className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-full px-4 py-3 shadow-lg transition-all duration-200 hover:scale-105 flex items-center gap-2"
            aria-label="Jump to pantry"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
            <span className="font-medium">Pantry</span>
          </button>
        )}
        <button
          onClick={scrollToToday}
          className="bg-blue-500 hover:bg-blue-600 text-white rounded-full px-4 py-3 shadow-lg transition-all duration-200 hover:scale-105 flex items-center gap-2"
          aria-label="Jump to today"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
          <span className="font-medium">Today</span>
        </button>
      </div>
    </div>
  );
}

export default App;
