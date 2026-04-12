import { useState, useEffect, useRef } from 'react';

/**
 * Detects whether the mobile virtual keyboard is open.
 *
 * Toggles `keyboard-open` class on <html> which restructures the layout:
 * locks viewport scroll and makes <main> the scroll container so sticky
 * elements work correctly on iOS.
 *
 * When the keyboard closes, preserves scroll position across the layout
 * switch (main scroll → window scroll) so the user stays on the same card.
 */
export function useKeyboardOpen(): boolean {
  const [isOpen, setIsOpen] = useState(false);
  const initialHeightRef = useRef(window.innerHeight);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const THRESHOLD = 150;

    const updateInitialHeight = () => {
      if (window.innerHeight > initialHeightRef.current) {
        initialHeightRef.current = window.innerHeight;
      }
    };

    const check = () => {
      updateInitialHeight();
      const vvSmaller = window.innerHeight - vv.height > THRESHOLD;
      const viewportShrank = initialHeightRef.current - vv.height > THRESHOLD;
      const open = vvSmaller || viewportShrank;

      // Preserve scroll position when keyboard closes (main → window scroll)
      if (wasOpenRef.current && !open) {
        const mainEl = document.querySelector('main');
        if (mainEl) {
          // Find the first visible day card in the main scroll container
          const cards = mainEl.querySelectorAll<HTMLElement>('[data-day-date]');
          let anchor: HTMLElement | null = null;
          let anchorOffset = 0;
          for (const card of cards) {
            const rect = card.getBoundingClientRect();
            if (rect.bottom > 0) {
              anchor = card;
              anchorOffset = rect.top;
              break;
            }
          }
          // Remove the class to switch layout, then restore position
          document.documentElement.classList.remove('keyboard-open');
          if (anchor) {
            requestAnimationFrame(() => {
              const newRect = anchor!.getBoundingClientRect();
              window.scrollBy(0, newRect.top - anchorOffset);
            });
          }
        } else {
          document.documentElement.classList.remove('keyboard-open');
        }
      } else {
        document.documentElement.classList.toggle('keyboard-open', open);
      }

      wasOpenRef.current = open;
      setIsOpen(open);
    };

    vv.addEventListener('resize', check);
    window.addEventListener('resize', updateInitialHeight);
    return () => {
      vv.removeEventListener('resize', check);
      window.removeEventListener('resize', updateInitialHeight);
      document.documentElement.classList.remove('keyboard-open');
    };
  }, []);

  return isOpen;
}
