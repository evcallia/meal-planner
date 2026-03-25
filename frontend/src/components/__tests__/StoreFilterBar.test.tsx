import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StoreFilterBar } from '../StoreFilterBar';
import type { Store } from '../../types';

const stores: Store[] = [
  { id: 'st1', name: 'Costco', position: 0 },
  { id: 'st2', name: "Trader Joe's", position: 1 },
];

describe('StoreFilterBar', () => {
  const mockOnFilterChange = vi.fn();
  const mockOnRename = vi.fn();
  const mockOnDelete = vi.fn();
  const mockOnReorder = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no stores', () => {
    const { container } = render(
      <StoreFilterBar
        stores={[]}
        activeStoreId={null}
        onFilterChange={mockOnFilterChange}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders store chips', () => {
    render(
      <StoreFilterBar
        stores={stores}
        activeStoreId={null}
        onFilterChange={mockOnFilterChange}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    expect(screen.getByText('Costco')).toBeInTheDocument();
    expect(screen.getByText("Trader Joe's")).toBeInTheDocument();
  });

  it('highlights active store chip', () => {
    render(
      <StoreFilterBar
        stores={stores}
        activeStoreId="st1"
        onFilterChange={mockOnFilterChange}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    const costcoButton = screen.getByText('Costco');
    expect(costcoButton.className).toContain('bg-blue-500');
  });

  it('short tap (pointerDown + pointerUp) on chip toggles filter', () => {
    render(
      <StoreFilterBar
        stores={stores}
        activeStoreId={null}
        onFilterChange={mockOnFilterChange}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(costcoButton);
    expect(mockOnFilterChange).toHaveBeenCalledWith('st1');
  });

  it('short tap on active store deselects it', () => {
    render(
      <StoreFilterBar
        stores={stores}
        activeStoreId="st1"
        onFilterChange={mockOnFilterChange}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(costcoButton);
    expect(mockOnFilterChange).toHaveBeenCalledWith(null);
  });

  it('does not show edit popover initially', () => {
    render(
      <StoreFilterBar
        stores={stores}
        activeStoreId={null}
        onFilterChange={mockOnFilterChange}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });
});
