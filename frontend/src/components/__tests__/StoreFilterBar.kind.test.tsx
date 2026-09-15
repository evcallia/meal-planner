import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoreFilterBar } from '../StoreFilterBar';
import type { Store } from '../../types';

// Store vs. recipe chip distinction: solid fill (stores) vs. outlined +
// leading icon (recipes) — the signal must survive selection/exclusion, not
// just the resting state, and must not depend on color alone (see CLAUDE.md
// "store vs. recipe" UI note).

const stores: Store[] = [{ id: 'st1', name: 'Costco', position: 0 }];
const recipes: Store[] = [{ id: 'r1', name: 'Fig Cocktail', position: 0 }];

const baseProps = {
  onToggleSelect: vi.fn(),
  onRemoveExclusion: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onReorder: vi.fn(),
  onExclude: vi.fn(),
};

describe('StoreFilterBar - store vs. recipe kind', () => {
  it('defaults to kind="store": solid fill, no icon, data-chip-kind="store"', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set(['st1'])}
        excludedStoreIds={new Set()}
        {...baseProps}
      />
    );
    const chip = screen.getByText('Costco');
    expect(chip).toHaveAttribute('data-chip-kind', 'store');
    expect(chip.className).toContain('bg-blue-500');
    expect(chip.querySelector('[data-testid="recipe-icon"]')).not.toBeInTheDocument();
  });

  it('kind="recipe" renders an outlined chip with a leading icon and a distinct accessible name', () => {
    render(
      <StoreFilterBar
        stores={recipes}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        {...baseProps}
        editable={false}
        kind="recipe"
      />
    );
    const chip = screen.getByText('Fig Cocktail');
    expect(chip).toHaveAttribute('data-chip-kind', 'recipe');
    expect(chip).toHaveAttribute('aria-label', 'Recipe filter: Fig Cocktail');
    expect(chip.querySelector('[data-testid="recipe-icon"]')).toBeInTheDocument();
    // Outlined, not solid-filled — the store's chip class is absent here.
    expect(chip.className).toContain('border');
    expect(chip.className).not.toContain('bg-blue-500');
  });

  it('a selected recipe chip stays outlined (never turns solid like a selected store chip)', () => {
    render(
      <StoreFilterBar
        stores={recipes}
        selectedStoreIds={new Set(['r1'])}
        excludedStoreIds={new Set()}
        {...baseProps}
        editable={false}
        kind="recipe"
      />
    );
    const chip = screen.getByText('Fig Cocktail');
    expect(chip.className).toContain('border');
    expect(chip.className).not.toContain('bg-blue-500');
    expect(chip.className).toContain('border-blue-500');
  });

  it('excluded styling (dimmed + strikethrough) applies identically to store and recipe chips', () => {
    const { rerender } = render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set(['st1'])}
        {...baseProps}
      />
    );
    const storeChip = screen.getByText('Costco');
    const excludedClasses = 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 line-through opacity-60';
    for (const cls of excludedClasses.split(' ')) {
      expect(storeChip.className).toContain(cls);
    }

    rerender(
      <StoreFilterBar
        stores={recipes}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set(['r1'])}
        {...baseProps}
        editable={false}
        kind="recipe"
      />
    );
    const recipeChip = screen.getByText('Fig Cocktail');
    for (const cls of excludedClasses.split(' ')) {
      expect(recipeChip.className).toContain(cls);
    }
    // Still carries the icon — excluded doesn't strip the store-vs-recipe signal.
    expect(recipeChip.querySelector('[data-testid="recipe-icon"]')).toBeInTheDocument();
  });

  it('groupLabel wraps the chip row in an accessible group, distinguishing bars for screen readers', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        {...baseProps}
        groupLabel="Store filters"
      />
    );
    expect(screen.getByRole('group', { name: 'Store filters' })).toBeInTheDocument();
  });

  it('omits the group role/label entirely when groupLabel is not passed (no behavior change for existing callers)', () => {
    render(
      <StoreFilterBar
        stores={stores}
        selectedStoreIds={new Set()}
        excludedStoreIds={new Set()}
        {...baseProps}
      />
    );
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });
});
