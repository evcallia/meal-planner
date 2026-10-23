import type { RefObject } from 'react';
import { kbFocus, kbLog } from './kbdebug';

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
export function closeOnBlurOutside(form: RefObject<HTMLElement | null>, close: () => void): void {
  const formEl = form.current;
  if (!formEl) return;
  kbLog('blurOutside:queued', { focus: kbFocus() });
  requestAnimationFrame(() => {
    // Already exited — Add, Cancel, Escape or another blur got there first.
    if (form.current !== formEl) {
      kbLog('blurOutside:gone');
      return;
    }
    // Focus stayed within the form — the user is still filling it in.
    if (formEl.contains(document.activeElement)) {
      kbLog('blurOutside:stayed', { focus: kbFocus() });
      return;
    }
    kbLog('blurOutside:exit', { focus: kbFocus() });
    close();
  });
}
