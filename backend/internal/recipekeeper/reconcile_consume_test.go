package recipekeeper

import (
	"testing"

	"mealplanner/internal/models"
)

// Decrementing must spend MP-only units before touching anything linked to a
// recipe — a locally-added unit costs nothing to give up, a linked one costs a
// write to a third party.
func TestConsumeUnitsSpendsLocalUnitsFirst(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})
	// User adds one of their own: quantity 3, two links.
	item := itemByName(t, db, "Lemon", false)
	setQuantity(item, 3)
	db.Save(item)

	if err := r.ConsumeUnits(item.ID, 1); err != nil {
		t.Fatalf("ConsumeUnits: %v", err)
	}

	item = itemByName(t, db, "Lemon", false)
	if quantityOf(item) != 2 {
		t.Errorf("quantity = %d, want 2", quantityOf(item))
	}
	if n := linkCount(db, item.Name, item.Checked); n != 2 {
		t.Errorf("links = %d, want 2 — no link should have moved", n)
	}
	pushes, _ := r.PendingPushes()
	if len(pushes) != 0 {
		t.Errorf("spending a local unit must not push: %+v", pushes)
	}
}

// Once local units run out, decrementing checks off linked rows, lowest
// rk_position first, and those become pending pushes.
func TestConsumeUnitsChecksLinksWhenLocalExhausted(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	a := rkItem("a-id", "Lemon", withRecipe("r1"))
	a.Position = 10
	b := rkItem("b-id", "Lemon", withRecipe("r2"))
	b.Position = 20
	_, _ = r.ApplyInbound([]ShoppingListItem{a, b})

	item := itemByName(t, db, "Lemon", false)
	if err := r.ConsumeUnits(item.ID, 1); err != nil {
		t.Fatalf("ConsumeUnits: %v", err)
	}

	unchecked := itemByName(t, db, "Lemon", false)
	checkedRow := itemByName(t, db, "Lemon", true)
	if unchecked == nil || checkedRow == nil {
		t.Fatal("want both an unchecked and a checked Lemon row")
	}
	if quantityOf(unchecked) != 1 || quantityOf(checkedRow) != 1 {
		t.Errorf("quantities = %d / %d, want 1 / 1", quantityOf(unchecked), quantityOf(checkedRow))
	}

	// The lowest-position link (a-id) is the one that moved.
	var moved models.RecipeKeeperLink
	db.First(&moved, "rk_item_id = ?", "a-id")
	if moved.MPName != "lemon" || !moved.MPChecked {
		t.Error("lowest-position link should have moved to the checked row")
	}

	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 || pushes[0].ID != "a-id" || !pushes[0].IsChecked {
		t.Errorf("pushes = %+v, want a-id checked", pushes)
	}
}

// Consuming everything empties the source row entirely.
func TestConsumeUnitsAllRemovesSourceRow(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)

	if err := r.ConsumeUnits(item.ID, 1); err != nil {
		t.Fatalf("ConsumeUnits: %v", err)
	}
	if itemByName(t, db, "Fig", false) != nil {
		t.Error("source row should be gone once fully consumed")
	}
	if itemByName(t, db, "Fig", true) == nil {
		t.Error("checked row should exist")
	}
}
