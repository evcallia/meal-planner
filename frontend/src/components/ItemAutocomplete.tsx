import { useState, useRef, useEffect, useCallback } from 'react';
import { toTitleCase } from '../utils/titleCase';

interface ItemAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect: (itemName: string) => void;
  items: Map<string, string | null>;
  currentListItemNames: Set<string>;
  onDelete: (itemName: string) => void;
  placeholder?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
  testId?: string;
}

export function ItemAutocomplete({
  value,
  onChange,
  onSelect,
  items,
  currentListItemNames,
  onDelete,
  placeholder = 'Item name...',
  inputRef: externalRef,
  className,
  onKeyDown: externalOnKeyDown,
  autoFocus,
  testId,
}: ItemAutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const internalRef = useRef<HTMLInputElement>(null);
  const ref = (externalRef ?? internalRef) as React.RefObject<HTMLInputElement>;
  const containerRef = useRef<HTMLDivElement>(null);

  const query = value.toLowerCase();
  const filtered = Array.from(items.keys())
    .filter(name => !query || name.includes(query))
    .sort((a, b) => a.localeCompare(b));

  const getDisplayName = useCallback((lowercaseName: string) => {
    return toTitleCase(lowercaseName);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const elevatedAncestorsRef = useRef<HTMLElement[]>([]);

  const elevateAncestor = useCallback(() => {
    const ancestors: HTMLElement[] = [];
    // Elevate .glass card for dropdown visibility
    const glass = containerRef.current?.closest('.glass');
    if (glass instanceof HTMLElement) {
      glass.style.zIndex = '20';
      glass.style.position = 'relative';
      ancestors.push(glass);
    }
    // Elevate [data-section-id] wrapper — its transform creates a stacking context
    const sectionWrapper = containerRef.current?.closest('[data-section-id]');
    if (sectionWrapper instanceof HTMLElement) {
      sectionWrapper.style.zIndex = '20';
      sectionWrapper.style.position = 'relative';
      ancestors.push(sectionWrapper);
    }
    elevatedAncestorsRef.current = ancestors;
  }, []);

  const restoreAncestor = useCallback(() => {
    for (const el of elevatedAncestorsRef.current) {
      el.style.zIndex = '';
      el.style.position = '';
    }
    elevatedAncestorsRef.current = [];
  }, []);

  const open = useCallback(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < 200);
    }
    setIsOpen(true);
    elevateAncestor();
  }, [elevateAncestor]);

  const close = useCallback(() => {
    setIsOpen(false);
    restoreAncestor();
  }, [restoreAncestor]);

  useEffect(() => {
    return () => restoreAncestor();
  }, [restoreAncestor]);

  const handleSelect = (lowercaseName: string) => {
    onSelect(getDisplayName(lowercaseName));
    close();
  };

  const handleDelete = (e: React.MouseEvent, lowercaseName: string) => {
    e.stopPropagation();
    onDelete(lowercaseName);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      close();
    } else if ((e.key === 'Enter' || e.key === 'Tab') && isOpen && filtered.length > 0 && value.trim()) {
      e.preventDefault();
      handleSelect(filtered[0]);
      return;
    }
    externalOnKeyDown?.(e);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={e => { onChange(e.target.value); open(); }}
        onFocus={() => { if (value.trim()) open(); }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        data-testid={testId}
        className={className ?? "flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"}
      />
      {isOpen && filtered.length > 0 && (
        <div className={`absolute z-50 left-0 right-0 glass-menu rounded-lg max-h-40 overflow-y-auto shadow-lg ${openUpward ? 'bottom-full mb-1' : 'mt-1'}`}>
          {filtered.map(name => {
            const displayName = getDisplayName(name);
            const isOnList = currentListItemNames.has(name);
            return (
              <div
                key={name}
                className="flex items-center hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <button
                  onClick={() => handleSelect(name)}
                  className="flex-1 text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-300"
                >
                  {displayName}
                </button>
                {!isOnList && (
                  <button
                    onClick={(e) => handleDelete(e, name)}
                    className="px-2 py-1 mr-1 text-red-400 hover:text-red-600 dark:text-red-500 dark:hover:text-red-400"
                    aria-label={`Delete ${displayName}`}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
