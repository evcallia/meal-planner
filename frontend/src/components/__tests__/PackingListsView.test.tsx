import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { PackingListsView } from '../PackingListsView';
import type { PackingList, UserInfo } from '../../types';

const mockToggleItem = vi.fn();
const mockAddItem = vi.fn();
const mockDeleteItem = vi.fn();
const mockEditItem = vi.fn();
const mockSetAllChecked = vi.fn();
const mockCreateList = vi.fn(() => Promise.resolve('new-list'));
const mockCreateSection = vi.fn();
const mockDeleteList = vi.fn();
const mockLeaveList = vi.fn();
const mockUpdateList = vi.fn();
const mockReorderLists = vi.fn();
const mockCopySection = vi.fn(() => Promise.resolve({ copied: 3, skipped: 0 }));
const mockDeleteSection = vi.fn();

let mockLists: PackingList[] = [];
let mockLoading = false;

vi.mock('../../hooks/usePacking', () => ({
  usePacking: () => ({
    lists: mockLists,
    loading: mockLoading,
    createList: mockCreateList,
    updateList: mockUpdateList,
    deleteList: mockDeleteList,
    reorderLists: mockReorderLists,
    restoreListFromSnapshot: vi.fn(),
    shareList: vi.fn(),
    unshareList: vi.fn(),
    leaveList: mockLeaveList,
    setAllChecked: mockSetAllChecked,
    addSection: vi.fn(),
    createSection: mockCreateSection,
    renameSection: vi.fn(),
    deleteSection: mockDeleteSection,
    reorderSections: vi.fn(),
    addItem: mockAddItem,
    editItem: mockEditItem,
    toggleItem: mockToggleItem,
    deleteItem: mockDeleteItem,
    moveItem: vi.fn(),
    reorderItems: vi.fn(),
    createBag: vi.fn(),
    renameBag: vi.fn(),
    deleteBag: vi.fn(),
    reorderBags: vi.fn(),
    copySectionToList: mockCopySection,
    itemSuggestions: new Map(),
  }),
}));

vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));

const user: UserInfo = { sub: 'me', email: 'me@example.com', name: 'Me' };

const listFixture = (): PackingList => ({
  id: 'l1', name: 'Paris', icon: null, color: 'blue', position: 0,
  owner_sub: 'me', owner_name: 'Me', is_owner: true, shared_with: [],
  bags: [
    { id: 'bag1', list_id: 'l1', name: 'Carry On', position: 0 },
    { id: 'bag2', list_id: 'l1', name: 'Toiletry Bag', position: 1 },
  ],
  sections: [{
    id: 's1', list_id: 'l1', name: 'Clothes', position: 0,
    items: [
      { id: 'i1', section_id: 's1', name: 'Boots', quantity: null, checked: false, position: 0, bag_id: 'bag1', updated_at: '2026-01-01T00:00:00' },
      { id: 'i2', section_id: 's1', name: 'Socks', quantity: '3', checked: true, position: 1, bag_id: 'bag1', updated_at: '2026-01-01T00:00:00' },
      { id: 'i3', section_id: 's1', name: 'Toothbrush', quantity: null, checked: false, position: 2, bag_id: 'bag2', updated_at: '2026-01-01T00:00:00' },
    ],
  }],
});

const renderView = (props: Partial<React.ComponentProps<typeof PackingListsView>> = {}) =>
  render(<PackingListsView user={user} {...props} />);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockLists = [listFixture()];
  mockLoading = false;
});

