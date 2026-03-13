import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PantryPanel } from '../PantryPanel';
import { usePantry } from '../../hooks/usePantry';

vi.mock('../../hooks/usePantry', () => ({
  usePantry: vi.fn(),
}));

vi.mock('../../contexts/UndoContext', () => ({
  useUndo: () => ({ canUndo: false, canRedo: false, pushAction: vi.fn(), undo: vi.fn(), redo: vi.fn() }),
}));

vi.mock('../../hooks/useDragReorder', () => ({
  useDragReorder: () => ({
    dragState: { isDragging: false, dragIndex: -1 },
    getDragHandlers: () => ({}),
    getHandleMouseDown: () => () => {},
  }),
  computeShiftTransform: () => null,
}));

describe('PantryPanel', () => {
  const mockUsePantry = vi.mocked(usePantry);
  const addSection = vi.fn();
  const deleteSection = vi.fn();
  const addItem = vi.fn();
  const updateItem = vi.fn();
  const removeItem = vi.fn();
  const adjustQuantity = vi.fn();
  const clearAll = vi.fn();
  const reorderSections = vi.fn();
  const reorderItems = vi.fn();
  const renameSection = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePantry.mockReturnValue({
      sections: [],
      loading: false,
      addSection,
      deleteSection,
      addItem,
      updateItem,
      removeItem,
      adjustQuantity,
      clearAll,
      reorderSections,
      reorderItems,
      renameSection,
    });
  });

  it('renders empty state', () => {
    render(<PantryPanel />);
    expect(screen.getByText('No pantry items yet. Add a section to get started.')).toBeInTheDocument();
  });

  it('renders loading state', () => {
    mockUsePantry.mockReturnValue({
      sections: [],
      loading: true,
      addSection,
      deleteSection,
      addItem,
      updateItem,
      removeItem,
      adjustQuantity,
      clearAll,
      reorderSections,
      reorderItems,
      renameSection,
    });

    render(<PantryPanel />);
    expect(screen.getByTestId('pantry-loading')).toBeInTheDocument();
  });

  it('renders sections with items and handles quantity adjustments', () => {
    mockUsePantry.mockReturnValue({
      sections: [
        {
          id: 's1', name: 'Fridge', position: 0,
          items: [
            { id: '1', section_id: 's1', name: 'Meatballs', quantity: 2, position: 0, updated_at: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
      loading: false,
      addSection,
      deleteSection,
      addItem,
      updateItem,
      removeItem,
      adjustQuantity,
      clearAll,
      reorderSections,
      reorderItems,
      renameSection,
    });

    render(<PantryPanel />);

    expect(screen.getByText('Fridge')).toBeInTheDocument();
    expect(screen.getByText('Meatballs')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Decrease Meatballs'));
    expect(adjustQuantity).toHaveBeenCalledWith('1', -1);

    fireEvent.click(screen.getByLabelText('Increase Meatballs'));
    expect(adjustQuantity).toHaveBeenCalledWith('1', 1);

    fireEvent.click(screen.getByLabelText('Remove Meatballs'));
    expect(removeItem).toHaveBeenCalledWith('1');
  });
});
