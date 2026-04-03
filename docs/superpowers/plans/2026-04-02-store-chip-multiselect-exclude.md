# Store Chip Multi-Select, Exclude & Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multi-select store filtering, store exclusion, smart chip visibility (only show stores with items), and improve the store clear button in item editing.

**Architecture:** All changes are frontend-only. GroceryListView owns three new state values (`selectedStoreIds`, `excludedStoreIds`, `showAllStores`) persisted in localStorage. StoreFilterBar gets new props for multi-select and exclude. StoreAutocomplete gets a styled clear button.

**Tech Stack:** React, TypeScript, Vitest, @testing-library/react

**Spec:** `docs/superpowers/specs/2026-04-02-store-chip-multiselect-exclude-design.md`

---

### Task 1: Update StoreFilterBar Props and Multi-Select Tap Behavior

**Files:**
- Modify: `frontend/src/components/StoreFilterBar.tsx:5-14` (props interface)
- Modify: `frontend/src/components/StoreFilterBar.tsx:16` (destructuring)
- Modify: `frontend/src/components/StoreFilterBar.tsx:188-206` (handlePointerUp tap logic)
- Modify: `frontend/src/components/StoreFilterBar.tsx:292-297` (chip className)
- Modify: `frontend/src/components/StoreFilterBar.tsx:302-308` (badge className)
- Modify: `frontend/src/components/StoreFilterBar.tsx:313-339` (None chip)
- Test: `frontend/src/components/__tests__/StoreFilterBar.test.tsx`

- [ ] **Step 1: Write failing tests for multi-select behavior**

Add to `frontend/src/components/__tests__/StoreFilterBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StoreFilterBar } from '../StoreFilterBar';
import type { Store } from '../../types';

const stores: Store[] = [
  { id: 'st1', name: 'Costco', position: 0 },
  { id: 'st2', name: "Trader Joe's", position: 1 },
];

describe('StoreFilterBar', () => {
  const mockOnToggleSelect = vi.fn();
  const mockOnRemoveExclusion = vi.fn();
  const mockOnRename = vi.fn();
  const mockOnDelete = vi.fn();
  const mockOnReorder = vi.fn();
  const mockOnExclude = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no stores', () => {
    const { container } = render(
      <StoreFilterBar
        stores={[]}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders store chips', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    expect(screen.getByText('Costco')).toBeInTheDocument();
    expect(screen.getByText("Trader Joe's")).toBeInTheDocument();
  });

  it('highlights selected store chips with blue', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set(['st1'])}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    const costcoButton = screen.getByText('Costco');
    expect(costcoButton.className).toContain('bg-blue-500');
  });

  it('short tap on neutral chip calls onToggleSelect', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(costcoButton);
    expect(mockOnToggleSelect).toHaveBeenCalledWith('st1');
  });

  it('short tap on selected chip calls onToggleSelect to deselect', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set(['st1'])}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(costcoButton);
    expect(mockOnToggleSelect).toHaveBeenCalledWith('st1');
  });

  it('multiple chips can be selected simultaneously', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set(['st1', 'st2'])}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    expect(screen.getByText('Costco').className).toContain('bg-blue-500');
    expect(screen.getByText("Trader Joe's").className).toContain('bg-blue-500');
  });

  it('does not show edit popover initially', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/StoreFilterBar.test.tsx 2>&1`
Expected: FAIL — props don't match new interface yet.

- [ ] **Step 3: Update StoreFilterBar props and implementation**

In `frontend/src/components/StoreFilterBar.tsx`, replace the props interface and update the component:

```tsx
interface StoreFilterBarProps {
  stores: Store[];
  selectedStoreIds: Set<string>;
  excludedStoreIds: Set<string>;
  onToggleSelect: (storeId: string) => void;
  onRemoveExclusion: (storeId: string) => void;
  onRename: (storeId: string, name: string) => void;
  onDelete: (storeId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onExclude: (storeId: string) => void;
  storeCounts?: Map<string, number>;
  noneCount?: number;
}
```

