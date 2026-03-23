import { useState, useRef } from 'react';
import { Store } from '../types';

interface StoreFilterBarProps {
  stores: Store[];
  activeStoreId: string | null;
  onFilterChange: (storeId: string | null) => void;
  onRename: (storeId: string, name: string) => void;
  onDelete: (storeId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

export function StoreFilterBar({ stores, activeStoreId, onFilterChange, onRename, onDelete, onReorder: _onReorder }: StoreFilterBarProps) {
  const [editingStoreId, setEditingStoreId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPressRef = useRef(false);

  if (stores.length === 0) return null;

  const handlePointerDown = (storeId: string, storeName: string) => {
    didLongPressRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      didLongPressRef.current = true;
      setEditingStoreId(storeId);
      setEditName(storeName);
    }, 500);
  };

  const handlePointerUp = (storeId: string) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (!didLongPressRef.current) {
      onFilterChange(activeStoreId === storeId ? null : storeId);
    }
  };

  const handlePointerLeave = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
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
      if (activeStoreId === editingStoreId) onFilterChange(null);
    }
    setEditingStoreId(null);
  };

  return (
    <div className="relative">
      <div className="flex gap-2 overflow-x-auto pb-2 px-1 -mx-1 scrollbar-hide">
        {stores.map(store => (
          <button
            key={store.id}
            onPointerDown={() => handlePointerDown(store.id, store.name)}
            onPointerUp={() => handlePointerUp(store.id)}
            onPointerLeave={handlePointerLeave}
            className={`
              flex-shrink-0 px-3 py-1 rounded-full text-sm font-medium transition-colors select-none
              ${activeStoreId === store.id
                ? 'bg-blue-500 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }
            `}
          >
            {store.name}
          </button>
        ))}
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
