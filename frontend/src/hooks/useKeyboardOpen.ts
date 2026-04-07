import { useState, useEffect, useRef } from 'react';

/**
 * Detects whether the mobile virtual keyboard is open.
 *
 * Toggles `keyboard-open` class on <html> which restructures the layout:
 * locks viewport scroll and makes <main> the scroll container so sticky
 * elements work correctly on iOS.
 */
export function useKeyboardOpen(): boolean {
  const [isOpen, setIsOpen] = useState(false);
  const initialHeightRef = useRef(window.innerHeight);

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
      setIsOpen(open);
      document.documentElement.classList.toggle('keyboard-open', open);
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
