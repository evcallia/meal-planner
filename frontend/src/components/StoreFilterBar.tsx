import { useState, useRef, useEffect } from 'react';
import { Store } from '../types';
import { NONE_STORE_ID } from './GroceryListView';

interface StoreFilterBarProps {
  stores: Store[];
  selectedStoreIds: Set<string>;
  excludedStoreIds: Set<string>;
  onToggleSelect: (storeId: string) => void;
  onRemoveExclusion: (storeId: string) => void;
  onRename: (storeId: string, name: string) => void;
  onDelete: (storeId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onExclude: (storeId: string) => void;
  storeCounts?: Map<string, number>;
  noneCount?: number;
}

export function StoreFilterBar({ stores, selectedStoreIds, excludedStoreIds, onToggleSelect, onRemoveExclusion, onRename, onDelete, onReorder, onExclude, storeCounts, noneCount = 0 }: StoreFilterBarProps) {
  const [editingStoreId, setEditingStoreId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragStartXRef = useRef(0);
  const chipRectsRef = useRef<DOMRect[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const dragIndexRef = useRef<number | null>(null);
  const dragOverIndexRef = useRef<number | null>(null);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  // Long-press can either start drag (if pointer moves) or open edit (if released without moving)
  const longPressReadyRef = useRef<{ index: number; storeId: string; storeName: string; clientX: number; clientY: number } | null>(null);

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const cacheChipRects = () => {
    if (!containerRef.current) return;
    const chips = containerRef.current.querySelectorAll<HTMLElement>('[data-chip-index]');
    chipRectsRef.current = Array.from(chips).map(el => el.getBoundingClientRect());
  };

  const findDropIndex = (clientX: number, clientY: number): number => {
    const rects = chipRectsRef.current;
    if (rects.length === 0) return 0;
    // Find the closest chip center by distance
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const cx = rects[i].left + rects[i].width / 2;
      const cy = rects[i].top + rects[i].height / 2;
      const dist = Math.sqrt((clientX - cx) ** 2 + (clientY - cy) ** 2);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }
    // If dragging past the midpoint of the closest chip, place after it
    const closestRect = rects[closestIdx];
    const midX = closestRect.left + closestRect.width / 2;
    if (clientX > midX && closestIdx < rects.length - 1) {
      // Check if the next chip is on the same row
      const nextRect = rects[closestIdx + 1];
      if (Math.abs(nextRect.top - closestRect.top) < closestRect.height / 2) {
        return closestIdx + 1;
      }
    }
    return closestIdx;
  };

  const beginDrag = (index: number, clientX: number, clientY: number) => {
    clearLongPress();
    didLongPressRef.current = true;
    isDraggingRef.current = true;
    dragIndexRef.current = index;
    dragOverIndexRef.current = index;
    setDragIndex(index);
    setDragOverIndex(index);
    dragStartXRef.current = clientX;
    dragStartYRef.current = clientY;
    cacheChipRects();

    // Create ghost via cloneNode
    const chip = containerRef.current?.querySelector<HTMLElement>(`[data-chip-index="${index}"]`);
    if (chip) {
      const rect = chip.getBoundingClientRect();
      const ghost = document.createElement('div');
      const clone = chip.cloneNode(true) as HTMLElement;
      ghost.appendChild(clone);
      ghost.style.position = 'fixed';
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.zIndex = '9999';
      ghost.style.opacity = '0.85';
      ghost.style.pointerEvents = 'none';
      document.body.appendChild(ghost);
      ghostRef.current = ghost;
    }

    document.body.style.setProperty('user-select', 'none');
    document.getSelection()?.removeAllRanges();
  };

  const dragStartYRef = useRef(0);

  const moveGhost = (clientX: number, clientY: number) => {
    if (!ghostRef.current || dragIndexRef.current === null) return;
    const startRect = chipRectsRef.current[dragIndexRef.current];
    if (!startRect) return;
    const dx = clientX - dragStartXRef.current;
    const dy = clientY - dragStartYRef.current;
    ghostRef.current.style.left = `${startRect.left + dx}px`;
    ghostRef.current.style.top = `${startRect.top + dy}px`;

    const overIdx = findDropIndex(clientX, clientY);
    dragOverIndexRef.current = overIdx;
    setDragOverIndex(overIdx);
  };

  const finishDrag = () => {
    if (ghostRef.current) {
      ghostRef.current.remove();
      ghostRef.current = null;
    }
    document.body.style.removeProperty('user-select');

    const from = dragIndexRef.current;
    const to = dragOverIndexRef.current;
    isDraggingRef.current = false;
    dragIndexRef.current = null;
    dragOverIndexRef.current = null;
    setDragIndex(null);
    setDragOverIndex(null);

    if (from !== null && to !== null && from !== to) {
      onReorderRef.current(from, to);
    }
  };

  // Document-level listeners for drag continuation outside chips
  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (isDraggingRef.current) moveGhost(e.clientX, e.clientY);
    };
    const handleUp = () => {
      if (isDraggingRef.current) finishDrag();
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    return () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };
  }, []);

  // Cleanup ghost on unmount
  useEffect(() => {
    return () => {
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }
    };
  }, []);

  // Two-phase long-press: 300ms = drag-ready, 500ms = auto-open popover
  const popoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPopoverTimer = () => {
    if (popoverTimerRef.current) {
      clearTimeout(popoverTimerRef.current);
      popoverTimerRef.current = null;
    }
  };

  const handlePointerDown = (index: number, storeId: string, storeName: string, clientX: number, clientY: number) => {
    didLongPressRef.current = false;
    dragStartXRef.current = clientX;
    dragStartYRef.current = clientY;
    longPressReadyRef.current = null;
    clearPopoverTimer();
    longPressTimerRef.current = setTimeout(() => {
      // 300ms: drag-ready. If pointer moves → drag. If not, popover opens at 500ms.
      didLongPressRef.current = true;
      longPressReadyRef.current = { index, storeId, storeName, clientX, clientY };
    }, 300);
    popoverTimerRef.current = setTimeout(() => {
      // 500ms: auto-open popover if no movement
      if (!isDraggingRef.current) {
        clearLongPress();
        didLongPressRef.current = true;
        longPressReadyRef.current = null;
        setEditingStoreId(storeId);
        setEditName(storeName);
      }
    }, 500);
  };

  const handlePointerUp = (storeId: string) => {
    clearLongPress();
    clearPopoverTimer();
    if (isDraggingRef.current) {
      finishDrag();
      return;
    }
    if (longPressReadyRef.current && longPressReadyRef.current.storeId === storeId) {
      // Long-press completed (300-500ms) but no drag movement and popover didn't auto-open yet
      setEditingStoreId(storeId);
      setEditName(storeId === NONE_STORE_ID ? 'None' : longPressReadyRef.current.storeName);
      longPressReadyRef.current = null;
      return;
    }
    if (!didLongPressRef.current) {
      if (excludedStoreIds.has(storeId)) {
        onRemoveExclusion(storeId);
      } else {
        onToggleSelect(storeId);
      }
    }
    longPressReadyRef.current = null;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDraggingRef.current) return; // document listener handles it
    // If long-press is ready and pointer moved, start the drag
    if (longPressReadyRef.current) {
      const dx = Math.abs(e.clientX - longPressReadyRef.current.clientX);
      const dy = Math.abs(e.clientY - longPressReadyRef.current.clientY);
      if (dx > 5 || dy > 5) {
        const { index, clientX, clientY } = longPressReadyRef.current;
        longPressReadyRef.current = null;
        clearPopoverTimer();
        // None chip (index -1) is not draggable
        if (index >= 0) beginDrag(index, clientX, clientY);
      }
      return;
    }
    // Cancel long-press timer if moved too far before it fires
    if (longPressTimerRef.current) {
      const dx = Math.abs(e.clientX - dragStartXRef.current);
      if (dx > 10) {
        clearLongPress();
        clearPopoverTimer();
      }
    }
  };

  const handlePointerLeave = () => {
    if (!isDraggingRef.current) {
      clearLongPress();
      clearPopoverTimer();
      longPressReadyRef.current = null;
    }
  };

  const handleSaveRename = () => {
    if (editingStoreId && editName.trim()) {
      onRename(editingStoreId, editName.trim());
    }
    setEditingStoreId(null);
  };

  const handleDelete = () => {
    if (editingStoreId) {
      onDelete(editingStoreId);
    }
    setEditingStoreId(null);
  };

  if (stores.length === 0 && noneCount === 0) return null;

  return (
    <div className="relative">
      <div ref={containerRef} className="flex flex-wrap gap-2 pb-2 px-1 -mx-1">
        {stores.map((store, i) => {
          const isDragged = dragIndex === i;
          const isSelected = selectedStoreIds.has(store.id);
          const isExcluded = excludedStoreIds.has(store.id);
          // During drag, compute where this chip should visually move to
          let transformStyle: string | undefined;
          if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex && !isDragged && chipRectsRef.current.length === stores.length) {
            // Build the visual reorder: which index does chip i end up at?
            const order = stores.map((_, idx) => idx);
            const [moved] = order.splice(dragIndex, 1);
            order.splice(dragOverIndex, 0, moved);
            const visualPos = order.indexOf(i);
            if (visualPos !== i) {
              // Translate from original rect to target rect
              const fromRect = chipRectsRef.current[i];
              const toRect = chipRectsRef.current[visualPos];
              if (fromRect && toRect) {
                const dx = toRect.left - fromRect.left;
                const dy = toRect.top - fromRect.top;
                if (dx !== 0 || dy !== 0) {
                  transformStyle = `translate(${dx}px, ${dy}px)`;
                }
              }
            }
          }

          return (
            <button
              key={store.id}
              data-chip-index={i}
              onPointerDown={(e) => handlePointerDown(i, store.id, store.name, e.clientX, e.clientY)}
              onPointerUp={() => handlePointerUp(store.id)}
              onPointerMove={handlePointerMove}
              onPointerLeave={handlePointerLeave}
              style={{
                opacity: isDragged ? 0.3 : 1,
                transform: transformStyle,
                transition: dragIndex !== null ? 'transform 200ms ease-out, opacity 200ms' : undefined,
              }}
              className={`
                px-3 py-1 rounded-full text-sm font-medium transition-colors select-none touch-none
                ${isExcluded
                  ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 line-through opacity-60'
                  : isSelected
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }
              `}
            >
              {store.name}
              {storeCounts && (storeCounts.get(store.id) ?? 0) > 0 && (
                <span className={`ml-1.5 text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center ${
                  isSelected
                    ? 'bg-blue-400/30 text-white'
                    : 'bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400'
                }`}>
                  {storeCounts.get(store.id)}
                </span>
              )}
            </button>
          );
        })}
        {(noneCount > 0 || excludedStoreIds.has(NONE_STORE_ID)) && (() => {
          const noneIsSelected = selectedStoreIds.has(NONE_STORE_ID);
          const noneIsExcluded = excludedStoreIds.has(NONE_STORE_ID);
          return (
            <button
              onPointerDown={(e) => {
                // Long-press for exclude popover, no drag for None chip
                handlePointerDown(-1, NONE_STORE_ID, 'None', e.clientX, e.clientY);
              }}
              onPointerUp={() => handlePointerUp(NONE_STORE_ID)}
              onPointerMove={handlePointerMove}
              onPointerLeave={handlePointerLeave}
              className={`
                px-3 py-1 rounded-full text-sm font-medium transition-colors select-none touch-none
                ${noneIsExcluded
                  ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 line-through opacity-60'
                  : noneIsSelected
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }
              `}
            >
              None
              {noneCount > 0 && (
                <span className={`ml-1.5 text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center ${
                  noneIsSelected
                    ? 'bg-blue-400/30 text-white'
                    : 'bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400'
                }`}>
                  {noneCount}
                </span>
              )}
            </button>
          );
        })()}
      </div>

      {editingStoreId && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-600 rounded-lg shadow-lg p-3 mx-2">
            {editingStoreId !== NONE_STORE_ID && (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRename(); if (e.key === 'Escape') setEditingStoreId(null); }}
                autoFocus
                className="w-full text-sm px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white mb-2"
              />
            )}
            {excludedStoreIds.has(editingStoreId) ? (
              <button
                onClick={() => { onRemoveExclusion(editingStoreId); setEditingStoreId(null); }}
                className="w-full text-left text-sm text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 mb-2"
              >
                Include in list
              </button>
            ) : (
              <button
                onClick={() => { onExclude(editingStoreId); setEditingStoreId(null); }}
                className="w-full text-left text-sm text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 mb-2"
              >
                Exclude from list
              </button>
            )}
            {editingStoreId !== NONE_STORE_ID && (
              <div className="flex justify-between">
                <button onClick={handleDelete} className="text-sm text-red-500 hover:text-red-700">
                  Delete
                </button>
                <div className="flex gap-2">
                  <button onClick={() => setEditingStoreId(null)} className="text-sm text-gray-500">
                    Cancel
                  </button>
                  <button onClick={handleSaveRename} className="text-sm text-blue-500 font-medium">
                    Save
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
