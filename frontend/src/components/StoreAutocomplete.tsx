import { useState, useRef, useEffect } from 'react';
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
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedStore = stores.find(s => s.id === selectedStoreId);
  const filtered = query
    ? stores.filter(s => s.name.toLowerCase().includes(query.toLowerCase()))
    : stores;
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

  const handleSelect = (store: Store) => {
    onSelect(store.id);
    setQuery('');
    setIsOpen(false);
  };

  const handleCreate = async () => {
    if (!query.trim()) return;
    const store = await onCreate(query.trim());
    if (store) {
      onSelect(store.id);
      setQuery('');
      setIsOpen(false);
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
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs ml-1"
            >
              ✕
            </button>
            <button
              onClick={() => { setIsOpen(true); setTimeout(() => inputRef.current?.focus(), 0); }}
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
            onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
            onFocus={() => setIsOpen(true)}
            placeholder="Assign store..."
            className="w-full text-sm px-2 py-1 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
          />
        )}
      </div>
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-gray-800 border dark:border-gray-600 rounded shadow-lg max-h-40 overflow-y-auto">
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
