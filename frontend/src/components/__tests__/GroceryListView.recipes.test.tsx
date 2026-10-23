import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { GroceryListView } from '../GroceryListView';

const mockMergeList = vi.fn();
const mockToggleItem = vi.fn();
const mockAddItem = vi.fn();
const mockDeleteItem = vi.fn();
const mockEditItem = vi.fn();
const mockClearChecked = vi.fn();
const mockClearAll = vi.fn();
const mockReorderSections = vi.fn();
const mockReorderItems = vi.fn();
const mockRenameSection = vi.fn();
const mockMoveItem = vi.fn();
const mockBatchUpdateStoreId = vi.fn();

let mockSections: any[] = [];
let mockLoading = false;

vi.mock('../../hooks/useGroceryList', () => ({
  useGroceryList: () => ({
    sections: mockSections,
    loading: mockLoading,
    mergeList: mockMergeList,
    toggleItem: mockToggleItem,
    addItem: mockAddItem,
    deleteItem: mockDeleteItem,
    editItem: mockEditItem,
    clearChecked: mockClearChecked,
    clearAll: mockClearAll,
    reorderSections: mockReorderSections,
    reorderItems: mockReorderItems,
    renameSection: mockRenameSection,
    moveItem: mockMoveItem,
    createSection: vi.fn(),
    deleteSection: vi.fn(),
    batchUpdateStoreId: mockBatchUpdateStoreId,
    itemDefaultsMap: new Map(),
    removeItemDefault: vi.fn(),
  }),
}));

let mockStores: any[] = [];

vi.mock('../../hooks/useStores', () => ({
  useStores: () => ({
    stores: mockStores,
    loading: false,
    createStore: vi.fn(),
    renameStore: vi.fn(),
    removeStore: vi.fn(),
    reorderStores: vi.fn(),
  }),
}));

vi.mock('../../hooks/useDragReorder', () => ({
  useDragReorder: () => ({
    dragState: { isDragging: false, dragIndex: null, overIndex: null, itemHeight: 0 },
    getDragHandlers: () => ({}),
    getHandleMouseDown: () => vi.fn(),
  }),
  computeShiftTransform: () => '',
}));

vi.mock('../../utils/groceryParser', () => ({
  parseGroceryText: vi.fn(() => []),
}));

// One item spans two recipes ("Lemon"), one is single-recipe ("Sugar"), one
// has no recipe attribution at all ("Paper Towels" — an MP-only item).
const recipeSections = [
  {
    id: 's1', name: 'Produce', position: 0,
    items: [
      {
        id: 'i1', section_id: 's1', name: 'Lemon', quantity: '4', checked: false, position: 0, store_id: null, updated_at: '2026-01-01',
        recipes: [{ id: 'r1', title: 'Fig Cocktail' }, { id: 'r2', title: 'Thai Curry' }],
      },
    ],
  },
  {
    id: 's2', name: 'Baking', position: 1,
    items: [
      {
        id: 'i2', section_id: 's2', name: 'Sugar', quantity: '1', checked: false, position: 0, store_id: null, updated_at: '2026-01-01',
        recipes: [{ id: 'r1', title: 'Fig Cocktail' }],
      },
      {
        id: 'i3', section_id: 's2', name: 'Paper Towels', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01',
        recipes: [],
      },
    ],
  },
];

describe('GroceryListView - group by recipe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = recipeSections;
    mockLoading = false;
    mockStores = [];
  });

  it('places a multi-recipe item under every recipe it belongs to', () => {
    render(<GroceryListView groupBy="recipe" />);
    const groups = screen.getAllByTestId('recipe-group');
    const groupTitles = groups.map(g => within(g).getByRole('heading').textContent);
    expect(groupTitles).toEqual(['Fig Cocktail', 'Thai Curry', 'No recipe']);

    const figGroup = groups.find(g => within(g).getByRole('heading').textContent === 'Fig Cocktail')!;
    expect(within(figGroup).getByText('Lemon')).toBeInTheDocument();
    expect(within(figGroup).getByText('Sugar')).toBeInTheDocument();

    const thaiGroup = groups.find(g => within(g).getByRole('heading').textContent === 'Thai Curry')!;
    expect(within(thaiGroup).getByText('Lemon')).toBeInTheDocument();
    expect(within(thaiGroup).queryByText('Sugar')).not.toBeInTheDocument();
  });

  it('groups items with no recipe attribution under "No recipe"', () => {
    render(<GroceryListView groupBy="recipe" />);
    const groups = screen.getAllByTestId('recipe-group');
    const noRecipeGroup = groups.find(g => within(g).getByRole('heading').textContent === 'No recipe')!;
    expect(within(noRecipeGroup).getByText('Paper Towels')).toBeInTheDocument();
  });
});