describe('PackingListsView', () => {
  it('shows a prompt when there are no lists yet', () => {
    mockLists = [];
    renderView();
    expect(screen.getByText(/No lists yet/i)).toBeInTheDocument();
  });

  it('renders a tab per list and the active list\'s sections', () => {
    mockLists = [listFixture(), { ...listFixture(), id: 'l2', name: 'Dolomites', position: 1 }];
    renderView();
    const tabs = screen.getByTestId('packing-tabs');
    expect(within(tabs).getByText('Paris')).toBeInTheDocument();
    expect(within(tabs).getByText('Dolomites')).toBeInTheDocument();
    expect(screen.getByText('Clothes')).toBeInTheDocument();
  });

  it('shows completed/total in the section header', () => {
    renderView();
    expect(screen.getByText('1/3 completed')).toBeInTheDocument();
  });

  it('renders completed items last, and hides them when showChecked is off', () => {
    const { unmount } = renderView({ showChecked: true });
    const names = screen.getAllByText(/Boots|Socks|Toothbrush/).map(el => el.textContent);
    expect(names.join(' ')).toMatch(/Boots.*Toothbrush.*Socks/s);
    unmount();

    renderView({ showChecked: false });
    expect(screen.queryByText('Socks')).not.toBeInTheDocument();
    expect(screen.getByText('Boots')).toBeInTheDocument();
  });

  it('toggles an item through the hook', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Check Boots' }));
    expect(mockToggleItem).toHaveBeenCalledWith('l1', 'i1', true);
  });

  it('unchecks a completed item', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Uncheck Socks' }));
    expect(mockToggleItem).toHaveBeenCalledWith('l1', 'i2', false);
  });

  it('renders per-bag progress plus a total', () => {
    renderView();
    const panel = screen.getByTestId('bag-progress');
    expect(within(panel).getByText('Carry On')).toBeInTheDocument();
    expect(within(panel).getByText('1/2')).toBeInTheDocument();   // Carry On
    expect(within(panel).getByText('0/1')).toBeInTheDocument();   // Toiletry Bag
    expect(within(panel).getByText('Total')).toBeInTheDocument();
    expect(within(panel).getByText('33.3%')).toBeInTheDocument(); // 1 of 3 completed
  });

  it('hides the per-bag rows and chips when bags are hidden', () => {
    renderView({ hideBags: true });
    expect(screen.queryByText('Carry On')).not.toBeInTheDocument();
    expect(screen.queryByText('1/2')).not.toBeInTheDocument();
  });

  it('still shows the overall completed total when tags are hidden', () => {
    renderView({ hideBags: true });
    const panel = screen.getByTestId('bag-progress');
    expect(within(panel).getByText('Total')).toBeInTheDocument();
    expect(within(panel).getByText('33.3%')).toBeInTheDocument();
  });

  it('offers check-all / uncheck-all from the kebab menu', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    fireEvent.click(screen.getByText('Check all items'));
    expect(mockSetAllChecked).toHaveBeenCalledWith('l1', true);

    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    fireEvent.click(screen.getByText('Uncheck all items'));
    expect(mockSetAllChecked).toHaveBeenCalledWith('l1', false);
  });

  it('toggles the show-completed display preference for the active list', () => {
    const onUpdateDisplayPrefs = vi.fn();
    renderView({ showChecked: true, onUpdateDisplayPrefs });
    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    fireEvent.click(screen.getByText('Hide completed items'));
    expect(onUpdateDisplayPrefs).toHaveBeenCalledWith({ showCheckedOverrides: { l1: false } });
  });

  it('creates a list', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /new list/i }));
    fireEvent.change(screen.getByTestId('new-list-name'), { target: { value: 'Dolomites' } });
    fireEvent.click(screen.getByTestId('create-list'));
    expect(mockCreateList).toHaveBeenCalledWith('Dolomites', 'blue');
  });

  it('adds an item through quick-add, creating the section on the fly', async () => {
    mockCreateSection.mockResolvedValue({ id: 's2', list_id: 'l1', name: 'Tech', position: 1, items: [] });
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Add items' }));
    fireEvent.change(screen.getByTestId('packing-quick-add-item'), { target: { value: 'Charger' } });
    fireEvent.change(screen.getByTestId('packing-quick-add-section'), { target: { value: 'Tech' } });
    await fireEvent.click(screen.getByTestId('packing-quick-add-submit'));

    expect(mockCreateSection).toHaveBeenCalledWith('l1', 'Tech');
  });

  it('edits a list\'s name and color together', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    fireEvent.click(screen.getByText(/Rename & color/));

    const editor = screen.getByTestId('edit-list');
    fireEvent.change(within(editor).getByTestId('edit-list-name'), { target: { value: 'Paris 2027' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Color rose' }));
    fireEvent.click(screen.getByTestId('edit-list-save'));

    expect(mockUpdateList).toHaveBeenCalledWith('l1', { name: 'Paris 2027', color: 'rose' });
  });

  it('changes only the color when the name is untouched', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    fireEvent.click(screen.getByText(/Rename & color/));
    fireEvent.click(within(screen.getByTestId('edit-list')).getByRole('button', { name: 'Color amber' }));
    fireEvent.click(screen.getByTestId('edit-list-save'));

    expect(mockUpdateList).toHaveBeenCalledWith('l1', { color: 'amber' });
  });

  it('saves nothing when neither name nor color changed', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    fireEvent.click(screen.getByText(/Rename & color/));
    fireEvent.click(screen.getByTestId('edit-list-save'));

    expect(mockUpdateList).not.toHaveBeenCalled();
    expect(screen.queryByTestId('edit-list')).not.toBeInTheDocument();
  });

  it('reorders lists after a long-press drag on the tab strip', () => {
    vi.useFakeTimers();
    try {
      mockLists = [listFixture(), { ...listFixture(), id: 'l2', name: 'Dolomites', position: 1 }];
      renderView();
      const paris = screen.getByTestId('packing-tabs').querySelector('[data-tab-id="l1"]')!;

      fireEvent.pointerDown(paris, { clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(250); });
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(
        { closest: () => ({ getAttribute: () => 'l2' }) } as unknown as Element,
      );
      act(() => { document.dispatchEvent(new PointerEvent('pointermove', { clientX: 90, clientY: 10 })); });
      act(() => { document.dispatchEvent(new PointerEvent('pointerup')); });

      expect(mockReorderLists).toHaveBeenCalledWith(['l2', 'l1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not switch tabs on the click that ends a drag', () => {
    vi.useFakeTimers();
    try {
      mockLists = [listFixture(), { ...listFixture(), id: 'l2', name: 'Dolomites', position: 1 }];
      renderView();
      const dolomites = screen.getByTestId('packing-tabs').querySelector('[data-tab-id="l2"]')!;

      const paris = screen.getByTestId('packing-tabs').querySelector('[data-tab-id="l1"]')!;
      expect(paris.className).toContain('bg-blue-500');

      fireEvent.pointerDown(dolomites, { clientX: 10, clientY: 10 });
      act(() => { vi.advanceTimersByTime(250); });
      act(() => { document.dispatchEvent(new PointerEvent('pointerup')); });
      fireEvent.click(dolomites);

      // Still on Paris — the drag's trailing click was swallowed.
      expect(paris.className).toContain('bg-blue-500');
      expect(dolomites.className).not.toContain('bg-blue-500');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows Leave instead of Delete for a list you do not own', () => {
    mockLists = [{ ...listFixture(), is_owner: false, owner_sub: 'someone-else' }];
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    expect(screen.getByText('Leave list')).toBeInTheDocument();
    expect(screen.queryByText('Delete list')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Share…/)).not.toBeInTheDocument();
  });

  it('locks the per-list notification toggle until the global one is on', () => {
    renderView({ notifyEditsDefault: false });
    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    expect(screen.getByText(/Mute notifications for this list/)).toBeDisabled();
  });

  it('mutes notifications for one list when the global toggle is on', () => {
    const onSetListNotify = vi.fn();
    renderView({ notifyEditsDefault: true, onSetListNotify });
    fireEvent.click(screen.getByRole('button', { name: /list options/i }));
    fireEvent.click(screen.getByText(/Mute notifications for this list/));
    expect(onSetListNotify).toHaveBeenCalledWith('l1', { edits: false });
  });

  it('filters items to the selected bag', () => {
    renderView({ selectedBags: ['bag2'] });
    expect(screen.getByText('Toothbrush')).toBeInTheDocument();
    expect(screen.queryByText('Boots')).not.toBeInTheDocument();
  });

  it('shows each bag\'s percentage next to its fraction', () => {
    const panel = (renderView(), screen.getByTestId('bag-progress'));
    expect(within(panel).getByText('50%')).toBeInTheDocument();  // Carry On 1/2
    expect(within(panel).getByText('0%')).toBeInTheDocument();   // Toiletry Bag 0/1
    expect(within(panel).getByText('33.3%')).toBeInTheDocument(); // total 1/3
  });

  it('copies a section into another list and confirms it', async () => {
    mockLists = [listFixture(), { ...listFixture(), id: 'l2', name: 'Dolomites', position: 1 }];
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /options for clothes/i }));
    const menu = screen.getByTestId('section-menu');
    await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Dolomites' })); });

    expect(mockCopySection).toHaveBeenCalledWith('l1', 's1', 'l2');
    expect(screen.getByTestId('packing-flash')).toHaveTextContent('Copied 3 items to “Dolomites”');
  });

  it('says so when the target already has everything', async () => {
    mockCopySection.mockResolvedValueOnce({ copied: 0, skipped: 3 });
    mockLists = [listFixture(), { ...listFixture(), id: 'l2', name: 'Dolomites', position: 1 }];
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /options for clothes/i }));
    const menu = screen.getByTestId('section-menu');
    await act(async () => { fireEvent.click(within(menu).getByRole('button', { name: 'Dolomites' })); });

    expect(screen.getByTestId('packing-flash')).toHaveTextContent('already has every item');
  });

  it('offers no copy targets when this is the only list', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /options for clothes/i }));
    expect(screen.getByText('No other lists yet')).toBeInTheDocument();
  });

  it('does not offer the current list as a copy target', () => {
    mockLists = [listFixture(), { ...listFixture(), id: 'l2', name: 'Dolomites', position: 1 }];
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /options for clothes/i }));
    const menu = screen.getByTestId('section-menu');
    expect(within(menu).queryByRole('button', { name: 'Paris' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Dolomites' })).toBeInTheDocument();
  });

  it('asks before deleting a section that still has items', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /options for clothes/i }));
    fireEvent.click(screen.getByText('Delete section (3)'));

    // Confirmation first — deleting takes the items with it.
    expect(mockDeleteSection).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete “Clothes” and its 3 items\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-delete-section'));
    expect(mockDeleteSection).toHaveBeenCalledWith('l1', 's1');
  });

  it('can back out of the confirmation', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /options for clothes/i }));
    fireEvent.click(screen.getByText('Delete section (3)'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockDeleteSection).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-delete-section')).not.toBeInTheDocument();
  });

  it('deletes an empty section without asking', () => {
    const list = listFixture();
    list.sections[0].items = [];
    mockLists = [list];
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /options for clothes/i }));
    fireEvent.click(screen.getByText('Delete section'));

    expect(mockDeleteSection).toHaveBeenCalledWith('l1', 's1');
  });

