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
  onDropOutside?: (fromIndex: number, clientY: number) => void;
  onDragMove?: (fromIndex: number, clientY: number) => void;
}

const LONG_PRESS_MS = 300;
const CANCEL_THRESHOLD = 10;
const AUTO_SCROLL_EDGE = 60; // px from viewport edge to trigger scroll
const MAX_SCROLL_SPEED = 12; // px per frame at the very edge

export function useDragReorder({ onReorder, containerRef, onDragStart, onDragEnd, onDropOutside, onDragMove }: DragReorderConfig) {
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
  const onDropOutsideRef = useRef(onDropOutside);
  onDropOutsideRef.current = onDropOutside;
  const onDragMoveRef = useRef(onDragMove);
  onDragMoveRef.current = onDragMove;

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
    lastClientY: 0,
    mouseCleanup: null as (() => void) | null,
    touchMoveCleanup: null as (() => void) | null,
    autoScrollRaf: 0,
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
      if (ref.touchMoveCleanup) ref.touchMoveCleanup();
      if (ref.autoScrollRaf) cancelAnimationFrame(ref.autoScrollRaf);
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
    ref.lastClientY = clientY;

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

    // Prevent page scroll during touch drag (React touch handlers are passive)
    const preventScroll = (e: TouchEvent) => {
      if (ref.phase === 'dragging') e.preventDefault();
    };
    document.addEventListener('touchmove', preventScroll, { passive: false });
    ref.touchMoveCleanup = () => {
      document.removeEventListener('touchmove', preventScroll);
    };

    // Auto-scroll when dragging near viewport edges
    const autoScroll = () => {
      if (ref.phase !== 'dragging') return;
      const y = ref.lastClientY;
      const vh = window.innerHeight;
      let delta = 0;
      if (y < AUTO_SCROLL_EDGE) {
        delta = -MAX_SCROLL_SPEED * (1 - y / AUTO_SCROLL_EDGE);
      } else if (y > vh - AUTO_SCROLL_EDGE) {
        delta = MAX_SCROLL_SPEED * (1 - (vh - y) / AUTO_SCROLL_EDGE);
      }
      if (delta !== 0) {
        window.scrollBy(0, delta);
        // Recache rects after scroll so hit-testing stays accurate
        ref.itemRects = ref.itemElements.map(el => el.getBoundingClientRect());
        const newOverIndex = computeOverIndex(y);
        if (newOverIndex !== ref.currentOverIndex) {
          ref.currentOverIndex = newOverIndex;
          setDragState(prev => ({ ...prev, overIndex: newOverIndex }));
        }
        onDragMoveRef.current?.(ref.startIndex, y);
      }
      ref.autoScrollRaf = requestAnimationFrame(autoScroll);
    };
    ref.autoScrollRaf = requestAnimationFrame(autoScroll);

    setDragState({
      isDragging: true,
      dragIndex: index,
      overIndex: index,
      itemHeight: rect.height,
    });
  }, [getItemElements, computeOverIndex]);

  const moveDrag = useCallback((clientY: number) => {
    const ref = internalRef.current;
    ref.lastClientY = clientY;
    if (ref.ghostEl) {
      ref.ghostEl.style.top = `${clientY - ref.offsetY}px`;
    }
    const newOverIndex = computeOverIndex(clientY);
    if (newOverIndex !== ref.currentOverIndex) {
      ref.currentOverIndex = newOverIndex;
      setDragState(prev => ({ ...prev, overIndex: newOverIndex }));
    }
    onDragMoveRef.current?.(ref.startIndex, clientY);
  }, [computeOverIndex]);

  const finishDrag = useCallback(() => {
    const ref = internalRef.current;
    const from = ref.startIndex;
    const to = ref.currentOverIndex;
    const lastY = ref.lastClientY;

    if (ref.ghostEl && ref.ghostEl.parentNode) {
      document.body.removeChild(ref.ghostEl);
      ref.ghostEl = null;
    }
    if (ref.touchMoveCleanup) { ref.touchMoveCleanup(); ref.touchMoveCleanup = null; }
    if (ref.autoScrollRaf) { cancelAnimationFrame(ref.autoScrollRaf); ref.autoScrollRaf = 0; }
    ref.phase = 'idle';
    setDragState({ isDragging: false, dragIndex: null, overIndex: null, itemHeight: 0 });
    onDragEndRef.current?.();

    // Check if drop landed outside the container (cross-section move)
    const container = containerRef.current;
    if (container && onDropOutsideRef.current) {
      const rect = container.getBoundingClientRect();
      if (lastY < rect.top || lastY > rect.bottom) {
        onDropOutsideRef.current(from, lastY);
        return;
      }
    }

    if (from !== to) {
      onReorderRef.current(from, to);
    }
  }, [containerRef]);

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
