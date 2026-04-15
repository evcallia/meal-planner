# Grocery Item Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add autocomplete to the grocery item name input so users can quickly select previously-used items, with the ability to delete unused items from the cache.

**Architecture:** New `ItemAutocomplete` component (modeled on `StoreAutocomplete`) used in both the quick-add form and per-section inline add. New `DELETE /api/grocery/item-defaults/{item_name}` backend endpoint. New `deleteLocalItemDefault` IDB function.

**Tech Stack:** React, TypeScript, Dexie (IDB), FastAPI, SQLAlchemy

---

### Task 1: Backend — DELETE item-defaults endpoint

**Files:**
- Modify: `backend/app/routers/grocery.py:44-49` (add endpoint after existing `list_item_defaults`)
- Test: `backend/tests/test_grocery.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_grocery.py`:

```python
def test_delete_item_default(authenticated_client, db_session):
    """DELETE /api/grocery/item-defaults/{item_name} removes the default."""
    from app.models import ItemDefault
    # Seed a default
    d = ItemDefault(item_name="sweet potato", store_id=None)
    db_session.add(d)
    db_session.commit()

    resp = authenticated_client.delete("/api/grocery/item-defaults/sweet%20potato")
    assert resp.status_code == 204

    # Confirm deleted
    assert db_session.query(ItemDefault).filter_by(item_name="sweet potato").first() is None


def test_delete_item_default_idempotent(authenticated_client):
    """DELETE returns 204 even when item doesn't exist."""
    resp = authenticated_client.delete("/api/grocery/item-defaults/nonexistent")
    assert resp.status_code == 204
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_grocery.py::test_delete_item_default backend/tests/test_grocery.py::test_delete_item_default_idempotent -v 2>&1`
Expected: FAIL — 404 or 405 (no route)

- [ ] **Step 3: Implement the endpoint**

In `backend/app/routers/grocery.py`, add after the existing `list_item_defaults` function (after line 49):

```python
@router.delete("/item-defaults/{item_name}", status_code=204)
async def delete_item_default(
    item_name: str,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    db.query(ItemDefault).filter(
        func.lower(ItemDefault.item_name) == item_name.lower()
    ).delete(synchronize_session=False)
    db.commit()
```

Make sure `func` is imported from `sqlalchemy` at the top of the file (check if it already is).

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_grocery.py::test_delete_item_default backend/tests/test_grocery.py::test_delete_item_default_idempotent -v 2>&1`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add backend/app/routers/grocery.py backend/tests/test_grocery.py
git commit -m "feat: add DELETE /api/grocery/item-defaults endpoint"
```

---

### Task 2: Frontend — API client + IDB delete function

**Files:**
- Modify: `frontend/src/api/client.ts:280-282` (add `deleteItemDefault` after `getItemDefaults`)
- Modify: `frontend/src/db.ts:553-555` (add `deleteLocalItemDefault` after `putLocalItemDefault`)

- [ ] **Step 1: Add `deleteItemDefault` to API client**

In `frontend/src/api/client.ts`, add after the `getItemDefaults` function (after line 282):

```typescript
export async function deleteItemDefault(itemName: string): Promise<void> {
  await fetchAPI(`/grocery/item-defaults/${encodeURIComponent(itemName)}`, {
    method: 'DELETE',
  });
}
```

- [ ] **Step 2: Add `deleteLocalItemDefault` to db.ts**

In `frontend/src/db.ts`, add after the `putLocalItemDefault` function (after line 555):

```typescript
export async function deleteLocalItemDefault(itemName: string) {
  await db.itemDefaults.delete(itemName);
}
```

- [ ] **Step 3: Commit**

```
git add frontend/src/api/client.ts frontend/src/db.ts
git commit -m "feat: add deleteItemDefault API + IDB functions"
```

---

### Task 3: Frontend — ItemAutocomplete component

