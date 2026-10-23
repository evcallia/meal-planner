import { useSyncExternalStore } from 'react';
import { getFlash, subscribeFlash } from '../utils/recentFlash';

/**
 * The flash key for one row: 0 when it is not highlighted, otherwise a
 * number that changes on every flash so the overlay can be keyed on it and
 * replay its animation.
 */
export function useItemFlash(itemId: string): number {
  return useSyncExternalStore(
    subscribeFlash,
    () => getFlash(itemId),
    () => 0,
  );
}
