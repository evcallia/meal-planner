package recipekeeper

import (
	"testing"

	"mealplanner/internal/models"
)

// A locally-checked row must produce a push for each of its links, carrying the
// complete entity with Z stripped from LastModified.
func TestPendingPushesOnLocalCheck(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})

	item := itemByName(t, db, "Lemon", false)
	item.Checked = true
	db.Save(item)
	// Meal Planner checks an item by flipping a flag on the same row; links
	// are keyed by (name, checked), so retargeting is what makes the row
	// still resolvable rather than an orphan.
	if err := r.RetargetLinks("Lemon", false, true); err != nil {
		t.Fatalf("RetargetLinks: %v", err)
	}

	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 2 {
		t.Fatalf("pushes = %d, want 2", len(pushes))
	}
	for _, p := range pushes {
		if !p.IsChecked {
			t.Errorf("push %s not checked", p.ID)
		}
		if p.CheckedDate == nil {
			t.Errorf("push %s missing CheckedDate", p.ID)
		}
		if p.LastModified == nil {
			t.Fatalf("push %s missing LastModified", p.ID)
		}
		if got := *p.LastModified; got[len(got)-1] == 'Z' {
			t.Errorf("pushed LastModified must have Z stripped, got %q", got)
		}
		if p.Name == "" || p.ShoppingListID != "list-1" {
			t.Errorf("push must carry the complete entity: %+v", p)
		}
	}
}

// Nothing changed locally => nothing to push. This is what stops echo loops.
func TestPendingPushesEmptyWhenInSync(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})

	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 0 {
		t.Errorf("pushes = %d, want 0", len(pushes))
	}
}

// A rename propagates to every link of the row.
func TestPendingPushesOnRename(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Lemon", withRecipe("r1"))})

	item := itemByName(t, db, "Lemon", false)
	item.Name = "Meyer Lemon"
	db.Save(item)
	// A direct MP rename strands the link exactly like a checked flip does
	// (links resolve by collapse key, not row id) — retargeting it is future
	// wiring (a rename handler, symmetric to RetargetLinks) that doesn't
	// exist yet. Simulate what it will do so this test exercises the diff
	// logic itself rather than the orphan path.
	db.Model(&models.RecipeKeeperLink{}).
		Where("mp_name = ? AND mp_checked = ?", "lemon", false).
		Update("mp_name", "meyer lemon")

	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 || pushes[0].Name != "Meyer Lemon" {
		t.Errorf("pushes = %+v, want one rename to Meyer Lemon", pushes)
	}
}

// Acks are the server's authoritative timestamps and must land on the link,
// or the next diff would push a stale LastModified forever.
func TestApplyAcksUpdatesLinkState(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)
	item.Checked = true
	db.Save(item)
	if err := r.RetargetLinks("Fig", false, true); err != nil {
		t.Fatalf("RetargetLinks: %v", err)
	}

	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 {
		t.Fatalf("pushes = %d, want 1", len(pushes))
	}
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T05:00:00.1234567Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}

	var link models.RecipeKeeperLink
	db.First(&link, "rk_item_id = ?", "a-id")
	if link.RKLastModified != "2026-09-14T05:00:00.1234567Z" {
		t.Errorf("link LastModified = %q", link.RKLastModified)
	}
	if !link.RKChecked {
		t.Error("link RKChecked should be true after ack")
	}

	again, _ := r.PendingPushes()
	if len(again) != 0 {
		t.Errorf("after ack, pushes = %d, want 0", len(again))
	}
}

