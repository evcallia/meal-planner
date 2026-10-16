import { flushSync } from 'react-dom';
import { pinScrollTo } from './scrollPin';

// Exiting an inline edit removes the focused input from the DOM, which makes
// iOS reset the visual viewport (the "page jumps to the top" bug), and the
// edit form is taller than the display row so everything below shifts.
// Blur first so the keyboard closes while the input still exists, then keep
// the edited element visually stationary across the layout change via
// pinScrollTo — iOS adjusts the scroll position again over the keyboard-close
// animation (~250ms) after this handler returns, so a single corrective
// scroll isn't enough.
export function exitEditAnchored(anchorEl: HTMLElement | null, exit: () => void) {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const before = anchorEl?.getBoundingClientRect().top;
  flushSync(exit);
  if (!anchorEl || before === undefined) return;
  pinScrollTo(anchorEl, before);
}
