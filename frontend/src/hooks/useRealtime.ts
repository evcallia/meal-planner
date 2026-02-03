import { useEffect } from 'react';

type RealtimePayload = {
  type: string;
  payload: unknown;
};

let eventSource: EventSource | null = null;
let subscriberCount = 0;

const createSource = () => {
  if (eventSource) return eventSource;
  eventSource = new EventSource('/api/stream');
  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as RealtimePayload;
      window.dispatchEvent(new CustomEvent('meal-planner-realtime', { detail: payload }));
    } catch (error) {
      console.warn('Realtime payload parse failed:', error);
    }
  };
  return eventSource;
};

export function useRealtime() {
  useEffect(() => {
    subscriberCount += 1;
    createSource();

    return () => {
      subscriberCount -= 1;
      if (subscriberCount <= 0 && eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  }, []);
}
