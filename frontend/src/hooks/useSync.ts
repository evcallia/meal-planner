import { useState, useEffect, useCallback } from 'react';
import { useOnlineStatus } from './useOnlineStatus';
import { getPendingChanges, removePendingChange } from '../db';
import { updateNotes, toggleItemized } from '../api/client';
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
