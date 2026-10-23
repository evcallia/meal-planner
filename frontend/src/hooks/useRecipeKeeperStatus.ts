import { useCallback, useEffect, useRef, useState } from 'react';
import { getRecipeKeeperStatus, RecipeKeeperStatus } from '../api/client';
import { useOnlineStatus } from './useOnlineStatus';

// Poll interval for the household Recipe Keeper connection. Lightweight
// endpoint (a single state-table read on the backend), and this only needs
// to be fresh enough for the bell badge / pinned error row to feel live —
// not real-time, unlike grocery.updated which arrives over SSE.
const POLL_INTERVAL_MS = 60_000;

/**
 * Tracks recipe_keeper_state via GET /api/recipe-keeper/status, polled while
 * signed in. `status.enabled` is false whenever the backend has no Recipe
 * Keeper credentials configured — callers should render nothing (or a
 * disabled state) rather than treat that as an error. Single source of
 * truth for the bell badge (App.tsx), the pinned ActivityPanel row, and the
 * Settings modal's Recipe Keeper section — all three read the same `status`
 * so an action taken in Settings (switch list, sync now) is reflected
 * everywhere immediately via `applyStatus`.
 */
export function useRecipeKeeperStatus(enabled: boolean) {
  const [status, setStatus] = useState<RecipeKeeperStatus | null>(null);
  const isOnline = useOnlineStatus();
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const refresh = useCallback(async () => {
    if (!isOnlineRef.current) return;
    try {
      const next = await getRecipeKeeperStatus();
      setStatus(next);
    } catch {
      // Offline or a transient network blip — keep showing the last known
      // status rather than flashing to a disabled/empty state.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  // Separate from the initial fetch above so the interval can stop once we
  // learn the backend has no Recipe Keeper credentials configured
  // (status.enabled === false) — that can only change via a server
  // restart, which reloads the page anyway, so polling every 60s forever
  // for a deployment that will never turn this on is wasted work. `status`
  // starts null (not yet loaded), so the interval still runs until the
  // initial fetch above resolves either way.
  useEffect(() => {
    if (!enabled || status?.enabled === false) return;
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled, status?.enabled, refresh]);

  // Also refresh promptly on reconnect (offline→online), same spirit as the
  // rest of the app's reconnect-triggered refreshes. Skips the initial
  // mount, which the effect above already covers — a `hadConnection` style
  // guard so this doesn't double the mount fetch.
  const hadConnectionRef = useRef(false);
  useEffect(() => {
    if (isOnline && hadConnectionRef.current) refresh();
    if (isOnline) hadConnectionRef.current = true;
  }, [isOnline, refresh]);

  return { status, refresh, applyStatus: setStatus };
}
