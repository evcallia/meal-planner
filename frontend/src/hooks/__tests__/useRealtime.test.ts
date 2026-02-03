import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRealtime } from '../useRealtime';

class MockEventSource {
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public close = vi.fn();

  constructor(public url: string) {}

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('useRealtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an EventSource and dispatches events', () => {
    const source = new MockEventSource('/api/stream');
    const eventSourceSpy = vi.fn(() => source);
    // @ts-expect-error - test override
    global.EventSource = eventSourceSpy;

    const listener = vi.fn();
    window.addEventListener('meal-planner-realtime', listener);

    renderHook(() => useRealtime());

    expect(eventSourceSpy).toHaveBeenCalledWith('/api/stream');

    source.emit({ type: 'pantry.updated', payload: { id: '1' } });

    expect(listener).toHaveBeenCalled();

    window.removeEventListener('meal-planner-realtime', listener);
  });
});
