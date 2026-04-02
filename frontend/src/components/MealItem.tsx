import { useState, useRef, useCallback } from 'react';
import { autoLinkUrls } from '../utils/autolink';
import { decodeHtmlEntities } from '../utils/html';
import { sanitizeHtml } from '../utils/sanitize';

interface MealItemProps {
  html: string;
  itemized: boolean;
  onToggle: () => void;
  onTextClick: () => void;
  onDelete?: () => void;
  mealTargetDate?: string;
  showHeader: boolean;
  showItemizedColumn?: boolean;
  compact?: boolean;
  bgClass?: string;
  lineIndex: number;
  date: string;
  dragHandleMouseDown?: (e: React.MouseEvent) => void;
}

const SWIPE_THRESHOLD = 50;
const SWIPE_MAX = 80;

export function MealItem({
  html,
  itemized,
  onToggle,
  onTextClick,
  onDelete,
  mealTargetDate,
  showHeader,
  showItemizedColumn = true,
  compact = false,
  bgClass = 'bg-white dark:bg-gray-800',
  lineIndex,
  date,
  dragHandleMouseDown,
}: MealItemProps) {
  const decodedHtml = decodeHtmlEntities(html);
  const linkedHtml = sanitizeHtml(autoLinkUrls(decodedHtml));
  const dragRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number; timeout: ReturnType<typeof setTimeout> | null }>({
    x: 0,
    y: 0,
    timeout: null,
  });
  const swipeModeRef = useRef(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwipeRevealed, setIsSwipeRevealed] = useState(false);

  // Touch-based swipe-to-delete support for mobile
  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const touch = e.touches[0];
      touchStartRef.current.x = touch.clientX;
      touchStartRef.current.y = touch.clientY;
      swipeModeRef.current = false;

      // If already revealed, close it on any new touch (unless it's on the delete button)
      if (isSwipeRevealed) {
        const target = e.target as HTMLElement;
        if (!target.closest('[data-delete-action]')) {
          setIsSwipeRevealed(false);
          setSwipeOffset(0);
        }
        return;
      }
    },
    [isSwipeRevealed]
  );

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (isSwipeRevealed) return;

    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = Math.abs(touch.clientY - touchStartRef.current.y);
    const absDx = Math.abs(dx);

    // Cancel long-press drag if moved
    if (absDx > 10 || dy > 10) {
      if (touchStartRef.current.timeout) {
        clearTimeout(touchStartRef.current.timeout);
        touchStartRef.current.timeout = null;
      }
    }

    // Enter swipe mode if horizontal left movement dominates
    if (!swipeModeRef.current && absDx > 15 && dx < 0 && absDx > dy * 1.5 && onDelete) {
      swipeModeRef.current = true;
    }

    if (swipeModeRef.current) {
      e.preventDefault();
      const offset = Math.min(Math.max(-dx, 0), SWIPE_MAX);
      setSwipeOffset(offset);
    }
  }, [isSwipeRevealed, onDelete]);

  const handleTouchEnd = useCallback(() => {
    if (touchStartRef.current.timeout) {
      clearTimeout(touchStartRef.current.timeout);
      touchStartRef.current.timeout = null;
    }

    if (swipeModeRef.current) {
      if (swipeOffset >= SWIPE_THRESHOLD) {
        setSwipeOffset(SWIPE_MAX);
        setIsSwipeRevealed(true);
      } else {
        setSwipeOffset(0);
      }
      swipeModeRef.current = false;
    }
  }, [swipeOffset]);

  const handleSwipeDelete = useCallback(() => {
    setSwipeOffset(0);
    setIsSwipeRevealed(false);
    onDelete?.();
  }, [onDelete]);

  return (
    <div className={`relative overflow-hidden ${bgClass}`}>
      {/* Delete action backdrop (mobile swipe) */}
      {onDelete && swipeOffset > 0 && (
        <div className="absolute inset-y-0 right-0 flex items-center" style={{ width: SWIPE_MAX }}>
          <button
            type="button"
            data-delete-action
            onClick={handleSwipeDelete}
            className="w-full h-full bg-red-500 text-white font-medium text-sm flex items-center justify-center"
          >
            Delete
          </button>
        </div>
      )}
      <div
        ref={dragRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        className={`group flex items-start ${compact ? 'py-0.5' : 'py-1.5'} ${showItemizedColumn ? 'gap-3' : ''} ${bgClass}`}
        style={{
          transform: swipeOffset > 0 ? `translateX(-${swipeOffset}px)` : undefined,
          transition: swipeModeRef.current ? undefined : 'transform 200ms ease-out',
        }}
      >
        {showItemizedColumn && (
          <div className="flex-shrink-0 flex flex-col items-center w-12">
            {showHeader && (
              <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wide mb-1">
                Itemized
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className={`
                w-5 h-5 rounded border-2 flex items-center justify-center
                transition-colors duration-150 ${!showHeader ? 'mt-0.5' : ''}
                ${itemized
                  ? 'bg-green-500 border-green-500 dark:bg-green-600 dark:border-green-600'
                  : 'border-gray-300 hover:border-gray-400 dark:border-gray-600 dark:hover:border-gray-500'
                }
              `}
            >
              {itemized && (
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          </div>
        )}
        <span
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('a')) {
              onTextClick();
            }
          }}
          data-meal-target={mealTargetDate}
          className={`text-gray-800 dark:text-gray-200 leading-snug cursor-text flex-1 min-w-0 break-words overflow-wrap-anywhere ${showHeader && showItemizedColumn ? 'mt-4' : ''} [&_a]:text-blue-600 [&_a]:dark:text-blue-400 [&_a]:underline [&_a]:break-all [&_p]:m-0`}
          dangerouslySetInnerHTML={{ __html: linkedHtml }}
        />
        {/* Drag handle indicator */}
        <div
          onMouseDown={dragHandleMouseDown}
          className={`flex-shrink-0 flex items-center opacity-30 hover:opacity-60 transition-opacity ml-1 cursor-grab active:cursor-grabbing ${showHeader && showItemizedColumn ? 'mt-4' : ''}`}
        >
          <svg className="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
            <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
          </svg>
        </div>
        {/* Desktop delete button - only visible on hover-capable devices */}
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className={`hover-delete-btn flex-shrink-0 items-center ml-1 text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400 ${showHeader && showItemizedColumn ? 'mt-4' : ''}`}
            aria-label="Delete meal"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
