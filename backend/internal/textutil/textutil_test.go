package textutil

// Port of backend/tests/test_itemized_alignment.py: itemized-state
// preservation across meal note edits. The Python tests drive
// PUT /api/days/{date}/notes; the state carry-over logic under test lives
// here, so noteSim replays the handler's SplitNoteLines +
// CarryItemizedState sequence directly.

import (
	"reflect"
	"testing"
)

// noteSim mirrors handleUpdateNotes' use of this package: each put replaces
// the note's lines, carrying itemized state from the previous revision.
type noteSim struct {
	lines    []string
	itemized map[int]bool
}

func newNoteSim() *noteSim {
	return &noteSim{itemized: map[int]bool{}}
}

// put mirrors put_notes: apply new note text and return the resulting
// {line_index: itemized} map.
func (n *noteSim) put(notes string) map[int]bool {
	newLines := []string{}
	if notes != "" {
		newLines = SplitNoteLines(notes)
	}
	carried := CarryItemizedState(n.lines, newLines, n.itemized)
	n.lines = newLines
	n.itemized = map[int]bool{}
	out := map[int]bool{}
	for i, v := range carried {
		n.itemized[i] = v
		out[i] = v
	}
	return out
}

// setItemized mirrors set_itemized (PATCH /api/days/{date}/items/{i}).
func (n *noteSim) setItemized(lineIndex int, itemized bool) {
	n.itemized[lineIndex] = itemized
}

func assertItems(t *testing.T, got, want map[int]bool) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("items = %v, want %v", got, want)
	}
}

func TestAppendingMealPreservesOtherLines(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Tacos\nPizza"), map[int]bool{0: false, 1: false})
	sim.setItemized(0, true)
	assertItems(t, sim.put("Tacos\nPizza\nSalad"), map[int]bool{0: true, 1: false, 2: false})
}

func TestEditingLineInPlaceKeepsItsState(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Tacos\nPizza"), map[int]bool{0: false, 1: false})
	sim.setItemized(1, true)
	assertItems(t, sim.put("Tacos\nPizza night"), map[int]bool{0: false, 1: true})
}

func TestTypoFixKeepsState(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Tacs\nPizza"), map[int]bool{0: false, 1: false})
	sim.setItemized(0, true)
	assertItems(t, sim.put("Tacos\nPizza"), map[int]bool{0: true, 1: false})
}

func TestRewritingLineToDifferentMealResetsState(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Tacos\nPizza"), map[int]bool{0: false, 1: false})
	sim.setItemized(0, true)
	assertItems(t, sim.put("Tandoori\nPizza"), map[int]bool{0: false, 1: false})
}

func TestInsertingLineAboveShiftsState(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Tacos\nPizza"), map[int]bool{0: false, 1: false})
	sim.setItemized(1, true)
	assertItems(t, sim.put("Soup\nTacos\nPizza"), map[int]bool{0: false, 1: false, 2: true})
}

func TestDuplicateLinesKeepIndividualState(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Tacos\nTacos"), map[int]bool{0: false, 1: false})
	sim.setItemized(0, true)
	assertItems(t, sim.put("Tacos\nTacos\nPizza"), map[int]bool{0: true, 1: false, 2: false})
}

func TestDeletingLineDropsStateAndShiftsRest(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Eggs\nBacon\nToast"), map[int]bool{0: false, 1: false, 2: false})
	sim.setItemized(2, true)
	assertItems(t, sim.put("Eggs\nToast"), map[int]bool{0: false, 1: true})
}

func TestReorderingLinesCarriesState(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Tacos\nPizza"), map[int]bool{0: false, 1: false})
	sim.setItemized(0, true)
	assertItems(t, sim.put("Pizza\nTacos"), map[int]bool{0: false, 1: true})
}

func TestHTMLLinesAlignLikeFrontend(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("<div>Tacos</div><div>Pizza</div>"), map[int]bool{0: false, 1: false})
	sim.setItemized(1, true)
	assertItems(t, sim.put("<div>Tacos</div><div>Pizza</div><div>Salad</div>"),
		map[int]bool{0: false, 1: true, 2: false})
}

func TestClearingNotesRemovesAllItems(t *testing.T) {
	sim := newNoteSim()
	assertItems(t, sim.put("Tacos"), map[int]bool{0: false})
	sim.setItemized(0, true)
	assertItems(t, sim.put(""), map[int]bool{})
}
