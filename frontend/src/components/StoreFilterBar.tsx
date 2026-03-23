import { useState, useRef, useEffect } from 'react';
import { Store } from '../types';

interface StoreFilterBarProps {
  stores: Store[];
  activeStoreId: string | null;
  onFilterChange: (storeId: string | null) => void;
  onRename: (storeId: string, name: string) => void;
  onDelete: (storeId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

export function StoreFilterBar({ stores, activeStoreId, onFilterChange, onRename, onDelete, onReorder }: StoreFilterBarProps) {
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

  // Double-tap tracking for edit popover
  const lastTapRef = useRef<{ storeId: string; time: number } | null>(null);

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

  const findDropIndex = (clientX: number): number => {
    const rects = chipRectsRef.current;
    for (let i = 0; i < rects.length; i++) {
      const mid = rects[i].left + rects[i].width / 2;
      if (clientX < mid) return i;
    }
    return rects.length - 1;
  };

  const beginDrag = (index: number, clientX: number) => {
    clearLongPress();
    didLongPressRef.current = true;
    isDraggingRef.current = true;
    dragIndexRef.current = index;
    dragOverIndexRef.current = index;
    setDragIndex(index);
    setDragOverIndex(index);
    dragStartXRef.current = clientX;
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

  const moveGhost = (clientX: number) => {
    if (!ghostRef.current || dragIndexRef.current === null) return;
    const startRect = chipRectsRef.current[dragIndexRef.current];
    if (!startRect) return;
    const dx = clientX - dragStartXRef.current;
    ghostRef.current.style.left = `${startRect.left + dx}px`;

    const overIdx = findDropIndex(clientX);
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
      if (isDraggingRef.current) moveGhost(e.clientX);
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

  const handlePointerDown = (index: number, storeId: string, storeName: string, clientX: number) => {
    didLongPressRef.current = false;
    dragStartXRef.current = clientX;
    longPressTimerRef.current = setTimeout(() => {
      if (stores.length > 1) {
        beginDrag(index, clientX);
      } else {
        // Only 1 store — open edit popover instead
        didLongPressRef.current = true;
        setEditingStoreId(storeId);
        setEditName(storeName);
      }
    }, 300);
  };

  const handlePointerUp = (storeId: string, storeName: string) => {
    clearLongPress();
    if (isDraggingRef.current) {
      finishDrag();
      return;
    }
    if (!didLongPressRef.current) {
      // Check for double-tap → edit popover
      const now = Date.now();
      if (lastTapRef.current && lastTapRef.current.storeId === storeId && now - lastTapRef.current.time < 400) {
        setEditingStoreId(storeId);
        setEditName(storeName);
        lastTapRef.current = null;
        return;
      }
      lastTapRef.current = { storeId, time: now };
      // Single tap → toggle filter
      onFilterChange(activeStoreId === storeId ? null : storeId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDraggingRef.current) return; // document listener handles it
    // Cancel long-press if moved too far before it fires
    if (longPressTimerRef.current) {
      const dx = Math.abs(e.clientX - dragStartXRef.current);
      if (dx > 10) clearLongPress();
    }
  };

  const handlePointerLeave = () => {
    if (!isDraggingRef.current) clearLongPress();
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
      if (activeStoreId === editingStoreId) onFilterChange(null);
    }
    setEditingStoreId(null);
  };

  // Compute chip shifts during drag
  const getShift = (index: number): number => {
    if (dragIndex === null || dragOverIndex === null || dragIndex === dragOverIndex) return 0;
    if (index === dragIndex) return 0; // dragged chip is hidden via opacity
    // Items between dragIndex and dragOverIndex shift
    if (dragIndex < dragOverIndex) {
      // Dragging right: items in (dragIndex, dragOverIndex] shift left
      if (index > dragIndex && index <= dragOverIndex) return -1;
    } else {
      // Dragging left: items in [dragOverIndex, dragIndex) shift right
      if (index >= dragOverIndex && index < dragIndex) return 1;
    }
    return 0;
  };

  if (stores.length === 0) return null;

  return (
    <div className="relative">
      <div ref={containerRef} className="flex gap-2 overflow-x-auto pb-2 px-1 -mx-1 scrollbar-hide">
        {stores.map((store, i) => {
          const shift = getShift(i);
          const isDragged = dragIndex === i;
          let shiftPx = 0;
          if (shift !== 0 && chipRectsRef.current.length > 0 && dragIndex !== null) {
            // Shift by the width of the dragged chip + gap
            const draggedRect = chipRectsRef.current[dragIndex];
            if (draggedRect) shiftPx = shift * (draggedRect.width + 8);
          }

          return (
            <button
              key={store.id}
              data-chip-index={i}
              onPointerDown={(e) => handlePointerDown(i, store.id, store.name, e.clientX)}
              onPointerUp={() => handlePointerUp(store.id, store.name)}
              onPointerMove={handlePointerMove}
              onPointerLeave={handlePointerLeave}
              style={{
                opacity: isDragged ? 0.3 : 1,
                transform: shiftPx ? `translateX(${shiftPx}px)` : undefined,
                transition: dragIndex !== null ? 'transform 200ms ease-out, opacity 200ms' : undefined,
              }}
              className={`
                flex-shrink-0 px-3 py-1 rounded-full text-sm font-medium transition-colors select-none touch-none
                ${activeStoreId === store.id
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }
              `}
            >
              {store.name}
            </button>
          );
        })}
      </div>

      {editingStoreId && (
        <div className="absolute top-full left-0 right-0 mt-1 z-50">
          <div className="bg-white dark:bg-gray-800 border dark:border-gray-600 rounded-lg shadow-lg p-3 mx-2">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRename(); if (e.key === 'Escape') setEditingStoreId(null); }}
              autoFocus
              className="w-full text-sm px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white mb-2"
            />
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
          </div>
        </div>
      )}
    </div>
  );
}