Update the component signature to destructure the new props:

```tsx
export function StoreFilterBar({ stores, selectedStoreIds, excludedStoreIds, onToggleSelect, onRemoveExclusion, onRename, onDelete, onReorder, onExclude, storeCounts, noneCount = 0 }: StoreFilterBarProps) {
```

Update `handlePointerUp` — the short-tap branch (line ~201-204):

```tsx
if (!didLongPressRef.current) {
  // Short tap
  if (excludedStoreIds.has(storeId)) {
    onRemoveExclusion(storeId);
  } else {
    onToggleSelect(storeId);
  }
}
```

Update `handleDelete` — remove the old `onFilterChange(null)` call since we no longer have that prop:

```tsx
const handleDelete = () => {
  if (editingStoreId) {
    onDelete(editingStoreId);
  }
  setEditingStoreId(null);
};
```

Update store chip className to use `selectedStoreIds.has()` and add excluded styling:

```tsx
const isSelected = selectedStoreIds.has(store.id);
const isExcluded = excludedStoreIds.has(store.id);
```

Chip className:
```tsx
className={`
  px-3 py-1 rounded-full text-sm font-medium transition-colors select-none touch-none
  ${isExcluded
    ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 line-through opacity-60'
    : isSelected
      ? 'bg-blue-500 text-white'
      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
  }
`}
```

Badge className — update to use `isSelected`:
```tsx
<span className={`ml-1.5 text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center ${
  isSelected
    ? 'bg-blue-400/30 text-white'
    : 'bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400'
}`}>
```

Update None chip — replace `activeStoreId === NONE_STORE_ID` with `selectedStoreIds.has(NONE_STORE_ID)` and `onFilterChange(...)` with `onToggleSelect(NONE_STORE_ID)`:

```tsx
{noneCount > 0 && (
  <button
    onPointerDown={(e) => {
      e.stopPropagation();
    }}
    onPointerUp={() => {
      onToggleSelect(NONE_STORE_ID);
    }}
    className={`
      px-3 py-1 rounded-full text-sm font-medium transition-colors select-none touch-none
      ${selectedStoreIds.has(NONE_STORE_ID)
        ? 'bg-blue-500 text-white'
        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
      }
    `}
  >
    None
    <span className={`ml-1.5 text-xs rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center ${
      selectedStoreIds.has(NONE_STORE_ID)
        ? 'bg-blue-400/30 text-white'
        : 'bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-400'
    }`}>
      {noneCount}
    </span>
  </button>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/StoreFilterBar.test.tsx 2>&1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/StoreFilterBar.tsx frontend/src/components/__tests__/StoreFilterBar.test.tsx
git commit -m "feat: update StoreFilterBar to multi-select and exclude props"
```

---

### Task 2: Add Exclude/Include Button to Edit Popover

**Files:**
- Modify: `frontend/src/components/StoreFilterBar.tsx:342-368` (edit popover)
- Test: `frontend/src/components/__tests__/StoreFilterBar.test.tsx`

- [ ] **Step 1: Write failing tests for exclude button in popover**

Add to `frontend/src/components/__tests__/StoreFilterBar.test.tsx`:

```tsx
describe('exclude in edit popover', () => {
  it('shows "Exclude from list" for non-excluded store in popover', async () => {
    vi.useFakeTimers();
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(costcoButton);
    expect(screen.getByText('Exclude from list')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows "Include in list" for excluded store in popover', async () => {
    vi.useFakeTimers();
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set(['st1'])}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(costcoButton);
    expect(screen.getByText('Include in list')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('clicking "Exclude from list" calls onExclude', async () => {
    vi.useFakeTimers();
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(costcoButton);
    fireEvent.click(screen.getByText('Exclude from list'));
    expect(mockOnExclude).toHaveBeenCalledWith('st1');
    vi.useRealTimers();
  });

  it('clicking "Include in list" calls onRemoveExclusion', async () => {
    vi.useFakeTimers();
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set(['st1'])}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        onExclude={mockOnExclude}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(300);
    fireEvent.pointerUp(costcoButton);
    fireEvent.click(screen.getByText('Include in list'));
    expect(mockOnRemoveExclusion).toHaveBeenCalledWith('st1');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/StoreFilterBar.test.tsx 2>&1`
