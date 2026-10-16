import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePinOnKeyboardClose } from '../usePinOnKeyboardClose';

describe('usePinOnKeyboardClose', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubViewport(height: number) {
    const resizeListeners: EventListener[] = [];
    const viewport = {
      height,
      addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('visualViewport', viewport);
    return { viewport, fire: () => resizeListeners.forEach(fn => fn(new Event('resize'))) };
  }

  it('pins the anchor via window.scrollBy when the keyboard closes while active', () => {
    const { viewport, fire } = stubViewport(window.innerHeight - 300); // keyboard open at mount
    const anchor = document.createElement('div');
    const tops = [300, 120]; // before (captured on close), after (first pin tick)
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
      () => ({ top: tops.shift() ?? 120 } as DOMRect)
    );
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const ref = { current: anchor };

    renderHook(({ active }) => usePinOnKeyboardClose(ref, active), {
      initialProps: { active: true },
    });

    // Keyboard closes: viewport grows back past the threshold.
    viewport.height = window.innerHeight;
    fire();

    expect(scrollBy).toHaveBeenCalledWith(0, 120 - 300);
  });

  it('does nothing while inactive (form closed) — not even subscribed', () => {
    const { viewport, fire } = stubViewport(window.innerHeight - 300);
    const anchor = document.createElement('div');
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const ref = { current: anchor };

    renderHook(({ active }) => usePinOnKeyboardClose(ref, active), {
      initialProps: { active: false },
    });

    expect(viewport.addEventListener).not.toHaveBeenCalled();
    viewport.height = window.innerHeight;
    fire();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('does not pin on a resize that is not a keyboard-close transition', () => {
    const { viewport, fire } = stubViewport(window.innerHeight); // keyboard already closed
    const anchor = document.createElement('div');
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect);
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const ref = { current: anchor };

    renderHook(({ active }) => usePinOnKeyboardClose(ref, active), {
      initialProps: { active: true },
    });

    // No actual open->close transition (keyboard was never open).
    fire();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('suppresses correction while the user is mid-touch, and re-arms after touchend', () => {
    const { viewport, fire } = stubViewport(window.innerHeight - 300); // keyboard open
    const anchor = document.createElement('div');
    // Returns a fresh (different) top on every call so any genuine pin
    // attempt produces nonzero drift; a suppressed attempt never reads it.
    let n = 0;
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
      () => ({ top: (n++) * 10 } as DOMRect)
    );
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    const ref = { current: anchor };

    renderHook(({ active }) => usePinOnKeyboardClose(ref, active), {
      initialProps: { active: true },
    });

    document.dispatchEvent(new Event('touchstart'));
    viewport.height = window.innerHeight; // keyboard closes mid deliberate scroll
    fire();
    expect(scrollBy).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('touchend'));

    // A fresh open->close transition after the touch ends still corrects.
    viewport.height = window.innerHeight - 300;
    fire();
    viewport.height = window.innerHeight;
    fire();
    expect(scrollBy).toHaveBeenCalled();
  });

  it('cleans up listeners on unmount', () => {
    const { viewport } = stubViewport(window.innerHeight - 300);
    const anchor = document.createElement('div');
    const ref = { current: anchor };

    const { unmount } = renderHook(({ active }) => usePinOnKeyboardClose(ref, active), {
      initialProps: { active: true },
    });
    unmount();

    expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});
