import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroceryListView } from '../GroceryListView';
import { exitEditAnchored } from '../../utils/exitEditAnchored';

vi.mock('../../utils/exitEditAnchored', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exitEditAnchored')>();
  return { exitEditAnchored: vi.fn(actual.exitEditAnchored) };
});

const mockMergeList = vi.fn();
const mockToggleItem = vi.fn();
const mockAddItem = vi.fn();
const mockDeleteItem = vi.fn();
const mockEditItem = vi.fn();
const mockClearChecked = vi.fn();
const mockClearAll = vi.fn();
const mockReorderSections = vi.fn();
const mockReorderItems = vi.fn();
const mockRenameSection = vi.fn();
const mockMoveItem = vi.fn();
const mockBatchUpdateStoreId = vi.fn();
const mockCreateStore = vi.fn();
const mockRenameStore = vi.fn();
const mockRemoveStore = vi.fn();
const mockReorderStores = vi.fn();

let mockSections: any[] = [];
let mockLoading = false;
let mockStores: any[] = [];

vi.mock('../../hooks/useGroceryList', () => ({
  useGroceryList: () => ({
    sections: mockSections,
    loading: mockLoading,
    mergeList: mockMergeList,
    toggleItem: mockToggleItem,
    addItem: mockAddItem,
    deleteItem: mockDeleteItem,
    editItem: mockEditItem,
    clearChecked: mockClearChecked,
    clearAll: mockClearAll,
    reorderSections: mockReorderSections,
    reorderItems: mockReorderItems,
    renameSection: mockRenameSection,
    moveItem: mockMoveItem,
    createSection: vi.fn(),
    deleteSection: vi.fn(),
    batchUpdateStoreId: mockBatchUpdateStoreId,
    itemDefaultsMap: new Map(),
    removeItemDefault: vi.fn(),
  }),
}));

vi.mock('../../hooks/useStores', () => ({
  useStores: () => ({
    stores: mockStores,
    loading: false,
    createStore: mockCreateStore,
    renameStore: mockRenameStore,
    removeStore: mockRemoveStore,
    reorderStores: mockReorderStores,
  }),
}));

vi.mock('../../hooks/useDragReorder', () => ({
  useDragReorder: () => ({
    dragState: { isDragging: false, dragIndex: null, overIndex: null, itemHeight: 0 },
    getDragHandlers: () => ({}),
    getHandleMouseDown: () => vi.fn(),
  }),
  computeShiftTransform: () => '',
}));

vi.mock('../../utils/groceryParser', () => ({
  parseGroceryText: vi.fn((text: string) => {
    if (!text.trim()) return [];
    return [{ name: 'Produce', items: [{ name: 'Test', quantity: null }] }];
  }),
}));

