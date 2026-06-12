import { useEffect, type RefObject } from 'react';

// Keeps an inline edit form visible on mobile: when the iOS keyboard opens it
// shrinks the visual viewport and the browser may scroll the row off-screen.
export function useScrollIntoViewOnEdit(ref: RefObject<HTMLElement | null>, isEditing: boolean) {
  useEffect(() => {
    if (!isEditing) return;

    let lastHeight = window.visualViewport?.height ?? window.innerHeight;

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
      // A growing viewport means the keyboard is CLOSING (Save/done tapped).
      // Starting a smooth scroll here races the edit form's unmount and the
      // in-flight animation lands somewhere arbitrary — skip it.
      if (growing) return;
      scrollIntoView();
    };

    // After the keyboard begins opening / layout settles (same delay DayCard uses)
    const timer = window.setTimeout(scrollIntoView, 350);

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', handleResize);

    return () => {
      window.clearTimeout(timer);
      viewport?.removeEventListener('resize', handleResize);
    };
  }, [isEditing, ref]);
}
