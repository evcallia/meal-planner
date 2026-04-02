import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StoreFilterBar } from '../StoreFilterBar';
import type { Store } from '../../types';

const stores: Store[] = [
  { id: 'st1', name: 'Costco', position: 0 },
  { id: 'st2', name: "Trader Joe's", position: 1 },
];

describe('StoreFilterBar', () => {
  const mockOnToggleSelect = vi.fn();
  const mockOnRemoveExclusion = vi.fn();
  const mockOnExclude = vi.fn();
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
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
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
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    expect(screen.getByText('Costco')).toBeInTheDocument();
    expect(screen.getByText("Trader Joe's")).toBeInTheDocument();
  });

  it('highlights selected store chips with blue', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set(['st1'])}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    const costcoButton = screen.getByText('Costco');
    expect(costcoButton.className).toContain('bg-blue-500');
  });

  it('short tap calls onToggleSelect', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    const costcoButton = screen.getByText('Costco');
    fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(costcoButton);
    expect(mockOnToggleSelect).toHaveBeenCalledWith('st1');
  });

  it('multiple chips can be selected simultaneously', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set(['st1', 'st2'])}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    const costcoButton = screen.getByText('Costco');
    const traderButton = screen.getByText("Trader Joe's");
    expect(costcoButton.className).toContain('bg-blue-500');
    expect(traderButton.className).toContain('bg-blue-500');
  });

  it('does not show edit popover initially', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  describe('exclude in edit popover', () => {
    it('shows "Exclude from list" for non-excluded store in popover', () => {
      vi.useFakeTimers();
      render(
        <StoreFilterBar
          stores={stores}
          selectedStoreIds={new Set()}
          excludedStoreIds={new Set()}
          onToggleSelect={mockOnToggleSelect}
          onRemoveExclusion={mockOnRemoveExclusion}
          onExclude={mockOnExclude}
          onRename={mockOnRename}
          onDelete={mockOnDelete}
          onReorder={mockOnReorder}
        />
      );
      const costcoButton = screen.getByText('Costco');
      fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(300);
      fireEvent.pointerUp(costcoButton);
      expect(screen.getByText('Exclude from list')).toBeInTheDocument();
      vi.useRealTimers();
    });

    it('shows "Include in list" for excluded store in popover', () => {
      vi.useFakeTimers();
      render(
        <StoreFilterBar
          stores={stores}
          selectedStoreIds={new Set()}
          excludedStoreIds={new Set(['st1'])}
          onToggleSelect={mockOnToggleSelect}
          onRemoveExclusion={mockOnRemoveExclusion}
          onExclude={mockOnExclude}
          onRename={mockOnRename}
          onDelete={mockOnDelete}
          onReorder={mockOnReorder}
        />
      );
      const costcoButton = screen.getByText('Costco');
      fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(300);
      fireEvent.pointerUp(costcoButton);
      expect(screen.getByText('Include in list')).toBeInTheDocument();
      vi.useRealTimers();
    });

    it('clicking "Exclude from list" calls onExclude', () => {
      vi.useFakeTimers();
      render(
        <StoreFilterBar
          stores={stores}
          selectedStoreIds={new Set()}
          excludedStoreIds={new Set()}
          onToggleSelect={mockOnToggleSelect}
          onRemoveExclusion={mockOnRemoveExclusion}
          onExclude={mockOnExclude}
          onRename={mockOnRename}
          onDelete={mockOnDelete}
          onReorder={mockOnReorder}
        />
      );
      const costcoButton = screen.getByText('Costco');
      fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(300);
      fireEvent.pointerUp(costcoButton);
      fireEvent.click(screen.getByText('Exclude from list'));
      expect(mockOnExclude).toHaveBeenCalledWith('st1');
      vi.useRealTimers();
    });

    it('clicking "Include in list" calls onRemoveExclusion', () => {
      vi.useFakeTimers();
      render(
        <StoreFilterBar
          stores={stores}
          selectedStoreIds={new Set()}
          excludedStoreIds={new Set(['st1'])}
          onToggleSelect={mockOnToggleSelect}
          onRemoveExclusion={mockOnRemoveExclusion}
          onExclude={mockOnExclude}
          onRename={mockOnRename}
          onDelete={mockOnDelete}
          onReorder={mockOnReorder}
        />
      );
      const costcoButton = screen.getByText('Costco');
      fireEvent.pointerDown(costcoButton, { clientX: 100, clientY: 100 });
      vi.advanceTimersByTime(300);
      fireEvent.pointerUp(costcoButton);
      fireEvent.click(screen.getByText('Include in list'));
      expect(mockOnRemoveExclusion).toHaveBeenCalledWith('st1');
      vi.useRealTimers();
    });
  });
});
