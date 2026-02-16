import { useEffect } from 'react';
import { useOnlineStatus } from './useOnlineStatus';

type RealtimePayload = {
  type: string;
  payload: unknown;
};

let eventSource: EventSource | null = null;
let subscriberCount = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
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
  // Clean up any existing connection first
  closeSource();

  eventSource = new EventSource('/api/stream', { withCredentials: true });

  eventSource.onopen = () => {
    // Reset reconnect attempts on successful connection
    reconnectAttempts = 0;
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

    // Only reconnect if we still have subscribers and haven't exceeded attempts
    if (subscriberCount > 0 && !reconnectTimeout) {
      // Exponential backoff with max delay
      reconnectAttempts++;
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
      }
    };
  }, []);

  // Reconnect when coming back online
  useEffect(() => {
    if (isOnline && subscriberCount > 0 && !eventSource) {
      reconnectAttempts = 0; // Reset on online status change
      createSource();
    } else if (!isOnline) {
      closeSource();
    }
  }, [isOnline]);
}
