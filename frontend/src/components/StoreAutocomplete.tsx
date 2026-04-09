import { useState, useRef, useEffect, useCallback } from 'react';
import { Store } from '../types';

interface StoreAutocompleteProps {
  stores: Store[];
  selectedStoreId: string | null;
  onSelect: (storeId: string | null) => void;
  onCreate: (name: string) => Promise<Store | null>;
}

export function StoreAutocomplete({ stores, selectedStoreId, onSelect, onCreate }: StoreAutocompleteProps) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedStore = stores.find(s => s.id === selectedStoreId);
  const filtered = (query
    ? stores.filter(s => s.name.toLowerCase().includes(query.toLowerCase()))
    : stores
  ).slice().sort((a, b) => a.name.localeCompare(b.name));
  const exactMatch = stores.some(s => s.name.toLowerCase() === query.toLowerCase());

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Track the elevated ancestor so cleanup works even after unmount (when containerRef is null)
  const elevatedAncestorRef = useRef<HTMLElement | null>(null);

  const elevateAncestor = useCallback(() => {
    const el = containerRef.current?.closest('.glass');
    if (el instanceof HTMLElement) {
      el.style.zIndex = '20';
      el.style.position = 'relative';
      elevatedAncestorRef.current = el;
    }
  }, []);

  const restoreAncestor = useCallback(() => {
    const el = elevatedAncestorRef.current;
    if (el) {
      el.style.zIndex = '';
      el.style.position = '';
      elevatedAncestorRef.current = null;
    }
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

  // Clean up z-index on unmount
  useEffect(() => {
    return () => restoreAncestor();
  }, [restoreAncestor]);

  const handleSelect = (store: Store) => {
    onSelect(store.id);
    setQuery('');
    close();
  };

  const handleCreate = async () => {
    if (!query.trim()) return;
    const store = await onCreate(query.trim());
    if (store) {
      onSelect(store.id);
      setQuery('');
      close();
    }
  };

  const handleClear = () => {
    setQuery('');
    open();
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={isOpen ? query : (selectedStore?.name ?? '')}
            onChange={(e) => { setQuery(e.target.value); open(); }}
            onFocus={() => { setQuery(selectedStore?.name ?? ''); open(); }}
            placeholder="Assign store..."
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {selectedStore && !isOpen && (
            <button
              onClick={handleClear}
              aria-label="Remove store"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {isOpen && (
        <div className={`absolute z-50 w-full glass-menu rounded max-h-40 overflow-y-auto ${openUpward ? 'bottom-full mb-1' : 'mt-1'}`}>
          {filtered.map(store => (
            <button
              key={store.id}
              onClick={() => handleSelect(store)}
              className="w-full text-left px-3 py-2 text-sm text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {store.name}
            </button>
          ))}
          {query.trim() && !exactMatch && (
            <button
              onClick={handleCreate}
              className="w-full text-left px-3 py-2 text-sm text-blue-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Create "{query.trim()}"
            </button>
          )}
          {filtered.length === 0 && !query.trim() && (
            <div className="px-3 py-2 text-sm text-gray-400">No stores yet</div>
          )}
        </div>
      )}
    </div>
  );
}
