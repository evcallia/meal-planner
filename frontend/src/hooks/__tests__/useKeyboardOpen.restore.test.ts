import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardOpen } from '../useKeyboardOpen';

// The scroll-position half of the keyboard dance. While the keyboard is up,
// `.keyboard-open` makes <main> the scroll container and the window scroll is
// pinned to 0; when it comes off, the position in main.scrollTop is discarded
// and the page lands at the top. The only restore that existed anchored on
// `[data-day-date]`, which only the Meals tab renders — on device, Grocery
// reported `anchorFound=false cards=0` and nothing was restored.
describe('useKeyboardOpen — handing the scroll position back', () => {
  const FULL = 844;
  const KEYBOARD = 390;
  let main: HTMLElement;
  let input: HTMLInputElement;
  let resizeListeners: EventListener[];
  let viewport: { height: number; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
  let scrollTo: ReturnType<typeof vi.fn>;

  const fireResize = () => act(() => { resizeListeners.forEach(fn => fn(new Event('resize'))); });

  beforeEach(() => {
    main = document.createElement('main');
    input = document.createElement('input');
    main.appendChild(input);
    document.body.appendChild(main);

    resizeListeners = [];
    viewport = {
      height: FULL,
      addEventListener: vi.fn((type: string, fn: EventListener) => { if (type === 'resize') resizeListeners.push(fn); }),
      removeEventListener: vi.fn(),
    };
    scrollTo = vi.fn();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', FULL);
    vi.stubGlobal('scrollTo', scrollTo);
    vi.stubGlobal('scrollY', 0);
  });

  afterEach(() => {
    main.remove();
    document.documentElement.classList.remove('keyboard-open');
    vi.unstubAllGlobals();
  });

  /** Focus an input, shrink the viewport: the layout switch happens. */
  const openKeyboard = () => {
    input.focus();
    viewport.height = FULL - KEYBOARD;
    fireResize();
  };

  it('restores the position main was carrying when no day card anchors it', () => {
    const { result } = renderHook(() => useKeyboardOpen());

    openKeyboard();
    expect(result.current).toBe(true);
    expect(document.documentElement.classList.contains('keyboard-open')).toBe(true);

    // The user scrolls the list while the keyboard is up — this is the
    // position that used to be thrown away.
    main.scrollTop = 400;

    viewport.height = FULL;
    fireResize();

    expect(document.documentElement.classList.contains('keyboard-open')).toBe(false);
    expect(scrollTo).toHaveBeenCalledWith(0, 400);
  });

  it('does not scroll when main was already at the top', () => {
    renderHook(() => useKeyboardOpen());

    openKeyboard();
    main.scrollTop = 0;

    viewport.height = FULL;
    fireResize();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('leaves the day-card anchor in charge on the Meals tab', () => {
    // That path measures real layout across the switch rather than assuming
    // main's box keeps its position, so where it applies it stays the one in
    // charge — and the two must not both correct the same close.
    const card = document.createElement('div');
    card.setAttribute('data-day-date', '2026-10-23');
    card.getBoundingClientRect = () => ({ top: 120, bottom: 400, left: 0, right: 0, width: 0, height: 280, x: 0, y: 120, toJSON: () => ({}) }) as DOMRect;
    main.appendChild(card);

    renderHook(() => useKeyboardOpen());
    openKeyboard();
    main.scrollTop = 400;

    viewport.height = FULL;
    fireResize();

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
