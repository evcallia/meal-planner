import { useEffect, type RefObject } from 'react';

// Keeps an inline edit form visible on mobile: when the iOS keyboard opens it
// shrinks the visual viewport and the browser may scroll the row off-screen.
export function useScrollIntoViewOnEdit(ref: RefObject<HTMLElement | null>, isEditing: boolean) {
  useEffect(() => {
    if (!isEditing) return;

    const scrollIntoView = () => {
      // Only scroll while the keyboard is actually covering the screen —
      // re-centering on keyboard dismiss would yank the page away from
      // wherever the user scrolled (threshold matches useKeyboardOpen).
      const viewport = window.visualViewport;
      if (viewport && window.innerHeight - viewport.height < 150) return;
      ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };

    // After the keyboard begins opening / layout settles (same delay DayCard uses)
    const timer = window.setTimeout(scrollIntoView, 350);

    // Re-scroll when the visual viewport resizes (keyboard open/close animation)
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', scrollIntoView);

    return () => {
      window.clearTimeout(timer);
      viewport?.removeEventListener('resize', scrollIntoView);
    };
  }, [isEditing, ref]);
}
