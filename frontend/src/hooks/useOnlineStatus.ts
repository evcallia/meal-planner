import { useState, useEffect, useCallback, useRef } from 'react';
import { emitAuthFailure } from '../authEvents';

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const checkingRef = useRef(false);

  // Actually test network connectivity with a fast timeout
  const checkConnectivity = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;

    try {
      const controller = new AbortController();
      // Very short timeout - if server doesn't respond in 2s, assume offline
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch('/api/health', {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        // Healthy response — truly online
        setIsOnline(true);
      } else if (response.status === 401 || response.status === 403) {
        // Got a response, so network is fine. The problem is auth/access.
        // Check if this is a Cloudflare challenge (HTML response to an API request)
        const contentType = response.headers.get('content-type') || '';
        const reason = contentType.includes('text/html') ? 'cf-challenge' : 'session-expired';
        setIsOnline(true);
        emitAuthFailure(reason);
      } else {
        // Other server errors (500, 502, 503) — could be server down
        setIsOnline(false);
      }
    } catch {
      // Network error or timeout - we're offline
      setIsOnline(false);
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      // Browser says we're online, but verify
      checkConnectivity();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial check
    if (navigator.onLine) {
      checkConnectivity();
    }

    // Periodic connectivity check when browser reports online
    const interval = setInterval(() => {
      if (navigator.onLine) {
        checkConnectivity();
      }
    }, 30000); // Check every 30 seconds

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(interval);
    };
  }, [checkConnectivity]);

  return isOnline;
}
