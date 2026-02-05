import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PantryPanel } from '../PantryPanel';
import { usePantry } from '../../hooks/usePantry';

vi.mock('../../hooks/usePantry', () => ({
  usePantry: vi.fn(),
}));

describe('PantryPanel', () => {
  const mockUsePantry = vi.mocked(usePantry);
  const addItem = vi.fn();
  const updateItem = vi.fn();
  const removeItem = vi.fn();
  const adjustQuantity = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePantry.mockReturnValue({
      items: [],
      addItem,
      updateItem,
      removeItem,
      adjustQuantity,
    });
  });

  it('renders empty state and adds item in full view', async () => {
    const user = userEvent.setup();
    render(<PantryPanel />);

    expect(screen.getByText('Pantry')).toBeInTheDocument();
    expect(screen.getByText('No pantry items yet.')).toBeInTheDocument();

    await act(async () => {
      await user.type(screen.getByPlaceholderText('e.g. Meatballs'), 'Meatballs');
      const qtyInput = screen.getByRole('spinbutton');
      await user.clear(qtyInput);
      await user.type(qtyInput, '3');
      await user.click(screen.getByRole('button', { name: 'Add' }));
    });

    expect(addItem).toHaveBeenCalledWith({ name: 'Meatballs', quantity: 3 });
  });

  it('handles non-numeric quantity input by coercing to 0', () => {
    render(<PantryPanel />);

    act(() => {
      fireEvent.change(screen.getByPlaceholderText('e.g. Meatballs'), {
        target: { value: 'Rice' },
      });
      fireEvent.change(screen.getByRole('spinbutton'), {
        target: { value: 'abc' },
      });
      fireEvent.submit(screen.getByRole('button', { name: 'Add' }).closest('form')!);
    });

    expect(addItem).toHaveBeenCalledWith({ name: 'Rice', quantity: 0 });
  });

  it('renders items and actions in compact view', () => {
    mockUsePantry.mockReturnValue({
      items: [
        { id: '1', name: 'Meatballs', quantity: 2, updated_at: '2026-01-01T00:00:00Z' },
      ],
      addItem,
      updateItem,
      removeItem,
      adjustQuantity,
    });

    render(<PantryPanel compactView />);

    const nameInput = screen.getByDisplayValue('Meatballs');
    fireEvent.change(nameInput, { target: { value: 'Turkey Meatballs' } });
    expect(updateItem).toHaveBeenCalledWith('1', { name: 'Turkey Meatballs' });

    fireEvent.click(screen.getByLabelText('Decrease Meatballs'));
    expect(adjustQuantity).toHaveBeenCalledWith('1', -1);

    fireEvent.click(screen.getByLabelText('Increase Meatballs'));
    expect(adjustQuantity).toHaveBeenCalledWith('1', 1);

    fireEvent.click(screen.getByLabelText('Remove Meatballs'));
    expect(removeItem).toHaveBeenCalledWith('1');
  });
});
