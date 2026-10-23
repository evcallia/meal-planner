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

// The headline path — "4 needed, got 1" — must leave the client able to see
// the checked row ConsumeUnits creates as a side effect. handleUpdateGroceryItem
// broadcasts exactly one grocery.updated event for this PATCH, and the new
// checked row is a second grocery item the event's own "item" field says
// nothing about — so that event must omit "action" entirely, which is the
// documented signal every hook (and the cache warmer) treats as "refetch the
// whole list", rather than claiming a plain item-updated that leaves the new
// row invisible until an unrelated refetch.
func TestUpdateGroceryItemConsumeCreatingCheckedRowOmitsActionForFullRefetch(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Lemon", Checked: false, Position: 0, Quantity: strp("4")}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	seedRecipeKeeperLinkAt(t, ta, "Lemon", false, "a-id", "rec-1", "Fig Cocktail", 10)

	col := ta.Collect(TestSub)
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": "1"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	// The checked sibling really was created in the database — this is the
	// row no client would otherwise learn about.
	var checkedCount int64
	ta.App.DB.Model(&models.GroceryItem{}).Where("name = ? AND checked = ?", "Lemon", true).Count(&checkedCount)
	if checkedCount != 1 {
		t.Fatalf("checked Lemon rows = %d, want 1", checkedCount)
	}

	events := col.Events()
	sawFallback := false
	for _, e := range events {
		if e["type"] != "grocery.updated" {
			continue
		}
		payload, _ := e["payload"].(map[string]any)
		if _, hasAction := payload["action"]; !hasAction {
			sawFallback = true
		}
	}
	if !sawFallback {
		t.Fatalf("want a grocery.updated event with no \"action\" key (triggers the full-refetch fallback) when ConsumeUnits touches a second row, got events = %+v", events)
	}

	// The acting client filters out its own SSE event by source_id, so it
	// never sees the fallback above — the response to ITS OWN request must
	// carry the same "something else changed" signal so it can refetch
	// itself instead of showing a stale recipe list until a manual refresh.
	if changed, _ := resp.Obj()["second_row_changed"].(bool); !changed {
		t.Errorf("response second_row_changed = %v, want true", resp.Obj()["second_row_changed"])
	}
}

// A decrease that does NOT create/touch a second row (the item was already
// checked, so ConsumeUnits' dest resolves to the very same row) must keep the
// normal, precise "item-updated" action — omitting it here would make every
// checked-item quantity nudge fall back to a full refetch for no reason.
func TestUpdateGroceryItemConsumeOnAlreadyCheckedItemKeepsItemUpdatedAction(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Lemon", Checked: true, Position: 0, Quantity: strp("3")}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}

	col := ta.Collect(TestSub)
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": "2"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	payload := col.LastPayload("grocery.updated")
	if payload == nil {
		t.Fatal("no grocery.updated event")
	}
	if payload["action"] != "item-updated" {
		t.Errorf("action = %v, want item-updated (no second row was touched)", payload["action"])
	}
	if _, present := resp.Obj()["second_row_changed"]; present {
		t.Errorf("second_row_changed = %v, want absent — no second row was touched, so the acting client must not refetch needlessly", resp.Obj()["second_row_changed"])
	}
}

