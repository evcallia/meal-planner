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

export function UndoProvider({ children }: { children: ReactNode }) {
  const [past, setPast] = useState<UndoAction[]>([]);
  const [future, setFuture] = useState<UndoAction[]>([]);
  // Use refs to avoid stale closures in undo/redo callbacks
  const pastRef = useRef(past);
  const futureRef = useRef(future);
  pastRef.current = past;
  futureRef.current = future;
  // Guard against re-entrant pushAction calls during undo/redo
  const isUndoRedoInProgress = useRef(false);

  const pushAction = useCallback((action: UndoAction) => {
    // Don't push new actions while undo/redo is in progress
    if (isUndoRedoInProgress.current) return;
    setPast(prev => [...prev.slice(-(MAX_HISTORY - 1)), action]);
    setFuture([]);
  }, []);

  const undo = useCallback(async () => {
    const action = pastRef.current[pastRef.current.length - 1];
    if (!action) return;
    // Update state first
    setPast(prev => prev.slice(0, -1));
    setFuture(prev => [...prev, action]);
    // Then execute the undo callback
    isUndoRedoInProgress.current = true;
    try {
      await action.undo();
    } finally {
      isUndoRedoInProgress.current = false;
    }
  }, []);

  const redo = useCallback(async () => {
    const action = futureRef.current[futureRef.current.length - 1];
    if (!action) return;
    // Update state first
    setFuture(prev => prev.slice(0, -1));
    setPast(prev => [...prev, action]);
    // Then execute the redo callback
    isUndoRedoInProgress.current = true;
    try {
      await action.redo();
    } finally {
      isUndoRedoInProgress.current = false;
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when editing text
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
