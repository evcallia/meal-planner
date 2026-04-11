import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ItemAutocomplete } from '../ItemAutocomplete';

const items = new Map<string, string | null>([
  ['sweet potato', 'store-1'],
  ['sweet chili sauce', 'store-2'],
  ['milk', null],
  ['bread', 'store-1'],
]);
const currentListItemNames = new Set(['milk', 'bread']);

function renderAutocomplete(overrides = {}) {
  const props = {
    value: '',
    onChange: vi.fn(),
    onSelect: vi.fn(),
    items,
    currentListItemNames,
    onDelete: vi.fn(),
    placeholder: 'Item name...',
    ...overrides,
  };
  return { ...render(<ItemAutocomplete {...props} />), props };
}

describe('ItemAutocomplete', () => {
  it('shows filtered suggestions when typing', () => {
    renderAutocomplete({ value: 'swe' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);

    expect(screen.getByText('Sweet Potato')).toBeInTheDocument();
    expect(screen.getByText('Sweet Chili Sauce')).toBeInTheDocument();
    expect(screen.queryByText('Milk')).not.toBeInTheDocument();
  });

  it('calls onSelect when clicking a suggestion', () => {
    const { props } = renderAutocomplete({ value: 'swe' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);

    fireEvent.click(screen.getByText('Sweet Potato'));
    expect(props.onSelect).toHaveBeenCalledWith('Sweet Potato');
  });

  it('shows delete button only for items not on the current list', () => {
    renderAutocomplete({ value: '' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);

    const deleteButtons = screen.getAllByLabelText(/^Delete /);
    const deleteLabels = deleteButtons.map(b => b.getAttribute('aria-label'));
    expect(deleteLabels).toContain('Delete Sweet Potato');
    expect(deleteLabels).toContain('Delete Sweet Chili Sauce');
    expect(deleteLabels).not.toContain('Delete Milk');
    expect(deleteLabels).not.toContain('Delete Bread');
  });

  it('calls onDelete when clicking delete button', () => {
    const { props } = renderAutocomplete({ value: 'sweet p' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);

    fireEvent.click(screen.getByLabelText('Delete Sweet Potato'));
    expect(props.onDelete).toHaveBeenCalledWith('sweet potato');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('closes dropdown on Escape', () => {
    renderAutocomplete({ value: 'swe' });
    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.focus(input);
    expect(screen.getByText('Sweet Potato')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByText('Sweet Potato')).not.toBeInTheDocument();
  });

  it('does not show dropdown when value is empty and not focused', () => {
    renderAutocomplete({ value: '' });
    expect(screen.queryByText('Sweet Potato')).not.toBeInTheDocument();
  });
});
