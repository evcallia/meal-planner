import { useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ChecklistItemRow, ChecklistItem } from '../ChecklistParts';
import { exitEditAnchored } from '../../utils/exitEditAnchored';

vi.mock('../../utils/exitEditAnchored', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exitEditAnchored')>();
  return { exitEditAnchored: vi.fn(actual.exitEditAnchored) };
});

const baseItem: ChecklistItem = {
  id: 'i1', section_id: 's1', name: 'Lemon', quantity: '6', checked: false, position: 0,
};

function Harness({ onEdit }: { onEdit: (id: string, updates: Record<string, unknown>) => void }) {
  const commitEditingRef = useRef<(() => void) | null>(null);
  // Mounted straight into edit mode: the row focuses its name input on mount,
  // which is the state a user is in when they reach for the keyboard's key.
  const [editingItemId, setEditingItemId] = useState<string | null>(baseItem.id);
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

// iOS's keyboard-dismiss key (the check mark above the keyboard) closes the
// keyboard without moving focus, so blur/focusout/pointerdown all stay
// silent. Before this was handled, the edit form just sat there: the typed
// text was saved only if the user went back and pressed Save, and the page
// jumped, because nothing ran exitEditAnchored's pin over the layout switch
// back to window scrolling.
describe('ChecklistItemRow — dismissing the keyboard while editing', () => {
  let resizeListeners: EventListener[];
  let viewport: { height: number; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  const openKeyboard = () => {
    viewport.height = window.innerHeight - 300;
    resizeListeners.forEach(fn => fn(new Event('resize')));
  };
  const dismissKeyboard = () => {
    viewport.height = window.innerHeight;
    resizeListeners.forEach(fn => fn(new Event('resize')));
  };

  beforeEach(() => {
    vi.mocked(exitEditAnchored).mockClear();
    resizeListeners = [];
    viewport = {
      height: window.innerHeight,
      addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
      // Genuinely detach, so a listener left behind by an unmounted form
      // cannot keep answering resizes in a way the browser never would.
      removeEventListener: vi.fn((_: string, fn: EventListener) => {
        const i = resizeListeners.indexOf(fn);
        if (i >= 0) resizeListeners.splice(i, 1);
      }),
    };
    vi.stubGlobal('visualViewport', viewport);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves the edited name and leaves edit mode through the anchored path', () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);

    const nameInput = screen.getByDisplayValue('Lemon');
    openKeyboard();
    fireEvent.change(nameInput, { target: { value: 'Meyer Lemon' } });

    dismissKeyboard();

    expect(onEdit).toHaveBeenCalledWith('i1', { name: 'Meyer Lemon' });
    // The exit has to go through exitEditAnchored, not a bare state reset:
    // the unmount is the layout change its pin measures against.
    expect(exitEditAnchored).toHaveBeenCalled();
    expect(screen.queryByDisplayValue('Meyer Lemon')).toBeNull();
  });

  it('leaves a blur to the blur handlers, which edit rows deliberately lack', () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);

    const nameInput = screen.getByDisplayValue('Lemon');
    openKeyboard();
    fireEvent.change(nameInput, { target: { value: 'Meyer Lemon' } });

    // Committing on blur was tried and reverted: on device it closed the row
    // without saving, so the text was lost rather than merely stranded. The
    // hook must stay out of the blur case until that is understood.
    nameInput.blur();
    dismissKeyboard();

    expect(onEdit).not.toHaveBeenCalled();
  });
});
