import { useSyncExternalStore } from 'react';

// Singleton online-status manager — a single /api/health check is shared
// across all hook consumers so tab switches don't trigger redundant calls.
let _isOnline = navigator.onLine;
const _listeners = new Set<() => void>();
let _checking = false;
let _interval: ReturnType<typeof setInterval> | null = null;
let _subscriberCount = 0;
const POLL_ONLINE = 30000;   // 30s when online
const POLL_OFFLINE = 5000;   // 5s when offline (server down)
const TIMEOUT_OFFLINE = 5000; // 5s fetch timeout when offline

export function resetOnlineStatus() {
  _isOnline = navigator.onLine;
  _checking = false;
  _listeners.clear();
  if (_interval) { clearInterval(_interval); _interval = null; }
  _subscriberCount = 0;
}

function notify() {
  for (const l of _listeners) l();
}

function restartInterval() {
  if (_interval) clearInterval(_interval);
  const rate = _isOnline ? POLL_ONLINE : POLL_OFFLINE;
  _interval = setInterval(() => {
    if (navigator.onLine) checkConnectivity();
  }, rate);
}

function setOnline(value: boolean) {
  if (_isOnline !== value) {
    _isOnline = value;
    notify();
    if (_subscriberCount > 0) restartInterval();
  }
}

async function healthFetch(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = _isOnline ? 2000 : TIMEOUT_OFFLINE;
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch('/api/health', {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    clearTimeout(timeoutId);
    return false;
  }
}

async function checkConnectivity() {
  if (_checking) return;
  _checking = true;
  try {
    const ok = await healthFetch();
    if (ok) {
      setOnline(true);
    } else if (!_isOnline) {
      // Already offline — stay offline
      setOnline(false);
    } else {
      // Currently online but health check failed — retry once before going offline
      await new Promise(r => setTimeout(r, 3000));
      const retryOk = await healthFetch();
      setOnline(retryOk);
    }
  } finally {
    _checking = false;
  }
}

function handleOnline() { checkConnectivity(); }
function handleOffline() { setOnline(false); }
function handleApiSuccess() { setOnline(true); }

function subscribe(callback: () => void) {
  _listeners.add(callback);

  if (_subscriberCount === 0) {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('api-request-succeeded', handleApiSuccess);
    if (navigator.onLine) checkConnectivity();
    _interval = setInterval(() => {
      if (navigator.onLine) checkConnectivity();
    }, _isOnline ? POLL_ONLINE : POLL_OFFLINE);
  }
  _subscriberCount++;

  return () => {
    _listeners.delete(callback);
    _subscriberCount--;
    if (_subscriberCount === 0) {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('api-request-succeeded', handleApiSuccess);
      if (_interval) { clearInterval(_interval); _interval = null; }
    }
  };
}

function getSnapshot() { return _isOnline; }

export function useOnlineStatus() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
