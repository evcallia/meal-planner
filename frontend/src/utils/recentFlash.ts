/**
 * Which rows changed just now, so they can highlight and fade out.
 *
 * A store rather than props because the three things that cause a flash sit
 * in three different places: the view's add handler, the row's own commit,
 * and — the case that motivated it — an undo or redo, which runs in a
 * closure outside React and can land on an item anywhere in the list,
 * including one scrolled out of sight. Threading a `flashItemId` prop down
 * through the section card would serve only the first of those.
 *
 * Ids are UUIDs and unique across tabs, so one store serves every list.
 */

/** Matches the row's CSS animation (and the Tasks tab's task-flash-*). */
export const FLASH_MS = 1300;

let seq = 0;
const flashes = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(fn => fn());
}

function expire(id: string) {
  flashes.delete(id);
  timers.delete(id);
  emit();
}

/**
 * Highlight these rows. Empty ids are dropped: callers pass values straight
 * from id resolution, which yields null for an item that has since gone.
 */
export function flashItems(ids: (string | null | undefined)[]): void {
  const real = ids.filter((id): id is string => !!id);
  if (real.length === 0) return;

  // One key per call, so every row in the same change animates together.
  seq++;
  for (const id of real) {
    flashes.set(id, seq);
    const running = timers.get(id);
    if (running) clearTimeout(running);
    timers.set(id, setTimeout(() => expire(id), FLASH_MS));
  }
  emit();
}

/** 0 when the row is not flashing; otherwise a key that changes per flash. */
export function getFlash(id: string): number {
  return flashes.get(id) ?? 0;
}

export function subscribeFlash(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Exported for tests only. */
export function __resetFlashesForTests() {
  timers.forEach(t => clearTimeout(t));
  timers.clear();
  flashes.clear();
  listeners.clear();
  seq = 0;
}
