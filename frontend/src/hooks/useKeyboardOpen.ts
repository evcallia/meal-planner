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

    // The keyboard can only be open while an editable element has focus.
    // Gating on this prevents the stuck-open state iOS standalone causes by
    // reporting a stale (shrunken) visualViewport height with no keyboard —
    // which left the bottom nav hidden and the scroll lock active until the
    // PWA was relaunched.
    const hasEditableFocus = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const check = () => {
      updateInitialHeight();
      const vvSmaller = window.innerHeight - vv.height > THRESHOLD;
      const viewportShrank = initialHeightRef.current - vv.height > THRESHOLD;
      const open = (vvSmaller || viewportShrank) && hasEditableFocus();

      // Size the app shell to the visible area (above the keyboard) so the
      // <main> scroll container can bring the bottom of the list into view.
      if (open) {
        document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      } else {
        document.documentElement.style.removeProperty('--vvh');
      }

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

    // iOS bypasses the body overflow:hidden lock when it auto-scrolls the
    // focused input into view, leaving the window panned by ~keyboard height
    // with no way for the user to scroll it back (main is the scroll
    // container while locked). Snap any stray document scroll back to 0.
    const fixStrayWindowScroll = () => {
      if (wasOpenRef.current && window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    };

    // Focus changes re-evaluate with a short delay: focusout fires before the
    // keyboard close animation, and tapping between two inputs would
    // otherwise flicker the layout closed and open again.
    let recheckTimer: number | null = null;
    const scheduleCheck = () => {
      if (recheckTimer !== null) window.clearTimeout(recheckTimer);
      recheckTimer = window.setTimeout(() => {
        recheckTimer = null;
        check();
      }, 100);
    };

    vv.addEventListener('resize', check);
    vv.addEventListener('scroll', fixStrayWindowScroll);
    window.addEventListener('resize', updateInitialHeight);
    window.addEventListener('scroll', fixStrayWindowScroll);
    document.addEventListener('focusin', scheduleCheck);
    document.addEventListener('focusout', scheduleCheck);
    return () => {
      if (recheckTimer !== null) window.clearTimeout(recheckTimer);
      vv.removeEventListener('resize', check);
      vv.removeEventListener('scroll', fixStrayWindowScroll);
      window.removeEventListener('resize', updateInitialHeight);
      window.removeEventListener('scroll', fixStrayWindowScroll);
      document.removeEventListener('focusin', scheduleCheck);
      document.removeEventListener('focusout', scheduleCheck);
      document.documentElement.classList.remove('keyboard-open');
    };
  }, []);

  return isOpen;
}
