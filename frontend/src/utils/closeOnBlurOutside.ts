/**
 * Closes a still-mounted inline form when focus genuinely leaves it.
 *
 * The inline add forms are the only surfaces in the app that stay mounted
 * across an iOS keyboard close, and that is exactly why they jumped: with
 * the form mounted there is no layout change to anchor against, and the
 * movement iOS makes is a *visual*-viewport change, which is invisible in
 * the layout coordinates `getBoundingClientRect()`/`window.scrollBy` work
 * in — so a corrective scroll measures ~0 drift and does nothing. There is
 * no API to scroll the visual viewport back.
 *
 * The surfaces that DO hold position (the Meals editor in DayCard, the
 * inline edit rows) all respond to dismissal by unmounting the form inside
 * `exitEditAnchored`, whose anchored pin works precisely because the
 * unmount forces a real layout change. This routes the add forms down that
 * same proven path.
 *
 * Focus moving to another control *inside* the form (a quantity field, an
 * autocomplete suggestion) must not close it, and on iOS the blur fires
 * before the new focus target is current — so defer a frame and then ask
 * where focus actually landed.
 */
export function closeOnBlurOutside(formEl: HTMLElement | null, close: () => void): void {
  if (!formEl) return;
  requestAnimationFrame(() => {
    // Already unmounted (Add, Cancel, Escape got there first).
    if (!formEl.isConnected) return;
    // Focus stayed within the form — the user is still filling it in.
    if (formEl.contains(document.activeElement)) return;
    close();
  });
}
