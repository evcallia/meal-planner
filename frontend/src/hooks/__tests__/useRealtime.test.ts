import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRealtime } from '../useRealtime';
import { useOnlineStatus } from '../useOnlineStatus';

vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

class MockEventSource {
  public onopen: (() => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: (() => void) | null = null;
  public close = vi.fn();

  constructor(public url: string, public options?: EventSourceInit) {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('useRealtime', () => {
  const mockUseOnlineStatus = vi.mocked(useOnlineStatus);

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseOnlineStatus.mockReturnValue(true);
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

  it('does not connect when offline', () => {
    mockUseOnlineStatus.mockReturnValue(false);
    const eventSourceSpy = vi.fn();
    // @ts-expect-error - test override
    global.EventSource = eventSourceSpy;

    const { unmount } = renderHook(() => useRealtime());

    expect(eventSourceSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('reconnects after errors with backoff', () => {
    vi.useFakeTimers();
    mockUseOnlineStatus.mockReturnValue(true);

    const sources: MockEventSource[] = [];
    const eventSourceSpy = vi.fn(function (url: string) {
      const source = new MockEventSource(url);
      sources.push(source);
      return source;
    });
    // @ts-expect-error - test override
    global.EventSource = eventSourceSpy;

    const { unmount } = renderHook(() => useRealtime());

    expect(sources).toHaveLength(1);

    act(() => {
      sources[0].onerror?.();
    });

    expect(sources[0].close).toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(sources.length).toBeGreaterThan(1);
    unmount();
    vi.useRealTimers();
  });

  it('logs warning when realtime payload is invalid', () => {
    mockUseOnlineStatus.mockReturnValue(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let source: MockEventSource | null = null;
    const eventSourceSpy = vi.fn(function (url: string) {
      source = new MockEventSource(url);
      return source;
    });
    // @ts-expect-error - test override
    global.EventSource = eventSourceSpy;

    const { unmount } = renderHook(() => useRealtime());

    if (!source) {
      throw new Error('EventSource was not created');
    }

    source.onmessage?.({ data: 'not-json' } as MessageEvent);
    expect(warnSpy).toHaveBeenCalledWith('Realtime payload parse failed:', expect.any(Error));

    warnSpy.mockRestore();
    unmount();
  });
});
