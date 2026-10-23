import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { closeOnBlurOutside } from '../closeOnBlurOutside';

describe('closeOnBlurOutside', () => {
  let form: HTMLDivElement;
  let inside: HTMLButtonElement;
  let outside: HTMLInputElement;
  let ref: { current: HTMLElement | null };

  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

  beforeEach(() => {
    form = document.createElement('div');
    inside = document.createElement('button');
    form.appendChild(inside);
    outside = document.createElement('input');
    document.body.append(form, outside);
    ref = { current: form };
  });

  afterEach(() => {
    form.remove();
    outside.remove();
  });

  it('exits once focus has landed outside the form', async () => {
    const close = vi.fn();
    outside.focus();
    closeOnBlurOutside(ref, close);
    expect(close).not.toHaveBeenCalled();
    await nextFrame();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does nothing when focus landed on a control inside the form', async () => {
    const close = vi.fn();
    inside.focus();
    closeOnBlurOutside(ref, close);
    await nextFrame();
    expect(close).not.toHaveBeenCalled();
  });

  it('does nothing when there is no form', async () => {
    const close = vi.fn();
    closeOnBlurOutside({ current: null }, close);
    await nextFrame();
    expect(close).not.toHaveBeenCalled();
  });

  // The guard this helper has always meant to apply: "Add, Cancel or Escape
  // got there first". It used to test formEl.isConnected, which cannot see
  // this — React reuses the same <div> when a row swaps its edit form for
  // its display markup, so the captured element is still connected (as the
  // display row) and the deferred callback ran anyway. Harmless while the
  // exit was just "close", but the edit rows pass a COMMIT: Cancel blurs the
  // input, unmounts the form, and this callback would then save the edit the
  // user had just cancelled.
  it('does not exit when the form was unmounted before the frame ran', async () => {
    const close = vi.fn();
    closeOnBlurOutside(ref, close);
    // What React does on unmount: detaches the ref. The element itself is
    // deliberately left in the document, standing in for the reused <div>.
    ref.current = null;
    await nextFrame();
    expect(close).not.toHaveBeenCalled();
  });

  it('does not exit when a different form has since taken the ref', async () => {
    const close = vi.fn();
    closeOnBlurOutside(ref, close);
    ref.current = document.createElement('div');
    await nextFrame();
    expect(close).not.toHaveBeenCalled();
  });

  it('exits once when two blur events race for the same form', async () => {
    // One real exit, two queued callbacks — the first takes the form down,
    // which has to make the second a no-op (the edit rows would otherwise
    // fire two saves and two API calls for one dismissal).
    const close = vi.fn(() => { ref.current = null; });
    outside.focus();
    closeOnBlurOutside(ref, close);
    closeOnBlurOutside(ref, close);
    await nextFrame();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
