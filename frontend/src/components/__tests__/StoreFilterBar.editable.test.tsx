import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { StoreFilterBar } from '../StoreFilterBar';
import type { Store } from '../../types';

// Recipe filter chips reuse StoreFilterBar with editable=false (derived
// data, not a user-managed entity like a store or packing bag) — the
// long-press popover should offer only exclude/include + cancel, no rename
// input or Delete button.
const recipeChips: Store[] = [
  { id: 'r1', name: 'Fig Cocktail', position: 0 },
  { id: 'r2', name: 'Thai Curry', position: 1 },
];

describe('StoreFilterBar - editable=false (recipe chips)', () => {
  const mockOnToggleSelect = vi.fn();
  const mockOnRemoveExclusion = vi.fn();
  const mockOnExclude = vi.fn();
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

  const longPress = (label: string) => {
    const btn = screen.getByText(label);
    fireEvent.pointerDown(btn, { clientX: 100, clientY: 100 });
    act(() => { vi.advanceTimersByTime(350); });
    fireEvent.pointerUp(btn);
  };

  it('long-press popover has no rename input or Delete button', () => {
    render(
      <StoreFilterBar
        stores={recipeChips}
        selectedStoreIds={new Set<string>()}
        excludedStoreIds={new Set<string>()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        editable={false}
      />
    );

    longPress('Fig Cocktail');

    expect(screen.queryByDisplayValue('Fig Cocktail')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.getByText('Exclude from list')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('exclude still works with editable=false', () => {
    render(
      <StoreFilterBar
        stores={recipeChips}
        selectedStoreIds={new Set<string>()}
        excludedStoreIds={new Set<string>()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
        editable={false}
      />
    );

    longPress('Fig Cocktail');
    fireEvent.click(screen.getByText('Exclude from list'));
    expect(mockOnExclude).toHaveBeenCalledWith('r1');
  });

  it('defaults to editable (stores keep rename + delete)', () => {
    render(
      <StoreFilterBar
        stores={recipeChips}
        selectedStoreIds={new Set<string>()}
        excludedStoreIds={new Set<string>()}
        onToggleSelect={mockOnToggleSelect}
        onRemoveExclusion={mockOnRemoveExclusion}
        onExclude={mockOnExclude}
        onRename={mockOnRename}
        onDelete={mockOnDelete}
        onReorder={mockOnReorder}
      />
    );

    longPress('Fig Cocktail');
    expect(screen.getByDisplayValue('Fig Cocktail')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });
});
