import { useRef, useCallback } from 'react';
import { isTempId, getTempIdMapping } from '../db';

/**
 * Manages a chain of ID remappings for undo/redo operations.
 *
 * When an item is deleted and then restored via undo, the server assigns
 * a new ID. `remapId` records old→new so that older undo entries (which
 * captured the original ID) can resolve to the current server ID via
 * `resolveId`. Handles arbitrary undo/redo cycles by flattening all
 * intermediate IDs in the chain to point directly to the latest.
 *
 * `resolveIdAsync` extends `resolveId` with an IndexedDB fallback for
 * temp IDs that were synced by `useSync` (which writes to IndexedDB,
 * not the in-memory map). Use this in main mutation paths where the
 * React state may still hold a temp ID after sync.
 */
export function useIdRemap() {
  const mapRef = useRef(new Map<string, string>());

  const resolveId = useCallback((originalId: string): string => {
    let id = originalId;
    while (mapRef.current.has(id)) {
      id = mapRef.current.get(id)!;
    }
    return id;
  }, []);

  const resolveIdAsync = useCallback(async (originalId: string): Promise<string> => {
    // First check in-memory remap
    let id = resolveId(originalId);
    // If still a temp ID, check IndexedDB (populated by useSync)
    if (isTempId(id)) {
      const mapped = await getTempIdMapping(id);
      if (mapped) {
        // Cache in memory for future sync lookups
        mapRef.current.set(id, mapped);
        id = mapped;
      }
    }
    return id;
  }, [resolveId]);

  const remapId = useCallback((oldId: string, newId: string) => {
    const map = mapRef.current;
    const staleIds = new Set<string>();
    let walk = oldId;
    while (map.has(walk)) {
      const next = map.get(walk)!;
      staleIds.add(walk);
      staleIds.add(next);
      walk = next;
    }
    staleIds.add(oldId);
    staleIds.delete(newId);
    for (const id of staleIds) {
      map.set(id, newId);
    }
  }, []);

  return { resolveId, resolveIdAsync, remapId };
}
