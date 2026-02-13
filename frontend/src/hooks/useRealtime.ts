import { useEffect } from 'react';
import { useOnlineStatus } from './useOnlineStatus';
import { emitAuthFailure } from '../authEvents';

type RealtimePayload = {
  type: string;
  payload: unknown;
};

let eventSource: EventSource | null = null;
let subscriberCount = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let authFailed = false;
const MAX_RECONNECT_DELAY = 60000; // Max 1 minute between retries
const BASE_RECONNECT_DELAY = 3000; // Start with 3 seconds

const closeSource = () => {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
};

const createSource = () => {
  // Don't reconnect if we know auth has failed
  if (authFailed) return;

  // Clean up any existing connection first
  closeSource();

  let didOpen = false;

  eventSource = new EventSource('/api/stream', { withCredentials: true });

  eventSource.onopen = () => {
    // Reset reconnect attempts on successful connection
    didOpen = true;
    reconnectAttempts = 0;
    authFailed = false;
  };

  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as RealtimePayload;
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: payload }));
    } catch (error) {
      console.warn('Realtime payload parse failed:', error);
    }
  };

  eventSource.onerror = () => {
    // Connection lost - close the source
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    reconnectAttempts++;

    // If the connection never opened, it's likely an auth error (401/403).
    // EventSource doesn't expose HTTP status, but a connection that immediately
    // errors without opening is characteristic of auth/access failures.
    // After 3 consecutive failures without ever connecting, assume auth issue.
    if (!didOpen && reconnectAttempts >= 3) {
      authFailed = true;
      emitAuthFailure('session-expired');
      return;
    }

    // Only reconnect if we still have subscribers
    if (subscriberCount > 0 && !reconnectTimeout) {
      const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);

      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        if (subscriberCount > 0) {
          createSource();
        }
      }, delay);
    }
  };

  return eventSource;
};

export function useRealtime() {
  const isOnline = useOnlineStatus();

  useEffect(() => {
    subscriberCount += 1;

    // Only create connection when online
    if (isOnline) {
      createSource();
    }

    return () => {
      subscriberCount -= 1;
      if (subscriberCount <= 0) {
        closeSource();
        reconnectAttempts = 0;
        authFailed = false;
      }
    };
  }, []);

  // Reconnect when coming back online
  useEffect(() => {
    if (isOnline && subscriberCount > 0 && !eventSource) {
      reconnectAttempts = 0; // Reset on online status change
      authFailed = false; // Re-check auth on new online event
      createSource();
    } else if (!isOnline) {
      closeSource();
    }
  }, [isOnline]);
}
