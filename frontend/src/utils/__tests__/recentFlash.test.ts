import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  flashItems, getFlash, subscribeFlash, FLASH_MS, __resetFlashesForTests,
} from '../recentFlash';

describe('recentFlash', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetFlashesForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks the named items and leaves the rest alone', () => {
    flashItems(['a', 'b']);
    expect(getFlash('a')).toBeGreaterThan(0);
    expect(getFlash('b')).toBeGreaterThan(0);
    expect(getFlash('c')).toBe(0);
  });

  // The row renders its overlay keyed on this number, so flashing the same
  // row twice has to hand it a NEW one — otherwise React keeps the existing
  // element and the CSS animation (which ends `forwards`, fully faded) never
  // replays. Undo/redo of the same item is exactly that case.
  it('gives a fresh key each time the same item flashes', () => {
    flashItems(['a']);
    const first = getFlash('a');
    flashItems(['a']);
    expect(getFlash('a')).not.toBe(first);
  });

  it('clears itself once the animation is over', () => {
    flashItems(['a']);
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(getFlash('a')).toBeGreaterThan(0);
    vi.advanceTimersByTime(2);
    expect(getFlash('a')).toBe(0);
  });

  it('restarts the clock rather than expiring on the first flash’s timer', () => {
    flashItems(['a']);
    vi.advanceTimersByTime(FLASH_MS - 100);
    flashItems(['a']);
    vi.advanceTimersByTime(FLASH_MS - 100);
    expect(getFlash('a')).toBeGreaterThan(0);
  });

  it('notifies subscribers on flash and on expiry', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFlash(listener);

    flashItems(['a']);
    expect(listener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(FLASH_MS + 1);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    flashItems(['b']);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // Callers pass ids straight from id-resolution helpers, which return null
  // for an item that has since been deleted or never synced.
  it('ignores empty ids without disturbing anything', () => {
    const listener = vi.fn();
    subscribeFlash(listener);
    flashItems([null, undefined, '']);
    expect(listener).not.toHaveBeenCalled();
  });
});