// .glass sets backdrop-filter, so every section card is its own stacking
// context — an in-card menu was painted under the following sections and under
// the fixed bottom nav, where it couldn't be clicked.
describe('section menu placement', () => {
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /options for clothes/i }));

  it('renders outside the section card, straight on <body>', () => {
    renderView();
    openMenu();
    const menu = screen.getByTestId('section-menu');
    expect(menu.closest('[data-section-id]')).toBeNull();
    expect(menu.parentElement).toBe(document.body);
  });

  it('anchors below the button when there is room', () => {
    renderView();
    openMenu();
    const menu = screen.getByTestId('section-menu');
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.top).not.toBe('');
    expect(menu.style.bottom).toBe('');
  });

  it('flips upward when the button sits near the bottom island', () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700, bottom: 730, left: 300, right: 340, width: 40, height: 30, x: 300, y: 700,
      toJSON: () => ({}),
    } as DOMRect);
    try {
      renderView();
      openMenu();
      const menu = screen.getByTestId('section-menu');
      expect(menu.style.bottom).not.toBe('');
      expect(menu.style.top).toBe('');
    } finally {
      rect.mockRestore();
    }
  });

  it('closes on an outside click but not on a click inside itself', () => {
    renderView();
    openMenu();
    fireEvent.mouseDown(screen.getByTestId('section-menu'));
    expect(screen.getByTestId('section-menu')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('section-menu')).not.toBeInTheDocument();
  });
});

  it('shows a loading spinner while lists load', () => {
    mockLoading = true;
    renderView();
    expect(screen.getByTestId('packing-loading')).toBeInTheDocument();
  });
});

