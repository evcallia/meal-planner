import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { restoreCarriedScroll } from '../scrollPin';

// While the iOS keyboard is up, <main> is the scroll container and the window
// scroll is pinned to 0, so the user's position lives in main.scrollTop and is
// discarded when the class comes off — the page lands at the top. Measured on
// device, the only restore that existed (a [data-day-date] anchor) reported
// `anchorFound=false cards=0` on Grocery, because those cards are Meals-only.
describe('restoreCarriedScroll', () => {
  let main: HTMLElement;
  let scrollTo: ReturnType<typeof vi.fn>;

  /** main's box sits below the header; its position in the document equals
   *  that same offset once the window is scrolled to 0. */
  const layOutMainAt = (screenTop: number) => {
    main.getBoundingClientRect = () => ({ top: screenTop, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: screenTop, toJSON: () => ({}) }) as DOMRect;
  };

  beforeEach(() => {
    main = document.createElement('main');
    document.body.appendChild(main);
    scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    vi.stubGlobal('scrollY', 0);
    layOutMainAt(48);
  });

  afterEach(() => {
    main.remove();
    vi.unstubAllGlobals();
  });

  it('scrolls the window to where the carried offset now sits', () => {
    restoreCarriedScroll(main, 400, 48);
    // boxTopInDoc(48) + carried(400) - boxTopBefore(48)
    expect(scrollTo).toHaveBeenCalledWith(0, 400);
  });

  it('accounts for main sitting at a different offset after the switch', () => {
    // The shell is sized to the visible area while the keyboard is up
    // (--vvh), so main's box can land somewhere else once that is undone.
    layOutMainAt(96);
    restoreCarriedScroll(main, 400, 48);
    expect(scrollTo).toHaveBeenCalledWith(0, 96 + 400 - 48);
  });

  it('never scrolls to a negative position', () => {
    layOutMainAt(0);
    restoreCarriedScroll(main, 10, 400);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('keeps re-applying, because iOS nudges the scroll over the close animation', async () => {
    restoreCarriedScroll(main, 400, 48, 60);
    const afterFirst = scrollTo.mock.calls.length;
    expect(afterFirst).toBe(1);
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    expect(scrollTo.mock.calls.length).toBeGreaterThan(afterFirst);
    // Converges on the same target rather than drifting.
    expect(scrollTo).toHaveBeenLastCalledWith(0, 400);
  });

  it('stops once main is gone', async () => {
    restoreCarriedScroll(main, 400, 48, 1000);
    main.remove();
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    const settled = scrollTo.mock.calls.length;
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    expect(scrollTo.mock.calls.length).toBe(settled);
  });
});
