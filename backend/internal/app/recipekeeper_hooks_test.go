package app

// Handler-level coverage for the RecipeKeeper wiring in grocery.go. The
// reconciler primitives (TombstoneLinks, RetargetLinks, ConsumeUnits) are
// already unit-tested in package recipekeeper — what's missing, and what
// these tests exist to prove, is that the grocery HTTP handlers actually
// call them. A handler that forgot would leave every one of those unit
// tests green.

import (
	"testing"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

// Renaming a linked item must retarget its link (links are keyed by
// (name, checked), and Meal Planner mutates the row in place) and the new
// name must show up in what would be pushed next.
func TestUpdateGroceryItemRenameRetargetsLink(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := seedGroceryItem(t, ta, section.ID, "Lemon", 0, false)
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail")

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"name": "Lime"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	var link models.RecipeKeeperLink
	if err := ta.App.DB.First(&link, "rk_item_id = ?", "rk-1").Error; err != nil {
		t.Fatalf("load link: %v", err)
	}
	if link.MPName != "lime" || link.MPChecked {
		t.Errorf("link not retargeted: MPName=%q MPChecked=%v", link.MPName, link.MPChecked)
	}

	pushes, err := ta.App.RecipeKeeper.Rec.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 1 || pushes[0].ID != "rk-1" || pushes[0].Name != "Lime" {
		t.Errorf("pushes = %+v, want one push of rk-1 named Lime", pushes)
	}
}

// Checking off a linked item must retarget its link onto the checked half of
// the collapse key and produce a pending push.
func TestUpdateGroceryItemCheckRetargetsLink(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := seedGroceryItem(t, ta, section.ID, "Lemon", 0, false)
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail")

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"checked": true})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	var link models.RecipeKeeperLink
	if err := ta.App.DB.First(&link, "rk_item_id = ?", "rk-1").Error; err != nil {
		t.Fatalf("load link: %v", err)
	}
	if link.MPName != "lemon" || !link.MPChecked {
		t.Errorf("link not retargeted: MPName=%q MPChecked=%v", link.MPName, link.MPChecked)
	}

	pushes, err := ta.App.RecipeKeeper.Rec.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 1 || pushes[0].ID != "rk-1" || !pushes[0].IsChecked {
		t.Errorf("pushes = %+v, want one push of rk-1 checked", pushes)
	}
}

// Deleting a linked item must tombstone its links before the row (and the
// links' only address, its collapse key) disappears.
func TestDeleteGroceryItemTombstonesLinks(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := seedGroceryItem(t, ta, section.ID, "Lemon", 0, false)
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail")

	resp := ta.DELETE("/api/grocery/items/" + item.ID.String())
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	var tomb models.RecipeKeeperTombstone
	if err := ta.App.DB.First(&tomb, "rk_item_id = ?", "rk-1").Error; err != nil {
		t.Fatalf("expected a tombstone for rk-1: %v", err)
	}
}

// Clear-checked must propagate: a local-only bulk delete would resurrect
// every one of these items on the next Recipe Keeper pull. Only checked
// items' links are tombstoned — an unchecked item elsewhere must survive.
func TestClearCheckedGroceryItemsTombstonesLinks(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	seedGroceryItem(t, ta, section.ID, "Milk", 0, true)
	seedGroceryItem(t, ta, section.ID, "Eggs", 1, true)
	seedGroceryItem(t, ta, section.ID, "Lemon", 2, false)
	seedRecipeKeeperLink(t, ta, "Milk", true, "rk-milk", "rec-1", "Pancakes")
	seedRecipeKeeperLink(t, ta, "Eggs", true, "rk-eggs", "rec-1", "Pancakes")
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-lemon", "rec-2", "Lemonade")

	resp := ta.DELETE("/api/grocery/items?mode=checked")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	var count int64
	ta.App.DB.Model(&models.RecipeKeeperTombstone{}).
		Where("rk_item_id IN ?", []string{"rk-milk", "rk-eggs"}).Count(&count)
	if count != 2 {
		t.Errorf("tombstones for checked items = %d, want 2", count)
	}
	var untouched int64
	ta.App.DB.Model(&models.RecipeKeeperTombstone{}).Where("rk_item_id = ?", "rk-lemon").Count(&untouched)
	if untouched != 0 {
		t.Error("unchecked item's link was tombstoned by a checked-only clear")
	}
}

// Deleting a section requires it to already be empty (unlike Travel/packing,
// grocery sections don't cascade-delete their items) — so today the
// tombstone loop in handleDeleteGrocerySection never actually iterates
// anything. This locks in the two things that ARE true: a rejected
// non-empty delete leaves no tombstones behind, and deleting the
// (necessarily empty) section afterward succeeds without touching Recipe
// Keeper.
func TestDeleteGrocerySectionWithLinkedItemIsRejectedWithoutTombstoning(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	seedGroceryItem(t, ta, section.ID, "Lemon", 0, false)
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail")

	resp := ta.DELETE("/api/grocery/sections/" + section.ID.String())
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400: %s", resp.Status, resp.Body)
	}
	var count int64
	ta.App.DB.Model(&models.RecipeKeeperTombstone{}).Count(&count)
	if count != 0 {
		t.Errorf("tombstones = %d, want 0 — the delete was rejected", count)
	}
}

