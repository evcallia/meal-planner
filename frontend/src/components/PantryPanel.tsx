import { useState, useCallback, useRef, useEffect } from 'react';
import { usePantry } from '../hooks/usePantry';
import { PantrySection } from '../types';
import { useDragReorder, computeShiftTransform } from '../hooks/useDragReorder';

export function PantryPanel() {
  const { sections, loading, addSection, deleteSection, addItem, updateItem, adjustQuantity, removeItem, clearAll, reorderSections, reorderItems, renameSection, moveItem } = usePantry();
  const [addingToSection, setAddingToSection] = useState<string | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQty, setNewItemQty] = useState('1');
  const [showClearMenu, setShowClearMenu] = useState(false);
  const [isSectionDragging, setIsSectionDragging] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('meal-planner-pantry-collapsed');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });
  const [isAddingSection, setIsAddingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  const clearMenuRef = useRef<HTMLDivElement>(null);
  const sectionContainerRef = useRef<HTMLDivElement>(null);
  const sectionInputRef = useRef<HTMLInputElement>(null);

  const handleSectionReorder = useCallback((from: number, to: number) => {
    reorderSections(from, to);
  }, [reorderSections]);

  const handleSectionDragStart = useCallback(() => {
    setIsSectionDragging(true);
  }, []);

  const handleSectionDragEnd = useCallback(() => {
    setIsSectionDragging(false);
  }, []);

  const { dragState: sectionDragState, getDragHandlers: getSectionDragHandlers, getHandleMouseDown: getSectionHandleMouseDown } = useDragReorder({
    itemCount: sections.length,
    onReorder: handleSectionReorder,
    containerRef: sectionContainerRef,
    onDragStart: handleSectionDragStart,
    onDragEnd: handleSectionDragEnd,
  });

  const [crossDrag, setCrossDrag] = useState<{
    sourceSectionId: string;
    targetSectionId: string;
    targetIndex: number;
    itemHeight: number;
  } | null>(null);

  const findDropTarget = useCallback((sourceSectionId: string, clientY: number) => {
    if (!sectionContainerRef.current) return null;
    const sectionEls = sectionContainerRef.current.querySelectorAll('[data-section-id]');
    for (const el of sectionEls) {
      const sectionId = (el as HTMLElement).dataset.sectionId;
      if (!sectionId || sectionId === sourceSectionId) continue;
      const rect = el.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        const itemContainer = el.querySelector('[data-item-container]');
        let targetIndex = 0;
        let itemHeight = 36;
        if (itemContainer) {
          const itemEls = itemContainer.querySelectorAll(':scope > [data-drag-index]');
          targetIndex = itemEls.length;
          for (let i = 0; i < itemEls.length; i++) {
            const itemRect = itemEls[i].getBoundingClientRect();
            if (itemRect.height > 0) {
              itemHeight = itemRect.height;
              if (clientY < itemRect.top + itemRect.height / 2) {
                targetIndex = i;
                break;
              }
            }
          }
        }
        return { sectionId, targetIndex, itemHeight };
      }
    }
    return null;
  }, []);

  const handleItemDragMove = useCallback((sourceSectionId: string, _fromIndex: number, clientY: number) => {
    const target = findDropTarget(sourceSectionId, clientY);
    setCrossDrag(prev => {
      if (!target) return prev ? null : prev;
      if (prev?.targetSectionId === target.sectionId && prev?.targetIndex === target.targetIndex) return prev;
      return { sourceSectionId, targetSectionId: target.sectionId, targetIndex: target.targetIndex, itemHeight: target.itemHeight };
    });
  }, [findDropTarget]);

  const handleItemDragEnd = useCallback(() => {
    setCrossDrag(null);
  }, []);

  const handleItemDropOutside = useCallback((sourceSectionId: string, fromIndex: number, clientY: number) => {
    const target = findDropTarget(sourceSectionId, clientY);
    if (target) {
      moveItem(sourceSectionId, fromIndex, target.sectionId, target.targetIndex);
    }
  }, [findDropTarget, moveItem]);

  useEffect(() => {
    if (!showClearMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (clearMenuRef.current && !clearMenuRef.current.contains(e.target as Node)) {
        setShowClearMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showClearMenu]);

  const toggleCollapsed = useCallback((sectionName: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionName)) next.delete(sectionName);
      else next.add(sectionName);
      try { localStorage.setItem('meal-planner-pantry-collapsed', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const handleAddItem = useCallback(async (sectionId: string) => {
    if (!newItemName.trim()) return;
    const qty = parseInt(newItemQty) || 1;
    await addItem(sectionId, newItemName.trim(), qty);
    setNewItemName('');
    setNewItemQty('1');
    setAddingToSection(null);
  }, [newItemName, newItemQty, addItem]);

  const handleClearAll = useCallback(async () => {
    setShowClearMenu(false);
    await clearAll();
  }, [clearAll]);

  const handleAddSection = useCallback(async () => {
    if (!newSectionName.trim()) return;
    await addSection(newSectionName.trim());
    setNewSectionName('');
    setIsAddingSection(false);
  }, [newSectionName, addSection]);

  useEffect(() => {
    if (isAddingSection && sectionInputRef.current) {
      sectionInputRef.current.focus();
    }
  }, [isAddingSection]);

  const hasItems = sections.length > 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="pantry-loading">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center gap-2">
        {isAddingSection ? (
          <div className="flex-1 flex items-center gap-2 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 px-3 py-2">
            <input
              ref={sectionInputRef}
              type="text"
              value={newSectionName}
              onChange={e => setNewSectionName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAddSection();
                if (e.key === 'Escape') { setNewSectionName(''); setIsAddingSection(false); }
              }}
              placeholder="Section name..."
              className="flex-1 bg-transparent text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none text-sm"
            />
            <button
              onClick={handleAddSection}
              className="text-blue-500 hover:text-blue-600 text-sm font-medium flex-shrink-0"
            >
              Add
            </button>
            <button
              onClick={() => { setNewSectionName(''); setIsAddingSection(false); }}
              className="text-gray-400 hover:text-gray-600 text-sm flex-shrink-0"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setIsAddingSection(true)}
            className="px-3 py-2 text-sm text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            + Add section
          </button>
        )}
        {hasItems && !isAddingSection && (
          <>
            <div className="flex-1" />
            {/* Clear menu */}
            <div className="relative" ref={clearMenuRef}>
              <button
                onClick={() => setShowClearMenu(prev => !prev)}
                className="p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700 transition-colors"
                aria-label="Clear options"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
              </button>
              {showClearMenu && (
                <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-20 min-w-[180px]">
                  <button
                    onClick={handleClearAll}
                    className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    Clear all items
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {!hasItems && !isAddingSection && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">No pantry items yet. Add a section to get started.</p>
        </div>
      )}

      {/* Sections */}
      <div ref={sectionContainerRef}>
        {sections.map((section, sectionIndex) => {
          const isBeingDragged = sectionDragState.isDragging && sectionDragState.dragIndex === sectionIndex;
          const shiftStyle = computeShiftTransform(sectionIndex, sectionDragState);
          return (
            <div
              key={section.id}
              data-drag-index={sectionIndex}
              data-section-id={section.id}
              className={sectionIndex > 0 ? 'mt-4' : ''}
              style={{
                opacity: isBeingDragged ? 0.3 : 1,
                transform: shiftStyle || undefined,
                transition: sectionDragState.isDragging ? 'transform 200ms ease-out, opacity 200ms' : undefined,
              }}
            >
              <PantrySectionCard
                section={section}
                sectionDragHandlers={getSectionDragHandlers(sectionIndex)}
                sectionHandleMouseDown={getSectionHandleMouseDown(sectionIndex)}
                isSectionDragging={isSectionDragging}
                isCollapsed={collapsedSections.has(section.name)}
                onToggleCollapse={() => toggleCollapsed(section.name)}
                onUpdateItem={updateItem}
                onAdjustQuantity={adjustQuantity}
                onDelete={removeItem}
                onDeleteSection={deleteSection}
                onRenameSection={renameSection}
                onReorderItems={(from, to) => reorderItems(section.id, from, to)}
                onItemDropOutside={(fromIndex, clientY) => handleItemDropOutside(section.id, fromIndex, clientY)}
                onItemDragMove={(fromIndex, clientY) => handleItemDragMove(section.id, fromIndex, clientY)}
                onItemDragEnd={handleItemDragEnd}
                crossDropTarget={crossDrag?.targetSectionId === section.id ? { targetIndex: crossDrag.targetIndex, itemHeight: crossDrag.itemHeight } : null}
                addingToSection={addingToSection}
                onStartAdd={setAddingToSection}
                newItemName={newItemName}
                onNewItemNameChange={setNewItemName}
                newItemQty={newItemQty}
                onNewItemQtyChange={setNewItemQty}
                onAddItem={handleAddItem}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PantrySectionCardProps {
  section: PantrySection;
  sectionDragHandlers: ReturnType<ReturnType<typeof useDragReorder>['getDragHandlers']>;
  sectionHandleMouseDown: (e: React.MouseEvent) => void;
  isSectionDragging: boolean;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onUpdateItem: (id: string, updates: { name?: string; quantity?: number }) => void;
  onAdjustQuantity: (id: string, delta: number) => void;
  onDelete: (id: string) => void;
  onDeleteSection: (sectionId: string) => void;
  onRenameSection: (sectionId: string, newName: string) => void;
  onReorderItems: (fromIndex: number, toIndex: number) => void;
  onItemDropOutside: (fromIndex: number, clientY: number) => void;
  onItemDragMove: (fromIndex: number, clientY: number) => void;
  onItemDragEnd: () => void;
  crossDropTarget: { targetIndex: number; itemHeight: number } | null;
  addingToSection: string | null;
  onStartAdd: (sectionId: string | null) => void;
  newItemName: string;
  onNewItemNameChange: (name: string) => void;
  newItemQty: string;
  onNewItemQtyChange: (qty: string) => void;
  onAddItem: (sectionId: string) => void;
}

function PantrySectionCard({
  section,
  sectionDragHandlers,
  sectionHandleMouseDown,
  isSectionDragging,
  isCollapsed,
  onToggleCollapse,
  onUpdateItem,
  onAdjustQuantity,
  onDelete,
  onDeleteSection,
  onRenameSection,
  onReorderItems,
  onItemDropOutside,
  onItemDragMove,
  onItemDragEnd,
  crossDropTarget,
  addingToSection,
  onStartAdd,
  newItemName,
  onNewItemNameChange,
  newItemQty,
  onNewItemQtyChange,
  onAddItem,
}: PantrySectionCardProps) {
  const itemContainerRef = useRef<HTMLDivElement>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState(section.name);
  const headerInputRef = useRef<HTMLInputElement>(null);

  const commitRename = useCallback(() => {
    const trimmed = editNameValue.trim();
    if (trimmed && trimmed !== section.name) {
      onRenameSection(section.id, trimmed);
    }
    setIsEditingName(false);
  }, [editNameValue, section.id, section.name, onRenameSection]);

  useEffect(() => {
    if (isEditingName && headerInputRef.current) {
      headerInputRef.current.focus();
      headerInputRef.current.select();
    }
  }, [isEditingName]);

  const { dragState: itemDragState, getDragHandlers: getItemDragHandlers, getHandleMouseDown: getItemHandleMouseDown } = useDragReorder({
    itemCount: section.items.length,
    onReorder: onReorderItems,
    containerRef: itemContainerRef,
    onDropOutside: onItemDropOutside,
    onDragMove: onItemDragMove,
    onDragEnd: onItemDragEnd,
  });

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Section Header */}
      <div
        className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-600 flex items-center justify-between px-4 py-2 touch-none"
        {...sectionDragHandlers}
      >
        <div className="flex items-center gap-2">
          <svg
            className="drag-handle w-4 h-4 text-gray-400 dark:text-gray-500 flex-shrink-0 cursor-grab active:cursor-grabbing"
            fill="currentColor"
            viewBox="0 0 20 20"
            onMouseDown={sectionHandleMouseDown}
          >
            <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
          </svg>
          {isEditingName ? (
            <input
              ref={headerInputRef}
              type="text"
              value={editNameValue}
              onChange={e => setEditNameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setEditNameValue(section.name); setIsEditingName(false); }
              }}
              onBlur={commitRename}
              className="font-semibold text-sm bg-white dark:bg-gray-700 border border-blue-400 dark:border-blue-500 rounded px-1.5 py-0.5 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 min-w-0"
            />
          ) : (
            <h3
              className="font-semibold text-gray-900 dark:text-gray-100 text-sm cursor-pointer"
              onClick={(e) => { e.stopPropagation(); setEditNameValue(section.name); setIsEditingName(true); }}
            >
              {section.name}
            </h3>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
            className="flex items-center gap-1 text-gray-400 dark:text-gray-500 text-xs hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            {section.items.length} item{section.items.length !== 1 ? 's' : ''}
            <svg
              className={`w-3.5 h-3.5 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDeleteSection(section.id); }}
            className="ml-1 text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 transition-colors"
            aria-label={`Delete section ${section.name}`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Items */}
      <div style={{ display: (isSectionDragging || isCollapsed) ? 'none' : undefined }}>
        <div className="py-1" ref={itemContainerRef} data-item-container>
          {section.items.map((item, index) => {
            const isBeingDragged = itemDragState.isDragging && itemDragState.dragIndex === index;
            const internalShift = computeShiftTransform(index, itemDragState);
            const crossShift = crossDropTarget && index >= crossDropTarget.targetIndex
              ? `translateY(${crossDropTarget.itemHeight}px)` : '';
            const shiftStyle = internalShift || crossShift;
            const isAnimating = itemDragState.isDragging || !!crossDropTarget;
            return (
              <div
                key={item.id}
                data-drag-index={index}
                style={{
                  opacity: isBeingDragged ? 0.3 : 1,
                  transform: shiftStyle || undefined,
                  transition: isAnimating ? 'transform 200ms ease-out, opacity 200ms' : undefined,
                }}
              >
                <PantryItemRow
                  item={item}
                  onUpdate={onUpdateItem}
                  onAdjustQuantity={onAdjustQuantity}
                  onDelete={onDelete}
                  dragHandlers={getItemDragHandlers(index)}
                  handleMouseDown={getItemHandleMouseDown(index)}
                  isDragging={itemDragState.isDragging}
                />
              </div>
            );
          })}

          {/* Spacer for cross-section drag target */}
          <div style={{
            height: crossDropTarget ? crossDropTarget.itemHeight : 0,
            transition: 'height 200ms ease-out',
          }} />

          {/* Add item inline */}
          {addingToSection === section.id ? (
            <div className="flex items-center gap-2 px-4 py-2">
              <input
                type="text"
                value={newItemName}
                onChange={e => onNewItemNameChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onAddItem(section.id);
                  if (e.key === 'Escape') onStartAdd(null);
                }}
                placeholder="Item name..."
                autoFocus
                className="flex-1 bg-transparent border-b border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 text-sm py-1"
              />
              <input
                type="number"
                min="0"
                step="1"
                value={newItemQty}
                onChange={e => onNewItemQtyChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') onAddItem(section.id);
                }}
                className="w-12 bg-transparent border-b border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:outline-none focus:border-blue-500 text-sm py-1 text-center"
              />
              <button
                onClick={() => onAddItem(section.id)}
                className="text-blue-500 hover:text-blue-600 text-sm font-medium"
              >
                Add
              </button>
              <button
                onClick={() => onStartAdd(null)}
                className="text-gray-400 hover:text-gray-600 text-sm"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => onStartAdd(section.id)}
              className="w-full text-left text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors px-4 py-1.5 text-sm"
            >
              + Add item
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface PantryItemRowProps {
  item: PantrySection['items'][number];
  onUpdate: (id: string, updates: { name?: string; quantity?: number }) => void;
  onAdjustQuantity: (id: string, delta: number) => void;
  onDelete: (id: string) => void;
  dragHandlers?: ReturnType<ReturnType<typeof useDragReorder>['getDragHandlers']>;
  handleMouseDown?: (e: React.MouseEvent) => void;
  isDragging?: boolean;
}

function PantryItemRow({ item, onUpdate, onAdjustQuantity, onDelete, dragHandlers, handleMouseDown, isDragging }: PantryItemRowProps) {
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwipeRevealed, setIsSwipeRevealed] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(item.name);
  const touchStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const swipeModeRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const SWIPE_THRESHOLD = 50;
  const SWIPE_MAX = 80;

  const startEditing = useCallback(() => {
    setEditName(item.name);
    setIsEditing(true);
  }, [item.name]);

  const commitEdit = useCallback(() => {
    const trimmedName = editName.trim();
    if (trimmedName && trimmedName !== item.name) {
      onUpdate(item.id, { name: trimmedName });
    }
    setIsEditing(false);
  }, [editName, item.id, item.name, onUpdate]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditName(item.name);
  }, [item.name]);

  useEffect(() => {
    if (isEditing && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditing]);

  if (isEditing) {
    return (
      <div className="flex items-center gap-2 px-4 py-1.5 bg-blue-50 dark:bg-blue-900/20">
        <input
          ref={nameInputRef}
          type="text"
          value={editName}
          onChange={e => setEditName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') cancelEdit();
          }}
          className="flex-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-sm py-0.5 px-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={commitEdit}
          className="text-blue-500 hover:text-blue-600 text-sm font-medium flex-shrink-0"
        >
          Save
        </button>
        <button
          onClick={cancelEdit}
          className="text-gray-400 hover:text-gray-600 text-sm flex-shrink-0"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden">
      {swipeOffset > 0 && (
        <div className="absolute inset-y-0 right-0 flex items-center" style={{ width: SWIPE_MAX }}>
          <button
            type="button"
            data-delete-action
            onClick={() => {
              setSwipeOffset(0);
              setIsSwipeRevealed(false);
              onDelete(item.id);
            }}
            className="w-full h-full bg-red-500 text-white font-medium text-sm flex items-center justify-center"
          >
            Delete
          </button>
        </div>
      )}
      <div
        className="flex items-center gap-2 group px-4 py-1.5"
        style={{
          transform: swipeOffset > 0 ? `translateX(-${swipeOffset}px)` : undefined,
          transition: swipeModeRef.current ? undefined : 'transform 200ms ease-out',
        }}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          touchStartRef.current = { x: touch.clientX, y: touch.clientY };
          swipeModeRef.current = false;
          if (isSwipeRevealed) {
            const target = e.target as HTMLElement;
            if (!target.closest('[data-delete-action]')) {
              setIsSwipeRevealed(false);
              setSwipeOffset(0);
            }
          }
          dragHandlers?.onTouchStart(e);
        }}
        onTouchMove={(e) => {
          if (isDragging) {
            dragHandlers?.onTouchMove(e);
            return;
          }
          if (isSwipeRevealed) return;
          const touch = e.touches[0];
          const dx = touch.clientX - touchStartRef.current.x;
          const dy = Math.abs(touch.clientY - touchStartRef.current.y);
          const absDx = Math.abs(dx);
          if (!swipeModeRef.current && absDx > 15 && dx < 0 && absDx > dy * 1.5) {
            swipeModeRef.current = true;
          }
          if (swipeModeRef.current) {
            e.preventDefault();
            setSwipeOffset(Math.min(Math.max(-dx, 0), SWIPE_MAX));
          }
          dragHandlers?.onTouchMove(e);
        }}
        onTouchEnd={() => {
          dragHandlers?.onTouchEnd();
          if (swipeModeRef.current) {
            if (swipeOffset >= SWIPE_THRESHOLD) {
              setSwipeOffset(SWIPE_MAX);
              setIsSwipeRevealed(true);
            } else {
              setSwipeOffset(0);
            }
            swipeModeRef.current = false;
          }
        }}
      >
        {/* Drag handle */}
        {dragHandlers && handleMouseDown && (
          <svg
            className="drag-handle w-3.5 h-3.5 text-gray-300 dark:text-gray-600 flex-shrink-0 cursor-grab active:cursor-grabbing"
            fill="currentColor"
            viewBox="0 0 20 20"
            onMouseDown={handleMouseDown}
          >
            <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
          </svg>
        )}

        {/* Item name — tap to edit */}
        <span
          className="flex-1 min-w-0 break-words cursor-pointer text-sm text-gray-800 dark:text-gray-200"
          onClick={startEditing}
        >
          {item.name}
        </span>

        {/* Quantity controls */}
        <button
          type="button"
          onClick={() => onAdjustQuantity(item.id, -1)}
          className="w-7 h-7 flex items-center justify-center rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-bold flex-shrink-0"
          aria-label={`Decrease ${item.name}`}
        >
          −
        </button>
        <span className="w-8 text-center text-sm font-medium text-gray-900 dark:text-gray-100 flex-shrink-0">
          {item.quantity}
        </span>
        <button
          type="button"
          onClick={() => onAdjustQuantity(item.id, 1)}
          className="w-7 h-7 flex items-center justify-center rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 text-sm font-bold flex-shrink-0"
          aria-label={`Increase ${item.name}`}
        >
          +
        </button>

        {/* Desktop delete button */}
        <button
          type="button"
          onClick={() => onDelete(item.id)}
          className="flex-shrink-0 flex items-center ml-1 text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400"
          aria-label={`Remove ${item.name}`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
