import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PantryPanel } from '../PantryPanel';
import { exitEditAnchored } from '../../utils/exitEditAnchored';

vi.mock('../../utils/exitEditAnchored', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exitEditAnchored')>();
  return { exitEditAnchored: vi.fn(actual.exitEditAnchored) };
});

const mockAddSection = vi.fn();
const mockDeleteSection = vi.fn();
const mockAddItem = vi.fn();
const mockUpdateItem = vi.fn();
const mockAdjustQuantity = vi.fn();
const mockRemoveItem = vi.fn();
const mockClearAll = vi.fn();
const mockReorderSections = vi.fn();
const mockReorderItems = vi.fn();
const mockRenameSection = vi.fn();
const mockMoveItem = vi.fn();

let mockSections: any[] = [];
let mockLoading = false;

vi.mock('../../hooks/usePantry', () => ({
  usePantry: () => ({
    sections: mockSections,
    loading: mockLoading,
    addSection: mockAddSection,
    deleteSection: mockDeleteSection,
    addItem: mockAddItem,
    updateItem: mockUpdateItem,
    adjustQuantity: mockAdjustQuantity,
    removeItem: mockRemoveItem,
    clearAll: mockClearAll,
    reorderSections: mockReorderSections,
    reorderItems: mockReorderItems,
    renameSection: mockRenameSection,
    moveItem: mockMoveItem,
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

const sampleSections = [
  {
    id: 's1', name: 'Fridge', position: 0,
    items: [
      { id: '1', section_id: 's1', name: 'Milk', quantity: 2, position: 0, updated_at: '2026-01-01' },
      { id: '2', section_id: 's1', name: 'Eggs', quantity: 12, position: 1, updated_at: '2026-01-01' },
    ],
  },
];

describe('PantryPanel - editing flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSections = sampleSections;
    mockLoading = false;
  });

  it('clicking item name opens edit mode', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));
    expect(screen.getByDisplayValue('Milk')).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
  });

  it('editing name and saving calls updateItem', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.change(input, { target: { value: 'Oat Milk' } });
    fireEvent.click(screen.getByText('Save'));

    expect(mockUpdateItem).toHaveBeenCalledWith('1', { name: 'Oat Milk' });
  });

  it('pressing Enter in edit saves', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.change(input, { target: { value: 'Oat Milk' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockUpdateItem).toHaveBeenCalled();
  });

  it('pressing Escape in edit cancels', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockUpdateItem).not.toHaveBeenCalled();
    // Should exit edit mode
    expect(screen.queryByDisplayValue('Milk')).not.toBeInTheDocument();
  });

  it('Cancel button exits edit mode without saving', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.change(input, { target: { value: 'Changed' } });

    // Find the Cancel button in the edit form
    const cancelBtns = screen.getAllByText('Cancel');
    fireEvent.click(cancelBtns[cancelBtns.length - 1]);

    expect(mockUpdateItem).not.toHaveBeenCalled();
  });

  it('clicking section name opens rename mode', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));
    expect(screen.getByDisplayValue('Fridge')).toBeInTheDocument();
  });

  it('renaming section and pressing Enter saves', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));

    const input = screen.getByDisplayValue('Fridge');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockRenameSection).toHaveBeenCalledWith('s1', 'Freezer');
  });

  it('renaming section and pressing Escape cancels', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));

    const input = screen.getByDisplayValue('Fridge');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockRenameSection).not.toHaveBeenCalled();
  });

  it('clicking "+ Add item" shows inline form with qty input', () => {
    render(<PantryPanel />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
    // Should have a number input for quantity
    const qtyInput = screen.getByDisplayValue('1');
    expect(qtyInput).toBeInTheDocument();
  });

  it('keeps the inline add form open, clears the name, and refocuses the input after a successful add', async () => {
    render(<PantryPanel />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Rice' } });
    const addBtn = screen.getAllByText('Add').find(el => el.tagName === 'BUTTON')!;
    fireEvent.click(addBtn);

    await waitFor(() => expect(mockAddItem).toHaveBeenCalled());
    // Form stays open (input still present) and is cleared + refocused,
    // rather than unmounting (which is what triggers iOS's scroll-jump bug).
    await waitFor(() => expect(screen.getByPlaceholderText('Item name...')).toHaveValue(''));
    expect(screen.getByPlaceholderText('Item name...')).toBe(document.activeElement);
  });

  it('does not call addItem, clear the input, or close the form for an empty name', () => {
    render(<PantryPanel />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const addBtn = screen.getAllByText('Add').find(el => el.tagName === 'BUTTON')!;
    fireEvent.click(addBtn);

    expect(mockAddItem).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
  });

  it('pressing Escape in the inline add form closes it via the anchored-exit helper', () => {
    render(<PantryPanel />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const input = screen.getByPlaceholderText('Item name...');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(exitEditAnchored).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Item name...')).not.toBeInTheDocument();
  });

  it('clicking Cancel in the inline add form closes it via the anchored-exit helper', () => {
    render(<PantryPanel />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    fireEvent.click(screen.getByText('Cancel'));

    expect(exitEditAnchored).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText('Item name...')).not.toBeInTheDocument();
  });

  it('clicking Add does not move focus off the item-name input (keeps the iOS keyboard open)', async () => {
    const user = userEvent.setup();
    render(<PantryPanel />);
    const addButtons = screen.getAllByText('+ Add item');
    fireEvent.click(addButtons[0]);

    const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
    await user.type(input, 'Rice');
    expect(document.activeElement).toBe(input);

    const addBtn = screen.getAllByText('Add').find(el => el.tagName === 'BUTTON')!;
    // The actual mechanism under test: the button suppresses the browser's
    // default focus-shift on mousedown, so the input — and with it the iOS
    // keyboard — never loses focus. Asserting `activeElement` alone cannot
    // see this: the post-add `.focus()` fallback restores focus in
    // happy-dom whether or not the guard exists, whereas on real iOS a
    // `.focus()` outside a user-gesture context cannot reopen a keyboard
    // that has already been dismissed. Verified by deletion — removing the
    // `onMouseDown` guard fails this assertion and nothing else.
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    addBtn.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);

    await user.click(addBtn);

    expect(document.activeElement).toBe(input);
    await waitFor(() => expect(mockAddItem).toHaveBeenCalled());
  });

  // The blur-close defers one frame so focus can land on its real target.
  const nextFrame = () => act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });

  // Dismissing the keyboard with the add form open used to leave the form
  // mounted, and that is the one state in the app where position cannot be
  // held: with no layout change there is nothing for exitEditAnchored's pin
  // to measure, and iOS's movement is a visual-viewport change that is
  // invisible to getBoundingClientRect/window.scrollBy. Blur now routes the
  // form down the same anchored-unmount path the Meals tab and the inline
  // edit rows already use. Typed text lives in the parent, so it survives.
  describe('dismissing the keyboard with the inline add form open', () => {
    it('closes the form through the anchored path when focus leaves it', async () => {
      render(<PantryPanel />);
      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Grapes' } });
      vi.mocked(exitEditAnchored).mockClear();

      input.blur();
      fireEvent.blur(input);
      await nextFrame();

      expect(screen.queryByPlaceholderText('Item name...')).toBeNull();
      expect(exitEditAnchored).toHaveBeenCalled();
    });

    it('keeps the typed name so reopening the form restores it', async () => {
      render(<PantryPanel />);
      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Grapes' } });

      input.blur();
      fireEvent.blur(input);
      await nextFrame();
      expect(screen.queryByPlaceholderText('Item name...')).toBeNull();

      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      expect(screen.getByPlaceholderText('Item name...')).toHaveValue('Grapes');
    });

    it('stays open when focus moves to another control inside the form', async () => {
      render(<PantryPanel />);
      fireEvent.click(screen.getAllByText('+ Add item')[0]);
      const input = screen.getByPlaceholderText('Item name...') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'Grapes' } });

      const qty = document.querySelector('input[type="number"]') as HTMLInputElement;
      qty.focus();
      fireEvent.blur(input);
      await nextFrame();

      expect(screen.getByPlaceholderText('Item name...')).toBeInTheDocument();
    });
  });

  it('section add form submits on Enter keypress in section name input', async () => {
    mockSections = [];
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('+ Add section'));

    const input = screen.getByPlaceholderText('Section name...');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockAddSection).toHaveBeenCalledWith('Freezer');
  });

  it('section add form cancels on Escape', () => {
    mockSections = [];
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('+ Add section'));

    const input = screen.getByPlaceholderText('Section name...');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByPlaceholderText('Section name...')).not.toBeInTheDocument();
  });

  it('does not save unchanged name on edit', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    // Don't change the name, just save
    fireEvent.click(screen.getByText('Save'));

    expect(mockUpdateItem).not.toHaveBeenCalled();
  });

  it('does not save empty name on edit', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Milk'));

    const input = screen.getByDisplayValue('Milk');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    expect(mockUpdateItem).not.toHaveBeenCalled();
  });

  it('onBlur commits section rename', () => {
    render(<PantryPanel />);
    fireEvent.click(screen.getByText('Fridge'));

    const input = screen.getByDisplayValue('Fridge');
    fireEvent.change(input, { target: { value: 'Freezer' } });
    fireEvent.blur(input);

    expect(mockRenameSection).toHaveBeenCalledWith('s1', 'Freezer');
  });
});
