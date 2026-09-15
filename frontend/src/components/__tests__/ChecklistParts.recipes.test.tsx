import { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChecklistItemRow, ChecklistItem } from '../ChecklistParts';

function Harness({ item, hideRecipes }: { item: ChecklistItem; hideRecipes?: boolean }) {
  const commitEditingRef = useRef<(() => void) | null>(null);
  return (
    <ChecklistItemRow
      item={item}
      onToggle={vi.fn()}
      onDelete={vi.fn()}
      onEdit={vi.fn()}
      chips={[]}
      chipId={null}
      onCreateChip={vi.fn()}
      editingItemId={null}
      onEditingItemChange={vi.fn()}
      commitEditingRef={commitEditingRef}
      sectionName="Produce"
      allSections={[{ id: 's1', name: 'Produce' }]}
      editHighlightColor="emerald"
      onChangeSection={vi.fn()}
      hideRecipes={hideRecipes}
    />
  );
}

const baseItem: ChecklistItem = {
  id: 'i1', section_id: 's1', name: 'Lemon', quantity: '6', checked: false, position: 0,
};

describe('ChecklistItemRow - recipe attribution', () => {
  it('renders nothing extra when the item has no recipes (no layout shift)', () => {
    render(<Harness item={{ ...baseItem, recipes: [] }} />);
    expect(screen.queryByTestId('recipe-chip')).not.toBeInTheDocument();
  });

  it('renders nothing extra when recipes is undefined', () => {
    render(<Harness item={{ ...baseItem, recipes: undefined }} />);
    expect(screen.queryByTestId('recipe-chip')).not.toBeInTheDocument();
  });

  it('truncates to two names plus "+N"', () => {
    const item: ChecklistItem = {
      ...baseItem,
      recipes: [
        { id: 'r1', title: 'Fig Cocktail' },
        { id: 'r2', title: 'Thai Curry' },
        { id: 'r3', title: 'Ceviche' },
        { id: 'r4', title: 'Lemonade' },
      ],
    };
    render(<Harness item={item} />);
    expect(screen.getByTestId('recipe-chip')).toHaveTextContent('Fig Cocktail, Thai Curry +2');
  });

  it('shows both names with no "+N" when exactly two recipes', () => {
    const item: ChecklistItem = {
      ...baseItem,
      recipes: [{ id: 'r1', title: 'Fig Cocktail' }, { id: 'r2', title: 'Thai Curry' }],
    };
    render(<Harness item={item} />);
    expect(screen.getByTestId('recipe-chip')).toHaveTextContent('Fig Cocktail, Thai Curry');
    expect(screen.getByTestId('recipe-chip').textContent).not.toMatch(/\+/);
  });

  it('opens a popover listing every recipe on tap, without opening the rename editor', () => {
    const onEditingItemChange = vi.fn();
    const item: ChecklistItem = {
      ...baseItem,
      recipes: [
        { id: 'r1', title: 'Fig Cocktail' },
        { id: 'r2', title: 'Thai Curry' },
        { id: 'r3', title: 'Ceviche' },
      ],
    };
    const commitEditingRef = { current: null } as React.MutableRefObject<(() => void) | null>;
    render(
      <ChecklistItemRow
        item={item}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        chips={[]}
        chipId={null}
        onCreateChip={vi.fn()}
        editingItemId={null}
        onEditingItemChange={onEditingItemChange}
        commitEditingRef={commitEditingRef}
        sectionName="Produce"
        allSections={[{ id: 's1', name: 'Produce' }]}
        editHighlightColor="emerald"
        onChangeSection={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('recipe-chip'));

    const popover = screen.getByTestId('recipe-popover');
    expect(popover).toHaveTextContent('Fig Cocktail');
    expect(popover).toHaveTextContent('Thai Curry');
    expect(popover).toHaveTextContent('Ceviche');
    // Tapping the recipe line must not trigger the row's rename editor
    // (the name area's onClick is startEditing) — stopPropagation guards it.
    expect(onEditingItemChange).not.toHaveBeenCalled();
  });

  it('shows an unlinked "No recipe (N)" row when quantity exceeds the link count', () => {
    const item: ChecklistItem = {
      ...baseItem,
      quantity: '4',
      recipes: [{ id: 'r1', title: 'Fig Cocktail' }],
    };
    render(<Harness item={item} />);
    fireEvent.click(screen.getByTestId('recipe-chip'));
    expect(screen.getByText('No recipe (3)')).toBeInTheDocument();
  });

  it('omits the "No recipe" row when every unit is linked', () => {
    const item: ChecklistItem = {
      ...baseItem,
      quantity: '2',
      recipes: [{ id: 'r1', title: 'Fig Cocktail' }, { id: 'r2', title: 'Thai Curry' }],
    };
    render(<Harness item={item} />);
    fireEvent.click(screen.getByTestId('recipe-chip'));
    expect(screen.queryByText(/No recipe/)).not.toBeInTheDocument();
  });

  it('hides the recipe line entirely when hideRecipes is set', () => {
    const item: ChecklistItem = {
      ...baseItem,
      recipes: [{ id: 'r1', title: 'Fig Cocktail' }],
    };
    render(<Harness item={item} hideRecipes />);
    expect(screen.queryByTestId('recipe-chip')).not.toBeInTheDocument();
  });
});