describe('GroceryListView - recipe filter chips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = recipeSections;
    mockLoading = false;
    mockStores = [];
  });

  it('selecting a recipe shows items matching ANY of their recipes', () => {
    render(<GroceryListView groupBy="category" selectedRecipes={['r2']} />);
    // r2 (Thai Curry) is only on Lemon — Sugar and Paper Towels drop out.
    expect(screen.getByText('Lemon')).toBeInTheDocument();
    expect(screen.queryByText('Sugar')).not.toBeInTheDocument();
    expect(screen.queryByText('Paper Towels')).not.toBeInTheDocument();
  });

  it('excluding a recipe hides an item only when EVERY recipe is excluded and it has no non-recipe units', () => {
    // Sugar: quantity 1, one link (r1) — fully consumed by the excluded
    // recipe with no MP-only remainder, so it must be hidden.
    render(<GroceryListView groupBy="category" excludedRecipes={['r1']} />);
    expect(screen.queryByText('Sugar')).not.toBeInTheDocument();
    // Lemon has a second, non-excluded recipe (r2) — must stay visible even
    // though it's shared with the excluded recipe. This is the "one failure
    // a shopping list must not have" case.
    expect(screen.getByText('Lemon')).toBeInTheDocument();
    // Paper Towels has no recipe attribution at all — never affected.
    expect(screen.getByText('Paper Towels')).toBeInTheDocument();
  });

  it('does not hide an item excluded on all its recipes if it also has MP-only units', () => {
    mockSections = [
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          {
            id: 'i1', section_id: 's1', name: 'Lemon', quantity: '4', checked: false, position: 0, store_id: null, updated_at: '2026-01-01',
            // The backend dedupes `recipes` by recipe id (see recipeRefsByKey
            // in serialize.go) and never sends duplicates — quantity is the
            // real signal for "more units than links". 4 units, 1 linked
            // recipe: 3 MP-only units remain, so the row must still show.
            recipes: [{ id: 'r1', title: 'Fig Cocktail' }],
          },
        ],
      },
    ];
    render(<GroceryListView groupBy="category" excludedRecipes={['r1']} />);
    expect(screen.getByText('Lemon')).toBeInTheDocument();
  });

  it('hideRecipes hides the chip bar but keeps filtering active', () => {
    const { rerender } = render(<GroceryListView groupBy="category" excludedRecipes={['r1']} hideRecipes={false} />);
    expect(screen.getByText('Fig Cocktail')).toBeInTheDocument(); // chip visible
    expect(screen.queryByText('Sugar')).not.toBeInTheDocument(); // still filtered out

    rerender(<GroceryListView groupBy="category" excludedRecipes={['r1']} hideRecipes={true} />);
    expect(screen.queryByText('Fig Cocktail')).not.toBeInTheDocument(); // chip hidden
    expect(screen.queryByText('Sugar')).not.toBeInTheDocument(); // filter still applies
  });

  it('treats a non-integer quantity as 1 unit for exclusion, matching the backend', () => {
    // "2 lbs" is unparseable server-side (strconv.Atoi rejects trailing
    // text) and means 1 unit — 1 unit, 1 link to the excluded recipe, 0
    // MP-only units left, so the row must be hidden. parseInt would read it
    // as 2 units and wrongly keep the row visible.
    mockSections = [
      {
        id: 's1', name: 'Produce', position: 0,
        items: [
          {
            id: 'i1', section_id: 's1', name: 'Lemon', quantity: '2 lbs', checked: false, position: 0, store_id: null, updated_at: '2026-01-01',
            recipes: [{ id: 'r1', title: 'Fig Cocktail' }],
          },
        ],
      },
    ];
    render(<GroceryListView groupBy="category" excludedRecipes={['r1']} />);
    expect(screen.queryByText('Lemon')).not.toBeInTheDocument();
  });

  it('keeps an excluded recipe chip visible (and un-un-excludable) after its last item leaves the list', () => {
    // Stores stay visible when excluded because they're a persisted entity
    // table; recipes have no such table — they're derived from current
    // item data, so this needs its own fallback (a title cache) or the
    // chip vanishes along with the id's only ability to be un-excluded.
    const { rerender } = render(<GroceryListView groupBy="category" excludedRecipes={['r1']} />);
    expect(screen.getByText('Fig Cocktail')).toBeInTheDocument();

    // Every item referencing r1 (Fig Cocktail) is gone now.
    mockSections = [
      {
        id: 's2', name: 'Baking', position: 1,
        items: [
          {
            id: 'i3', section_id: 's2', name: 'Paper Towels', quantity: null, checked: false, position: 1, store_id: null, updated_at: '2026-01-01',
            recipes: [],
          },
        ],
      },
    ];
    rerender(<GroceryListView groupBy="category" excludedRecipes={['r1']} />);
    expect(screen.getByText('Fig Cocktail')).toBeInTheDocument();
  });
});

