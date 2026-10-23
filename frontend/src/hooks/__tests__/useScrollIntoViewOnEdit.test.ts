import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollIntoViewOnEdit } from '../useScrollIntoViewOnEdit';

describe('useScrollIntoViewOnEdit', () => {
  const scrollIntoView = vi.fn();
  const ref = { current: { scrollIntoView } as unknown as HTMLElement };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls the element into view shortly after editing starts', () => {
    renderHook(({ editing }) => useScrollIntoViewOnEdit(ref, editing), {
      initialProps: { editing: true },
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('does nothing when not editing', () => {
    renderHook(({ editing }) => useScrollIntoViewOnEdit(ref, editing), {
      initialProps: { editing: false },
    });
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('cancels the pending scroll when editing ends', () => {
    const { rerender } = renderHook(
      ({ editing }) => useScrollIntoViewOnEdit(ref, editing),
      { initialProps: { editing: true } },
    );
    rerender({ editing: false });
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('re-scrolls on viewport resize while the keyboard is open', () => {
    const resizeListeners: EventListener[] = [];
    const viewport = {
      height: window.innerHeight - 300, // keyboard covering the screen
      addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('visualViewport', viewport);

    const { unmount } = renderHook(
      ({ editing }) => useScrollIntoViewOnEdit(ref, editing),
      { initialProps: { editing: true } },
    );
    expect(viewport.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));

    resizeListeners.forEach(fn => fn(new Event('resize')));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });

    unmount();
    expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    vi.unstubAllGlobals();
  });

  it('does not re-scroll on resize after the keyboard is dismissed', () => {
    const resizeListeners: EventListener[] = [];
    const viewport = {
      height: window.innerHeight, // keyboard gone — full-height viewport
      addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('visualViewport', viewport);

    renderHook(({ editing }) => useScrollIntoViewOnEdit(ref, editing), {
      initialProps: { editing: true },
    });
    resizeListeners.forEach(fn => fn(new Event('resize')));
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('ignores viewport growth (keyboard closing) — a scroll cannot counter it', () => {
    const resizeListeners: EventListener[] = [];
    const viewport = {
      height: window.innerHeight - 300, // keyboard fully open at mount
      addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('visualViewport', viewport);

    renderHook(({ editing }) => useScrollIntoViewOnEdit(ref, editing), {
      initialProps: { editing: true },
    });

    // Keyboard begins closing: viewport grows. A scrollIntoView call here
    // (previously an instant 'nearest' scroll) didn't hold position against
    // iOS's own scroll restoration — either a no-op or itself a competing
    // movement. The close case is handled by unmounting the form (wired
    // alongside this hook at every inline-add-form call site), so this hook
    // must do nothing on growth.
    viewport.height = window.innerHeight - 200;
    resizeListeners.forEach(fn => fn(new Event('resize')));
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Keyboard re-opens / shrinks again: smooth centering resumes
    viewport.height = window.innerHeight - 300;
    resizeListeners.forEach(fn => fn(new Event('resize')));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', behavior: 'smooth' });
    vi.unstubAllGlobals();
  });
});
