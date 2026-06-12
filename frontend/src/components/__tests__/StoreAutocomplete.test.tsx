import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoreAutocomplete } from '../StoreAutocomplete';
import type { Store } from '../../types';

const stores: Store[] = [
  { id: 'st1', name: 'Costco', position: 0 },
  { id: 'st2', name: "Trader Joe's", position: 1 },
  { id: 'st3', name: 'Whole Foods', position: 2 },
];

describe('StoreAutocomplete', () => {
  const mockOnSelect = vi.fn();
  const mockOnCreate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows input placeholder when no store selected', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    expect(screen.getByPlaceholderText('Assign store...')).toBeInTheDocument();
  });

  it('shows selected store name in input when store is selected', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId="st1" onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    const input = screen.getByPlaceholderText('Assign store...') as HTMLInputElement;
    expect(input.value).toBe('Costco');
  });

  it('shows store list on focus', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    fireEvent.focus(screen.getByPlaceholderText('Assign store...'));
    expect(screen.getByText('Costco')).toBeInTheDocument();
    expect(screen.getByText("Trader Joe's")).toBeInTheDocument();
    expect(screen.getByText('Whole Foods')).toBeInTheDocument();
  });

  it('filters stores based on query', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    const input = screen.getByPlaceholderText('Assign store...');
    fireEvent.change(input, { target: { value: 'cost' } });
    expect(screen.getByText('Costco')).toBeInTheDocument();
    expect(screen.queryByText("Trader Joe's")).not.toBeInTheDocument();
  });

  it('selecting a store calls onSelect', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    fireEvent.focus(screen.getByPlaceholderText('Assign store...'));
    fireEvent.click(screen.getByText('Costco'));
    expect(mockOnSelect).toHaveBeenCalledWith('st1');
  });

  it('shows "Create" option for non-matching query', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    const input = screen.getByPlaceholderText('Assign store...');
    fireEvent.change(input, { target: { value: 'Safeway' } });
    expect(screen.getByText(/Create "Safeway"/)).toBeInTheDocument();
  });

  it('creating a new store calls onCreate then onSelect', async () => {
    const newStore: Store = { id: 'st4', name: 'Safeway', position: 3 };
    mockOnCreate.mockResolvedValue(newStore);

    render(
      <StoreAutocomplete stores={stores} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    const input = screen.getByPlaceholderText('Assign store...');
    fireEvent.change(input, { target: { value: 'Safeway' } });
    fireEvent.click(screen.getByText(/Create "Safeway"/));

    await waitFor(() => {
      expect(mockOnCreate).toHaveBeenCalledWith('Safeway');
      expect(mockOnSelect).toHaveBeenCalledWith('st4');
    });
  });

  it('clear button removes the store and closes the dropdown', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId="st1" onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    fireEvent.click(screen.getByRole('button', { name: /remove store/i }));
    expect(mockOnSelect).toHaveBeenCalledWith(null);
    // Dropdown stays closed so the form's Save button isn't covered
    expect(screen.queryByText("Trader Joe's")).not.toBeInTheDocument();
  });

  it('closes the dropdown when the input loses focus', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    const input = screen.getByPlaceholderText('Assign store...');
    fireEvent.focus(input);
    expect(screen.getByText('Costco')).toBeInTheDocument();
    fireEvent.blur(input);
    expect(screen.queryByText('Costco')).not.toBeInTheDocument();
  });

  it('still selects a store via mousedown+click without blur closing first', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    const input = screen.getByPlaceholderText('Assign store...');
    fireEvent.focus(input);
    const option = screen.getByText('Costco');
    fireEvent.mouseDown(option); // preventDefault keeps focus on the input
    fireEvent.click(option);
    expect(mockOnSelect).toHaveBeenCalledWith('st1');
  });

  it('clear button appears when store is selected', () => {
    render(
      <StoreAutocomplete stores={stores} selectedStoreId="st1" onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    const clearButton = screen.getByRole('button', { name: /remove store/i });
    expect(clearButton).toBeInTheDocument();
  });

  it('shows "No stores yet" when no stores and no query', () => {
    render(
      <StoreAutocomplete stores={[]} selectedStoreId={null} onSelect={mockOnSelect} onCreate={mockOnCreate} />
    );
    fireEvent.focus(screen.getByPlaceholderText('Assign store...'));
    expect(screen.getByText('No stores yet')).toBeInTheDocument();
  });
});