describe('GroceryListView - group by recipe editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = recipeSections;
    mockLoading = false;
    mockStores = [];
  });

  it('tapping one copy of a multi-recipe item enters edit mode only for that copy', () => {
    render(<GroceryListView groupBy="recipe" />);
    const groups = screen.getAllByTestId('recipe-group');
    const figGroup = groups.find(g => within(g).getByRole('heading').textContent === 'Fig Cocktail')!;
    const thaiGroup = groups.find(g => within(g).getByRole('heading').textContent === 'Thai Curry')!;

    // "Lemon" renders once per recipe group (Fig Cocktail AND Thai Curry).
    fireEvent.click(within(figGroup).getByText('Lemon'));

    // Only the tapped (Fig Cocktail) copy mounts an edit form — the Thai
    // Curry copy, which shares the same item id, stays a normal row. This is
    // the composite editId (`${group.id}-${item.id}`) doing its job: each
    // copy only matches editingItemId when it's the one actually tapped.
    expect(within(figGroup).getByText('Save')).toBeInTheDocument();
    expect(within(thaiGroup).queryByText('Save')).not.toBeInTheDocument();
    expect(within(thaiGroup).getByText('Lemon')).toBeInTheDocument();
  });

  it('committing an edit on one copy updates the item, and the other copy reflects the change', async () => {
    mockEditItem.mockImplementation((id: string, updates: Record<string, unknown>) => {
      mockSections = mockSections.map(s => ({
        ...s,
        items: s.items.map((i: any) => (i.id === id ? { ...i, ...updates } : i)),
      }));
    });
    const { rerender } = render(<GroceryListView groupBy="recipe" />);
    let groups = screen.getAllByTestId('recipe-group');
    const figGroup = groups.find(g => within(g).getByRole('heading').textContent === 'Fig Cocktail')!;

    fireEvent.click(within(figGroup).getByText('Lemon'));
    const input = within(figGroup).getByDisplayValue('Lemon');
    fireEvent.change(input, { target: { value: 'Lime' } });
    fireEvent.click(within(figGroup).getByText('Save'));

    await waitFor(() => {
      expect(mockEditItem).toHaveBeenCalledWith('i1', expect.objectContaining({ name: 'Lime' }));
    });

    rerender(<GroceryListView groupBy="recipe" />);
    groups = screen.getAllByTestId('recipe-group');
    const newFigGroup = groups.find(g => within(g).getByRole('heading').textContent === 'Fig Cocktail')!;
    const newThaiGroup = groups.find(g => within(g).getByRole('heading').textContent === 'Thai Curry')!;
    expect(within(newFigGroup).getByText('Lime')).toBeInTheDocument();
    expect(within(newThaiGroup).getByText('Lime')).toBeInTheDocument();
  });

  it('an edit left open in category view does not appear mounted after switching to group-by-recipe', () => {
    // editingItemId is component state, independent of the groupBy prop — a
    // stale bare item id from a different view's default editId must not
    // coincidentally match a composite editId in the recipe view.
    const { rerender } = render(<GroceryListView groupBy="category" />);
    fireEvent.click(screen.getByText('Lemon'));
    expect(screen.getByText('Save')).toBeInTheDocument();

    rerender(<GroceryListView groupBy="recipe" />);
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
  });
});

