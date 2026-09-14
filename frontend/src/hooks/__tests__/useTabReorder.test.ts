import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabReorder } from '../useTabReorder';

// The long-press tab drag shared by the Lists and Tasks tabs.

const pointer = (x = 0, y = 0) => ({ clientX: x, clientY: y }) as React.PointerEvent;

/** Make document.elementFromPoint resolve to the given tab id (or nothing). */
function overTab(id: string | null) {
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(
    id === null ? null : ({ closest: () => ({ getAttribute: () => id }) } as unknown as Element),
  );
}

function setup(tabIds = ['a', 'b', 'c']) {
  const onReorder = vi.fn();
  const stripRef = { current: null as HTMLElement | null };
  const hook = renderHook(() => useTabReorder({ tabIds, stripRef, onReorder }));
  return { ...hook, onReorder };
}

beforeEach(() => {
  vi.useFakeTimers();
  // rAF drives the edge auto-scroll loop; a no-op keeps it from spinning.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useTabReorder', () => {
  it('does not pick a tab up before the long-press completes', () => {
    const { result } = setup();
    act(() => { result.current.tabHandlers('a').onPointerDown(pointer(10, 10)); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current.dragId).toBeNull();
  });

  it('picks the tab up after holding', () => {
    const { result } = setup();
    act(() => { result.current.tabHandlers('a').onPointerDown(pointer(10, 10)); });
    act(() => { vi.advanceTimersByTime(250); });
    expect(result.current.dragId).toBe('a');
    expect(result.current.dragOrder).toEqual(['a', 'b', 'c']);
  });

  it('cancels the pick-up when the pointer moves first (that gesture is a scroll)', () => {
    const { result } = setup();
    act(() => { result.current.tabHandlers('a').onPointerDown(pointer(10, 10)); });
    act(() => { result.current.tabHandlers('a').onPointerMove(pointer(40, 10)); });
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.dragId).toBeNull();
  });

  it('shuffles the order as the pointer passes over other tabs', () => {
    const { result } = setup();
    act(() => { result.current.tabHandlers('a').onPointerDown(pointer(10, 10)); });
    act(() => { vi.advanceTimersByTime(250); });

    overTab('c');
    act(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientX: 90, clientY: 10 })); });
    expect(result.current.dragOrder).toEqual(['b', 'c', 'a']);
  });

  it('reports the final order once, on release', () => {
    const { result, onReorder } = setup();
    act(() => { result.current.tabHandlers('a').onPointerDown(pointer(10, 10)); });
    act(() => { vi.advanceTimersByTime(250); });
    overTab('b');
    act(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 10 })); });
    act(() => { document.dispatchEvent(new PointerEvent('pointerup')); });

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
    expect(result.current.dragId).toBeNull();
    expect(result.current.dragOrder).toBeNull();
  });

  it('stays quiet when the drag ends where it started', () => {
    const { result, onReorder } = setup();
    act(() => { result.current.tabHandlers('a').onPointerDown(pointer(10, 10)); });
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { document.dispatchEvent(new PointerEvent('pointerup')); });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('suppresses the click that follows a drag, then re-enables it', () => {
    const { result } = setup();
    act(() => { result.current.tabHandlers('a').onPointerDown(pointer(10, 10)); });
    act(() => { vi.advanceTimersByTime(250); });
    act(() => { document.dispatchEvent(new PointerEvent('pointerup')); });
    expect(result.current.justDraggedRef.current).toBe(true);
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.justDraggedRef.current).toBe(false);
  });

  it('leaves no document listeners behind when unmounted mid-drag', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    const { result, unmount } = setup();
    act(() => { result.current.tabHandlers('a').onPointerDown(pointer(10, 10)); });
    act(() => { vi.advanceTimersByTime(250); });
    unmount();
    const events = remove.mock.calls.map(c => c[0]);
    expect(events).toContain('pointermove');
    expect(events).toContain('pointerup');
    expect(events).toContain('touchmove');
  });
});
