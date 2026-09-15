import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

vi.mock('../../hooks/useStores', () => ({
  useStores: () => ({
    stores: [],
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
            // Only 2 of the 4 units are linked (both to the excluded recipe)
            // — 2 MP-only units remain, so the row must still show.
            recipes: [{ id: 'r1', title: 'Fig Cocktail' }, { id: 'r1', title: 'Fig Cocktail' }],
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
});
