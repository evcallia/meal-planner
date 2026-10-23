import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { flashItems } from '../utils/recentFlash';

interface UndoAction {
  type: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /**
   * The rows this action touches, highlighted briefly once it has been
   * undone or redone. Unlike an edit the user just made, an undo can land
   * on a row anywhere in the list — including one off screen — so there is
   * otherwise nothing to say what moved.
   *
   * A function, not a list, because it is evaluated AFTER the work runs:
   * an item that was deleted and restored comes back with a new server id,
   * and the closures follow that through the remap chain. Ids that have
   * since gone are returned as null and dropped.
   *
   * Left off bulk actions (clear, replace) on purpose — flashing thirty
   * rows at once is noise, not a signal.
   */
  highlight?: () => (string | null | undefined)[];
}

interface UndoContextValue {
  canUndo: boolean;
  canRedo: boolean;
  pushAction: (action: UndoAction) => void;
  runAsUndoGroup: (type: string, fn: () => void | Promise<void>) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const UndoContext = createContext<UndoContextValue | null>(null);

const MAX_HISTORY = 10;
const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Module-level storage keyed by provider id — survives unmount/remount
const stacks = new Map<string, { past: UndoAction[]; future: UndoAction[] }>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function getStack(id: string) {
  let stack = stacks.get(id);
  if (!stack) {
    stack = { past: [], future: [] };
    stacks.set(id, stack);
  }
  return stack;
}

function resetInactivityTimer(id: string) {
  const existing = timers.get(id);
  if (existing) clearTimeout(existing);
  timers.set(id, setTimeout(() => {
    const stack = stacks.get(id);
    if (stack) {
      stack.past = [];
      stack.future = [];
    }
    timers.delete(id);
  }, INACTIVITY_TIMEOUT));
}

export function UndoProvider({ id, children }: { id: string; children: ReactNode }) {
  const stack = getStack(id);
  // React state to trigger re-renders — synced from module-level storage
  const [past, setPast] = useState<UndoAction[]>(stack.past);
  const [future, setFuture] = useState<UndoAction[]>(stack.future);

  // Keep refs in sync for use inside async callbacks
  const pastRef = useRef(past);
  const futureRef = useRef(future);
  pastRef.current = past;
  futureRef.current = future;

  // Guard against re-entrant pushAction calls during undo/redo
  const isUndoRedoInProgress = useRef(false);

  // Sync React state back to module-level storage on every change
  useEffect(() => { stack.past = past; }, [past, stack]);
  useEffect(() => { stack.future = future; }, [future, stack]);

  // While a group is open, pushes land here instead of on the stack.
  const groupRef = useRef<UndoAction[] | null>(null);

  const pushAction = useCallback((action: UndoAction) => {
    if (isUndoRedoInProgress.current) return;
    if (groupRef.current) {
      groupRef.current.push(action);
      return;
    }
    setPast(prev => [...prev.slice(-(MAX_HISTORY - 1)), action]);
    setFuture([]);
    resetInactivityTimer(id);
  }, [id]);

  /**
   * Collapses everything pushed while `fn` runs into ONE history entry, so a
   * single user action costs a single undo.
   *
   * Committing an inline edit can be two mutations — the field edit and a
   * category move — each of which pushes its own entry, leaving the user to
   * press undo twice to reverse one edit (and seeing a half-reverted item in
   * between). `fn` is awaited because these mutations push AFTER their API
   * call, not synchronously.
   *
   * Undo runs the collected actions in reverse, redo in order, which is what
   * keeps a move-then-edit pair reversible in either direction.
   */
  const runAsUndoGroup = useCallback(async (type: string, fn: () => void | Promise<void>) => {
    // Already inside a group: let the outer one collect, so nesting stays one
    // entry rather than becoming a group of groups.
    if (groupRef.current) {
      await fn();
      return;
    }
    const collected: UndoAction[] = [];
    groupRef.current = collected;
    try {
      await fn();
    } finally {
      groupRef.current = null;
    }
    if (collected.length === 0) return;
    if (collected.length === 1) {
      pushAction(collected[0]);
      return;
    }
    pushAction({
      type,
      undo: async () => {
        for (const action of [...collected].reverse()) await action.undo();
      },
      redo: async () => {
        for (const action of collected) await action.redo();
      },
      highlight: () => collected.flatMap(action => action.highlight?.() ?? []),
    });
  }, [pushAction]);

  const undo = useCallback(async () => {
    if (isUndoRedoInProgress.current) return;
    const action = pastRef.current[pastRef.current.length - 1];
    if (!action) return;
    setPast(prev => prev.slice(0, -1));
    setFuture(prev => [...prev, action]);
    isUndoRedoInProgress.current = true;
    try {
      await action.undo();
    } finally {
      isUndoRedoInProgress.current = false;
    }
    // After the work, so the ids are the ones that now exist. Skipped when
    // the action threw, since nothing changed to point at.
    flashItems(action.highlight?.() ?? []);
    window.dispatchEvent(new Event('undo-redo-applied'));
    resetInactivityTimer(id);
  }, [id]);

  const redo = useCallback(async () => {
    if (isUndoRedoInProgress.current) return;
    const action = futureRef.current[futureRef.current.length - 1];
    if (!action) return;
    setFuture(prev => prev.slice(0, -1));
    setPast(prev => [...prev, action]);
    isUndoRedoInProgress.current = true;
    try {
      await action.redo();
    } finally {
      isUndoRedoInProgress.current = false;
    }
    // After the work, so the ids are the ones that now exist. Skipped when
    // the action threw, since nothing changed to point at.
    flashItems(action.highlight?.() ?? []);
    window.dispatchEvent(new Event('undo-redo-applied'));
    resetInactivityTimer(id);
  }, [id]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        if (e.shiftKey) {
          e.preventDefault();
          redo();
        } else {
          e.preventDefault();
          undo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  return (
    <UndoContext.Provider value={{ canUndo: past.length > 0, canRedo: future.length > 0, pushAction, runAsUndoGroup, undo, redo }}>
      {children}
    </UndoContext.Provider>
  );
}

/**
 * For components that want undo grouping when it is available but must not
 * depend on it. The shared checklist row is presentational and is rendered
 * bare in tests and in isolation; making it throw without a provider would
 * trade a real coupling for a cosmetic nicety. Callers fall back to running
 * their work ungrouped, which is simply the behaviour from before grouping.
 */
export function useOptionalUndo(): UndoContextValue | null {
  return useContext(UndoContext);
}

export function useUndo() {
  const ctx = useContext(UndoContext);
  if (!ctx) throw new Error('useUndo must be used within UndoProvider');
  return ctx;
}