Expected: FAIL — "Exclude from list" text not found.

- [ ] **Step 3: Add exclude/include button to edit popover**

In `StoreFilterBar.tsx`, update the edit popover section (after the `<input>` and before the `<div className="flex justify-between">`):

```tsx
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
      {excludedStoreIds.has(editingStoreId) ? (
        <button
          onClick={() => { onRemoveExclusion(editingStoreId); setEditingStoreId(null); }}
          className="w-full text-left text-sm text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 mb-2"
        >
          Include in list
        </button>
      ) : (
        <button
          onClick={() => { onExclude(editingStoreId); setEditingStoreId(null); }}
          className="w-full text-left text-sm text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300 mb-2"
        >
          Exclude from list
        </button>
      )}
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/StoreFilterBar.test.tsx 2>&1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/StoreFilterBar.tsx frontend/src/components/__tests__/StoreFilterBar.test.tsx
git commit -m "feat: add exclude/include toggle to store chip edit popover"
```

---

### Task 3: Update GroceryListView State and Filtering

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx:22-28` (state declarations)
- Modify: `frontend/src/components/GroceryListView.tsx:40-78` (storeCounts, visibleSections)
- Modify: `frontend/src/components/GroceryListView.tsx:411-419` (StoreFilterBar props)

- [ ] **Step 1: Replace filterStoreId with new state variables**

In `GroceryListView.tsx`, replace the `filterStoreId` state (line 27) with:

```tsx
const [selectedStoreIds, setSelectedStoreIds] = useState<Set<string>>(() => {
  try {
    const saved = localStorage.getItem('meal-planner-selected-stores');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch { return new Set(); }
});
const [excludedStoreIds, setExcludedStoreIds] = useState<Set<string>>(() => {
  try {
    const saved = localStorage.getItem('meal-planner-excluded-stores');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  } catch { return new Set(); }
});
const [showAllStores, setShowAllStores] = useState<boolean>(() => {
  try {
    return localStorage.getItem('meal-planner-show-all-stores') === 'true';
  } catch { return false; }
});
```

- [ ] **Step 2: Add persistence helpers**

Add after the state declarations:

```tsx
const persistSelectedStores = useCallback((ids: Set<string>) => {
  setSelectedStoreIds(ids);
  try { localStorage.setItem('meal-planner-selected-stores', JSON.stringify([...ids])); } catch {}
}, []);

const persistExcludedStores = useCallback((ids: Set<string>) => {
  setExcludedStoreIds(ids);
  try { localStorage.setItem('meal-planner-excluded-stores', JSON.stringify([...ids])); } catch {}
}, []);

const handleToggleSelect = useCallback((storeId: string) => {
  setSelectedStoreIds(prev => {
    const next = new Set(prev);
    if (next.has(storeId)) {
      next.delete(storeId);
    } else {
      next.add(storeId);
    }
    try { localStorage.setItem('meal-planner-selected-stores', JSON.stringify([...next])); } catch {}
    return next;
  });
}, []);

const handleExclude = useCallback((storeId: string) => {
  // Remove from selected if present
  setSelectedStoreIds(prev => {
    if (prev.has(storeId)) {
      const next = new Set(prev);
      next.delete(storeId);
      try { localStorage.setItem('meal-planner-selected-stores', JSON.stringify([...next])); } catch {}
      return next;
    }
    return prev;
  });
  setExcludedStoreIds(prev => {
    const next = new Set(prev);
    next.add(storeId);
    try { localStorage.setItem('meal-planner-excluded-stores', JSON.stringify([...next])); } catch {}
    return next;
  });
}, []);

const handleRemoveExclusion = useCallback((storeId: string) => {
  setExcludedStoreIds(prev => {
    const next = new Set(prev);
    next.delete(storeId);
    try { localStorage.setItem('meal-planner-excluded-stores', JSON.stringify([...next])); } catch {}
    return next;
  });
}, []);

const handleToggleShowAllStores = useCallback(() => {
  setShowAllStores(prev => {
    const next = !prev;
    try { localStorage.setItem('meal-planner-show-all-stores', String(next)); } catch {}
    return next;
  });
}, []);
```

- [ ] **Step 3: Update visibleSections filtering logic**

Replace the `visibleSections` useMemo (lines 54-79):

```tsx
const visibleSections = useMemo(() => {
  let filtered = sections.filter(s => s.items.some(i => !i.checked));

  // 1. Remove excluded stores' items
  if (excludedStoreIds.size > 0) {
    filtered = filtered
      .map(s => ({
        ...s,
        items: s.items.filter(i => !i.store_id || !excludedStoreIds.has(i.store_id)),
      }))
      .filter(s => s.items.some(i => !i.checked));
  }

  // 2. If any stores are selected, show only those
  if (selectedStoreIds.size > 0) {
    filtered = filtered
      .map(s => ({
        ...s,
        items: s.items.filter(i => !i.checked && (selectedStoreIds.has(NONE_STORE_ID)
          ? !i.store_id || selectedStoreIds.has(i.store_id!)
          : i.store_id && selectedStoreIds.has(i.store_id))),
      }))
      .filter(s => s.items.length > 0);
  }

  if (sortByStore) {
    const storeOrder = new Map(stores.map(s => [s.id, s.position]));
    filtered = filtered.map(s => ({
      ...s,
      items: [...s.items].sort((a, b) => {
        const aPos = a.store_id ? (storeOrder.get(a.store_id) ?? Infinity) : Infinity;
        const bPos = b.store_id ? (storeOrder.get(b.store_id) ?? Infinity) : Infinity;
        if (aPos !== bPos) return aPos - bPos;
        return a.position - b.position;
      }),
    }));
  }
  return filtered;
}, [sections, selectedStoreIds, excludedStoreIds, sortByStore, stores]);
```

- [ ] **Step 4: Compute visible stores for chip bar**

Add a `visibleStores` memo after `storeCounts`:

```tsx
const visibleStores = useMemo(() => {
  if (showAllStores) return stores;
  return stores.filter(s =>
    (storeCounts.get(s.id) ?? 0) > 0 || excludedStoreIds.has(s.id)
  );
}, [stores, storeCounts, excludedStoreIds, showAllStores]);
```

- [ ] **Step 5: Update StoreFilterBar props in JSX**

Replace the `<StoreFilterBar>` usage (around line 411):

```tsx
<StoreFilterBar
  stores={visibleStores}
  selectedStoreIds={selectedStoreIds}
  excludedStoreIds={excludedStoreIds}
  onToggleSelect={handleToggleSelect}
  onRemoveExclusion={handleRemoveExclusion}
  onRename={renameStore}
  onDelete={removeStore}
  onReorder={reorderStores}
  onExclude={handleExclude}
  storeCounts={storeCounts}
  noneCount={storeCounts.get(NONE_STORE_ID) ?? 0}
/>
```

- [ ] **Step 6: Run build to verify no type errors**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx tsc --noEmit 2>&1`
Expected: No errors (or only pre-existing ones unrelated to this change).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/GroceryListView.tsx
git commit -m "feat: add multi-select, exclude, and chip visibility state to GroceryListView"
```

---

### Task 4: Add "Show All Stores" Menu Option

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx:361-402` (kebab menu)

- [ ] **Step 1: Add menu option to kebab menu**

In the kebab menu dropdown (after the "Copy list" button, before "Clear checked"), add:

```tsx
{stores.length > 0 && (
  <button
    onClick={() => { handleToggleShowAllStores(); setShowClearMenu(false); }}
    className="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
  >
    {showAllStores ? 'Show only active stores' : 'Show all stores'}
  </button>
)}
```

- [ ] **Step 2: Verify visually (manual)**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npm run build 2>&1`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/GroceryListView.tsx
git commit -m "feat: add 'Show all stores' toggle to grocery kebab menu"
```

---

### Task 5: Update StoreFilterBar.additional.test.tsx

**Files:**
- Modify: `frontend/src/components/__tests__/StoreFilterBar.additional.test.tsx`

- [ ] **Step 1: Read the additional test file and update props**

Read `frontend/src/components/__tests__/StoreFilterBar.additional.test.tsx` and update all `<StoreFilterBar>` renders to use the new props interface:
- Replace `activeStoreId={null}` with `selectedStoreIds={new Set()}` and `excludedStoreIds={new Set()}`
- Replace `onFilterChange={...}` with `onToggleSelect={...}` and `onRemoveExclusion={...}`
- Add `onExclude={mockOnExclude}`

- [ ] **Step 2: Run all StoreFilterBar tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/StoreFilterBar 2>&1`
Expected: All PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/__tests__/StoreFilterBar.additional.test.tsx
git commit -m "test: update StoreFilterBar additional tests for new props"
```

---

### Task 6: Style StoreAutocomplete Clear Button

**Files:**
- Modify: `frontend/src/components/StoreAutocomplete.tsx:60-65`
- Test: `frontend/src/components/__tests__/StoreAutocomplete.test.tsx`

- [ ] **Step 1: Write failing test for the styled clear button**

Update the existing test in `StoreAutocomplete.test.tsx` — the "clearing selected store" test already validates behavior. Add a new test for the button's visual presence:

```tsx
it('clear button has red styling and visible text', () => {
  render(
    <StoreAutocomplete stores={stores} selectedStoreId="st1" onSelect={mockOnSelect} onCreate={mockOnCreate} />
  );
  const clearButton = screen.getByRole('button', { name: /remove store/i });
  expect(clearButton).toBeInTheDocument();
  expect(clearButton.className).toContain('text-red');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/StoreAutocomplete.test.tsx 2>&1`
Expected: FAIL — no button with name "remove store".

- [ ] **Step 3: Update the clear button styling**

In `StoreAutocomplete.tsx`, replace the clear button (lines 60-65):

```tsx
<button
  onClick={handleClear}
  aria-label="Remove store"
  className="text-red-400 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 text-sm font-bold ml-1 px-1"
>
  X
</button>
```

- [ ] **Step 4: Update existing test that looks for "✕"**

In `StoreAutocomplete.test.tsx`, the existing test `'clearing selected store calls onSelect(null)'` clicks `screen.getByText('✕')`. Update it to use the new aria-label:

```tsx
it('clearing selected store calls onSelect(null)', () => {
  render(
    <StoreAutocomplete stores={stores} selectedStoreId="st1" onSelect={mockOnSelect} onCreate={mockOnCreate} />
  );
  fireEvent.click(screen.getByRole('button', { name: /remove store/i }));
  expect(mockOnSelect).toHaveBeenCalledWith(null);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npx vitest run frontend/src/components/__tests__/StoreAutocomplete.test.tsx 2>&1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/StoreAutocomplete.tsx frontend/src/components/__tests__/StoreAutocomplete.test.tsx
git commit -m "feat: style store clear button with red X for better visibility"
```

---

### Task 7: Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run all frontend tests**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npm run test:run 2>&1`
Expected: All PASS. If any fail, fix them before proceeding.

- [ ] **Step 2: Run build**

Run: `cd /Users/evan.callia/Desktop/meal-planner && export PATH="/opt/homebrew/bin:$PATH" && npm run build 2>&1`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Final commit if any fixes were needed**

Only if fixes were made in steps 1-2:
```bash
git add -A
git commit -m "fix: resolve test/build issues from store chip changes"
```
