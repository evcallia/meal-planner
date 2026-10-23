import type { RefObject } from 'react';

/**
 * Runs a form's exit (close, or save-and-close) when focus genuinely leaves
 * it.
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
 * same proven path. The edit rows use it too, with a commit as the exit:
 * iOS's keyboard-dismiss key blurs the focused input, and they had no blur
 * handling at all, so that key left them open with the text unsaved.
 *
 * Focus moving to another control *inside* the form (a quantity field, an
 * autocomplete suggestion) must not exit it, and on iOS the blur fires
 * before the new focus target is current — so defer a frame and then ask
 * where focus actually landed.
 *
 * Takes the ref rather than the element so it can tell whether the form is
 * still mounted AS that form. `formEl.isConnected` cannot: React reuses the
 * same <div> when a row swaps its edit form for its display markup, so the
 * captured element stays connected as the display row and a second deferred
 * callback sails through. With a commit as the exit that is not cosmetic —
 * tapping Cancel blurs the input, unmounts the form, and the pending
 * callback would then save the edit the user just cancelled.
 */
/**
 * Browsers — Safari especially — do not move focus to a <button> when it is
 * tapped. So tapping a control inside the form that isn't a text field (the
 * quantity stepper, Cancel, an autocomplete option) blurs the focused input
 * and leaves `document.activeElement` on <body>: indistinguishable, by focus
 * alone, from the user leaving the form entirely. Acting on that exits the
 * edit before the tap it came from is delivered, which is why the quantity
 * stepper stopped working and why picking a store or category appeared to
 * save only the item's name.
 *
 * Tracking the pointer answers it: if the tap that caused this blur landed
 * inside the form, the user has not left. The pointer may already be up —
 * a tap can complete inside one animation frame — so a recent in-form
 * pointerdown counts too. The window only has to outlast one frame; a
 * keyboard dismissal arrives whole seconds after the tap that opened the
 * field, so it is never mistaken for one.
 */
const RECENT_TAP_MS = 350;
let pointerDownTarget: Node | null = null;
let pointerDownAt = 0;
let pointerIsDown = false;
let tracking = false;

function trackPointer() {
  if (tracking) return;
  tracking = true;
  document.addEventListener('pointerdown', (e: Event) => {
    pointerDownTarget = e.target as Node;
    pointerDownAt = Date.now();
    pointerIsDown = true;
  }, true);
  const release = () => { pointerIsDown = false; };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
}

/** Exported for tests only. */
export function __resetPointerTrackingForTests() {
  pointerDownTarget = null;
  pointerDownAt = 0;
  pointerIsDown = false;
}

export function closeOnBlurOutside(form: RefObject<HTMLElement | null>, close: () => void): void {
  trackPointer();
  const formEl = form.current;
  if (!formEl) return;
  requestAnimationFrame(() => {
    // Already exited — Add, Cancel, Escape or another blur got there first.
    if (form.current !== formEl) return;
    // Focus stayed within the form — the user is still filling it in.
    if (formEl.contains(document.activeElement)) return;
    // The tap that caused this blur was on something inside the form that
    // the browser declined to focus.
    if (
      pointerDownTarget &&
      formEl.contains(pointerDownTarget) &&
      (pointerIsDown || Date.now() - pointerDownAt < RECENT_TAP_MS)
    ) return;
    close();
  });
}
