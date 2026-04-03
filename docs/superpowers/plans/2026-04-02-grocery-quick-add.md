# Grocery Quick-Add Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bulk paste textarea as the default "Add items" experience with a quick-add form (section combobox + quantity stepper + item name), keeping paste as a toggle.

**Architecture:** Frontend-only changes to `GroceryListView.tsx` and its test file. The quick-add form reuses existing `addItem()` hook for existing sections and `mergeList()` for new sections. No backend changes.

**Tech Stack:** React, TypeScript, Tailwind CSS, Vitest + React Testing Library

---

### Task 1: Replace `showInputArea` state with `addMode` and add quick-add state

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx:22-52` (state declarations)

- [ ] **Step 1: Replace `showInputArea` with `addMode` and add new state variables**

In `GroceryListView.tsx`, replace:
```typescript
const [showInputArea, setShowInputArea] = useState(false);
```
with:
```typescript
const [addMode, setAddMode] = useState<'closed' | 'quick' | 'paste'>('closed');
```

Add these new state variables after `addMode`:
```typescript
const [quickAddSection, setQuickAddSection] = useState('');
const [quickAddQuantity, setQuickAddQuantity] = useState(1);
const [quickAddItemName, setQuickAddItemName] = useState('');
const [showSectionDropdown, setShowSectionDropdown] = useState(false);
```

Add a ref for the section dropdown (after `sectionContainerRef`):
```typescript
const sectionDropdownRef = useRef<HTMLDivElement>(null);
const quickAddItemRef = useRef<HTMLInputElement>(null);
```

- [ ] **Step 2: Update all references to `showInputArea`**

Find and replace all usages of `showInputArea` in the component:

1. Line ~379: `sections.length === 0 || showInputArea` → `sections.length === 0 || addMode !== 'closed'`
2. Line ~399: `{showInputArea && (` → `{addMode !== 'closed' && (`
3. Line ~401: `setShowInputArea(false)` → `setAddMode('closed')`
4. Line ~319: `setShowInputArea(false)` in `handleSubmitText` → `setAddMode('closed')`
5. Line ~434: `setShowInputArea(true)` → `setAddMode('quick')`

- [ ] **Step 3: Add filtered sections memo**

Add a `useMemo` for filtered section suggestions (after the existing `storeCounts` memo):

```typescript
const filteredSections = useMemo(() => {
  if (!quickAddSection.trim()) return sections.map(s => s.name);
  const lower = quickAddSection.toLowerCase();
  return sections.map(s => s.name).filter(name => name.toLowerCase().includes(lower));
}, [sections, quickAddSection]);
```

- [ ] **Step 4: Add `handleQuickAdd` callback**

Add a new handler after `handleAddItem`:

```typescript
const handleQuickAdd = useCallback(async () => {
  const trimmedName = quickAddItemName.trim();
  const trimmedSection = quickAddSection.trim();
  if (!trimmedName || !trimmedSection) return;

  const quantity = quickAddQuantity > 0 ? String(quickAddQuantity) : null;

  // Find existing section (case-insensitive)
  const existingSection = sections.find(
    s => s.name.toLowerCase() === trimmedSection.toLowerCase()
  );

  if (existingSection) {
    await addItem(existingSection.id, trimmedName, quantity);
  } else {
    // New section: use mergeList to create section + item
    await mergeList([{ name: trimmedSection, items: [{ name: trimmedName, quantity }] }]);
  }

  // Reset for rapid entry: clear item, reset quantity, keep section
  setQuickAddItemName('');
  setQuickAddQuantity(1);
  // Focus item input for next entry
  requestAnimationFrame(() => quickAddItemRef.current?.focus());
}, [quickAddItemName, quickAddSection, quickAddQuantity, sections, addItem, mergeList]);
```

- [ ] **Step 5: Add click-outside handler for section dropdown**

Add a `useEffect` for closing the section dropdown when clicking outside (after the existing `showClearMenu` click-outside effect):

```typescript
useEffect(() => {
  if (!showSectionDropdown) return;
  const handleClick = (e: MouseEvent) => {
    if (sectionDropdownRef.current && !sectionDropdownRef.current.contains(e.target as Node)) {
      setShowSectionDropdown(false);
    }
  };
  document.addEventListener('mousedown', handleClick);
  return () => document.removeEventListener('mousedown', handleClick);
}, [showSectionDropdown]);
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/GroceryListView.tsx
git commit -m "refactor: replace showInputArea with addMode state for quick-add form"
```

---

### Task 2: Build the quick-add form UI

**Files:**
- Modify: `frontend/src/components/GroceryListView.tsx:379-430` (the input area JSX)

- [ ] **Step 1: Replace the textarea block with mode-switching UI**

Replace the content inside the `sections.length === 0 || addMode !== 'closed'` conditional (the entire `<div className="flex-1 bg-white ...">` block, lines ~380-430) with:

```tsx
<div className="flex-1 bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-4">
  {addMode === 'paste' ? (
    <>
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
        {sections.length === 0 ? 'Add your grocery list' : 'Paste grocery list'}
      </h3>
      <textarea
        ref={textareaRef}
        value={inputText}
        onChange={e => setInputText(e.target.value)}
        placeholder={'Type or paste grocery list...\n\n[Produce]\n(2) Bananas\nArugula\n\n[Dairy]\nMilk\nYogurt'}
        className="w-full h-32 p-3 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={handleSubmitText}
          disabled={!inputText.trim()}
          className="px-4 py-1.5 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 rounded-lg transition-colors"
        >
          Add items
        </button>
        <button
          onClick={() => {
            const ta = textareaRef.current;
            if (!ta) return;
            const pos = ta.selectionStart;
            const before = inputText.slice(0, pos);
            const after = inputText.slice(pos);
            const needsNewline = before.length > 0 && !before.endsWith('\n');
            const insert = (needsNewline ? '\n' : '') + '[]';
            const newText = before + insert + after;
            const cursorPos = pos + insert.length - 1;
            setInputText(newText);
            requestAnimationFrame(() => {
              ta.focus();
              ta.setSelectionRange(cursorPos, cursorPos);
            });
          }}
          className="ml-auto text-sm text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"
        >
          Add section
        </button>
      </div>
      <div className="mt-3 text-center">
        <button
          onClick={() => setAddMode('quick')}
          className="text-sm text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Back to quick add
        </button>
      </div>
    </>
  ) : (
    <>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Add Items
        </h3>
        {addMode !== 'closed' && sections.length > 0 && (
          <button
            onClick={() => {
              setAddMode('closed');
              setQuickAddSection('');
              setQuickAddItemName('');
              setQuickAddQuantity(1);
            }}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close add items"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        )}
      </div>

      {/* Section combobox */}
      <div className="relative mb-2" ref={sectionDropdownRef}>
        <input
          type="text"
          value={quickAddSection}
          onChange={e => {
            setQuickAddSection(e.target.value);
            setShowSectionDropdown(true);
          }}
          onFocus={() => setShowSectionDropdown(true)}
          onKeyDown={e => {
            if (e.key === 'Escape') setShowSectionDropdown(false);
            if (e.key === 'Tab' || e.key === 'Enter') setShowSectionDropdown(false);
          }}
          placeholder="Section — type or select..."
          className="w-full p-2.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          data-testid="quick-add-section"
        />
        {showSectionDropdown && filteredSections.length > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-40 overflow-y-auto">
            {filteredSections.map(name => (
              <button
                key={name}
                onClick={() => {
                  setQuickAddSection(name);
                  setShowSectionDropdown(false);
                  quickAddItemRef.current?.focus();
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Quantity + Item name row */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setQuickAddQuantity(q => Math.max(0, q - 1))}
            className="w-7 h-7 flex items-center justify-center rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 text-sm font-bold"
          >
            −
          </button>
          <span className="w-8 text-center text-sm font-medium text-blue-600 dark:text-blue-400">
            {quickAddQuantity || '–'}
          </span>
          <button
            onClick={() => setQuickAddQuantity(q => q + 1)}
            className="w-7 h-7 flex items-center justify-center rounded bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-500 text-sm font-bold"
          >
            +
          </button>
        </div>
        <input
          ref={quickAddItemRef}
          type="text"
          value={quickAddItemName}
          onChange={e => setQuickAddItemName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleQuickAdd();
            if (e.key === 'Escape') {
              setAddMode('closed');
              setQuickAddSection('');
              setQuickAddItemName('');
              setQuickAddQuantity(1);
            }
          }}
          placeholder="Item name..."
          className="flex-1 min-w-0 p-2.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          data-testid="quick-add-item"
        />
      </div>

      {/* Add Item button (full width) */}
      <button
        onClick={handleQuickAdd}
        disabled={!quickAddItemName.trim() || !quickAddSection.trim()}
        className="w-full py-2.5 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 rounded-lg transition-colors"
        data-testid="quick-add-submit"
      >
        Add Item
      </button>

      {/* Paste toggle */}
      <div className="mt-3 text-center">
        <button
          onClick={() => setAddMode('paste')}
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
        >
          Paste a list instead
        </button>
      </div>
    </>
  )}
</div>
```

- [ ] **Step 2: Update Cancel button in the action bar**

The existing Cancel button (inside `{addMode !== 'closed' && (`) needs its `onClick` updated. Replace:
```typescript
onClick={() => { setShowInputArea(false); setInputText(''); }}
```
with:
```typescript
onClick={() => { setAddMode('closed'); setInputText(''); setQuickAddSection(''); setQuickAddItemName(''); setQuickAddQuantity(1); }}
```

Note: This Cancel button should be removed entirely since we now have the X button in the quick-add header and no Cancel in paste mode (there's "Back to quick add" instead). Remove the Cancel button block.

- [ ] **Step 3: Update the "Add items" button to open quick mode**

The button at line ~434 already opens `setAddMode('quick')` from Step 2 of Task 1. Verify this is correct.

- [ ] **Step 4: Handle empty state — show quick-add by default when no sections**

When `sections.length === 0`, the form currently shows automatically. Update the condition so it shows the quick-add form (not paste) when there are no sections. The condition `sections.length === 0 || addMode !== 'closed'` already handles this — when no sections exist, the form shows. But `addMode` defaults to `'closed'`, so the quick-add branch renders (the `else` in the ternary). This is correct since `addMode === 'paste'` is false when `addMode === 'closed'`, so the quick-add form shows by default.

However, the "Add Items" header should show "Add your grocery list" when there are no sections. Update the h3:
```tsx
<h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
  {sections.length === 0 ? 'Add your grocery list' : 'Add Items'}
</h3>
```

- [ ] **Step 5: Verify build compiles**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: Build succeeds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/GroceryListView.tsx
git commit -m "feat: add grocery quick-add form with section combobox and quantity stepper"
```

---

### Task 3: Update tests for the new quick-add form

**Files:**
- Modify: `frontend/src/components/__tests__/GroceryListView.test.tsx`

- [ ] **Step 1: Update existing tests that reference the old textarea behavior**

The test `'shows add textarea when no sections exist'` (line 91) should now check for the quick-add form:

```typescript
it('shows quick-add form when no sections exist', () => {
  mockSections = [];
  render(<GroceryListView />);
  expect(screen.getByText('Add your grocery list')).toBeInTheDocument();
  expect(screen.getByTestId('quick-add-section')).toBeInTheDocument();
  expect(screen.getByTestId('quick-add-item')).toBeInTheDocument();
});
```

The test `'clicking "Add items" shows textarea'` (line 112) should check for quick-add:

```typescript
it('clicking "Add items" shows quick-add form', () => {
  mockSections = sampleSections;
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Add items'));
  expect(screen.getByText('Add Items')).toBeInTheDocument();
  expect(screen.getByTestId('quick-add-section')).toBeInTheDocument();
});
```

The test `'submitting text input calls mergeList'` (line 170) needs to navigate to paste mode first:

```typescript
it('submitting paste textarea calls mergeList', async () => {
  mockSections = [];
  render(<GroceryListView />);

  // Switch to paste mode
  fireEvent.click(screen.getByText('Paste a list instead'));

  const textarea = screen.getByPlaceholderText(/Type or paste grocery list/);
  fireEvent.change(textarea, { target: { value: '[Produce]\nBananas' } });

  // Click the "Add items" submit button
  const buttons = screen.getAllByText('Add items');
  fireEvent.click(buttons[buttons.length - 1]);

  await waitFor(() => {
    expect(mockMergeList).toHaveBeenCalled();
  });
});
```

The test `'cancel button hides input area'` (line 186) should use the X close button:

```typescript
it('close button hides quick-add form', () => {
  mockSections = sampleSections;
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Add items'));
  expect(screen.getByTestId('quick-add-section')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Close add items'));
  expect(screen.queryByTestId('quick-add-section')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Add test for quick-add submitting to existing section**

```typescript
it('quick-add calls addItem for existing section', async () => {
  mockSections = sampleSections;
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Add items'));

  // Select existing section from dropdown
  const sectionInput = screen.getByTestId('quick-add-section');
  fireEvent.change(sectionInput, { target: { value: 'Produce' } });
  fireEvent.focus(sectionInput);
  fireEvent.click(screen.getByText('Produce'));

  // Enter item name
  const itemInput = screen.getByTestId('quick-add-item');
  fireEvent.change(itemInput, { target: { value: 'Celery' } });

  // Submit
  fireEvent.click(screen.getByTestId('quick-add-submit'));

  await waitFor(() => {
    expect(mockAddItem).toHaveBeenCalledWith('s1', 'Celery', '1');
  });
});
```

- [ ] **Step 3: Add test for quick-add with new section**

```typescript
it('quick-add calls mergeList for new section', async () => {
  mockSections = sampleSections;
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Add items'));

  // Type new section name
  const sectionInput = screen.getByTestId('quick-add-section');
  fireEvent.change(sectionInput, { target: { value: 'Bakery' } });

  // Enter item name
  const itemInput = screen.getByTestId('quick-add-item');
  fireEvent.change(itemInput, { target: { value: 'Sourdough' } });

  // Submit
  fireEvent.click(screen.getByTestId('quick-add-submit'));

  await waitFor(() => {
    expect(mockMergeList).toHaveBeenCalledWith([
      { name: 'Bakery', items: [{ name: 'Sourdough', quantity: '1' }] },
    ]);
  });
});
```

- [ ] **Step 4: Add test for rapid entry (form stays open, item clears)**

```typescript
it('quick-add clears item and keeps section after submit', async () => {
  mockSections = sampleSections;
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Add items'));

  const sectionInput = screen.getByTestId('quick-add-section');
  fireEvent.change(sectionInput, { target: { value: 'Produce' } });
  fireEvent.focus(sectionInput);
  fireEvent.click(screen.getByText('Produce'));

  const itemInput = screen.getByTestId('quick-add-item');
  fireEvent.change(itemInput, { target: { value: 'Celery' } });
  fireEvent.click(screen.getByTestId('quick-add-submit'));

  await waitFor(() => {
    expect(mockAddItem).toHaveBeenCalled();
  });

  // Form still open, section preserved, item cleared
  expect(screen.getByTestId('quick-add-section')).toHaveValue('Produce');
  expect(screen.getByTestId('quick-add-item')).toHaveValue('');
});
```

- [ ] **Step 5: Add test for quantity stepper**

```typescript
it('quick-add quantity stepper adjusts quantity', async () => {
  mockSections = sampleSections;
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Add items'));

  // Click + button twice (1 → 2 → 3)
  const plusButton = screen.getAllByText('+')[0];
  fireEvent.click(plusButton);
  fireEvent.click(plusButton);
  expect(screen.getByText('3')).toBeInTheDocument();

  // Select section and add item
  const sectionInput = screen.getByTestId('quick-add-section');
  fireEvent.change(sectionInput, { target: { value: 'Produce' } });
  fireEvent.focus(sectionInput);
  fireEvent.click(screen.getByText('Produce'));

  const itemInput = screen.getByTestId('quick-add-item');
  fireEvent.change(itemInput, { target: { value: 'Limes' } });
  fireEvent.click(screen.getByTestId('quick-add-submit'));

  await waitFor(() => {
    expect(mockAddItem).toHaveBeenCalledWith('s1', 'Limes', '3');
  });
});
```

- [ ] **Step 6: Add test for paste mode toggle**

```typescript
it('paste toggle switches to textarea and back', () => {
  mockSections = sampleSections;
  render(<GroceryListView />);
  fireEvent.click(screen.getByText('Add items'));

  // Start in quick-add mode
  expect(screen.getByTestId('quick-add-section')).toBeInTheDocument();

  // Switch to paste mode
  fireEvent.click(screen.getByText('Paste a list instead'));
  expect(screen.getByPlaceholderText(/Type or paste grocery list/)).toBeInTheDocument();
  expect(screen.queryByTestId('quick-add-section')).not.toBeInTheDocument();

  // Switch back to quick-add
  fireEvent.click(screen.getByText('Back to quick add'));
  expect(screen.getByTestId('quick-add-section')).toBeInTheDocument();
});
```

- [ ] **Step 7: Run tests**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run test:run --prefix /Users/evan.callia/Desktop/meal-planner/frontend 2>&1`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/__tests__/GroceryListView.test.tsx
git commit -m "test: update grocery list tests for quick-add form"
```
