import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { setupPerfLogging } from './utils/perf';

const BUILD_KEY = 'meal-planner-build';

const maybeBustCaches = () => {
  if (!import.meta.env.PROD) return;
  try {
    const previousBuild = localStorage.getItem(BUILD_KEY);
    const currentBuild = __APP_BUILD__;
    if (previousBuild && previousBuild !== currentBuild) {
      localStorage.setItem(BUILD_KEY, currentBuild);
      // Only bust caches if we're online - otherwise we'd break offline mode
      if (navigator.onLine) {
        const clearCaches = async () => {
          if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            await Promise.all(registrations.map(registration => registration.unregister()));
          }
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(key => caches.delete(key)));
          }
        };
        clearCaches().finally(() => {
          if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
            window.location.reload();
          }
        });
        return;
      }
    }
    localStorage.setItem(BUILD_KEY, currentBuild);
  } catch (error) {
    console.warn('Build cache check failed:', error);
  }
};

setupPerfLogging();
maybeBustCaches();

if (import.meta.env.PROD) {
  const loadPwa = new Function("return import('virtual:pwa-register')") as () => Promise<{ registerSW: (options: {
    immediate?: boolean;
    onRegisteredSW?: (swUrl: string, registration?: ServiceWorkerRegistration) => void;
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
  }) => (reload?: boolean) => void }>;
  loadPwa().then(({ registerSW }) => {
    const updateSW = registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        console.log('Service worker registered');
        // Check for updates periodically
        if (registration) {
          setInterval(() => {
            registration.update();
          }, 60 * 60 * 1000); // Check every hour
        }
      },
      onNeedRefresh() {
        console.log('New content available, refreshing...');
        updateSW(true);
      },
      onOfflineReady() {
        console.log('App ready to work offline');
      },
    });
  }).catch(err => {
    console.warn('PWA registration failed:', err);
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