**Files:**
- Create: `frontend/src/components/ItemAutocomplete.tsx`
- Test: `frontend/src/components/__tests__/ItemAutocomplete.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/__tests__/ItemAutocomplete.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ItemAutocomplete } from '../ItemAutocomplete';

const items = new Map<string, string | null>([
  ['sweet potato', 'store-1'],
  ['sweet chili sauce', 'store-2'],
  ['milk', null],
  ['bread', 'store-1'],
]);
const currentListItemNames = new Set(['milk', 'bread']);

function renderAutocomplete(overrides = {}) {
  const props = {
    value: '',
    onChange: vi.fn(),
    onSelect: vi.fn(),
    items,
    currentListItemNames,
    onDelete: vi.fn(),
    placeholder: 'Item name...',
    ...overrides,
  };
  return { ...render(<ItemAutocomplete {...props} />), props };
}

describe('ItemAutocomplete', () => {
  it('shows filtered suggestions when typing', () => {
    renderAutocomplete({ value: 'swe' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);

    expect(screen.getByText('Sweet Potato')).toBeInTheDocument();
    expect(screen.getByText('Sweet Chili Sauce')).toBeInTheDocument();
    expect(screen.queryByText('Milk')).not.toBeInTheDocument();
  });

  it('calls onSelect when clicking a suggestion', () => {
    const { props } = renderAutocomplete({ value: 'swe' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);

    fireEvent.click(screen.getByText('Sweet Potato'));
    expect(props.onSelect).toHaveBeenCalledWith('Sweet Potato');
  });

  it('shows delete button only for items not on the current list', () => {
    renderAutocomplete({ value: '' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);

    // sweet potato and sweet chili sauce are NOT on current list → should have delete buttons
    const deleteButtons = screen.getAllByLabelText(/^Delete /);
    // milk and bread ARE on the list → no delete buttons for them
    const deleteLabels = deleteButtons.map(b => b.getAttribute('aria-label'));
    expect(deleteLabels).toContain('Delete Sweet Potato');
    expect(deleteLabels).toContain('Delete Sweet Chili Sauce');
    expect(deleteLabels).not.toContain('Delete Milk');
    expect(deleteLabels).not.toContain('Delete Bread');
  });

  it('calls onDelete when clicking delete button', () => {
    const { props } = renderAutocomplete({ value: 'sweet p' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);

    fireEvent.click(screen.getByLabelText('Delete Sweet Potato'));
    expect(props.onDelete).toHaveBeenCalledWith('sweet potato');
    // Should NOT have called onSelect
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('closes dropdown on Escape', () => {
    renderAutocomplete({ value: 'swe' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);
    expect(screen.getByText('Sweet Potato')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('Sweet Potato')).not.toBeInTheDocument();
  });

  it('does not show dropdown when value is empty and not focused', () => {
    renderAutocomplete({ value: '' });
    expect(screen.queryByText('Sweet Potato')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/ItemAutocomplete.test.tsx 2>&1`
Expected: FAIL — module not found

- [ ] **Step 3: Create the ItemAutocomplete component**

Create `frontend/src/components/ItemAutocomplete.tsx`:

```tsx
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
}: ItemAutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const internalRef = useRef<HTMLInputElement>(null);
  const ref = externalRef ?? internalRef;
  const containerRef = useRef<HTMLDivElement>(null);

  const query = value.toLowerCase();
  const filtered = Array.from(items.keys())
    .filter(name => !query || name.includes(query))
    .sort((a, b) => a.localeCompare(b));

  // Build a display name map: use actual cased name from current list if available, else title-case
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
      // Select top match if dropdown is open and there's a query
      e.preventDefault();
      handleSelect(filtered[0]);
      return; // Don't call external onKeyDown for this Enter
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/ItemAutocomplete.test.tsx 2>&1`
Expected: PASS

- [ ] **Step 5: Commit**

```
git add frontend/src/components/ItemAutocomplete.tsx frontend/src/components/__tests__/ItemAutocomplete.test.tsx
git commit -m "feat: add ItemAutocomplete component with delete support"
```

---

### Task 4: Frontend — Integrate into quick-add form

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx`

- [ ] **Step 1: Add imports and derive `currentListItemNames`**

In `GroceryListView.tsx`, add to the imports (line 1 area):

```typescript
import { ItemAutocomplete } from './ItemAutocomplete';
import { deleteLocalItemDefault } from '../db';
import { deleteItemDefault } from '../api/client';
```

After the `itemDefaultsMap` useMemo (after line 50), add:

```typescript
const currentListItemNames = useMemo(() => {
  const names = new Set<string>();
  for (const section of sections) {
    for (const item of section.items) {
      names.add(item.name.toLowerCase());
    }
  }
  return names;
}, [sections]);

