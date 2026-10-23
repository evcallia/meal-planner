import { useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChecklistItemRow, ChecklistItem } from '../ChecklistParts';
import { flashItems, __resetFlashesForTests, FLASH_MS } from '../../utils/recentFlash';

const baseItem: ChecklistItem = {
  id: 'i1', section_id: 's1', name: 'Lemon', quantity: '6', checked: false, position: 0,
};

function Harness({ onEdit = vi.fn(), startEditing = false }: {
  onEdit?: (id: string, updates: Record<string, unknown>) => void;
  startEditing?: boolean;
}) {
  const commitEditingRef = useRef<(() => void) | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(startEditing ? baseItem.id : null);
  return (
    <ChecklistItemRow
      item={baseItem}
      onToggle={vi.fn()}
      onDelete={vi.fn()}
      onEdit={onEdit}
      chips={[]}
      chipId={null}
      onCreateChip={vi.fn()}
      editingItemId={editingItemId}
      onEditingItemChange={setEditingItemId}
      commitEditingRef={commitEditingRef}
      sectionName="Produce"
      allSections={[{ id: 's1', name: 'Produce' }]}
      editHighlightColor="emerald"
      onChangeSection={vi.fn()}
    />
  );
}

const flash = () => screen.queryByTestId('row-flash');

// "Which row did that just change?" — obvious for a tap on the row in front
// of you, not obvious for an add that merges into an existing row, and not
// obvious at all for an undo, which can land anywhere in the list.
describe('ChecklistItemRow — recent-change flash', () => {
  beforeEach(() => {
    __resetFlashesForTests();
  });
  afterEach(() => {
    __resetFlashesForTests();
  });

  it('shows no highlight when nothing has changed', () => {
    render(<Harness />);
    expect(flash()).toBeNull();
  });

  it('highlights the row whose id was flashed', () => {
    render(<Harness />);
    act(() => { flashItems(['i1']); });
    expect(flash()).toBeInTheDocument();
    expect(flash()).toHaveClass('row-flash-edit');
  });

  it('leaves other rows alone', () => {
    render(<Harness />);
    act(() => { flashItems(['someone-else']); });
    expect(flash()).toBeNull();
  });

  it('removes the highlight once it has faded', () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      act(() => { flashItems(['i1']); });
      expect(flash()).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(FLASH_MS + 1); });
      expect(flash()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // The animation ends `forwards` (fully transparent), so replaying it needs
  // a new element — which is what keying the overlay on the flash number
  // buys. Undoing and redoing the same item is exactly this case.
  it('replays rather than staying faded when the same row flashes twice', () => {
    render(<Harness />);
    act(() => { flashItems(['i1']); });
    const first = flash();
    act(() => { flashItems(['i1']); });
    expect(flash()).toBeInTheDocument();
    expect(flash()).not.toBe(first);
  });

  it('does not swallow taps on the row underneath', () => {
    render(<Harness />);
    act(() => { flashItems(['i1']); });
    expect(flash()).toHaveClass('pointer-events-none');
  });

  it('highlights the row when its own edit is saved', () => {
    render(<Harness startEditing />);

    const nameInput = screen.getByDisplayValue('Lemon');
    fireEvent.change(nameInput, { target: { value: 'Meyer Lemon' } });
    fireEvent.click(screen.getByText('Save'));

    expect(flash()).toBeInTheDocument();
  });

  // Save with nothing changed is not a change — flashing there would train
  // the eye to ignore the highlight.
  it('does not highlight when a save changed nothing', () => {
    render(<Harness startEditing />);
    fireEvent.click(screen.getByText('Save'));
    expect(flash()).toBeNull();
  });
});