// A muted list is marked on its tab, so you can see which lists are silenced
// without opening each one. The mark is meaningless while the global List-edits
// toggle is off — nothing notifies then anyway — so it stays hidden.
describe('PackingListsView muted indicator', () => {
  const tabs = () => screen.getByTestId('packing-tabs');

  it('marks a muted list when List notifications are enabled', () => {
    renderView({ notifyEditsDefault: true, listNotifyOverrides: { l1: { edits: false } } });
    const icon = within(tabs()).getByTestId('muted-icon');
    expect(icon).toHaveAccessibleName('Edit notifications muted');
  });

  it('shows nothing when the list is not muted', () => {
    renderView({ notifyEditsDefault: true, listNotifyOverrides: {} });
    expect(within(tabs()).queryByTestId('muted-icon')).not.toBeInTheDocument();
  });

  it('shows nothing when List notifications are globally off', () => {
    renderView({ notifyEditsDefault: false, listNotifyOverrides: { l1: { edits: false } } });
    expect(within(tabs()).queryByTestId('muted-icon')).not.toBeInTheDocument();
  });
});

// Show/hide completed is a per-list choice layered over a global default, so
// one list can hide its completed items without silencing every other list.
describe('PackingListsView per-list completed visibility', () => {
  const secondList = (): PackingList => ({
    ...listFixture(), id: 'l2', name: 'Home projects', position: 1,
  });
  const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /list options/i }));

  it('follows the global default when the list has no override', () => {
    renderView({ showChecked: false, showCheckedOverrides: {} });
    expect(screen.queryByText('Socks')).not.toBeInTheDocument();
  });

  it('lets a list override the default in either direction', () => {
    const { unmount } = renderView({ showChecked: false, showCheckedOverrides: { l1: true } });
    expect(screen.getByText('Socks')).toBeInTheDocument();
    unmount();

    renderView({ showChecked: true, showCheckedOverrides: { l1: false } });
    expect(screen.queryByText('Socks')).not.toBeInTheDocument();
  });

  it('toggling writes an override for THIS list only, leaving the default alone', () => {
    const onUpdate = vi.fn();
    renderView({ showChecked: true, showCheckedOverrides: { l2: false }, onUpdateDisplayPrefs: onUpdate });
    openMenu();
    fireEvent.click(screen.getByText('Hide completed items'));
    expect(onUpdate).toHaveBeenCalledWith({ showCheckedOverrides: { l2: false, l1: false } });
    // The global default must be untouched by a per-list toggle.
    expect(onUpdate.mock.calls[0][0]).not.toHaveProperty('showChecked');
  });

  it('the menu label reflects the effective value, not the global default', () => {
    renderView({ showChecked: true, showCheckedOverrides: { l1: false } });
    openMenu();
    expect(screen.getByText('Show completed items')).toBeInTheDocument();
  });

  it('offers to apply to all lists after a toggle, without doing it yet', () => {
    const onUpdate = vi.fn();
    mockLists = [listFixture(), secondList()];
    renderView({ showChecked: true, showCheckedOverrides: {}, onUpdateDisplayPrefs: onUpdate });
    openMenu();
    fireEvent.click(screen.getByText('Hide completed items'));
    // The toggle itself only pinned this list.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ showCheckedOverrides: { l1: false } });
    expect(screen.getByTestId('packing-flash')).toHaveTextContent(/Paris/);
    expect(screen.getByRole('button', { name: /apply to all lists/i })).toBeInTheDocument();
  });

  it('applies to every list when the offer is taken', () => {
    const onUpdate = vi.fn();
    mockLists = [listFixture(), secondList()];
    renderView({ showChecked: true, showCheckedOverrides: {}, onUpdateDisplayPrefs: onUpdate });
    openMenu();
    fireEvent.click(screen.getByText('Hide completed items'));
    fireEvent.click(screen.getByRole('button', { name: /apply to all lists/i }));
    expect(onUpdate).toHaveBeenLastCalledWith({ showChecked: false, showCheckedOverrides: {} });
    // The offer is consumed; a confirmation replaces it.
    expect(screen.queryByRole('button', { name: /apply to all lists/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('packing-flash')).toHaveTextContent(/all lists/i);
  });

  it('does not offer when applying to all would change nothing', () => {
    // Only list, and the toggle lands back on the global default.
    renderView({ showChecked: false, showCheckedOverrides: { l1: true } });
    openMenu();
    fireEvent.click(screen.getByText('Hide completed items'));
    expect(screen.queryByRole('button', { name: /apply to all lists/i })).not.toBeInTheDocument();
  });

  it('still offers when another list carries an override', () => {
    mockLists = [listFixture(), secondList()];
    renderView({ showChecked: false, showCheckedOverrides: { l1: true, l2: true } });
    openMenu();
    // Back to the default for l1, but l2 is still pinned — applying to all clears it.
    fireEvent.click(screen.getByText('Hide completed items'));
    expect(screen.getByRole('button', { name: /apply to all lists/i })).toBeInTheDocument();
  });

  it('has no apply-to-all item in the menu itself', () => {
    renderView({ showChecked: true, showCheckedOverrides: { l1: false } });
    openMenu();
    expect(screen.queryByText('Use this for all lists')).not.toBeInTheDocument();
  });
});
