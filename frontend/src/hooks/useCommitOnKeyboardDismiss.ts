import { useEffect, useRef, type RefObject } from 'react';
import { kbFocus, kbHeights, kbLog } from '../utils/kbdebug';

// Treats the keyboard's own dismiss key as "I'm done with this form".
//
// Every other way out of an inline form moves focus — Save/Cancel/Enter/
// Escape call the commit directly, tapping elsewhere fires blur
// (closeOnBlurOutside, DayCard's handleBlur) — and all of them end up inside
// `exitEditAnchored`, which blurs, unmounts and pins the anchor across the
// layout change. iOS's dismiss key (the check mark above the keyboard) is the
// one exit that moves no focus at all: the input stays focused, so no blur,
// focusout or pointerdown fires, every existing path misses it, and the form
// sits there with the keyboard gone.
//
// That left the edit stranded (the user's text saved only if they went back
// and hit Save) and the page jumped, because nothing ran the anchored pin
// that holds position across the keyboard-open layout switch. Routing this
// exit to the same commit the Save button calls fixes both: the text lands
// and the unmount goes through `exitEditAnchored` like every other exit.
//
// The only signal available is the visual viewport growing back while our
// input still holds focus. `active` must be the form's own mounted/editing
// flag so a dismissal is only ever attributed to the form the user was in.
export function useCommitOnKeyboardDismiss(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  commit: () => void,
) {
  // commit closes over the edit state, so it is a different function on every
  // keystroke. Re-subscribing on each one would be wasteful and would reset
  // wasOpen mid-edit; read it through a ref instead.
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!active) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    kbLog('hook:subscribe', kbHeights());

    // Measure against the tallest window we have seen, not the live value:
    // iOS standalone reports a stale (already shrunken) window.innerHeight,
    // and against that the gap reads ~0 with the keyboard plainly up, so the
    // dismissal never registers as one. useKeyboardOpen keeps the same
    // running maximum (initialHeightRef) for the same reason. Subscribing
    // happens when the form mounts, before its input takes focus and raises
    // the keyboard, so the first reading is a genuine full-height one.
    let tallest = window.innerHeight;
    // Same threshold as useKeyboardOpen/useScrollIntoViewOnEdit: anything
    // smaller is iOS's own chrome (accessory bar, toolbar), not a keyboard.
    const covered = () => {
      tallest = Math.max(tallest, window.innerHeight);
      return tallest - viewport.height > 150;
    };

    // Only a transition counts. Without this, a form mounted while the
    // keyboard is already down would commit itself on the first unrelated
    // resize.
    let wasOpen = covered();

    const handleResize = () => {
      const isOpen = covered();
      const dismissed = wasOpen && !isOpen;
      kbLog('hook:resize', { wasOpen, isOpen, dismissed, tallest, inForm: !!ref.current?.contains(document.activeElement), focus: kbFocus(), ...kbHeights() });
      wasOpen = isOpen;
      if (!dismissed) return;
      // Focus elsewhere means the user left by a route that already handles
      // itself; committing here as well would run the save twice.
      if (!ref.current?.contains(document.activeElement)) {
        kbLog('hook:declined', { reason: 'focus left the form' });
        return;
      }
      kbLog('hook:commit');
      commitRef.current();
    };

    viewport.addEventListener('resize', handleResize);
    return () => viewport.removeEventListener('resize', handleResize);
  }, [active, ref]);
}