const handleDeleteItemDefault = useCallback(async (itemName: string) => {
  // Remove from local IDB cache
  await deleteLocalItemDefault(itemName);
  setIdbDefaults(prev => {
    const next = new Map(prev);
    next.delete(itemName);
    return next;
  });
  // Remove from server (best-effort)
  deleteItemDefault(itemName).catch(() => {});
}, []);
```

- [ ] **Step 2: Replace the quick-add item input with ItemAutocomplete**

Replace the `<input>` block at lines 591-621 (the item name input in the quick-add form) with:

```tsx
<ItemAutocomplete
  value={quickAddItemName}
  onChange={val => {
    setQuickAddItemName(val);
    const trimmed = val.trim().toLowerCase();
    if (trimmed) {
      const match = sections.flatMap(s => s.items).find(
        i => i.name.toLowerCase() === trimmed && i.store_id
      );
      setQuickAddStoreId(match?.store_id ?? itemDefaultsMap.get(trimmed) ?? null);
    } else {
      setQuickAddStoreId(null);
    }
  }}
  onSelect={displayName => {
    setQuickAddItemName(displayName);
    const trimmed = displayName.trim().toLowerCase();
    const match = sections.flatMap(s => s.items).find(
      i => i.name.toLowerCase() === trimmed && i.store_id
    );
    setQuickAddStoreId(match?.store_id ?? itemDefaultsMap.get(trimmed) ?? null);
  }}
  items={itemDefaultsMap}
  currentListItemNames={currentListItemNames}
  onDelete={handleDeleteItemDefault}
  inputRef={quickAddItemRef}
  placeholder="Item name..."
  onKeyDown={e => {
    if (e.key === 'Escape') {
      setAddMode('closed');
      resetQuickAdd();
    }
  }}
  className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
/>
```

Note: The `handleQuickAdd` Enter key is now handled inside `ItemAutocomplete` — when Enter is pressed with no dropdown match or closed dropdown, the external `onKeyDown` fires and we need to trigger `handleQuickAdd`. Update the `onKeyDown` prop:

```tsx
onKeyDown={e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleQuickAdd();
  } else if (e.key === 'Escape') {
    setAddMode('closed');
    resetQuickAdd();
  }
}}
```

- [ ] **Step 3: Run existing tests to ensure nothing breaks**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npx vitest run 2>&1`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```
git add frontend/src/components/GroceryListView.tsx
git commit -m "feat: integrate ItemAutocomplete into quick-add form"
```

---

### Task 5: Frontend — Integrate into per-section inline add

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx` (SectionCard component and its props)

- [ ] **Step 1: Add new props to SectionCardProps**

Add these props to the `SectionCardProps` interface (around line 958):

```typescript
itemDefaultsMap: Map<string, string | null>;
currentListItemNames: Set<string>;
onDeleteItemDefault: (itemName: string) => void;
```

- [ ] **Step 2: Update SectionCard function signature**

Destructure the new props in the `SectionCard` function (around line 987):

```typescript
itemDefaultsMap,
currentListItemNames,
onDeleteItemDefault,
```

- [ ] **Step 3: Replace inline add input with ItemAutocomplete**

Replace the `<input>` in the inline add section (lines 1132-1142) with:

```tsx
<ItemAutocomplete
  value={newItemName}
  onChange={name => onNewItemNameChange(name)}
  onSelect={displayName => {
    onNewItemNameChange(displayName);
  }}
  items={itemDefaultsMap}
  currentListItemNames={currentListItemNames}
  onDelete={onDeleteItemDefault}
  placeholder="Item name..."
  autoFocus
  onKeyDown={e => {
    if (e.key === 'Enter') onAddItem(section.id);
    if (e.key === 'Escape') onStartAdd(null);
  }}
  className="flex-1 bg-transparent border-b border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:border-blue-500 text-sm py-1"
/>
```

- [ ] **Step 4: Pass new props from parent to SectionCard**

In the `<SectionCard>` usage (around line 878), add:

```tsx
itemDefaultsMap={itemDefaultsMap}
currentListItemNames={currentListItemNames}
onDeleteItemDefault={handleDeleteItemDefault}
```

- [ ] **Step 5: Run all tests**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npx vitest run 2>&1`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```
git add frontend/src/components/GroceryListView.tsx
git commit -m "feat: integrate ItemAutocomplete into per-section inline add"
```

---

### Task 6: Build verification and Docker restart

- [ ] **Step 1: Run full frontend build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds with no errors

- [ ] **Step 2: Run all backend tests**

Run: `/Users/evan.callia/Desktop/meal-planner/.venv/bin/python -m pytest /Users/evan.callia/Desktop/meal-planner/backend/tests/ -v 2>&1`
Expected: All PASS

- [ ] **Step 3: Run all frontend tests**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner 2>&1`
Expected: All PASS

- [ ] **Step 4: Rebuild and restart Docker dev server**

Run: `docker-compose -f /Users/evan.callia/Desktop/meal-planner/docker-compose.yml up -d --build 2>&1`

- [ ] **Step 5: Commit all remaining changes (if any)**

Check `git status` and commit any uncommitted files.