// Regression guard for the double-decrement bug found during review: the
// ordinary "quantity" column write and ConsumeUnits both persist the row's
// final quantity, and running both would subtract the decrease twice
// (4 -> 3 landing on 2). No RK links at all here — the whole unit is
// MP-only — so the only way this could land anywhere but 3 is that bug.
func TestUpdateGroceryItemDecreaseQuantityNotDoubleDecremented(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Sugar", Checked: false, Position: 0, Quantity: strp("4")}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": "3"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if q := resp.Obj()["quantity"]; q != "3" {
		t.Fatalf("quantity = %v, want \"3\" (double-decrement would land on 2)", q)
	}
	var reloaded models.GroceryItem
	if err := ta.App.DB.First(&reloaded, "id = ?", item.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.Quantity == nil || *reloaded.Quantity != "3" {
		t.Fatalf("db quantity = %v, want \"3\"", reloaded.Quantity)
	}
}

// A non-integer quantity (freeform text like "2 lbs") must never be routed
// through ConsumeUnits — QuantityOf would parse it as the default "1",
// which looks like a decrease from any oldQty > 1, and ConsumeUnits would
// silently replace the user's literal text with a bare integer. The plain
// write must preserve it exactly, matching the RecipeKeeper-disabled path.
func TestUpdateGroceryItemFreeformQuantityBypassesConsumeUnits(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Flour", Checked: false, Position: 0, Quantity: strp("3")}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": "2 lbs"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if q := resp.Obj()["quantity"]; q != "2 lbs" {
		t.Fatalf("quantity = %v, want the literal \"2 lbs\" preserved", q)
	}
	// No checked sibling should have been created — ConsumeUnits never ran.
	var checked int64
	ta.App.DB.Model(&models.GroceryItem{}).Where("name = ? AND checked = ?", "Flour", true).Count(&checked)
	if checked != 0 {
		t.Errorf("a checked sibling was created — ConsumeUnits ran on a freeform quantity")
	}
}

// Renaming and decreasing quantity in the SAME PATCH must retarget before
// consuming — ConsumeUnits looks up links under the item's CURRENT
// (name, checked), so consuming first would find nothing under the new
// name and silently fail to check off the linked row that should exhaust.
func TestUpdateGroceryItemRenameAndDecreaseInOnePatchRetargetsBeforeConsuming(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Lemon", Checked: false, Position: 0, Quantity: strp("2")}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	// Quantity 2, two links — zero local units, so the decrease below MUST
	// check off a link, and it can only find that link if the rename
	// retargeted it first.
	seedRecipeKeeperLinkAt(t, ta, "Lemon", false, "a-id", "rec-1", "Fig Cocktail", 10)
	seedRecipeKeeperLinkAt(t, ta, "Lemon", false, "b-id", "rec-2", "Lemon Bars", 20)

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"name": "Lime", "quantity": "1"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	var links []models.RecipeKeeperLink
	ta.App.DB.Order("rk_item_id").Find(&links)
	if len(links) != 2 {
		t.Fatalf("links = %d, want 2", len(links))
	}
	for _, l := range links {
		if l.MPName != "lime" {
			t.Errorf("link %s MPName = %q, want lime — rename did not retarget it", l.RKItemID, l.MPName)
		}
	}
	var moved, untouched models.RecipeKeeperLink
	ta.App.DB.First(&moved, "rk_item_id = ?", "a-id")
	ta.App.DB.First(&untouched, "rk_item_id = ?", "b-id")
	if !moved.MPChecked {
		t.Error("a-id (lowest rk_position) should have been checked off by the consume")
	}
	if untouched.MPChecked {
		t.Error("b-id should still be unchecked — only one link needed to be consumed")
	}

	pushes, err := ta.App.RecipeKeeper.Rec.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 2 {
		t.Fatalf("pushes = %+v, want 2 (both renamed, one also checked)", pushes)
	}
	sawChecked, sawUnchecked := false, false
	for _, p := range pushes {
		if p.Name != "Lime" {
			t.Errorf("push %+v has stale name", p)
		}
		if p.IsChecked {
			sawChecked = true
		} else {
			sawUnchecked = true
		}
	}
	if !sawChecked || !sawUnchecked {
		t.Errorf("pushes = %+v, want one checked and one unchecked", pushes)
	}
}

// mode=all must tombstone every item's links, not just checked ones — the
// whole list (and every section) is about to be deleted.
func TestClearAllGroceryItemsTombstonesLinks(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	seedGroceryItem(t, ta, section.ID, "Milk", 0, true)
	seedGroceryItem(t, ta, section.ID, "Lemon", 1, false)
	seedRecipeKeeperLink(t, ta, "Milk", true, "rk-milk", "rec-1", "Pancakes")
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-lemon", "rec-2", "Lemonade")

	resp := ta.DELETE("/api/grocery/items?mode=all")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	var count int64
	ta.App.DB.Model(&models.RecipeKeeperTombstone{}).
		Where("rk_item_id IN ?", []string{"rk-milk", "rk-lemon"}).Count(&count)
	if count != 2 {
		t.Errorf("tombstones = %d, want 2", count)
	}
}

// PUT /api/grocery (merge/paste, and the replay target for undo of delete
// and clear) must NEVER tombstone anything, even though it wipes and
// recreates every section and item under fresh ids. Tombstoning here would
// push a delete of the user's entire Recipe Keeper list the first time they
// hit undo — the most destructive possible outcome of this whole task.
func TestReplaceGroceryCreatesZeroTombstones(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	section := seedGrocerySection(t, ta, "Produce", 0)
	seedGroceryItem(t, ta, section.ID, "Lemon", 0, false)
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail")

	resp := ta.PUT("/api/grocery", map[string]any{
		"sections": []map[string]any{{
			"name":  "Produce",
			"items": []map[string]any{{"name": "Lime"}},
		}},
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	var count int64
	ta.App.DB.Model(&models.RecipeKeeperTombstone{}).Count(&count)
	if count != 0 {
		t.Fatalf("tombstones = %d, want 0 — PUT /api/grocery must never tombstone", count)
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
	// Assert the actual final quantity, not just the status code — deleting
	// the plain-write "else" branch in handleUpdateGroceryItem's quantity
	// block and routing every decrease through the RecipeKeeper-only path
	// would still return 200 here (a.RecipeKeeper is nil, so ConsumeUnits is
	// never reachable either way), silently leaving this path unpinned.
	resp := ta.PATCH("/api/grocery/items/"+qtyItem.ID.String(), map[string]any{"quantity": "1"})
	if resp.Status != 200 {
		t.Fatalf("quantity decrease: status = %d: %s", resp.Status, resp.Body)
	}
	if q := resp.Obj()["quantity"]; q != "1" {
		t.Fatalf("quantity = %v, want \"1\"", q)
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
	if resp := ta.PATCH("/api/grocery/items/"+uuid.NewString(), map[string]any{"checked": true}); resp.Status != 204 {
		t.Fatalf("missing item update: status = %d, want 204", resp.Status)
	}
}
