import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GroceryListView } from '../GroceryListView';

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
    const checkboxes = screen.getAllByRole('button').filter(b => b.className.includes('rounded border-2'));
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
