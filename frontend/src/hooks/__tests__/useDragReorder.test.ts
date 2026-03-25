import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDragReorder, computeShiftTransform, type DragReorderState } from '../useDragReorder';
import { useRef } from 'react';

describe('computeShiftTransform', () => {
  it('returns empty string when not dragging', () => {
    const state: DragReorderState = { isDragging: false, dragIndex: null, overIndex: null, itemHeight: 0 };
    expect(computeShiftTransform(0, state)).toBe('');
  });

  it('returns empty string when dragIndex is null', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: null, overIndex: 2, itemHeight: 50 };
    expect(computeShiftTransform(1, state)).toBe('');
  });

  it('returns empty string when overIndex is null', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: 1, overIndex: null, itemHeight: 50 };
    expect(computeShiftTransform(0, state)).toBe('');
  });

  it('returns empty string for the dragged item itself', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: 1, overIndex: 3, itemHeight: 50 };
    expect(computeShiftTransform(1, state)).toBe('');
  });

  it('shifts items up when dragging down (dragIndex < overIndex)', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: 1, overIndex: 3, itemHeight: 50 };
    // Items between dragIndex and overIndex should shift up
    expect(computeShiftTransform(2, state)).toBe('translateY(-50px)');
    expect(computeShiftTransform(3, state)).toBe('translateY(-50px)');
  });

  it('does not shift items outside the range when dragging down', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: 1, overIndex: 3, itemHeight: 50 };
    expect(computeShiftTransform(0, state)).toBe('');
    expect(computeShiftTransform(4, state)).toBe('');
  });

  it('shifts items down when dragging up (dragIndex > overIndex)', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: 3, overIndex: 1, itemHeight: 50 };
    // Items between overIndex and dragIndex should shift down
    expect(computeShiftTransform(1, state)).toBe('translateY(50px)');
    expect(computeShiftTransform(2, state)).toBe('translateY(50px)');
  });

  it('does not shift items outside the range when dragging up', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: 3, overIndex: 1, itemHeight: 50 };
    expect(computeShiftTransform(0, state)).toBe('');
    expect(computeShiftTransform(4, state)).toBe('');
  });

  it('returns empty string when dragIndex equals overIndex', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: 2, overIndex: 2, itemHeight: 50 };
    expect(computeShiftTransform(0, state)).toBe('');
    expect(computeShiftTransform(1, state)).toBe('');
    expect(computeShiftTransform(3, state)).toBe('');
  });

  it('uses correct itemHeight for different values', () => {
    const state: DragReorderState = { isDragging: true, dragIndex: 0, overIndex: 2, itemHeight: 36 };
    expect(computeShiftTransform(1, state)).toBe('translateY(-36px)');
    expect(computeShiftTransform(2, state)).toBe('translateY(-36px)');
  });
});

describe('useDragReorder', () => {
  it('returns initial drag state', () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement>(null);
      return useDragReorder({
        itemCount: 5,
        onReorder: vi.fn(),
        containerRef: ref,
      });
    });

    expect(result.current.dragState).toEqual({
      isDragging: false,
      dragIndex: null,
      overIndex: null,
      itemHeight: 0,
    });
  });

  it('getDragHandlers returns touch event handlers', () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement>(null);
      return useDragReorder({
        itemCount: 5,
        onReorder: vi.fn(),
        containerRef: ref,
      });
    });

    const handlers = result.current.getDragHandlers(0);
    expect(handlers).toHaveProperty('onTouchStart');
    expect(handlers).toHaveProperty('onTouchMove');
    expect(handlers).toHaveProperty('onTouchEnd');
  });

  it('getHandleMouseDown returns a function', () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement>(null);
      return useDragReorder({
        itemCount: 5,
        onReorder: vi.fn(),
        containerRef: ref,
      });
    });

    const handler = result.current.getHandleMouseDown(0);
    expect(typeof handler).toBe('function');
  });
});
