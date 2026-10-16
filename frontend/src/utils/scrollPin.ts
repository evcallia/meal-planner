// Shared "keep an element visually stationary across an async layout
// shift" primitive. iOS doesn't settle its viewport/scroll position
// synchronously when the keyboard opens/closes, or when a DOM mutation
// collapses content above the fold — it keeps nudging the scroll position
// over roughly a 250ms animation AFTER the triggering event/mutation has
// already happened. A single corrective scroll isn't enough; this
// re-measures drift against a fixed baseline and corrects it on every
// animation frame for a window of time.
const DEFAULT_PIN_DURATION_MS = 400;

/**
 * Keeps `anchorEl` pinned at the viewport position recorded in `before`
 * (its `getBoundingClientRect().top` at some earlier instant), repeatedly
 * countering any drift with `window.scrollBy` for `durationMs`.
 */
export function pinScrollTo(anchorEl: HTMLElement, before: number, durationMs = DEFAULT_PIN_DURATION_MS): void {
  const pin = () => {
    const drift = anchorEl.getBoundingClientRect().top - before;
    if (drift !== 0) {
      window.scrollBy(0, drift);
    }
  };

  pin();
  const start = performance.now();
  const tick = () => {
    if (!anchorEl.isConnected || performance.now() - start > durationMs) return;
    pin();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