const sectionsWithMultiple = [
  {
    id: 's1', name: 'Produce', position: 0,
    items: [
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: 'st1', updated_at: '2026-01-01' },
      { id: 'i2', section_id: 's1', name: 'Apples', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01' },
    ],
  },
  {
    id: 's2', name: 'Dairy', position: 1,
    items: [
      { id: 'i3', section_id: 's2', name: 'Milk', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-01' },
      { id: 'i4', section_id: 's2', name: 'Butter', quantity: null, checked: true, position: 1, store_id: null, updated_at: '2026-01-01' },
    ],
  },
];

describe('GroceryListView - additional coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = [];
    mockLoading = false;
    mockStores = [];
  });

  it('renders multiple sections', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    expect(screen.getByText('Produce')).toBeInTheDocument();
    expect(screen.getByText('Dairy')).toBeInTheDocument();
  });

  it('clicking checkbox calls toggleItem', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    // Find the checkbox button next to "Apples" - it's the unchecked checkbox
    // Each item row has a checkbox button - click one
    const checkboxes = screen.getAllByRole('button').filter(b => b.className.includes('rounded-sm border-2'));
    if (checkboxes.length > 0) {
      fireEvent.click(checkboxes[0]);
      expect(mockToggleItem).toHaveBeenCalled();
    }
  });

  it('clicking delete icon calls deleteItem', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const deleteButtons = screen.getAllByLabelText('Delete item');
    fireEvent.click(deleteButtons[0]);
    expect(mockDeleteItem).toHaveBeenCalled();
  });

  it('clicking item name opens edit mode', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Apples'));
    // Should see edit form with Save/Cancel
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('editing item and clicking Save calls editItem', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Apples'));

    const nameInput = screen.getByDisplayValue('Apples');
    fireEvent.change(nameInput, { target: { value: 'Green Apples' } });
    fireEvent.click(screen.getByText('Save'));

    expect(mockEditItem).toHaveBeenCalledWith('i2', expect.objectContaining({ name: 'Green Apples' }));
  });

  it('pressing Cancel in edit mode cancels', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Apples'));

    fireEvent.click(screen.getByText('Cancel'));
    // Should no longer be in edit mode
    expect(screen.queryByDisplayValue('Apples')).not.toBeInTheDocument();
  });

  it('pressing Enter in edit mode saves', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Apples'));

    const nameInput = screen.getByDisplayValue('Apples');
    fireEvent.change(nameInput, { target: { value: 'Red Apples' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });

    expect(mockEditItem).toHaveBeenCalled();
  });

  it('pressing Escape in edit mode cancels', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Apples'));

    const nameInput = screen.getByDisplayValue('Apples');
    fireEvent.keyDown(nameInput, { key: 'Escape' });

    expect(mockEditItem).not.toHaveBeenCalled();
  });

  it('clicking "+ Add item" shows inline add form', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);
    expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
  });

  it('entering item name and clicking Add calls addItem', async () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.change(input, { target: { value: 'Grapes' } });

    // Find the Add button in the inline form
    const addBtn = screen.getAllByText('Add').find(el => el.tagName === 'BUTTON');
    if (addBtn) fireEvent.click(addBtn);

    await waitFor(() => expect(mockAddItem).toHaveBeenCalled());
  });

  it('keeps the inline add form open, clears the name, and refocuses the input after a successful add', async () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Grapes' } });
    const addBtn = screen.getAllByText('Add').find(el => el.tagName === 'BUTTON')!;
    fireEvent.click(addBtn);

    await waitFor(() => expect(mockAddItem).toHaveBeenCalled());
    // Form stays open (input still present) and is cleared + refocused,
    // rather than unmounting (which is what triggers iOS's scroll-jump bug).
    await waitFor(() => expect(screen.getByPlaceholderText('Item name...')).toHaveValue(''));
    expect(screen.getByPlaceholderText('Item name...')).toBe(document.activeElement);
  });

  it('does not call addItem, clear the input, or close the form for an empty name', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const addBtn = screen.getAllByText('Add').find(el => el.tagName === 'BUTTON')!;
    fireEvent.click(addBtn);

    expect(mockAddItem).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
  });

  it('pressing Escape in the inline add form closes it via the anchored-exit helper', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(exitEditAnchored).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Item name...')).not.toBeInTheDocument();
  });

  it('clicking Cancel in the inline add form closes it via the anchored-exit helper', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    fireEvent.click(screen.getByText('Cancel'));

    expect(exitEditAnchored).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Item name...')).not.toBeInTheDocument();
  });

  it('clicking Add does not move focus off the item-name input (keeps the iOS keyboard open)', async () => {
    const user = userEvent.setup();
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
    await user.type(input, 'Grapes');
    expect(document.activeElement).toBe(input);

    const addBtn = screen.getAllByText('Add').find(el => el.tagName === 'BUTTON')!;
    // The actual mechanism under test: the button suppresses the browser's
    // default focus-shift on mousedown, so the input — and with it the iOS
    // keyboard — never loses focus. Asserting `activeElement` alone cannot
    // see this: the post-add `.focus()` fallback restores focus in
    // happy-dom whether or not the guard exists, whereas on real iOS a
    // `.focus()` outside a user-gesture context cannot reopen a keyboard
    // that has already been dismissed. Verified by deletion — removing the
    // `onMouseDown` guard fails this assertion and nothing else.
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    addBtn.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);

    await user.click(addBtn);

    expect(document.activeElement).toBe(input);
    await waitFor(() => expect(mockAddItem).toHaveBeenCalled());
  });

  // The old approach here (an instant `scrollIntoView({ block: 'nearest' })`
  // on the keyboard-closing resize) didn't hold position against iOS's own
  // scroll restoration — either a no-op or itself a competing movement.
  // `usePinOnKeyboardClose` replaces it with the same anchored-pin technique
  // `exitEditAnchored` uses: measure the form's position the instant the
  // close is detected, then repeatedly counter drift via `window.scrollBy`.
  describe('keyboard-close scroll correction on the inline add form', () => {
    // Mirrors the stubbing style in hooks/__tests__/useScrollIntoViewOnEdit.test.ts
    function stubViewport(height: number) {
      const resizeListeners: EventListener[] = [];
      const viewport = {
        height,
        addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('visualViewport', viewport);
      return { viewport, fire: () => resizeListeners.forEach(fn => fn(new Event('resize'))) };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('pins the form via window.scrollBy once it is open, on a keyboard-close resize', () => {
      mockSections = sectionsWithMultiple;
      const { viewport, fire } = stubViewport(window.innerHeight - 300); // keyboard open
      render(<GroceryListView />);
      const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
      // getBoundingClientRect returns a fresh value on every call so a real
      // pin attempt always sees nonzero drift (jsdom/happy-dom don't lay
      // out content, so every element reports the same static rect
      // otherwise — a false negative, not a sign the pin didn't run).
      let n = 0;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ top: (n++) * 10 } as DOMRect)
      );

      // Add form closed: nothing is subscribed, so a keyboard-close resize is a no-op.
      viewport.height = window.innerHeight;
      fire();
      expect(scrollBy).not.toHaveBeenCalled();
      viewport.height = window.innerHeight - 300; // keyboard "re-opens" before the form mounts

      // Open the add form, then simulate the keyboard closing (viewport
      // grows back past the threshold).
      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      viewport.height = window.innerHeight;
      fire();
      expect(scrollBy).toHaveBeenCalled();
    });

    it('suppresses the correction during a deliberate touch-scroll', () => {
      mockSections = sectionsWithMultiple;
      const { viewport, fire } = stubViewport(window.innerHeight - 300);
      render(<GroceryListView />);
      const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
      // getBoundingClientRect returns a fresh value on every call so a real
      // pin attempt always sees nonzero drift (jsdom/happy-dom don't lay
      // out content, so every element reports the same static rect
      // otherwise — a false negative, not a sign the pin didn't run).
      let n = 0;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ top: (n++) * 10 } as DOMRect)
      );
      fireEvent.click(screen.getAllByText('+ Add item')[0]);

      fireEvent.touchStart(document);
      viewport.height = window.innerHeight; // keyboard closes mid deliberate scroll
      fire();
      expect(scrollBy).not.toHaveBeenCalled();
      fireEvent.touchEnd(document);

      // A fresh open->close transition after the touch ends still corrects.
      viewport.height = window.innerHeight - 300;
      fire();
      viewport.height = window.innerHeight;
      fire();
      expect(scrollBy).toHaveBeenCalled();
    });
  });

  describe('keyboard-close scroll correction on the top quick-add form', () => {
    // Mirrors the stubbing style above. This is the surface the
    // group-by-recipe view relies on exclusively (no per-section add form
    // there), so it's the one most likely to be mid-edit when the keyboard
    // closes.
    function stubViewport(height: number) {
      const resizeListeners: EventListener[] = [];
      const viewport = {
        height,
        addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('visualViewport', viewport);
      return { viewport, fire: () => resizeListeners.forEach(fn => fn(new Event('resize'))) };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('pins the form via window.scrollBy once it is open, on a keyboard-close resize', () => {
      mockSections = sectionsWithMultiple;
      const { viewport, fire } = stubViewport(window.innerHeight - 300); // keyboard open
      render(<GroceryListView />);
      const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
      // getBoundingClientRect returns a fresh value on every call so a real
      // pin attempt always sees nonzero drift (jsdom/happy-dom don't lay
      // out content, so every element reports the same static rect
      // otherwise — a false negative, not a sign the pin didn't run).
      let n = 0;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ top: (n++) * 10 } as DOMRect)
      );

      // Quick-add closed: nothing is subscribed, so a keyboard-close resize is a no-op.
      viewport.height = window.innerHeight;
      fire();
      expect(scrollBy).not.toHaveBeenCalled();
      viewport.height = window.innerHeight - 300; // keyboard "re-opens" before quick-add mounts

      // Open quick-add, then simulate the keyboard closing (viewport grows
      // back past the threshold).
      fireEvent.click(screen.getByText('Add items'));
      viewport.height = window.innerHeight;
      fire();
      expect(scrollBy).toHaveBeenCalled();
    });

    it('suppresses the correction during a deliberate touch-scroll', () => {
      mockSections = sectionsWithMultiple;
      const { viewport, fire } = stubViewport(window.innerHeight - 300);
      render(<GroceryListView />);
      const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
      // getBoundingClientRect returns a fresh value on every call so a real
      // pin attempt always sees nonzero drift (jsdom/happy-dom don't lay
      // out content, so every element reports the same static rect
      // otherwise — a false negative, not a sign the pin didn't run).
      let n = 0;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ top: (n++) * 10 } as DOMRect)
      );
      fireEvent.click(screen.getByText('Add items'));

      fireEvent.touchStart(document);
      viewport.height = window.innerHeight; // keyboard closes mid deliberate scroll
      fire();
      expect(scrollBy).not.toHaveBeenCalled();
      fireEvent.touchEnd(document);

      viewport.height = window.innerHeight - 300;
      fire();
      viewport.height = window.innerHeight;
      fire();
      expect(scrollBy).toHaveBeenCalled();
    });

    it('switches the correction to the paste-mode textarea once "Paste a list" is chosen', () => {
      mockSections = sectionsWithMultiple;
      const { viewport, fire } = stubViewport(window.innerHeight - 300); // keyboard open
      render(<GroceryListView />);
      const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
      // getBoundingClientRect returns a fresh value on every call so a real
      // pin attempt always sees nonzero drift (jsdom/happy-dom don't lay
      // out content, so every element reports the same static rect
      // otherwise — a false negative, not a sign the pin didn't run).
      let n = 0;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ top: (n++) * 10 } as DOMRect)
      );
      fireEvent.click(screen.getByText('Add items'));
      fireEvent.click(screen.getByText('Paste a list'));

      viewport.height = window.innerHeight;
      fire();
      expect(scrollBy).toHaveBeenCalled();
    });
  });

  it('clicking section name opens rename mode', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Produce'));
    expect(screen.getByDisplayValue('Produce')).toBeInTheDocument();
  });

  it('renaming section and pressing Enter saves', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Produce'));

    const input = screen.getByDisplayValue('Produce');
    fireEvent.change(input, { target: { value: 'Fruits' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockRenameSection).toHaveBeenCalledWith('s1', 'Fruits');
  });

  it('shows store name on item with store_id', () => {
    mockSections = sectionsWithMultiple;
    mockStores = [{ id: 'st1', name: 'Costco', position: 0 }];
    render(<GroceryListView />);
    // "Costco" appears both in StoreFilterBar chip and item store label
    const costcoElements = screen.getAllByText('Costco');
    expect(costcoElements.length).toBeGreaterThanOrEqual(1);
  });

  it('copy list writes to clipboard', () => {
    mockSections = sectionsWithMultiple;
    const writeTextMock = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    render(<GroceryListView />);
    fireEvent.click(screen.getByLabelText('Clear options'));
    fireEvent.click(screen.getByText('Copy full list'));

    expect(writeTextMock).toHaveBeenCalled();
  });

  it('shows checked items with strikethrough styling', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    const butter = screen.getByText('Butter');
    expect(butter.className).toContain('line-through');
  });

  it('quantity +/- buttons in edit mode work', () => {
    mockSections = sectionsWithMultiple;
    render(<GroceryListView />);
    // Click on Bananas to edit (has quantity)
    fireEvent.click(screen.getByText('Bananas'));

    // Should see +/- buttons and the quantity display
    const plusBtn = screen.getByText('+');
    const minusBtn = screen.getByText('−');
    expect(plusBtn).toBeInTheDocument();
    expect(minusBtn).toBeInTheDocument();
  });

  it('edit mode shows StoreAutocomplete', () => {
    mockSections = sectionsWithMultiple;
    mockStores = [{ id: 'st1', name: 'Costco', position: 0 }];
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Apples'));
    expect(screen.getByPlaceholderText('Assign store...')).toBeInTheDocument();
  });
});