describe('GroceryListView - category/none view editing regression (composite identity default)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = recipeSections;
    mockLoading = false;
    mockStores = [];
  });

  it('entering edit mode in category view still works for an item that also has recipe attribution', () => {
    render(<GroceryListView groupBy="category" />);
    fireEvent.click(screen.getByText('Lemon'));
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('entering edit mode in the flat ("none" groupBy) view still works', () => {
    render(<GroceryListView groupBy="none" />);
    fireEvent.click(screen.getByText('Lemon'));
    expect(screen.getByText('Save')).toBeInTheDocument();
  });
});

describe('GroceryListView - store vs. recipe chip bars', () => {
  const storeAndRecipeSections = [
    {
      id: 's1', name: 'Produce', position: 0,
      items: [
        {
          id: 'i1', section_id: 's1', name: 'Lemon', quantity: '4', checked: false, position: 0, store_id: 'st1', updated_at: '2026-01-01',
          recipes: [{ id: 'r1', title: 'Fig Cocktail' }],
        },
      ],
    },
  ];
  const storeOnlySections = [
    {
      id: 's1', name: 'Produce', position: 0,
      items: [
        {
          id: 'i1', section_id: 's1', name: 'Lemon', quantity: '4', checked: false, position: 0, store_id: 'st1', updated_at: '2026-01-01',
          recipes: [],
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoading = false;
    mockStores = [{ id: 'st1', name: 'Costco', position: 0 }];
  });

  it('does not render the recipe bar when there are no recipe chips (store bar still renders)', () => {
    mockSections = storeOnlySections;
    render(<GroceryListView groupBy="category" />);
    expect(screen.getByRole('group', { name: 'Store filters' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Recipe filters' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('recipe-icon')).not.toBeInTheDocument();
  });

  it('renders both bars, distinguishable by data-chip-kind, when both stores and recipes are present', () => {
    mockSections = storeAndRecipeSections;
    render(<GroceryListView groupBy="category" />);
    const storeGroup = screen.getByRole('group', { name: 'Store filters' });
    const recipeGroup = screen.getByRole('group', { name: 'Recipe filters' });
    expect(within(storeGroup).getByText('Costco')).toHaveAttribute('data-chip-kind', 'store');
    expect(within(recipeGroup).getByText('Fig Cocktail')).toHaveAttribute('data-chip-kind', 'recipe');
  });

  it('hiding recipes collapses only the recipe bar — store filtering is untouched', () => {
    mockSections = storeAndRecipeSections;
    const { rerender } = render(<GroceryListView groupBy="category" hideStores={false} hideRecipes={false} />);
    expect(screen.getByRole('group', { name: 'Store filters' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Recipe filters' })).toBeInTheDocument();

    rerender(<GroceryListView groupBy="category" hideStores={false} hideRecipes={true} />);
    expect(screen.getByRole('group', { name: 'Store filters' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Recipe filters' })).not.toBeInTheDocument();
  });

  it('hiding stores collapses only the store bar — the recipe bar is untouched', () => {
    mockSections = storeAndRecipeSections;
    const { rerender } = render(<GroceryListView groupBy="category" hideStores={false} hideRecipes={false} />);
    expect(screen.getByRole('group', { name: 'Store filters' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Recipe filters' })).toBeInTheDocument();

    rerender(<GroceryListView groupBy="category" hideStores={true} hideRecipes={false} />);
    expect(screen.queryByRole('group', { name: 'Store filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Recipe filters' })).toBeInTheDocument();
  });
});
