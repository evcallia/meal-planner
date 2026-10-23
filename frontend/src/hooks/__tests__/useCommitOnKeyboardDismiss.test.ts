import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCommitOnKeyboardDismiss } from '../useCommitOnKeyboardDismiss';

describe('useCommitOnKeyboardDismiss', () => {
  const KEYBOARD = 300;
  let form: HTMLDivElement;
  let input: HTMLInputElement;
  let outside: HTMLInputElement;
  let resizeListeners: EventListener[];
  let viewport: { height: number; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  const ref = { current: null as HTMLElement | null };

  /** Mirrors iOS: the keyboard shrinks the visual viewport, nothing else. */
  const openKeyboard = () => {
    viewport.height = window.innerHeight - KEYBOARD;
    resizeListeners.forEach(fn => fn(new Event('resize')));
  };
  const dismissKeyboard = () => {
    viewport.height = window.innerHeight;
    resizeListeners.forEach(fn => fn(new Event('resize')));
  };

  beforeEach(() => {
    resizeListeners = [];
    viewport = {
      height: window.innerHeight,
      addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('visualViewport', viewport);

    form = document.createElement('div');
    input = document.createElement('input');
    form.appendChild(input);
    outside = document.createElement('input');
    document.body.append(form, outside);
    ref.current = form;
    input.focus();
  });

  afterEach(() => {
    form.remove();
    outside.remove();
    vi.unstubAllGlobals();
  });

  it('commits when the keyboard is dismissed with focus still in the form', () => {
    const commit = vi.fn();
    renderHook(() => useCommitOnKeyboardDismiss(ref, true, commit));

    openKeyboard();
    expect(commit).not.toHaveBeenCalled();

    // The iOS dismiss key closes the keyboard but leaves the input focused,
    // so no blur/focusout/pointerdown ever fires.
    dismissKeyboard();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('commits once per dismissal, not on every later resize', () => {
    const commit = vi.fn();
    renderHook(() => useCommitOnKeyboardDismiss(ref, true, commit));

    openKeyboard();
    dismissKeyboard();
    resizeListeners.forEach(fn => fn(new Event('resize')));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('leaves a genuine blur to the blur handlers', () => {
    const commit = vi.fn();
    renderHook(() => useCommitOnKeyboardDismiss(ref, true, commit));

    openKeyboard();
    // Tapping outside moves focus first; closeOnBlurOutside/handleBlur own
    // that path and already exit anchored. Committing here too would run the
    // save twice for one dismissal.
    outside.focus();
    dismissKeyboard();
    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores a viewport that was never covered by a keyboard', () => {
    const commit = vi.fn();
    renderHook(() => useCommitOnKeyboardDismiss(ref, true, commit));

    // A desktop window resize, or iOS collapsing its own toolbar: no
    // keyboard was ever open, so there is no dismissal to act on.
    viewport.height = window.innerHeight - 40;
    resizeListeners.forEach(fn => fn(new Event('resize')));
    dismissKeyboard();
    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores partial growth while the keyboard still covers the screen', () => {
    const commit = vi.fn();
    renderHook(() => useCommitOnKeyboardDismiss(ref, true, commit));

    openKeyboard();
    // The accessory/predictive-text bar toggling resizes the viewport without
    // dismissing anything.
    viewport.height = window.innerHeight - 250;
    resizeListeners.forEach(fn => fn(new Event('resize')));
    expect(commit).not.toHaveBeenCalled();
  });

  it('calls the latest commit, not the one captured at subscribe time', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = renderHook(
      ({ commit }) => useCommitOnKeyboardDismiss(ref, true, commit),
      { initialProps: { commit: stale } },
    );

    openKeyboard();
    // commit closes over the edit state, so it is a new function on every
    // keystroke — firing the subscribe-time copy would save stale text.
    rerender({ commit: fresh });
    dismissKeyboard();
    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('still sees the dismissal when iOS reports a stale window height', () => {
    const commit = vi.fn();
    const full = window.innerHeight;
    renderHook(() => useCommitOnKeyboardDismiss(ref, true, commit));

    // In an iOS standalone PWA window.innerHeight is reported already
    // shrunken (the case useKeyboardOpen keeps initialHeightRef for), so the
    // live gap reads ~0 with the keyboard fully up. Measured against that,
    // the keyboard never looks open and the dismissal never registers.
    viewport.height = full - KEYBOARD;
    vi.stubGlobal('innerHeight', full - KEYBOARD);
    resizeListeners.forEach(fn => fn(new Event('resize')));
    expect(commit).not.toHaveBeenCalled();

    viewport.height = full;
    vi.stubGlobal('innerHeight', full);
    resizeListeners.forEach(fn => fn(new Event('resize')));
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('does not subscribe while inactive', () => {
    const commit = vi.fn();
    renderHook(() => useCommitOnKeyboardDismiss(ref, false, commit));
    expect(viewport.addEventListener).not.toHaveBeenCalled();
  });

  it('unsubscribes on unmount', () => {
    const commit = vi.fn();
    const { unmount } = renderHook(() => useCommitOnKeyboardDismiss(ref, true, commit));
    expect(viewport.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    unmount();
    expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});
