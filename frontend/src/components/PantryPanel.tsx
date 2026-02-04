import { FormEvent, useState } from 'react';
import { usePantry } from '../hooks/usePantry';

export function PantryPanel() {
  const { items, addItem, updateItem, removeItem, adjustQuantity } = usePantry();
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(quantity);
    addItem({
      name,
      quantity: Number.isFinite(parsed) ? parsed : 1,
    });
    setName('');
    setQuantity('1');
  };

  return (
    <section className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Pantry</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">Track what you already have on hand.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="px-4 py-4 border-b border-gray-200 dark:border-gray-700 grid gap-3 grid-cols-[3fr_1fr_auto]">
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Item</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Meatballs"
            className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            required
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400">Qty</label>
          <input
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            type="number"
            min="0"
            step="1"
            className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
          />
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            className="w-full rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2"
          >
            Add
          </button>
        </div>
      </form>

      <div className="px-4 py-4 space-y-3">
        {items.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No pantry items yet.</p>
        ) : (
          items.map(item => (
            <div key={item.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1 grid gap-2 grid-cols-[2fr_1fr]">
                  <input
                    value={item.name}
                    onChange={(event) => updateItem(item.id, { name: event.target.value })}
                    className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                  />
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={item.quantity}
                    onChange={(event) => updateItem(item.id, { quantity: Number(event.target.value) })}
                    className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 text-sm text-gray-900 dark:text-gray-100"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => adjustQuantity(item.id, -1)}
                    className="rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm text-gray-600 dark:text-gray-300"
                    aria-label={`Decrease ${item.name}`}
                  >
                    -1
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustQuantity(item.id, 1)}
                    className="rounded-md border border-gray-300 dark:border-gray-600 px-2 py-1 text-sm text-gray-600 dark:text-gray-300"
                    aria-label={`Increase ${item.name}`}
                  >
                    +1
                  </button>
                  <button
                    type="button"
                    onClick={() => removeItem(item.id)}
                    className="rounded-md text-sm text-red-500 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
