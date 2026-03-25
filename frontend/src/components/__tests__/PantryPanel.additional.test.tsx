import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PantryPanel } from '../PantryPanel';

const mockAddSection = vi.fn();
const mockDeleteSection = vi.fn();
const mockAddItem = vi.fn();
const mockUpdateItem = vi.fn();
const mockAdjustQuantity = vi.fn();
const mockRemoveItem = vi.fn();
const mockClearAll = vi.fn();
const mockReorderSections = vi.fn();
const mockReorderItems = vi.fn();
const mockRenameSection = vi.fn();
const mockMoveItem = vi.fn();

let mockSections: any[] = [];
let mockLoading = false;

vi.mock('../../hooks/usePantry', () => ({
  usePantry: () => ({
    sections: mockSections,
    loading: mockLoading,
    addSection: mockAddSection,
    deleteSection: mockDeleteSection,
    addItem: mockAddItem,
    updateItem: mockUpdateItem,
    adjustQuantity: mockAdjustQuantity,
    removeItem: mockRemoveItem,
    clearAll: mockClearAll,
    reorderSections: mockReorderSections,
    reorderItems: mockReorderItems,
    renameSection: mockRenameSection,
    moveItem: mockMoveItem,
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

const sampleSections = [
  {
    id: 's1', name: 'Fridge', position: 0,
    items: [
      { id: '1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-01-01' },
      { id: '2', section_id: 's1', name: 'Eggs', quantity: 12, position: 1, updated_at: '2026-01-01' },
    ],
  },
  {
    id: 's2', name: 'Pantry', position: 1,
    items: [
      { id: '3', section_id: 's2', name: 'Rice', quantity: 1, position: 0, updated_at: '2026-01-01' },
    ],
  },
];

describe('PantryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = [];
    mockLoading = false;
  });

  it('shows loading spinner when loading', () => {
    mockLoading = true;
    render(<PantryPanel />);
    expect(screen.getByTestId('pantry-loading')).toBeInTheDocument();
  });

  it('shows empty state when no sections', () => {
    mockSections = [];
    render(<PantryPanel />);
    expect(screen.getByText('No pantry items yet. Add a section to get started.')).toBeInTheDocument();
  });

  it('shows "+ Add section" button', () => {
    render(<PantryPanel />);
    expect(screen.getByText('+ Add section')).toBeInTheDocument();
  });

  it('clicking "+ Add section" shows input field', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('+ Add section'));
    expect(screen.getByPlaceholderText('Section name...')).toBeInTheDocument();
  });

  it('renders sections with items', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    expect(screen.getByText('Fridge')).toBeInTheDocument();
    expect(screen.getByText('Pantry')).toBeInTheDocument();
    expect(screen.getByText('Milk')).toBeInTheDocument();
    expect(screen.getByText('Eggs')).toBeInTheDocument();
    expect(screen.getByText('Rice')).toBeInTheDocument();
  });

  it('shows item quantities', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('shows item count in section header', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    expect(screen.getByText('2 items')).toBeInTheDocument();
    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('clicking + button on item calls adjustQuantity with +1', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    fireEvent.click(screen.getByLabelText('Increase Milk'));
    expect(mockAdjustQuantity).toHaveBeenCalledWith('1', 1);
  });

  it('clicking - button on item calls adjustQuantity with -1', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    fireEvent.click(screen.getByLabelText('Decrease Milk'));
    expect(mockAdjustQuantity).toHaveBeenCalledWith('1', -1);
  });

  it('clicking remove button calls removeItem', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    fireEvent.click(screen.getByLabelText('Remove Milk'));
    expect(mockRemoveItem).toHaveBeenCalledWith('1');
  });

  it('clicking delete section button calls deleteSection', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    fireEvent.click(screen.getByLabelText('Delete section Fridge'));
    expect(mockDeleteSection).toHaveBeenCalledWith('s1');
  });

  it('shows "+ Add item" button in section', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    const addButtons = screen.getAllByText('+ Add item');
    expect(addButtons).toHaveLength(2);
  });

  it('shows clear menu when items exist', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    fireEvent.click(screen.getByLabelText('Clear options'));
    expect(screen.getByText('Clear all items')).toBeInTheDocument();
  });

  it('clear all calls clearAll', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    fireEvent.click(screen.getByLabelText('Clear options'));
    fireEvent.click(screen.getByText('Clear all items'));
    expect(mockClearAll).toHaveBeenCalled();
  });

  it('adding section calls addSection', async () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('+ Add section'));
    const input = screen.getByPlaceholderText('Section name...');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => {
      expect(mockAddSection).toHaveBeenCalledWith('Freezer');
    });
  });

  it('cancel hides section input', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('+ Add section'));
    expect(screen.getByPlaceholderText('Section name...')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByPlaceholderText('Section name...')).not.toBeInTheDocument();
  });

  it('clicking section name opens rename input', () => {
    mockSections = sampleSections;
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));
    // Should show an input with the section name
    const input = screen.getByDisplayValue('Fridge');
    expect(input.tagName).toBe('INPUT');
  });
});
