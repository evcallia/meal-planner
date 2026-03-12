import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { setupPerfLogging } from './utils/perf';

// Track current build in localStorage (informational only — no cache nuking)
const BUILD_KEY = 'meal-planner-build';
try {
  localStorage.setItem(BUILD_KEY, __APP_BUILD__);
} catch { /* localStorage unavailable */ }

setupPerfLogging();

// version.json backup detection for iOS standalone mode
// Runs outside React so it works even if the React tree is stale
if (import.meta.env.PROD) {
  let lastVersionCheck = 0;
  const THROTTLE = 30_000;

  const checkForUpdate = async () => {
    if ((window as any).__pwaUpdateAvailable) return;
    const now = Date.now();
    if (now - lastVersionCheck < THROTTLE) return;
    lastVersionCheck = now;
    try {
      const res = await fetch(`/version.json?t=${now}`, { cache: 'no-store' });
      if (!res.ok) return;
      const { build } = await res.json();
      if (build && build !== __APP_BUILD__) {
        (window as any).__pwaUpdateAvailable = true;
        window.dispatchEvent(new Event('pwa-update-available'));
      }
    } catch { /* offline */ }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  window.addEventListener('focus', () => checkForUpdate());
  checkForUpdate();
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
