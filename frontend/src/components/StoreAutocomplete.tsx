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
    onSelect(null);
    setQuery('');
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        {selectedStore && !isOpen ? (
          <div className="flex items-center gap-1 text-sm">
            <span className="text-gray-600 dark:text-gray-400">{selectedStore.name}</span>
            <button
              onClick={handleClear}
              aria-label="Remove store"
              className="text-red-400 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 text-sm font-bold ml-1 px-1"
            >
              X
            </button>
            <button
              onClick={() => { open(); setTimeout(() => inputRef.current?.focus(), 0); }}
              className="text-blue-500 text-xs ml-1"
            >
              change
            </button>
          </div>
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); open(); }}
            onFocus={() => open()}
            placeholder="Assign store..."
            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        )}
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
