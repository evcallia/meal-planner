import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useVisualViewportPin } from '../useVisualViewportPin';

function Pinned() {
  const ref = useVisualViewportPin<HTMLDivElement>();
  return <div ref={ref} data-testid="pinned" />;
}

type Listener = () => void;

function makeViewport(height: number, offsetTop = 0) {
  const listeners = new Map<string, Set<Listener>>();
  const viewport = {
    height,
    offsetTop,
    width: 400,
    offsetLeft: 0,
    pageTop: 0,
    scale: 1,
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
    fire: (type: string) => {
      listeners.get(type)?.forEach(fn => fn());
    },
  };
  return viewport;
}

describe('useVisualViewportPin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Synchronous rAF; returns 0 so the hook's "one frame in flight" guard
    // (reset inside the callback, i.e. before this return value lands) stays clear.
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      fn(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('applies no correction when the viewports agree', () => {
    const viewport = makeViewport(window.innerHeight);
    vi.stubGlobal('visualViewport', viewport);
    const { getByTestId } = render(<Pinned />);
    expect(getByTestId('pinned').style.getPropertyValue('translate')).toBe('');
  });

  it('lifts the element when the layout viewport bottom is below the visual bottom (keyboard pan)', () => {
    // innerHeight 800, visual viewport 500 high panned 40 down → gap 260
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const viewport = makeViewport(500, 40);
    vi.stubGlobal('visualViewport', viewport);
    const { getByTestId } = render(<Pinned />);
    expect(getByTestId('pinned').style.getPropertyValue('translate')).toBe('0 -260px');
  });

  it('pushes the element down when innerHeight is stale (nav floating mid-screen)', () => {
    // Stale innerHeight 500 but the visual viewport is actually 800 → gap -300
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    const viewport = makeViewport(800, 0);
    vi.stubGlobal('visualViewport', viewport);
    const { getByTestId } = render(<Pinned />);
    expect(getByTestId('pinned').style.getPropertyValue('translate')).toBe('0 300px');
  });

  it('clears the correction once the viewports re-agree', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const viewport = makeViewport(500, 0);
    vi.stubGlobal('visualViewport', viewport);
    const { getByTestId } = render(<Pinned />);
    expect(getByTestId('pinned').style.getPropertyValue('translate')).toBe('0 -300px');

    viewport.height = 800;
    act(() => {
      viewport.fire('resize');
    });
    expect(getByTestId('pinned').style.getPropertyValue('translate')).toBe('');
  });

  it('re-checks on a timer even without viewport events', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const viewport = makeViewport(800, 0);
    vi.stubGlobal('visualViewport', viewport);
    const { getByTestId } = render(<Pinned />);
    expect(getByTestId('pinned').style.getPropertyValue('translate')).toBe('');

    // Viewport silently breaks (no events fired) — the poll catches it.
    viewport.height = 500;
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(getByTestId('pinned').style.getPropertyValue('translate')).toBe('0 -300px');
  });
});
