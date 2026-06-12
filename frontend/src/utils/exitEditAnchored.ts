import { flushSync } from 'react-dom';

// Exiting an inline edit removes the focused input from the DOM, which makes
// iOS reset the visual viewport (the "page jumps to the top" bug), and the
// edit form is taller than the display row so everything below shifts.
// Blur first so the keyboard closes while the input still exists, then keep
// the edited element visually stationary across the layout change.
export function exitEditAnchored(anchorEl: HTMLElement | null, exit: () => void) {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const before = anchorEl?.getBoundingClientRect().top;
  flushSync(exit);
  if (anchorEl && before !== undefined) {
    const after = anchorEl.getBoundingClientRect().top;
    if (after !== before) {
      window.scrollBy(0, after - before);
    }
  }
}
