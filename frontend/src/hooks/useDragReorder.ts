import { useRef, useState, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';

export interface DragReorderState {
  isDragging: boolean;
  dragIndex: number | null;
  overIndex: number | null;
  itemHeight: number;
}

interface DragReorderConfig {
  itemCount: number;
  onReorder: (fromIndex: number, toIndex: number) => void;
  containerRef: React.RefObject<HTMLElement | null>;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

const LONG_PRESS_MS = 300;
const CANCEL_THRESHOLD = 10;

export function useDragReorder({ onReorder, containerRef, onDragStart, onDragEnd }: DragReorderConfig) {
  const [dragState, setDragState] = useState<DragReorderState>({
    isDragging: false,
    dragIndex: null,
    overIndex: null,
    itemHeight: 0,
  });

  // Use refs to avoid stale closures in document-level listeners
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  const internalRef = useRef({
    phase: 'idle' as 'idle' | 'pressing' | 'dragging',
    timer: null as ReturnType<typeof setTimeout> | null,
    startY: 0,
    startX: 0,
    offsetY: 0,
    startIndex: 0,
    itemRects: [] as DOMRect[],
    itemElements: [] as HTMLElement[],
    ghostEl: null as HTMLDivElement | null,
    currentOverIndex: 0,
    mouseCleanup: null as (() => void) | null,
  });

  // Prevent text selection while dragging
  useEffect(() => {
    if (dragState.isDragging) {
      document.body.style.setProperty('user-select', 'none');
      document.body.style.setProperty('-webkit-user-select', 'none');
      return () => {
        document.body.style.removeProperty('user-select');
        document.body.style.removeProperty('-webkit-user-select');
      };
    }
  }, [dragState.isDragging]);

  // Recache rects after DOM updates during drag (e.g. section collapse)
  useEffect(() => {
    if (dragState.isDragging && containerRef.current) {
      requestAnimationFrame(() => {
        const ref = internalRef.current;
        if (ref.phase !== 'dragging') return;
        const elements = Array.from(
          containerRef.current?.querySelectorAll(':scope > [data-drag-index]') ?? []
        ) as HTMLElement[];
        ref.itemElements = elements;
        ref.itemRects = elements.map(el => el.getBoundingClientRect());
        // Update itemHeight for collapsed layout
        const newRect = ref.itemRects[ref.startIndex];
        if (newRect) {
          ref.offsetY = Math.min(ref.offsetY, newRect.height / 2);
          setDragState(prev => ({ ...prev, itemHeight: newRect.height }));
        }
      });
    }
  }, [dragState.isDragging, containerRef]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const ref = internalRef.current;
      if (ref.timer) clearTimeout(ref.timer);
      if (ref.ghostEl && ref.ghostEl.parentNode) ref.ghostEl.parentNode.removeChild(ref.ghostEl);
      if (ref.mouseCleanup) ref.mouseCleanup();
      document.body.style.removeProperty('user-select');
      document.body.style.removeProperty('-webkit-user-select');
    };
  }, []);

  const getItemElements = useCallback((): HTMLElement[] => {
    if (!containerRef.current) return [];
    return Array.from(containerRef.current.querySelectorAll(':scope > [data-drag-index]'));
  }, [containerRef]);

  const computeOverIndex = useCallback((clientY: number) => {
    const ref = internalRef.current;
    let newOverIndex = ref.startIndex;
    for (let i = 0; i < ref.itemRects.length; i++) {
      const mid = ref.itemRects[i].top + ref.itemRects[i].height / 2;
      if (clientY > mid) newOverIndex = i;
    }
    if (ref.itemRects.length > 0 && clientY < ref.itemRects[0].top + ref.itemRects[0].height / 2) {
      newOverIndex = 0;
    }
    return Math.max(0, Math.min(newOverIndex, ref.itemRects.length - 1));
  }, []);

  const beginDrag = useCallback((index: number, clientY: number) => {
    const ref = internalRef.current;
    ref.phase = 'dragging';
    if (navigator.vibrate) navigator.vibrate(50);
    document.getSelection()?.removeAllRanges();

    // Flush onDragStart first so DOM collapses before we cache rects / clone ghost
    if (onDragStartRef.current) {
      flushSync(() => { onDragStartRef.current?.(); });
    }

    const elements = getItemElements();
    ref.itemElements = elements;
    ref.itemRects = elements.map(el => el.getBoundingClientRect());

    const rect = ref.itemRects[index];
    if (!rect) { ref.phase = 'idle'; return; }

    ref.offsetY = clientY - rect.top;
    ref.currentOverIndex = index;

    const sourceEl = elements[index];
    if (!sourceEl) { ref.phase = 'idle'; return; }

    const ghost = sourceEl.cloneNode(true) as HTMLDivElement;
    ghost.style.position = 'fixed';
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${clientY - ref.offsetY}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.zIndex = '50';
    ghost.style.pointerEvents = 'none';
    ghost.style.opacity = '0.9';
    ghost.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    ghost.style.borderRadius = '8px';
    ghost.style.transform = 'scale(1.02)';
    ghost.style.transition = 'none';
    ghost.style.overflow = 'hidden';
    document.body.appendChild(ghost);
    ref.ghostEl = ghost;

    setDragState({
      isDragging: true,
      dragIndex: index,
      overIndex: index,
      itemHeight: rect.height,
    });
  }, [getItemElements]);

  const moveDrag = useCallback((clientY: number) => {
    const ref = internalRef.current;
    if (ref.ghostEl) {
      ref.ghostEl.style.top = `${clientY - ref.offsetY}px`;
    }
    const newOverIndex = computeOverIndex(clientY);
    if (newOverIndex !== ref.currentOverIndex) {
      ref.currentOverIndex = newOverIndex;
      setDragState(prev => ({ ...prev, overIndex: newOverIndex }));
    }
  }, [computeOverIndex]);

  const finishDrag = useCallback(() => {
    const ref = internalRef.current;
    const from = ref.startIndex;
    const to = ref.currentOverIndex;

    if (ref.ghostEl && ref.ghostEl.parentNode) {
      document.body.removeChild(ref.ghostEl);
      ref.ghostEl = null;
    }
    ref.phase = 'idle';
    setDragState({ isDragging: false, dragIndex: null, overIndex: null, itemHeight: 0 });
    onDragEndRef.current?.();

    if (from !== to) {
      onReorderRef.current(from, to);
    }
  }, []);

  // Touch handlers (long-press to drag)
  const getDragHandlers = useCallback((index: number) => ({
    onTouchStart: (_e: React.TouchEvent) => {
      const ref = internalRef.current;
      if (ref.phase === 'dragging') return;

      const touch = _e.touches[0];
      ref.startY = touch.clientY;
      ref.startX = touch.clientX;
      ref.startIndex = index;
      ref.phase = 'pressing';

      // Prevent text selection immediately
      document.getSelection()?.removeAllRanges();

      ref.timer = setTimeout(() => {
        beginDrag(index, touch.clientY);
      }, LONG_PRESS_MS);
    },

    onTouchMove: (e: React.TouchEvent) => {
      const ref = internalRef.current;
      const touch = e.touches[0];

      if (ref.phase === 'pressing') {
        const dy = Math.abs(touch.clientY - ref.startY);
        const dx = Math.abs(touch.clientX - ref.startX);
        if (dy > CANCEL_THRESHOLD || dx > CANCEL_THRESHOLD) {
          if (ref.timer) clearTimeout(ref.timer);
          ref.timer = null;
          ref.phase = 'idle';
        }
        return;
      }

      if (ref.phase === 'dragging') {
        e.preventDefault();
        moveDrag(touch.clientY);
      }
    },

    onTouchEnd: () => {
      const ref = internalRef.current;
      if (ref.timer) { clearTimeout(ref.timer); ref.timer = null; }

      if (ref.phase === 'dragging') {
        finishDrag();
      } else {
        ref.phase = 'idle';
      }
    },
  }), [beginDrag, moveDrag, finishDrag]);

  // Mouse handler for drag handle (desktop — immediate drag, no long press)
  const getHandleMouseDown = useCallback((index: number) => {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const ref = internalRef.current;
      if (ref.phase !== 'idle') return;

      ref.startIndex = index;
      beginDrag(index, e.clientY);

      const onMouseMove = (ev: MouseEvent) => {
        ev.preventDefault();
        moveDrag(ev.clientY);
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        ref.mouseCleanup = null;
        finishDrag();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      ref.mouseCleanup = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
    };
  }, [beginDrag, moveDrag, finishDrag]);

  return { dragState, getDragHandlers, getHandleMouseDown };
}

/**
 * Compute the translateY shift for a non-dragged item based on drag state.
 */
export function computeShiftTransform(
  index: number,
  dragState: DragReorderState,
): string {
  if (!dragState.isDragging || dragState.dragIndex === null || dragState.overIndex === null) return '';
  if (index === dragState.dragIndex) return '';

  const { dragIndex, overIndex, itemHeight } = dragState;

  if (dragIndex < overIndex) {
    if (index > dragIndex && index <= overIndex) {
      return `translateY(-${itemHeight}px)`;
    }
  } else if (dragIndex > overIndex) {
    if (index >= overIndex && index < dragIndex) {
      return `translateY(${itemHeight}px)`;
    }
  }

  return '';
}
