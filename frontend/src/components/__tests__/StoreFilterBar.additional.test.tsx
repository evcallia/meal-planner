import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { StoreFilterBar } from '../StoreFilterBar';
import type { Store } from '../../types';

const stores: Store[] = [
  { id: 'st1', name: 'Costco', position: 0 },
  { id: 'st2', name: "Trader Joe's", position: 1 },
  { id: 'st3', name: 'Whole Foods', position: 2 },
];

describe('StoreFilterBar - additional coverage', () => {
  const mockOnFilterChange = vi.fn();
  const mockOnRename = vi.fn();
  const mockOnDelete = vi.fn();
  const mockOnReorder = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const { afterEach: _ } = { afterEach: () => {} }; // eslint trick to avoid unused var

  it('long press then release opens edit popover', async () => {
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

    // Simulate long press
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });

    // Advance past the 300ms long press timeout
    act(() => {
      vi.advanceTimersByTime(350);
    });

    // Release without moving
    fireEvent.pointerUp(costcoButton);

    // Should show edit popover
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Costco')).toBeInTheDocument();
  });

  it('edit popover rename and save calls onRename', async () => {
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

    // Long press to open edit
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    act(() => { vi.advanceTimersByTime(350); });
    fireEvent.pointerUp(costcoButton);

    // Change name
    const input = screen.getByDisplayValue('Costco');
    fireEvent.change(input, { target: { value: 'New Costco' } });
    fireEvent.click(screen.getByText('Save'));

    expect(mockOnRename).toHaveBeenCalledWith('st1', 'New Costco');
  });

  it('edit popover pressing Enter saves', () => {
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
    act(() => { vi.advanceTimersByTime(350); });
    fireEvent.pointerUp(costcoButton);

    const input = screen.getByDisplayValue('Costco');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockOnRename).toHaveBeenCalledWith('st1', 'Renamed');
  });

  it('edit popover pressing Escape closes', () => {
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
    act(() => { vi.advanceTimersByTime(350); });
    fireEvent.pointerUp(costcoButton);

    const input = screen.getByDisplayValue('Costco');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('edit popover Delete button calls onDelete', () => {
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
    act(() => { vi.advanceTimersByTime(350); });
    fireEvent.pointerUp(costcoButton);

    fireEvent.click(screen.getByText('Delete'));

    expect(mockOnDelete).toHaveBeenCalledWith('st1');
    // Should also clear the active filter since deleted store was active
    expect(mockOnFilterChange).toHaveBeenCalledWith(null);
  });

  it('edit popover Cancel button closes', () => {
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
    act(() => { vi.advanceTimersByTime(350); });
    fireEvent.pointerUp(costcoButton);

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('moving pointer after long-press timer cancels long press', () => {
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

    // Move before long press fires (cancels)
    fireEvent.pointerMove(costcoButton, { clientX: 200, clientY: 100 });

    act(() => { vi.advanceTimersByTime(350); });
    fireEvent.pointerUp(costcoButton);

    // Should not open edit popover — should be a filter toggle instead
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });

  it('renders all store chips', () => {
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
    expect(screen.getByText('Whole Foods')).toBeInTheDocument();
  });

  it('chips have data-chip-index attributes', () => {
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

    const chips = document.querySelectorAll('[data-chip-index]');
    expect(chips.length).toBe(3);
  });
});
