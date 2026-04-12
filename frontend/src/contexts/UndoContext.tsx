import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';

interface UndoAction {
  type: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

interface UndoContextValue {
  canUndo: boolean;
  canRedo: boolean;
  pushAction: (action: UndoAction) => void;
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

  const pushAction = useCallback((action: UndoAction) => {
    if (isUndoRedoInProgress.current) return;
    setPast(prev => [...prev.slice(-(MAX_HISTORY - 1)), action]);
    setFuture([]);
    resetInactivityTimer(id);
  }, [id]);

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
    <UndoContext.Provider value={{ canUndo: past.length > 0, canRedo: future.length > 0, pushAction, undo, redo }}>
      {children}
    </UndoContext.Provider>
  );
}

export function useUndo() {
  const ctx = useContext(UndoContext);
  if (!ctx) throw new Error('useUndo must be used within UndoProvider');
  return ctx;
}
