import { useRef, useCallback } from 'react';
import { autoLinkUrls } from '../utils/autolink';
import { decodeHtmlEntities } from '../utils/html';

interface MealItemProps {
  html: string;
  itemized: boolean;
  onToggle: () => void;
  onTextClick: () => void;
  showHeader: boolean;
  showItemizedColumn?: boolean;
  compact?: boolean;
  lineIndex: number;
  date: string;
  onDragStart?: (date: string, lineIndex: number, html: string) => void;
  onDragEnd?: () => void;
}

export function MealItem({
  html,
  itemized,
  onToggle,
  onTextClick,
  showHeader,
  showItemizedColumn = true,
  compact = false,
  lineIndex,
  date,
  onDragStart,
  onDragEnd,
}: MealItemProps) {
  const decodedHtml = decodeHtmlEntities(html);
  const linkedHtml = autoLinkUrls(decodedHtml);
  const dragRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number; timeout: ReturnType<typeof setTimeout> | null }>({
    x: 0,
    y: 0,
    timeout: null,
  });

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ date, lineIndex, html: decodedHtml }));
      // Set a custom drag image
      if (dragRef.current) {
        const clone = dragRef.current.cloneNode(true) as HTMLDivElement;
        clone.style.position = 'absolute';
        clone.style.top = '-1000px';
        clone.style.opacity = '0.8';
        clone.style.backgroundColor = '#fff';
        clone.style.padding = '8px';
        clone.style.borderRadius = '4px';
        clone.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
        clone.style.maxWidth = '200px';
        document.body.appendChild(clone);
        // Position drag image to the left of cursor (offset by element width)
        const rect = clone.getBoundingClientRect();
        e.dataTransfer.setDragImage(clone, rect.width, 0);
        setTimeout(() => document.body.removeChild(clone), 0);
      }
      onDragStart?.(date, lineIndex, decodedHtml);
    },
    [date, lineIndex, decodedHtml, onDragStart]
  );

  const handleDragEnd = useCallback(() => {
    onDragEnd?.();
  }, [onDragEnd]);

  // Touch-based drag support for mobile
  const handleTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const touch = e.touches[0];
      touchStartRef.current.x = touch.clientX;
      touchStartRef.current.y = touch.clientY;

      // Long press to initiate drag
      touchStartRef.current.timeout = setTimeout(() => {
        onDragStart?.(date, lineIndex, decodedHtml);
        // Trigger haptic feedback if available
        if (navigator.vibrate) {
          navigator.vibrate(50);
        }
      }, 300);
    },
    [date, lineIndex, decodedHtml, onDragStart]
  );

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartRef.current.y);

    // If the user moves their finger, cancel the long press
    if (dx > 10 || dy > 10) {
      if (touchStartRef.current.timeout) {
        clearTimeout(touchStartRef.current.timeout);
        touchStartRef.current.timeout = null;
      }
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (touchStartRef.current.timeout) {
      clearTimeout(touchStartRef.current.timeout);
      touchStartRef.current.timeout = null;
    }
  }, []);

  return (
    <div
      ref={dragRef}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className={`flex items-start ${compact ? 'py-0.5' : 'py-1.5'} ${showItemizedColumn ? 'gap-3' : ''} cursor-grab active:cursor-grabbing`}
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
              transition-colors duration-150
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
        onClick={onTextClick}
        className={`text-gray-800 dark:text-gray-200 leading-snug cursor-text flex-1 ${showHeader && showItemizedColumn ? 'mt-4' : ''} [&_a]:text-blue-600 [&_a]:dark:text-blue-400 [&_a]:underline`}
        dangerouslySetInnerHTML={{ __html: linkedHtml }}
      />
      {/* Drag handle indicator */}
      <div className={`flex-shrink-0 flex items-center opacity-30 hover:opacity-60 transition-opacity ${showHeader && showItemizedColumn ? 'mt-4' : ''}`}>
        <svg className="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
        </svg>
      </div>
    </div>
  );
}
