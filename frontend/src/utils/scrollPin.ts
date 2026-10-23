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
 * Hands a scroll position back to the window when an element stops being
 * the scroll container.
 *
 * While the iOS keyboard is up, `.keyboard-open` makes <main> the scroll
 * container and the window scroll is pinned to 0 — so the user's position
 * lives in `main.scrollTop` and is discarded the moment the class comes
 * off. The page lands at the top, which is the "it scrolls up" bug.
 *
 * `carried` is `main.scrollTop` and `boxTopBefore` its
 * `getBoundingClientRect().top`, both read BEFORE the class is removed.
 * The content pixel at main's top edge was `carried`; once main lays out in
 * the document that pixel sits at `boxTopInDoc + carried`, so showing it at
 * the same screen position means scrolling to
 * `boxTopInDoc + carried - boxTopBefore`. Re-applied for `durationMs` for
 * the same reason pinScrollTo exists: iOS keeps nudging the scroll position
 * over the keyboard-close animation, well after the event that triggered it.
 */
export function restoreCarriedScroll(
  mainEl: HTMLElement,
  carried: number,
  boxTopBefore: number,
  durationMs = DEFAULT_PIN_DURATION_MS,
): void {
  const apply = () => {
    const boxTopInDoc = mainEl.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, boxTopInDoc + carried - boxTopBefore));
  };

  apply();
  const start = performance.now();
  const tick = () => {
    if (!mainEl.isConnected || performance.now() - start > durationMs) return;
    apply();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

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
