import { useState, useEffect, useRef, useCallback } from 'react';
import { CalendarView } from './components/CalendarView';
import { StatusBar } from './components/StatusBar';
import { useSync } from './hooks/useSync';
import { useDarkMode } from './hooks/useDarkMode';
import { getCurrentUser, getLoginUrl, logout } from './api/client';
import { UserInfo } from './types';

function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showJumpToToday, setShowJumpToToday] = useState(false);
  const { status, pendingCount } = useSync();
  const { isDark, toggle: toggleDarkMode } = useDarkMode();
  const todayRefElement = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const currentUser = await getCurrentUser();
        setUser(currentUser);
      } catch (error) {
        console.error('Auth check failed:', error);
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, []);

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  const handleTodayRefReady = useCallback((ref: HTMLDivElement | null) => {
    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    todayRefElement.current = ref;

    // Set up new intersection observer when ref is ready
    if (ref) {
      const observer = new IntersectionObserver(
        (entries) => {
          setShowJumpToToday(!entries[0].isIntersecting);
        },
        { threshold: 0.1 }
      );
      observer.observe(ref);
      observerRef.current = observer;
    }
  }, []);

  // Cleanup observer on unmount
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  const scrollToToday = () => {
    if (todayRefElement.current) {
      todayRefElement.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center">
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
            {/* Dark mode toggle */}
            <button
              onClick={toggleDarkMode}
              className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              aria-label="Toggle dark mode"
            >
              {isDark ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
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
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-4">
        <CalendarView onTodayRefReady={handleTodayRefReady} />
      </main>

      {/* Jump to Today FAB */}
      {showJumpToToday && (
        <button
          onClick={scrollToToday}
          className="fixed bottom-6 right-6 bg-blue-500 hover:bg-blue-600 text-white rounded-full px-4 py-3 shadow-lg transition-all duration-200 hover:scale-105 z-20 flex items-center gap-2"
          aria-label="Jump to today"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
          <span className="font-medium">Today</span>
        </button>
      )}
    </div>
  );
}

export default App;
