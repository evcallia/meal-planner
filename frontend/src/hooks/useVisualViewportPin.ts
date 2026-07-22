import { useEffect, useRef } from 'react';

/**
 * Pins a `position: fixed` bottom-anchored element to the *visual* viewport.
 *
 * On iOS, fixed elements attach to the layout viewport, and Safari lets the
 * two viewports come apart: the keyboard pans the page, and (especially since
 * recent Safari releases) a stale pan or a stale `window.innerHeight` can
 * survive after the keyboard closes — leaving the bottom nav island floating
 * part-way up the screen until the next layout change.
 *
 * Rather than chasing each trigger, continuously measure the gap between the
 * two viewports' bottom edges and counter it with an inline `translate`.
 * When the viewports agree the correction is removed entirely, so this is a
 * no-op everywhere except the broken states. The CSS `translate` property is
 * used (not `transform`) so it composes with Tailwind transform classes like
 * `-translate-x-1/2` instead of overwriting them.
 */
export function useVisualViewportPin<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let raf = 0;
    const apply = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      // How far the layout viewport's bottom edge sits below the visual
      // viewport's bottom edge (in layout coordinates). Positive: the element
      // is being pushed off the bottom (keyboard pan) — lift it up. Negative:
      // stale innerHeight has the element floating mid-screen — push it down.
      const gap = window.innerHeight - vv.height - vv.offsetTop;
      if (Math.abs(gap) > 1) {
        el.style.setProperty('translate', `0 ${-gap}px`);
      } else {
        el.style.removeProperty('translate');
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };

    schedule();
    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    // The broken states are exactly the ones where Safari failed to fire the
    // events above, so poll as a safety net — one cheap read per second.
    const interval = window.setInterval(schedule, 1000);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      window.clearInterval(interval);
    };
  }, []);

  return ref;
}
