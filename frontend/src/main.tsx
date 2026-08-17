import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { setupPerfLogging } from './utils/perf';
import { currentFingerprint, watchForAppUpdate } from './utils/appUpdate';

// Breadcrumb for debugging which bundle a device is actually running.
try {
  localStorage.setItem('meal-planner-build', currentFingerprint());
} catch { /* localStorage unavailable */ }

setupPerfLogging();

// Backup update detection for iOS standalone, where the service worker's own
// update lifecycle is unreliable. Runs outside React so it works even if the
// React tree is stale. See utils/appUpdate.ts.
if (import.meta.env.PROD) {
  watchForAppUpdate();
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
