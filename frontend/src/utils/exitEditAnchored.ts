import { flushSync } from 'react-dom';

// How long to keep countering iOS's keyboard-close scroll restoration.
const PIN_DURATION_MS = 400;

// Exiting an inline edit removes the focused input from the DOM, which makes
// iOS reset the visual viewport (the "page jumps to the top" bug), and the
// edit form is taller than the display row so everything below shifts.
// Blur first so the keyboard closes while the input still exists, then keep
// the edited element visually stationary across the layout change — and keep
// re-pinning it briefly, because iOS adjusts the scroll position again over
// the keyboard-close animation (~250ms) after this handler returns.
export function exitEditAnchored(anchorEl: HTMLElement | null, exit: () => void) {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const before = anchorEl?.getBoundingClientRect().top;
  flushSync(exit);
  if (!anchorEl || before === undefined) return;

  const pin = () => {
    const drift = anchorEl.getBoundingClientRect().top - before;
    if (drift !== 0) {
      window.scrollBy(0, drift);
    }
  };

  pin();
  const start = performance.now();
  const tick = () => {
    if (!anchorEl.isConnected || performance.now() - start > PIN_DURATION_MS) return;
    pin();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
