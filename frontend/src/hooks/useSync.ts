import { useState, useEffect, useCallback } from 'react';
import { useOnlineStatus } from './useOnlineStatus';
import {
  getPendingChanges,
  removePendingChange,
  isTempId,
  saveTempIdMapping,
  getTempIdMapping,
  deleteLocalPantryItem,
  saveLocalPantryItem,
  deleteLocalMealIdea,
  saveLocalMealIdea,
} from '../db';
import {
  updateNotes,
  toggleItemized,
  createPantryItem,
  updatePantryItem,
  deletePantryItem,
  createMealIdea,
  updateMealIdea,
  deleteMealIdea,
} from '../api/client';
import { ConnectionStatus } from '../types';

export function useSync() {
  const isOnline = useOnlineStatus();
  const [status, setStatus] = useState<ConnectionStatus>(isOnline ? 'online' : 'offline');
  const [pendingCount, setPendingCount] = useState(0);

  const syncPendingChanges = useCallback(async () => {
    if (!isOnline) return;

    const changes = await getPendingChanges();
    if (changes.length === 0) {
      setStatus('online');
      return;
    }

    setStatus('syncing');
    setPendingCount(changes.length);

    for (const change of changes) {
      try {
        if (change.type === 'notes') {
          const payload = change.payload as { notes: string };
          await updateNotes(change.date, payload.notes);
        } else if (change.type === 'itemized') {
          const payload = change.payload as { lineIndex: number; itemized: boolean };
          await toggleItemized(change.date, payload.lineIndex, payload.itemized);
        } else if (change.type === 'pantry-add') {
          const payload = change.payload as { id: string; name: string; quantity: number };
          const created = await createPantryItem({ name: payload.name, quantity: payload.quantity });
          // Map temp ID to real ID
          if (isTempId(payload.id)) {
            await saveTempIdMapping(payload.id, created.id);
            // Update local DB with real ID
            await deleteLocalPantryItem(payload.id);
            await saveLocalPantryItem(created);
          }
        } else if (change.type === 'pantry-update') {
          const payload = change.payload as { id: string; name?: string; quantity?: number };
          // Check if we need to resolve a temp ID
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              // Temp ID not yet synced, skip this update
              console.warn('Skipping pantry update for unsynced temp ID:', payload.id);
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await updatePantryItem(realId, { name: payload.name, quantity: payload.quantity });
        } else if (change.type === 'pantry-delete') {
          const payload = change.payload as { id: string };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              // Item was created and deleted offline before sync
              console.warn('Skipping pantry delete for unsynced temp ID:', payload.id);
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await deletePantryItem(realId);
        } else if (change.type === 'meal-idea-add') {
          const payload = change.payload as { id: string; title: string };
          const created = await createMealIdea({ title: payload.title });
          // Map temp ID to real ID
          if (isTempId(payload.id)) {
            await saveTempIdMapping(payload.id, created.id);
            // Update local DB with real ID
            await deleteLocalMealIdea(payload.id);
            await saveLocalMealIdea(created);
          }
        } else if (change.type === 'meal-idea-update') {
          const payload = change.payload as { id: string; title?: string };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              console.warn('Skipping meal idea update for unsynced temp ID:', payload.id);
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await updateMealIdea(realId, { title: payload.title });
        } else if (change.type === 'meal-idea-delete') {
          const payload = change.payload as { id: string };
          let realId = payload.id;
          if (isTempId(payload.id)) {
            const mapped = await getTempIdMapping(payload.id);
            if (mapped) {
              realId = mapped;
            } else {
              console.warn('Skipping meal idea delete for unsynced temp ID:', payload.id);
              if (change.id) {
                await removePendingChange(change.id);
              }
              setPendingCount(prev => prev - 1);
              continue;
            }
          }
          await deleteMealIdea(realId);
        }
        if (change.id) {
          await removePendingChange(change.id);
        }
        setPendingCount(prev => prev - 1);
      } catch (error) {
        console.error('Failed to sync change:', error);
        // Stop syncing on error, will retry on next online event
        break;
      }
    }

    const remaining = await getPendingChanges();
    if (remaining.length === 0) {
      setStatus('online');
    }
  }, [isOnline]);

  // Update status when online state changes
  useEffect(() => {
    if (!isOnline) {
      setStatus('offline');
    } else {
      // When coming online, try to sync
      syncPendingChanges();
    }
  }, [isOnline, syncPendingChanges]);

  // Check pending count periodically
  useEffect(() => {
    const checkPending = async () => {
      const changes = await getPendingChanges();
      setPendingCount(changes.length);
    };
    checkPending();
    const interval = setInterval(checkPending, 5000);
    return () => clearInterval(interval);
  }, []);

  return { status, pendingCount, syncPendingChanges };
}
