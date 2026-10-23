import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { UndoProvider, useUndo } from '../UndoContext';
import type { ReactNode } from 'react';

// Committing an inline edit can be two mutations — the field edit and a
// category move — and each pushes its own history entry. One commit then
// cost two undos, and the item sat half-reverted in between.
describe('UndoContext — runAsUndoGroup', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <UndoProvider id={`group-${Math.random()}`}>{children}</UndoProvider>
  );

  const setup = () => renderHook(() => useUndo(), { wrapper });

  it('collapses several pushes into one entry', async () => {
    const { result } = setup();
    const order: string[] = [];

    await act(async () => {
      await result.current.runAsUndoGroup('commit', async () => {
        result.current.pushAction({
          type: 'edit',
          undo: async () => { order.push('undo:edit'); },
          redo: async () => { order.push('redo:edit'); },
        });
        result.current.pushAction({
          type: 'move',
          undo: async () => { order.push('undo:move'); },
          redo: async () => { order.push('redo:move'); },
        });
      });
    });

    expect(result.current.canUndo).toBe(true);

    await act(async () => { await result.current.undo(); });
    // Reverse order: the move was applied last, so it comes off first.
    expect(order).toEqual(['undo:move', 'undo:edit']);
    expect(result.current.canUndo).toBe(false);

    await act(async () => { await result.current.redo(); });
    expect(order).toEqual(['undo:move', 'undo:edit', 'redo:edit', 'redo:move']);
  });

  it('captures pushes that happen after an await, not just synchronous ones', async () => {
    const { result } = setup();
    const undone: string[] = [];

    await act(async () => {
      await result.current.runAsUndoGroup('commit', async () => {
        // Real mutations push AFTER their API call resolves.
        await Promise.resolve();
        result.current.pushAction({ type: 'a', undo: async () => { undone.push('a'); }, redo: async () => {} });
        await Promise.resolve();
        result.current.pushAction({ type: 'b', undo: async () => { undone.push('b'); }, redo: async () => {} });
      });
    });

    await act(async () => { await result.current.undo(); });
    expect(undone).toEqual(['b', 'a']);
    expect(result.current.canUndo).toBe(false);
  });

  it('pushes a lone action as itself rather than wrapping it', async () => {
    const { result } = setup();
    const action = { type: 'solo', undo: vi.fn(async () => {}), redo: vi.fn(async () => {}) };

    await act(async () => {
      await result.current.runAsUndoGroup('commit', () => {
        result.current.pushAction(action);
      });
    });
    await act(async () => { await result.current.undo(); });

    expect(action.undo).toHaveBeenCalledTimes(1);
  });

  it('adds nothing to history when the work pushed nothing', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.runAsUndoGroup('commit', () => {});
    });
    expect(result.current.canUndo).toBe(false);
  });

  it('keeps a nested group flat instead of grouping groups', async () => {
    const { result } = setup();
    const undone: string[] = [];

    await act(async () => {
      await result.current.runAsUndoGroup('outer', async () => {
        result.current.pushAction({ type: 'a', undo: async () => { undone.push('a'); }, redo: async () => {} });
        await result.current.runAsUndoGroup('inner', async () => {
          result.current.pushAction({ type: 'b', undo: async () => { undone.push('b'); }, redo: async () => {} });
        });
      });
    });

    // One entry covering both, not an entry whose undo is another group.
    await act(async () => { await result.current.undo(); });
    expect(undone).toEqual(['b', 'a']);
    expect(result.current.canUndo).toBe(false);
  });

  it('releases the group even if the work throws', async () => {
    const { result } = setup();

    await act(async () => {
      await expect(result.current.runAsUndoGroup('commit', async () => {
        throw new Error('mutation failed');
      })).rejects.toThrow('mutation failed');
    });

    // A leaked group would swallow every later push into a buffer nobody
    // flushes, silently killing undo for the rest of the session.
    await act(async () => {
      result.current.pushAction({ type: 'after', undo: async () => {}, redo: async () => {} });
    });
    expect(result.current.canUndo).toBe(true);
  });
});
