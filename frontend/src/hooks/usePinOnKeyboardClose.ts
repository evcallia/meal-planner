import { useEffect, type RefObject } from 'react';
import { pinScrollTo } from '../utils/scrollPin';

// Same threshold useKeyboardOpen/useScrollIntoViewOnEdit treat as "the
// keyboard is covering the screen".
const THRESHOLD = 150;

/**
 * Keeps an inline form that stays mounted across keyboard open/close (e.g.
 * the per-section "add item" row, kept open deliberately for rapid entry —
 * see ChecklistSectionCard/PantrySectionCard — and the top quick-add/paste
 * forms in GroceryListView) from drifting when the keyboard closes.
 *
 * useScrollIntoViewOnEdit's old approach for this case
 * (`scrollIntoView({ block: 'nearest' })` on the resize that signals the
 * keyboard closing) didn't hold position: it's a no-op once the element is
 * already on-screen, and otherwise just another one-shot scroll competing
 * with iOS's own restoration. iOS keeps adjusting the scroll position for
 * ~250ms after that resize event fires, so instead this measures the
 * anchor's position the instant the close is detected and re-asserts it
 * with `pinScrollTo` (the same technique `exitEditAnchored` uses for the
 * edit-exit case) across that window.
 *
 * Deliberately does NOT touch the keyboard-OPENING case — that's left to
 * useScrollIntoViewOnEdit (bringing the form above the keyboard as it
 * opens), which callers keep using alongside this hook.
 */
export function usePinOnKeyboardClose(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const viewport = window.visualViewport;
    if (!viewport) return;

    // While the user's finger is on the screen they are scrolling on
    // purpose — never fight that with a corrective scroll.
    let touchActive = false;
    const onTouchStart = () => { touchActive = true; };
    const onTouchEnd = () => { touchActive = false; };

    let keyboardOpen = window.innerHeight - viewport.height >= THRESHOLD;

    const handleResize = () => {
      const isOpenNow = window.innerHeight - viewport.height >= THRESHOLD;
      // Keyboard just closed: the gap crossed back under the threshold.
      if (keyboardOpen && !isOpenNow && !touchActive && ref.current) {
        pinScrollTo(ref.current, ref.current.getBoundingClientRect().top);
      }
      keyboardOpen = isOpenNow;
    };

    viewport.addEventListener('resize', handleResize);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      viewport.removeEventListener('resize', handleResize);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [active, ref]);
}
