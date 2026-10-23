import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { UndoProvider, useUndo } from '../UndoContext';
import { getFlash, __resetFlashesForTests } from '../../utils/recentFlash';
import type { ReactNode } from 'react';

// An undo can land on a row anywhere in the list — including one scrolled
// out of sight — so unlike an edit you made yourself, there is nothing to
// tell you what just moved. Actions name the rows they touch, and the
// context flashes them once the work has actually run.
describe('UndoContext — highlighting what an undo touched', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <UndoProvider id={`highlight-${Math.random()}`}>{children}</UndoProvider>
  );
  const setup = () => renderHook(() => useUndo(), { wrapper });

  beforeEach(() => { __resetFlashesForTests(); });
  afterEach(() => { __resetFlashesForTests(); });

  const flashing = (id: string) => getFlash(id) > 0;

  it('flashes the named rows after an undo', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.pushAction({
        type: 'edit', undo: async () => {}, redo: async () => {},
        highlight: () => ['i1'],
      });
    });

    expect(flashing('i1')).toBe(false);
    await act(async () => { await result.current.undo(); });
    expect(flashing('i1')).toBe(true);
  });

  it('flashes again after the redo', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.pushAction({
        type: 'edit', undo: async () => {}, redo: async () => {},
        highlight: () => ['i1'],
      });
    });

    await act(async () => { await result.current.undo(); });
    const afterUndo = getFlash('i1');
    await act(async () => { await result.current.redo(); });
    expect(getFlash('i1')).not.toBe(afterUndo);
  });

  // Evaluated AFTER the work, not at push time: an item that has been
  // deleted and restored comes back with a new server id, and the closures
  // track that through the remap chain. A value captured at push time would
  // point at an id that no longer exists.
  it('asks for the ids after the action has run', async () => {
    const { result } = setup();
    let currentId = 'temp-1';
    await act(async () => {
      result.current.pushAction({
        type: 'restore',
        undo: async () => { currentId = 'server-7'; },
        redo: async () => {},
        highlight: () => [currentId],
      });
    });

    await act(async () => { await result.current.undo(); });
    expect(flashing('server-7')).toBe(true);
    expect(flashing('temp-1')).toBe(false);
  });

  it('flashes every row a grouped commit touched', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.runAsUndoGroup('commit', () => {
        result.current.pushAction({
          type: 'edit', undo: async () => {}, redo: async () => {}, highlight: () => ['i1'],
        });
        result.current.pushAction({
          type: 'move', undo: async () => {}, redo: async () => {}, highlight: () => ['i2'],
        });
      });
    });

    await act(async () => { await result.current.undo(); });
    expect(flashing('i1')).toBe(true);
    expect(flashing('i2')).toBe(true);
  });

  it('flashes nothing for an action that names no rows', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.pushAction({ type: 'clear', undo: async () => {}, redo: async () => {} });
    });

    await act(async () => { await result.current.undo(); });
    expect(flashing('i1')).toBe(false);
  });

  it('does not flash when the action itself failed', async () => {
    const { result } = setup();
    await act(async () => {
      result.current.pushAction({
        type: 'edit',
        undo: async () => { throw new Error('offline'); },
        redo: async () => {},
        highlight: () => ['i1'],
      });
    });

    await act(async () => {
      await expect(result.current.undo()).rejects.toThrow('offline');
    });
    expect(flashing('i1')).toBe(false);
  });
});
