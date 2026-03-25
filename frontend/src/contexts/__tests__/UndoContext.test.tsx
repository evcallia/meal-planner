import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { UndoProvider, useUndo } from '../UndoContext';
import type { ReactNode } from 'react';

const wrapper = ({ children }: { children: ReactNode }) => (
  <UndoProvider>{children}</UndoProvider>
);

describe('UndoContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when useUndo is used outside UndoProvider', () => {
    // Suppress console.error for this test
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useUndo())).toThrow('useUndo must be used within UndoProvider');
    spy.mockRestore();
  });

  it('starts with canUndo and canRedo as false', () => {
    const { result } = renderHook(() => useUndo(), { wrapper });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('sets canUndo to true after pushing an action', () => {
    const { result } = renderHook(() => useUndo(), { wrapper });

    act(() => {
      result.current.pushAction({
        type: 'test',
        undo: vi.fn(),
        redo: vi.fn(),
      });
    });

    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('calls undo callback and enables redo', async () => {
    const undoFn = vi.fn();
    const { result } = renderHook(() => useUndo(), { wrapper });

    act(() => {
      result.current.pushAction({
        type: 'test',
        undo: undoFn,
        redo: vi.fn(),
      });
    });

    await act(async () => {
      await result.current.undo();
    });

    expect(undoFn).toHaveBeenCalledOnce();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it('calls redo callback and moves action back to past', async () => {
    const redoFn = vi.fn();
    const { result } = renderHook(() => useUndo(), { wrapper });

    act(() => {
      result.current.pushAction({
        type: 'test',
        undo: vi.fn(),
        redo: redoFn,
      });
    });

    await act(async () => {
      await result.current.undo();
    });

    await act(async () => {
      await result.current.redo();
    });

    expect(redoFn).toHaveBeenCalledOnce();
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('clears future (redo stack) when a new action is pushed', async () => {
    const { result } = renderHook(() => useUndo(), { wrapper });

    act(() => {
      result.current.pushAction({ type: 'a', undo: vi.fn(), redo: vi.fn() });
    });

    await act(async () => {
      await result.current.undo();
    });

    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.pushAction({ type: 'b', undo: vi.fn(), redo: vi.fn() });
    });

    expect(result.current.canRedo).toBe(false);
  });

  it('limits history to MAX_HISTORY (10) actions', () => {
    const { result } = renderHook(() => useUndo(), { wrapper });

    for (let i = 0; i < 15; i++) {
      act(() => {
        result.current.pushAction({ type: `action-${i}`, undo: vi.fn(), redo: vi.fn() });
      });
    }

    // Should still have canUndo, but only 10 items in past
    expect(result.current.canUndo).toBe(true);

    // Undo 10 times should exhaust the stack
    const undoAll = async () => {
      for (let i = 0; i < 10; i++) {
        await act(async () => { await result.current.undo(); });
      }
    };

    return undoAll().then(() => {
      expect(result.current.canUndo).toBe(false);
    });
  });

  it('does nothing when undo is called with empty past', async () => {
    const { result } = renderHook(() => useUndo(), { wrapper });

    await act(async () => {
      await result.current.undo();
    });

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('does nothing when redo is called with empty future', async () => {
    const { result } = renderHook(() => useUndo(), { wrapper });

    await act(async () => {
      await result.current.redo();
    });

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('blocks pushAction during undo/redo execution', async () => {
    const { result } = renderHook(() => useUndo(), { wrapper });

    let pushDuringUndo = false;

    act(() => {
      result.current.pushAction({
        type: 'original',
        undo: async () => {
          // Try to push during undo — should be blocked
          result.current.pushAction({ type: 'sneaky', undo: vi.fn(), redo: vi.fn() });
          pushDuringUndo = true;
        },
        redo: vi.fn(),
      });
    });

    await act(async () => {
      await result.current.undo();
    });

    expect(pushDuringUndo).toBe(true);
    // canRedo should still be true (the sneaky push should have been blocked)
    expect(result.current.canRedo).toBe(true);
  });

  describe('keyboard shortcuts', () => {
    it('Ctrl+Z triggers undo', async () => {
      const undoFn = vi.fn();
      const { result } = renderHook(() => useUndo(), { wrapper });

      act(() => {
        result.current.pushAction({ type: 'test', undo: undoFn, redo: vi.fn() });
      });

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        // Wait for undo to process
        await new Promise(r => setTimeout(r, 10));
      });

      expect(undoFn).toHaveBeenCalled();
    });

    it('Ctrl+Shift+Z triggers redo', async () => {
      const redoFn = vi.fn();
      const { result } = renderHook(() => useUndo(), { wrapper });

      act(() => {
        result.current.pushAction({ type: 'test', undo: vi.fn(), redo: redoFn });
      });

      await act(async () => {
        await result.current.undo();
      });

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }));
        await new Promise(r => setTimeout(r, 10));
      });

      expect(redoFn).toHaveBeenCalled();
    });

    it('does not trigger undo when target is an input element', () => {
      const undoFn = vi.fn();
      const { result } = renderHook(() => useUndo(), { wrapper });

      act(() => {
        result.current.pushAction({ type: 'test', undo: undoFn, redo: vi.fn() });
      });

      const input = document.createElement('input');
      document.body.appendChild(input);

      act(() => {
        const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true });
        Object.defineProperty(event, 'target', { value: input });
        window.dispatchEvent(event);
      });

      expect(undoFn).not.toHaveBeenCalled();
      document.body.removeChild(input);
    });

    it('does not trigger undo when target is a textarea', () => {
      const undoFn = vi.fn();
      const { result } = renderHook(() => useUndo(), { wrapper });

      act(() => {
        result.current.pushAction({ type: 'test', undo: undoFn, redo: vi.fn() });
      });

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);

      act(() => {
        const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true });
        Object.defineProperty(event, 'target', { value: textarea });
        window.dispatchEvent(event);
      });

      expect(undoFn).not.toHaveBeenCalled();
      document.body.removeChild(textarea);
    });
  });
});
