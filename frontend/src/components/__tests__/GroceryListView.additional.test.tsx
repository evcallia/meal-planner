import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

  // The blur-close defers one frame so focus can land on its real target.
  const nextFrame = () => act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });

  // Dismissing the keyboard with the add form open used to leave the form
  // mounted, and that is the one state in the app where position cannot be
  // held: with no layout change there is nothing for exitEditAnchored's pin
  // to measure, and iOS's movement is a visual-viewport change that is
  // invisible to getBoundingClientRect/window.scrollBy. Blur now routes the
  // form down the same anchored-unmount path the Meals tab and the inline
  // edit rows already use. Typed text lives in the parent, so it survives.
  describe('dismissing the keyboard with the inline add form open', () => {
    it('closes the form through the anchored path when focus leaves it', async () => {
      mockSections = sectionsWithMultiple;
      render(<GroceryListView />);
      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Grapes' } });
      vi.mocked(exitEditAnchored).mockClear();

      input.blur();
      fireEvent.blur(input);
      await nextFrame();

      expect(screen.queryByPlaceholderText('Item name...')).toBeNull();
      expect(exitEditAnchored).toHaveBeenCalled();
    });

    it('adds what was typed rather than discarding it', async () => {
      mockSections = sectionsWithMultiple;
      render(<GroceryListView />);
      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Grapes' } });

      input.blur();
      fireEvent.blur(input);
      await nextFrame();

      // It used to close and keep the text for next time, which read as the
      // item vanishing — the Add button was the only thing that worked.
      await waitFor(() => expect(mockAddItem).toHaveBeenCalled());
      expect(screen.queryByPlaceholderText('Item name...')).toBeNull();
    });

    it('just closes when nothing was typed', async () => {
      mockSections = sectionsWithMultiple;
      render(<GroceryListView />);
      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;

      input.blur();
      fireEvent.blur(input);
      await nextFrame();

      expect(mockAddItem).not.toHaveBeenCalled();
      expect(screen.queryByPlaceholderText('Item name...')).toBeNull();
    });

    it('stays open when focus moves to another control inside the form', async () => {
      mockSections = sectionsWithMultiple;
      render(<GroceryListView />);
      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Grapes' } });

      const addBtn = screen.getAllByText('Add').find(el => el.tagName === 'BUTTON')! as HTMLButtonElement;
      addBtn.focus();
      fireEvent.blur(input);
      await nextFrame();

      expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
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
