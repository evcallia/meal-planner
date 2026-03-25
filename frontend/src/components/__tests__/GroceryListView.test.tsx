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
    moveItem: mockMoveItem,
    batchUpdateStoreId: mockBatchUpdateStoreId,
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
  parseGroceryText: vi.fn((text: string) => {
    if (!text.trim()) return [];
    return [{ name: 'Produce', items: [{ name: 'Test', quantity: null }] }];
  }),
}));

const sampleSections = [
  {
    id: 's1', name: 'Produce', position: 0,
    items: [
      { id: 'i1', section_id: 's1', name: 'Bananas', quantity: '2', checked: false, position: 0, store_id: null, updated_at: '2026-01-01' },
      { id: 'i2', section_id: 's1', name: 'Apples', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01' },
      { id: 'i3', section_id: 's1', name: 'Old Lettuce', quantity: null, checked: true, position: 2, store_id: null, updated_at: '2026-01-01' },
    ],
  },
];

describe('GroceryListView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = [];
    mockLoading = false;
  });

  it('shows loading spinner when loading', () => {
    mockLoading = true;
    render(<GroceryListView />);
    expect(screen.getByTestId('grocery-loading')).toBeInTheDocument();
  });

  it('shows add textarea when no sections exist', () => {
    mockSections = [];
    render(<GroceryListView />);
    expect(screen.getByText('Add your grocery list')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Type or paste grocery list/)).toBeInTheDocument();
  });

  it('shows sections with unchecked items', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    expect(screen.getByText('Produce')).toBeInTheDocument();
    expect(screen.getByText('Bananas')).toBeInTheDocument();
    expect(screen.getByText('Apples')).toBeInTheDocument();
  });

  it('shows "Add items" button when has sections', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    expect(screen.getByText('Add items')).toBeInTheDocument();
  });

  it('clicking "Add items" shows textarea', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Add items'));
    expect(screen.getByText('Add items to grocery list')).toBeInTheDocument();
  });

  it('shows checked items section at bottom', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    expect(screen.getByText(/Checked/)).toBeInTheDocument();
    expect(screen.getByText('Old Lettuce')).toBeInTheDocument();
  });

  it('shows item count in section header', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    expect(screen.getByText('2 items')).toBeInTheDocument();
  });

  it('shows quantity for items that have one', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('shows "+ Add item" button in section', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    expect(screen.getByText('+ Add item')).toBeInTheDocument();
  });

  it('clicking clear menu button shows options', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    // Click the 3-dot menu button
    fireEvent.click(screen.getByLabelText('Clear options'));
    expect(screen.getByText('Clear all items')).toBeInTheDocument();
    expect(screen.getByText(/Clear checked/)).toBeInTheDocument();
    expect(screen.getByText('Copy list')).toBeInTheDocument();
  });

  it('clear all calls clearAll', async () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    fireEvent.click(screen.getByLabelText('Clear options'));
    fireEvent.click(screen.getByText('Clear all items'));
    expect(mockClearAll).toHaveBeenCalled();
  });

  it('clear checked calls clearChecked', async () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    fireEvent.click(screen.getByLabelText('Clear options'));
    fireEvent.click(screen.getByText(/Clear checked/));
    expect(mockClearChecked).toHaveBeenCalled();
  });

  it('submitting text input calls mergeList', async () => {
    mockSections = [];
    render(<GroceryListView />);

    const textarea = screen.getByPlaceholderText(/Type or paste grocery list/);
    fireEvent.change(textarea, { target: { value: '[Produce]\nBananas' } });

    // Click the "Add items" submit button
    const buttons = screen.getAllByText('Add items');
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => {
      expect(mockMergeList).toHaveBeenCalled();
    });
  });

  it('cancel button hides input area', () => {
    mockSections = sampleSections;
    render(<GroceryListView />);
    fireEvent.click(screen.getByText('Add items'));
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Add items to grocery list')).not.toBeInTheDocument();
  });
});
