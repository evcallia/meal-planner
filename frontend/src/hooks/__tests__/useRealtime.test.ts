import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRealtime } from '../useRealtime';

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

class MockEventSource {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public close = vi.fn();

  constructor(public url: string, public options?: EventSourceInit) {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('useRealtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an EventSource and dispatches events', () => {
    let source: MockEventSource | null = null;
    const eventSourceSpy = vi.fn(function (url: string) {
      source = new MockEventSource(url);
      return source;
    });
    // @ts-expect-error - test override
    global.EventSource = eventSourceSpy;

    const listener = vi.fn();
    window.addEventListener('meal-planner-realtime', listener);

    const { unmount } = renderHook(() => useRealtime());

    expect(eventSourceSpy).toHaveBeenCalledWith('/api/stream', { withCredentials: true });

    if (!source) {
      throw new Error('EventSource was not created');
    }

    source.emit({ type: 'pantry.updated', payload: { id: '1' } });

    expect(listener).toHaveBeenCalled();

    unmount();
    window.removeEventListener('meal-planner-realtime', listener);
  });
});
