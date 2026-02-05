import { useState, useEffect, useCallback, useRef } from 'react';

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

      // If we got a response, we're online
      setIsOnline(response.ok);
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
