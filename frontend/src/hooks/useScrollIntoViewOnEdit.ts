import { useEffect, type RefObject } from 'react';

// Keeps an inline form visible on mobile: when the iOS keyboard opens it
// shrinks the visual viewport and the browser may scroll the row off-screen.
// Named `active` rather than `isEditing`: this covers both inline edit forms
// and inline add forms (any form whose focused input can trigger the iOS
// keyboard-open/close viewport dance).
export function useScrollIntoViewOnEdit(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;

    let lastHeight = window.visualViewport?.height ?? window.innerHeight;

    // While the user's finger is on the screen they are scrolling on purpose
    // (e.g. checking something at the top of the list mid-edit) — never fight
    // that with a corrective scroll.
    let touchActive = false;
    const onTouchStart = () => { touchActive = true; };
    const onTouchEnd = () => { touchActive = false; };

    const scrollIntoView = () => {
      // Only scroll while the keyboard is actually covering the screen —
      // re-centering on keyboard dismiss would yank the page away from
      // wherever the user scrolled (threshold matches useKeyboardOpen).
      const viewport = window.visualViewport;
      if (viewport && window.innerHeight - viewport.height < 150) return;
      ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    const handleResize = () => {
      const viewport = window.visualViewport;
      if (!viewport) return;
      const growing = viewport.height > lastHeight;
      lastHeight = viewport.height;
      if (touchActive) return;
      // Keyboard CLOSING (viewport growing): leave this alone. A corrective
      // scroll here used to be `scrollIntoView({ block: 'nearest' })`, but
      // against iOS's own scroll restoration that's either a no-op (already
      // visible) or itself a competing movement — it doesn't hold position.
      // `usePinOnKeyboardClose` is the real fix for that case; wire it
      // alongside this hook wherever a form stays mounted across keyboard
      // close.
      if (growing) return;
      scrollIntoView();
    };

    // After the keyboard begins opening / layout settles (same delay DayCard uses)
    const timer = window.setTimeout(scrollIntoView, 350);

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', handleResize);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      window.clearTimeout(timer);
      viewport?.removeEventListener('resize', handleResize);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [active, ref]);
}
