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
const mockDeleteSection = vi.fn();
const mockCreateSection = vi.fn();
const mockMoveItem = vi.fn();
const mockBatchUpdateStoreId = vi.fn();

let mockSections: any[] = [];
let mockLoading = false;

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
    deleteSection: mockDeleteSection,
    createSection: mockCreateSection,
    moveItem: mockMoveItem,
    batchUpdateStoreId: mockBatchUpdateStoreId,
    itemDefaultsMap: new Map(),
    removeItemDefault: vi.fn(),
  }),
}));

vi.mock('../../hooks/useStores', () => ({
  useStores: () => ({
    stores: [],
    loading: false,
    createStore: vi.fn(),
    renameStore: vi.fn(),
    removeStore: vi.fn(),
    reorderStores: vi.fn(),
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
  parseGroceryText: vi.fn(() => []),
}));

const sectionsFixture = [
  {
    id: 'sec-produce', name: 'Produce', position: 0,
    items: [
      { id: 'item-1', section_id: 'sec-produce', name: 'Apples', quantity: null, checked: false, position: 0, store_id: null, updated_at: '2026-01-01' },
    ],
  },
  {
    id: 'sec-dairy', name: 'Dairy', position: 1,
    items: [],
  },
];

function openEditForm() {
  fireEvent.click(screen.getByText('Apples'));
  expect(screen.getByText('Save')).toBeInTheDocument();
}

describe('GroceryListView - edit form section change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = sectionsFixture;
    mockLoading = false;
  });

  it('moves the item when its section is changed in the edit form', async () => {
    render(<GroceryListView />);
    openEditForm();

    const sectionInput = screen.getByPlaceholderText('Section');
    fireEvent.change(sectionInput, { target: { value: 'Dairy' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockMoveItem).toHaveBeenCalledWith('sec-produce', 0, 'sec-dairy', 0);
    });
    expect(mockCreateSection).not.toHaveBeenCalled();
  });

  it('creates a new section then moves when the name does not match', async () => {
    mockCreateSection.mockResolvedValue({ id: 'sec-new', name: 'Frozen', position: 2, items: [] });
    render(<GroceryListView />);
    openEditForm();

    const sectionInput = screen.getByPlaceholderText('Section');
    fireEvent.change(sectionInput, { target: { value: 'Frozen' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(mockCreateSection).toHaveBeenCalledWith('Frozen');
    });
    await waitFor(() => {
      expect(mockMoveItem).toHaveBeenCalledWith('sec-produce', 0, 'sec-new', 0);
    });
  });

  it('does not move when the section is unchanged', async () => {
    render(<GroceryListView />);
    openEditForm();

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(screen.queryByText('Save')).not.toBeInTheDocument();
    });
    expect(mockEditItem).not.toHaveBeenCalled();
    expect(mockMoveItem).not.toHaveBeenCalled();
    expect(mockCreateSection).not.toHaveBeenCalled();
  });

  it('shows matching sections in the combobox dropdown', () => {
    render(<GroceryListView />);
    openEditForm();

    const sectionInput = screen.getByPlaceholderText('Section');
    fireEvent.focus(sectionInput);
    fireEvent.change(sectionInput, { target: { value: 'Da' } });

    const option = screen.getAllByText('Dairy').find(el => el.tagName === 'BUTTON');
    expect(option).toBeTruthy();
    fireEvent.click(option!);
    expect(sectionInput).toHaveValue('Dairy');
  });
});
