import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
];

describe('PantryPanel - editing flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = sampleSections;
    mockLoading = false;
  });

  it('clicking item name opens edit mode', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));
    expect(screen.getByDisplayValue('Milk')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('editing name and saving calls updateItem', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.change(input, { target: { value: 'Oat Milk' } });
    fireEvent.click(screen.getByText('Save'));

    expect(mockUpdateItem).toHaveBeenCalledWith('1', { name: 'Oat Milk' });
  });

  it('pressing Enter in edit saves', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.change(input, { target: { value: 'Oat Milk' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockUpdateItem).toHaveBeenCalled();
  });

  it('pressing Escape in edit cancels', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockUpdateItem).not.toHaveBeenCalled();
    // Should exit edit mode
    expect(screen.queryByDisplayValue('Milk')).not.toBeInTheDocument();
  });

  it('Cancel button exits edit mode without saving', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.change(input, { target: { value: 'Changed' } });

    // Find the Cancel button in the edit form
    const cancelBtns = screen.getAllByText('Cancel');
    fireEvent.click(cancelBtns[cancelBtns.length - 1]);

    expect(mockUpdateItem).not.toHaveBeenCalled();
  });

  it('clicking section name opens rename mode', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));
    expect(screen.getByDisplayValue('Fridge')).toBeInTheDocument();
  });

  it('renaming section and pressing Enter saves', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));

    const input = screen.getByDisplayValue('Fridge');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockRenameSection).toHaveBeenCalledWith('s1', 'Freezer');
  });

  it('renaming section and pressing Escape cancels', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));

    const input = screen.getByDisplayValue('Fridge');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockRenameSection).not.toHaveBeenCalled();
  });

  it('clicking "+ Add item" shows inline form with qty input', () => {
    render(<PantryPanel />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
    // Should have a number input for quantity
    const qtyInput = screen.getByDisplayValue('1');
    expect(qtyInput).toBeInTheDocument();
  });

  it('section add form submits on Enter keypress in section name input', async () => {
    mockSections = [];
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('+ Add section'));

    const input = screen.getByPlaceholderText('Section name...');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockAddSection).toHaveBeenCalledWith('Freezer');
  });

  it('section add form cancels on Escape', () => {
    mockSections = [];
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('+ Add section'));

    const input = screen.getByPlaceholderText('Section name...');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByPlaceholderText('Section name...')).not.toBeInTheDocument();
  });

  it('does not save unchanged name on edit', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    // Don't change the name, just save
    fireEvent.click(screen.getByText('Save'));

    expect(mockUpdateItem).not.toHaveBeenCalled();
  });

  it('does not save empty name on edit', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    expect(mockUpdateItem).not.toHaveBeenCalled();
  });

  it('onBlur commits section rename', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));

    const input = screen.getByDisplayValue('Fridge');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.blur(input);

    expect(mockRenameSection).toHaveBeenCalledWith('s1', 'Freezer');
  });
});
