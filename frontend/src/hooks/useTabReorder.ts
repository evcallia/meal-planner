import { useCallback, useEffect, useRef, useState } from 'react';

// Long-press drag-to-reorder for a horizontal tab strip. Shared by the Lists
// tab and the Lists tab so both feel identical: press and hold a tab to pick
// it up, drag over neighbours to shuffle, and the strip auto-scrolls when the
// pointer nears an edge so you can reach tabs that are off-screen.
//
// The hook owns the gesture only. It reports the finished order via onReorder
// and lets the caller decide what that means (persisting it, keeping the
// viewed tab selected, pinning a synthetic tab's slot, …).

const preventDefaultTouch = (e: TouchEvent) => e.preventDefault();

export interface UseTabReorderOptions {
  /** Current tab order (ids). Read at drag start. */
  tabIds: string[];
  /** The scrollable strip element — used for edge auto-scroll. */
  stripRef: React.RefObject<HTMLElement | null>;
  /** Called with the new order once the drag ends, only if it changed. */
  onReorder: (orderedIds: string[]) => void;
  /** How long to hold before a tab is picked up. */
  longPressMs?: number;
}

export function useTabReorder({ tabIds, stripRef, onReorder, longPressMs = 250 }: UseTabReorderOptions) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);

  const dragIdRef = useRef<string | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const draggingRef = useRef(false);
  // Set briefly after a drag so the click that follows pointerup doesn't also
  // switch tabs.
  const justDraggedRef = useRef(false);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastXRef = useRef(0);
  const lastYRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Refs so the document-level handlers below never capture stale values.
  const tabIdsRef = useRef(tabIds);
  tabIdsRef.current = tabIds;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const hitTest = useCallback((x: number, y: number) => {
    const id = dragIdRef.current;
    const cur = dragOrderRef.current;
    if (!id || !cur) return;
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-tab-id]');
    const overId = el?.getAttribute('data-tab-id');
    if (!overId || overId === id) return;
    const from = cur.indexOf(id);
    const to = cur.indexOf(overId);
    if (from < 0 || to < 0) return;
    const next = [...cur];
    next.splice(to, 0, next.splice(from, 1)[0]);
    dragOrderRef.current = next;
    setDragOrder(next);
  }, []);

  const onDragMove = useCallback((e: PointerEvent) => {
    lastXRef.current = e.clientX;
    lastYRef.current = e.clientY;
    hitTest(e.clientX, e.clientY);
  }, [hitTest]);

  // Scroll the strip when the dragged tab nears an edge, so a long strip stays
  // fully reachable mid-drag.
  const autoScroll = useCallback(() => {
    const strip = stripRef.current;
    if (strip && dragIdRef.current) {
      const rect = strip.getBoundingClientRect();
      const EDGE = 56;
      const SPEED = 12;
      const x = lastXRef.current;
      if (x > rect.right - EDGE && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1) {
        strip.scrollLeft += SPEED;
        hitTest(x, lastYRef.current);
      } else if (x < rect.left + EDGE && strip.scrollLeft > 0) {
        strip.scrollLeft -= SPEED;
        hitTest(x, lastYRef.current);
      }
    }
    rafRef.current = requestAnimationFrame(autoScroll);
  }, [stripRef, hitTest]);

  const endDrag = useCallback(() => {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', endDrag);
    document.removeEventListener('touchmove', preventDefaultTouch);
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }

    const order = dragOrderRef.current;
    dragIdRef.current = null;
    dragOrderRef.current = null;
    draggingRef.current = false;
    setDragId(null);
    setDragOrder(null);
    justDraggedRef.current = true;
    setTimeout(() => { justDraggedRef.current = false; }, 60);

    const before = tabIdsRef.current;
    if (order && order.some((id, i) => id !== before[i])) {
      onReorderRef.current(order);
    }
  }, [onDragMove]);

  const beginDrag = useCallback((id: string) => {
    draggingRef.current = true;
    dragIdRef.current = id;
    const order = [...tabIdsRef.current];
    dragOrderRef.current = order;
    setDragId(id);
    setDragOrder(order);
    const rect = stripRef.current?.getBoundingClientRect();
    if (rect) {
      lastXRef.current = (rect.left + rect.right) / 2;
      lastYRef.current = (rect.top + rect.bottom) / 2;
    }
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('touchmove', preventDefaultTouch, { passive: false });
    rafRef.current = requestAnimationFrame(autoScroll);
  }, [stripRef, onDragMove, endDrag, autoScroll]);

  const onPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => beginDrag(id), longPressMs);
  }, [beginDrag, longPressMs]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (draggingRef.current) return;
    // Moved before the hold completed — that's a scroll, not a pick-up.
    const s = pressStartRef.current;
    if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10 && pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  const onPointerUp = useCallback(() => {
    if (pressTimerRef.current) { clearTimeout(pressTimerRef.current); pressTimerRef.current = null; }
  }, []);

  // A drag in flight when the component unmounts must not leave document
  // listeners or the rAF loop behind.
  useEffect(() => () => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', endDrag);
    document.removeEventListener('touchmove', preventDefaultTouch);
  }, [onDragMove, endDrag]);

  /** Spread onto each tab button, alongside `data-tab-id={id}`. */
  const tabHandlers = useCallback((id: string) => ({
    onPointerDown: (e: React.PointerEvent) => onPointerDown(e, id),
    onPointerMove,
    onPointerUp,
  }), [onPointerDown, onPointerMove, onPointerUp]);

  return {
    /** The tab currently picked up (style it as lifted). */
    dragId,
    /** Live order while dragging; null when idle — render `dragOrder ?? tabIds`. */
    dragOrder,
    /** True for ~60ms after a drag: skip the click that follows. */
    justDraggedRef,
    tabHandlers,
  };
}
