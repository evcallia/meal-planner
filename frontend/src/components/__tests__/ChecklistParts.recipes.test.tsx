import { useRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
        { id: 'r1', title: 'Fig Cocktail', count: 1 },
        { id: 'r2', title: 'Thai Curry', count: 1 },
        { id: 'r3', title: 'Ceviche', count: 1 },
        { id: 'r4', title: 'Lemonade', count: 1 },
      ],
    };
    render(<Harness item={item} />);
    expect(screen.getByTestId('recipe-chip')).toHaveTextContent('Fig Cocktail, Thai Curry +2');
  });

  it('shows both names with no "+N" when exactly two recipes', () => {
    const item: ChecklistItem = {
      ...baseItem,
      recipes: [{ id: 'r1', title: 'Fig Cocktail', count: 1 }, { id: 'r2', title: 'Thai Curry', count: 1 }],
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
        { id: 'r1', title: 'Fig Cocktail', count: 1 },
        { id: 'r2', title: 'Thai Curry', count: 1 },
        { id: 'r3', title: 'Ceviche', count: 1 },
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
      recipes: [{ id: 'r1', title: 'Fig Cocktail', count: 1 }],
    };
    render(<Harness item={item} />);
    fireEvent.click(screen.getByTestId('recipe-chip'));
    expect(screen.getByText('No recipe (3)')).toBeInTheDocument();
  });

  it('omits the "No recipe" row when every unit is linked', () => {
    const item: ChecklistItem = {
      ...baseItem,
      quantity: '2',
      recipes: [{ id: 'r1', title: 'Fig Cocktail', count: 1 }, { id: 'r2', title: 'Thai Curry', count: 1 }],
    };
    render(<Harness item={item} />);
    fireEvent.click(screen.getByTestId('recipe-chip'));
    expect(screen.queryByText(/No recipe/)).not.toBeInTheDocument();
  });

  // Reported bug: a grocery row where every unit came from the SAME recipe
  // (Recipe Keeper stores one link per recipe-ingredient occurrence — e.g.
  // an item added to a recipe six times) must not compute leftover MP-only
  // units from the number of DISTINCT recipes (1) instead of the SUM of
  // their counts (6) — that produced a phantom "No recipe (5)" row for an
  // item that's fully accounted for.
  it('omits the "No recipe" row when one recipe accounts for every unit via its count', () => {
    const item: ChecklistItem = {
      ...baseItem,
      quantity: '6',
      recipes: [{ id: 'r1', title: 'Beef Soft Tacos', count: 6 }],
    };
    render(<Harness item={item} />);
    fireEvent.click(screen.getByTestId('recipe-chip'));
    expect(screen.queryByText(/No recipe/)).not.toBeInTheDocument();
  });

  it('shows ×N beside a recipe only when its count is greater than 1', () => {
    const item: ChecklistItem = {
      ...baseItem,
      quantity: '7',
      recipes: [
        { id: 'r1', title: 'Beef Soft Tacos', count: 6 },
        { id: 'r2', title: 'Salsa Verde', count: 1 },
      ],
    };
    render(<Harness item={item} />);
    fireEvent.click(screen.getByTestId('recipe-chip'));
    const popover = screen.getByTestId('recipe-popover');
    expect(within(popover).getByText('Beef Soft Tacos ×6')).toBeInTheDocument();
    // Singles stay bare — no "×1" noise.
    expect(within(popover).getByText('Salsa Verde')).toBeInTheDocument();
    expect(within(popover).queryByText(/Salsa Verde ×1/)).not.toBeInTheDocument();
  });

  it('leads the recipe line with the shared outline icon; the store label carries no icon of its own', () => {
    // Stores keep their existing solid/plain-text marker; only the recipe
    // line gets the icon — same store-vs-recipe visual language as the
    // chip bars (StoreFilterBar's kind="recipe").
    const item: ChecklistItem = { ...baseItem, recipes: [{ id: 'r1', title: 'Fig Cocktail', count: 1 }] };
    const commitEditingRef = { current: null } as React.MutableRefObject<(() => void) | null>;
    render(
      <ChecklistItemRow
        item={item}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        chips={[{ id: 'st1', name: 'Costco', position: 0 }]}
        chipId="st1"
        onCreateChip={vi.fn()}
        editingItemId={null}
        onEditingItemChange={vi.fn()}
        commitEditingRef={commitEditingRef}
        sectionName="Produce"
        allSections={[{ id: 's1', name: 'Produce' }]}
        editHighlightColor="emerald"
        onChangeSection={vi.fn()}
      />
    );

    expect(screen.getByText('Costco')).toBeInTheDocument();
    // Exactly one icon on the row, and it lives inside the recipe line.
    expect(screen.getAllByTestId('recipe-icon')).toHaveLength(1);
    expect(within(screen.getByTestId('recipe-chip')).getByTestId('recipe-icon')).toBeInTheDocument();
  });

  it('hides the recipe line entirely when hideRecipes is set', () => {
    const item: ChecklistItem = {
      ...baseItem,
      recipes: [{ id: 'r1', title: 'Fig Cocktail', count: 1 }],
    };
    render(<Harness item={item} hideRecipes />);
    expect(screen.queryByTestId('recipe-chip')).not.toBeInTheDocument();
  });

  it('treats a non-integer quantity as 1 unit, matching the backend\'s strconv.Atoi rule', () => {
    // "2 lbs" is NOT 2 server-side (recipekeeper/store.go quantityOf uses
    // strconv.Atoi, which rejects trailing text) — it's an unparseable
    // quantity that means 1 unit. parseInt would wrongly read it as 2 and
    // disagree with the server on MP-only-unit math.
    const item: ChecklistItem = {
      ...baseItem,
      quantity: '2 lbs',
      recipes: [{ id: 'r1', title: 'Fig Cocktail', count: 1 }],
    };
    render(<Harness item={item} />);
    fireEvent.click(screen.getByTestId('recipe-chip'));
    // 1 unit total, 1 linked — nothing left over, no "No recipe" row.
    expect(screen.queryByText(/No recipe/)).not.toBeInTheDocument();
  });

  it('a stale editingItemId from another view (a bare item id) never matches a composite editId', () => {
    // Guards the actual duplicate-forms bug: a two-recipe item mounts one
    // ChecklistItemRow per group, all sharing the same editingItemId state.
    // If editingItemId were somehow already set to this item's bare id (e.g.
    // an edit started in category view, which uses the default editId,
    // before switching to group-by-recipe), this row — rendered with a
    // composite editId — must still render as a normal row, not an edit form.
    const commitEditingRef = { current: null } as React.MutableRefObject<(() => void) | null>;
    const item: ChecklistItem = { ...baseItem, recipes: [{ id: 'r1', title: 'Fig Cocktail', count: 1 }] };
    render(
      <ChecklistItemRow
        item={item}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        chips={[]}
        chipId={null}
        onCreateChip={vi.fn()}
        editingItemId={item.id}
        onEditingItemChange={vi.fn()}
        commitEditingRef={commitEditingRef}
        sectionName="Produce"
        allSections={[{ id: 's1', name: 'Produce' }]}
        editHighlightColor="emerald"
        onChangeSection={vi.fn()}
        editId={`r1-${item.id}`}
      />
    );
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.getByText('Lemon')).toBeInTheDocument();
  });

  it('only the tapped copy enters edit mode when the same item renders twice under different editIds', () => {
    // Mirrors how GroceryListView's group-by-recipe view renders a
    // multi-recipe item once per group, sharing one editingItemId state.
    function DualCopyHarness({ item }: { item: ChecklistItem }) {
      const [editingItemId, setEditingItemId] = useState<string | null>(null);
      const commitEditingRef = useRef<(() => void) | null>(null);
      const handleChange = (id: string | null) => {
        if (id !== null && editingItemId !== null && id !== editingItemId) {
          commitEditingRef.current?.();
        }
        setEditingItemId(id);
      };
      const shared = {
        item, onToggle: vi.fn(), onDelete: vi.fn(), onEdit: vi.fn(),
        chips: [], chipId: null, onCreateChip: vi.fn(),
        editingItemId, onEditingItemChange: handleChange, commitEditingRef,
        sectionName: 'Produce', allSections: [{ id: 's1', name: 'Produce' }],
        editHighlightColor: 'emerald', onChangeSection: vi.fn(),
      };
      return (
        <>
          <div data-testid="copy-a"><ChecklistItemRow {...shared} editId="g1-i1" /></div>
          <div data-testid="copy-b"><ChecklistItemRow {...shared} editId="g2-i1" /></div>
        </>
      );
    }

    const item: ChecklistItem = {
      ...baseItem,
      recipes: [{ id: 'r1', title: 'Fig Cocktail', count: 1 }, { id: 'r2', title: 'Thai Curry', count: 1 }],
    };
    render(<DualCopyHarness item={item} />);
    const copyA = screen.getByTestId('copy-a');
    const copyB = screen.getByTestId('copy-b');

    fireEvent.click(within(copyA).getByText('Lemon'));

    expect(within(copyA).getByText('Save')).toBeInTheDocument();
    expect(within(copyB).queryByText('Save')).not.toBeInTheDocument();
    expect(within(copyB).getByText('Lemon')).toBeInTheDocument();
  });
});