// Deleting a grocery item tombstones its links so the delete can be pushed and
// the row can never be re-imported. TombstoneLinks only marks the links —
// actually removing the row is the caller's job (grocery.go's delete handler,
// a later task) — so the test deletes it too, matching real call order
// ("before deleting the row" per the plan).
func TestTombstoneLinksOnDelete(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})
	item := itemByName(t, db, "Lemon", false)

	if err := r.TombstoneLinks(item.Name, item.Checked); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	if err := db.Delete(item).Error; err != nil {
		t.Fatalf("delete item: %v", err)
	}
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Where("pushed_at IS NULL").Count(&n)
	if n != 2 {
		t.Errorf("pending tombstones = %d, want 2", n)
	}

	pushes, _ := r.PendingPushes()
	if len(pushes) != 2 {
		t.Fatalf("delete pushes = %d, want 2", len(pushes))
	}
	for _, p := range pushes {
		if !p.IsDeleted {
			t.Errorf("push %s should be a delete", p.ID)
		}
	}
}

// A pushed delete that gets acked stays pending-free, but an undo before the
// ack simply cancels: the tombstone is never pushed at all.
func TestTombstoneUndoBeforePushForgetsTombstone(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)
	if err := r.TombstoneLinks(item.Name, item.Checked); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	if err := db.Delete(item).Error; err != nil {
		t.Fatalf("delete item: %v", err)
	}

	// Undo: the row comes back (a new id — delete-undo recreates the row —
	// but the SAME collapse key, which is all PendingPushes looks at).
	restored := &models.GroceryItem{
		ID: models.NewID(), SectionID: item.SectionID, Name: item.Name,
		Checked: item.Checked, Position: item.Position,
	}
	if err := db.Create(restored).Error; err != nil {
		t.Fatalf("restore item: %v", err)
	}

	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 0 {
		t.Errorf("pushes = %+v, want 0 (never-pushed tombstone should be forgotten, not resent)", pushes)
	}
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Count(&n)
	if n != 0 {
		t.Errorf("tombstones = %d, want 0 (forgotten on undo)", n)
	}
}

// Once a delete has been pushed and acked, an undo (the row resolving again)
// must push IsDeleted:false rather than trying to recreate the entity, and
// the link must survive the ack so the undo has something to rebuild from.
func TestTombstoneUndoAfterAckPushesUnDelete(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)
	if err := r.TombstoneLinks(item.Name, item.Checked); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	if err := db.Delete(item).Error; err != nil {
		t.Fatalf("delete item: %v", err)
	}

	// The delete goes out and gets acked. ApplyAcks must keep the link so a
	// later undo still has an entity to rebuild from.
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T06:00:00.0000000Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}
	var link models.RecipeKeeperLink
	if err := db.First(&link, "rk_item_id = ?", "a-id").Error; err != nil {
		t.Fatalf("link should survive an acked delete so undo can rebuild: %v", err)
	}

	// Undo: the row comes back.
	restored := &models.GroceryItem{
		ID: models.NewID(), SectionID: item.SectionID, Name: item.Name,
		Checked: item.Checked, Position: item.Position,
	}
	if err := db.Create(restored).Error; err != nil {
		t.Fatalf("restore item: %v", err)
	}

	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 1 {
		t.Fatalf("pushes = %d, want 1 (the undo)", len(pushes))
	}
	if pushes[0].IsDeleted {
		t.Errorf("undo push should be IsDeleted:false: %+v", pushes[0])
	}
}

// RetargetLinks is what makes a same-row check/uncheck resolvable: it moves a
// link from its old (name, checked) collapse key to the new one.
func TestRetargetLinksMovesCollapseKey(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})

	if err := r.RetargetLinks("Fig", false, true); err != nil {
		t.Fatalf("RetargetLinks: %v", err)
	}

	var link models.RecipeKeeperLink
	if err := db.First(&link, "rk_item_id = ?", "a-id").Error; err != nil {
		t.Fatalf("link lookup: %v", err)
	}
	if !link.MPChecked {
		t.Error("link MPChecked should be true after retarget")
	}

	// Retargeting again with a non-matching `from` must touch nothing.
	if err := r.RetargetLinks("Fig", false, true); err != nil {
		t.Fatalf("RetargetLinks (no-op): %v", err)
	}
	db.First(&link, "rk_item_id = ?", "a-id")
	if !link.MPChecked {
		t.Error("link MPChecked should remain true")
	}
}
