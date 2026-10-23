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

function Harness({ onEdit, onChangeSection = vi.fn() }: {
  onEdit: (id: string, updates: Record<string, unknown>) => void;
  onChangeSection?: (id: string, section: string) => void;
}) {
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
      onChangeSection={onChangeSection}
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
  const nextFrame = () => act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
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

  // The device trace settled which signal iOS's dismiss key gives:
  //   +2840ms focusout from=input="Salmon" nowFocused=body
  // An ordinary blur, with focus landing on <body> — and this row had no
  // blur path at all, which is why that key stranded it while the add forms
  // and the Meals editor behaved.
  it('saves when the dismiss key blurs the input', async () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);

    const nameInput = screen.getByDisplayValue('Lemon');
    openKeyboard();
    fireEvent.change(nameInput, { target: { value: 'Meyer Lemon' } });

    nameInput.blur();
    await nextFrame();

    expect(onEdit).toHaveBeenCalledWith('i1', { name: 'Meyer Lemon' });
    expect(exitEditAnchored).toHaveBeenCalled();
    expect(screen.queryByDisplayValue('Meyer Lemon')).toBeNull();
  });

  it('keeps editing when focus moves to a control inside the form', async () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);

    const nameInput = screen.getByDisplayValue('Lemon');
    openKeyboard();
    fireEvent.change(nameInput, { target: { value: 'Meyer Lemon' } });

    // Tapping the quantity stepper, section combobox or chip picker blurs the
    // name input without leaving the form: committing there would end the
    // edit halfway through it.
    screen.getByText('+').focus();
    fireEvent.blur(nameInput);
    await nextFrame();

    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Meyer Lemon')).toBeInTheDocument();
  });

  // The commit lives on the FORM, not the name input. With it on the input,
  // dismissing the keyboard from the section or chip field fired nothing —
  // which on device looked like "only the title saves".
  it('saves a category change made after the name field lost focus', async () => {
    const onEdit = vi.fn();
    const onChangeSection = vi.fn();
    render(<Harness onEdit={onEdit} onChangeSection={onChangeSection} />);

    const nameInput = screen.getByDisplayValue('Lemon');
    openKeyboard();
    fireEvent.change(nameInput, { target: { value: 'Meyer Lemon' } });

    // Moving to the section field must NOT commit — it is the same edit.
    const section = screen.getByPlaceholderText('Section');
    section.focus();
    fireEvent.blur(nameInput);
    await nextFrame();
    expect(onEdit).not.toHaveBeenCalled();

    fireEvent.change(section, { target: { value: 'Citrus' } });

    // Dismissing from the section field commits the whole form.
    section.blur();
    await nextFrame();

    expect(onEdit).toHaveBeenCalledWith('i1', { name: 'Meyer Lemon' });
    expect(onChangeSection).toHaveBeenCalledWith('i1', 'Citrus');
  });

  // iOS's keyboard shows previous/next arrows that walk the fields sharing a
  // FORM OWNER — `input.form`. Without a <form> ancestor that is null, Safari
  // falls back to heuristics, and the store/tag box could not be reached from
  // the keyboard at all while name and category could.
  it('puts every field in one form so the keyboard can walk them', () => {
    render(<Harness onEdit={vi.fn()} />);

    const name = screen.getByDisplayValue('Lemon') as HTMLInputElement;
    const section = screen.getByPlaceholderText('Section') as HTMLInputElement;
    const store = screen.getByPlaceholderText('Assign store...') as HTMLInputElement;

    expect(name.form).not.toBeNull();
    expect(section.form).toBe(name.form);
    expect(store.form).toBe(name.form);
  });

  // Inside a <form> an untyped <button> defaults to type="submit", so a tap
  // on Save, Cancel or the stepper would navigate the page away.
  it('never lets a control submit the form', () => {
    const onSubmit = vi.fn();
    render(<Harness onEdit={vi.fn()} />);
    const form = (screen.getByDisplayValue('Lemon') as HTMLInputElement).form!;
    form.addEventListener('submit', onSubmit);

    // Clicking each one is not the test — Save unmounts the form — so assert
    // the attribute that decides it.
    for (const label of ['Save', 'Cancel', '+', '−']) {
      expect((screen.getByText(label) as HTMLButtonElement).type).toBe('button');
    }
    fireEvent.click(screen.getByText('−'));
    expect(onSubmit).not.toHaveBeenCalled();

    // And the catch-all: anything that does reach submit is prevented, so a
    // nested control nobody typed can't navigate away either.
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
  });

  it('saves once when the blur and the viewport growth both arrive', async () => {
    const onEdit = vi.fn();
    render(<Harness onEdit={onEdit} />);

    const nameInput = screen.getByDisplayValue('Lemon');
    openKeyboard();
    fireEvent.change(nameInput, { target: { value: 'Meyer Lemon' } });

    // Both paths cover this key. The blur lands first and unmounts the form,
    // which unsubscribes the viewport listener, so the growth that follows
    // ~80ms later (per the trace) finds nothing to commit.
    nameInput.blur();
    await nextFrame();
    dismissKeyboard();

    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
