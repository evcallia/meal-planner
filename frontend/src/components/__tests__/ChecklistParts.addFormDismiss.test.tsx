import { useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { ChecklistSectionCard } from '../ChecklistParts';

const section = { id: 's1', name: 'Produce', items: [] };
const chips = [{ id: 'st1', name: 'Costco', position: 0 }];

function Harness({ onAddItem }: { onAddItem: (sectionId: string) => void }) {
  const commitEditingRef = useRef<(() => void) | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newItemChipId, setNewItemChipId] = useState<string | null>(null);
  const [addingToSection, setAddingToSection] = useState<string | null>(section.id);
  return (
    <ChecklistSectionCard
      section={section}
      visibleItems={[]}
      sectionDragHandlers={{}}
      sectionHandleMouseDown={vi.fn()}
      isSectionDragging={false}
      isCollapsed={false}
      onToggleCollapse={vi.fn()}
      onToggle={vi.fn()}
      onDelete={vi.fn()}
      onEdit={vi.fn()}
      onRenameSection={vi.fn()}
      onReorderItems={vi.fn()}
      onItemDropOutside={vi.fn()}
      onItemDragMove={vi.fn()}
      onItemDragEnd={vi.fn()}
      crossDropTarget={null}
      addingToSection={addingToSection}
      onStartAdd={setAddingToSection}
      newItemName={newItemName}
      onNewItemNameChange={setNewItemName}
      newItemChipId={newItemChipId}
      onNewItemChipChange={setNewItemChipId}
      onAddItem={onAddItem}
      chips={chips}
      chipIdFor={() => null}
      onCreateChip={vi.fn()}
      editingItemId={null}
      onEditingItemChange={vi.fn()}
      commitEditingRef={commitEditingRef}
      itemDefaultsMap={new Map()}
      currentListItemNames={new Set()}
      onDeleteItemDefault={vi.fn()}
      allSections={[{ id: 's1', name: 'Produce' }]}
      editHighlightColor="emerald"
      onChangeSection={vi.fn()}
    />
  );
}

// The inline add form grew a second line — the store/tag field — and that
// field arrived with no exit of its own. The commit sat on the NAME INPUT's
// onBlur, so dismissing the keyboard from the store box fired nothing at
// all: the keyboard closed and the typed item was silently dropped. This is
// the same mistake the edit row already made and fixed (there, it read as
// "only the title saves"); the fix is the same, and it belongs on the FORM,
// which cannot be outgrown by adding another field.
describe('ChecklistSectionCard — dismissing the keyboard from the add form', () => {
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
  const nextFrame = () => act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });

  const form = () => screen.getByTestId('inline-add-form');
  const nameInput = () => within(form()).getByPlaceholderText('Item name...');
  const storeInput = () => within(form()).getByPlaceholderText('Assign store...');

  beforeEach(() => {
    resizeListeners = [];
    viewport = {
      height: window.innerHeight,
      addEventListener: vi.fn((_: string, fn: EventListener) => resizeListeners.push(fn)),
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

  it('adds the item when the dismiss key blurs the store/tag field', async () => {
    const onAddItem = vi.fn();
    render(<Harness onAddItem={onAddItem} />);

    openKeyboard();
    fireEvent.change(nameInput(), { target: { value: 'Lemon' } });

    // Move to the store field — part of the same add, so nothing commits yet.
    storeInput().focus();
    fireEvent.blur(nameInput());
    await nextFrame();
    expect(onAddItem).not.toHaveBeenCalled();

    // iOS's dismiss key blurs with focus landing on <body>.
    storeInput().blur();
    await nextFrame();

    expect(onAddItem).toHaveBeenCalledWith('s1');
  });

  it('adds the item when the keyboard closes without a blur', () => {
    const onAddItem = vi.fn();
    render(<Harness onAddItem={onAddItem} />);

    openKeyboard();
    fireEvent.change(nameInput(), { target: { value: 'Lemon' } });
    storeInput().focus();

    // The other half of the dismiss key: a device that keeps focus and only
    // grows the viewport back. The edit row has had this since the trace;
    // the add form never got it.
    dismissKeyboard();

    expect(onAddItem).toHaveBeenCalledWith('s1');
  });

  it('still adds when the dismissal comes from the name field', async () => {
    const onAddItem = vi.fn();
    render(<Harness onAddItem={onAddItem} />);

    openKeyboard();
    fireEvent.change(nameInput(), { target: { value: 'Lemon' } });
    nameInput().blur();
    await nextFrame();

    expect(onAddItem).toHaveBeenCalledWith('s1');
  });

  it('closes without adding when nothing was typed', async () => {
    const onAddItem = vi.fn();
    render(<Harness onAddItem={onAddItem} />);

    openKeyboard();
    storeInput().focus();
    storeInput().blur();
    await nextFrame();

    expect(onAddItem).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inline-add-form')).toBeNull();
  });
});