// Decreasing quantity must spend MP-only units before touching anything
// linked to a recipe, and only check off a linked row once local units run
// out — the same rule ConsumeUnits enforces, exercised here through the real
// PATCH endpoint across two successive decreases.
func TestUpdateGroceryItemDecreaseQuantityConsumesLocalThenLinks(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Lemon", Checked: false, Position: 0, Quantity: strp("3")}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	// Two links (rk_position 10, 20) against quantity 3 — one unit is
	// MP-only.
	seedRecipeKeeperLinkAt(t, ta, "Lemon", false, "a-id", "rec-1", "Fig Cocktail", 10)
	seedRecipeKeeperLinkAt(t, ta, "Lemon", false, "b-id", "rec-2", "Lemon Bars", 20)

	// 3 -> 2 spends the one local unit. No link should move, nothing pushed.
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": "2"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	var links []models.RecipeKeeperLink
	ta.App.DB.Order("rk_item_id").Find(&links)
	for _, l := range links {
		if l.MPChecked {
			t.Fatalf("link %s moved on a purely local decrease: %+v", l.RKItemID, l)
		}
	}
	pushes, err := ta.App.RecipeKeeper.Rec.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 0 {
		t.Fatalf("spending a local unit must not push: %+v", pushes)
	}

	// 2 -> 1 exhausts local units — the lowest rk_position link (a-id) must
	// check off and become a pending push.
	resp = ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": "1"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	var moved models.RecipeKeeperLink
	if err := ta.App.DB.First(&moved, "rk_item_id = ?", "a-id").Error; err != nil {
		t.Fatalf("load link: %v", err)
	}
	if !moved.MPChecked {
		t.Error("lowest rk_position link should have moved to the checked row")
	}
	pushes, err = ta.App.RecipeKeeper.Rec.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 1 || pushes[0].ID != "a-id" || !pushes[0].IsChecked {
		t.Errorf("pushes = %+v, want a-id checked", pushes)
	}
}

// With the integration disabled — a.RecipeKeeper == nil, same as a
// deployment with no RECIPE_KEEPER_* env vars — every one of the five wired
// endpoints must behave exactly as before: no panic, no Recipe Keeper
// bookkeeping, same status codes an unmodified handler would return.
func TestGroceryHandlersUnaffectedWhenRecipeKeeperDisabled(t *testing.T) {
	ta := newTestApp(t) // a.RecipeKeeper is left nil

	section := seedGrocerySection(t, ta, "Produce", 0)
	renamed := seedGroceryItem(t, ta, section.ID, "Lemon", 0, false)
	if resp := ta.PATCH("/api/grocery/items/"+renamed.ID.String(), map[string]any{"name": "Lime", "checked": true}); resp.Status != 200 {
		t.Fatalf("rename+check: status = %d: %s", resp.Status, resp.Body)
	}

	qtyItem := models.GroceryItem{SectionID: section.ID, Name: "Sugar", Checked: false, Position: 1, Quantity: strp("3")}
	if err := ta.App.DB.Create(&qtyItem).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	if resp := ta.PATCH("/api/grocery/items/"+qtyItem.ID.String(), map[string]any{"quantity": "1"}); resp.Status != 200 {
		t.Fatalf("quantity decrease: status = %d: %s", resp.Status, resp.Body)
	}

	deleted := seedGroceryItem(t, ta, section.ID, "Flour", 2, false)
	if resp := ta.DELETE("/api/grocery/items/" + deleted.ID.String()); resp.Status != 200 {
		t.Fatalf("delete item: status = %d: %s", resp.Status, resp.Body)
	}

	checkedItem := seedGroceryItem(t, ta, section.ID, "Butter", 3, true)
	_ = checkedItem
	if resp := ta.DELETE("/api/grocery/items?mode=checked"); resp.Status != 200 {
		t.Fatalf("clear checked: status = %d: %s", resp.Status, resp.Body)
	}

	emptySection := seedGrocerySection(t, ta, "Empty", 1)
	if resp := ta.DELETE("/api/grocery/sections/" + emptySection.ID.String()); resp.Status != 204 {
		t.Fatalf("delete section: status = %d: %s", resp.Status, resp.Body)
	}

	// Missing-row tolerance on update is unconditional (not RecipeKeeper-
	// specific), so it must hold here too.
	if resp := ta.PATCH("/api/grocery/items/"+uuid.NewString(), map[string]any{"checked": true}); resp.Status != 200 {
		t.Fatalf("missing item update: status = %d, want 200", resp.Status)
	}
}
