// backend/internal/recipekeeper/reconcile_echo_test.go
package recipekeeper

import (
	"testing"

	"mealplanner/internal/models"
)

// The full loop: check locally, push, ack, then receive our own change back
// through the doorbell. Nothing further may be pushed. Without the echo
// guard in applyOne, this would push forever: every sync cycle would see its
// own prior push reflected back and re-diff it as a fresh change.
func TestPushAckEchoProducesNoFurtherPush(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)

	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})

	item := itemByName(t, db, "Fig", false)
	item.Checked = true
	db.Save(item)
	// Meal Planner checks an item by flipping a flag on the same row; links
	// are keyed by (name, checked), so retargeting is what makes the row
	// still resolvable rather than an orphan (see reconcile_outbound_test.go).
	if err := r.RetargetLinks("Fig", false, "Fig", true); err != nil {
		t.Fatalf("RetargetLinks: %v", err)
	}

	pushes, err := r.PendingPushes()
	if err != nil || len(pushes) != 1 {
		t.Fatalf("pushes = %d (err %v), want 1", len(pushes), err)
	}

	const serverLM = "2026-09-14T06:00:00.7654321Z"
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: serverLM}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}

	// The doorbell fires for our own write and the server replays the entity.
	echo := rkItem("a-id", "Fig", withRecipe("r1"), checked)
	lm := serverLM
	echo.LastModified = &lm
	ch, err := r.ApplyInbound([]ShoppingListItem{echo})
	if err != nil {
		t.Fatalf("ApplyInbound(echo): %v", err)
	}
	if ch.Any() {
		t.Errorf("echo produced changes: %+v", ch)
	}

	after, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(after) != 0 {
		t.Fatalf("ECHO LOOP: %d pushes after round trip, want 0: %+v", len(after), after)
	}
}

// A delete round trip must also settle: after the ack, the replayed tombstoned
// entity must not resurrect the item or re-push.
func TestDeleteRoundTripSettles(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)

	if err := r.TombstoneLinks(item.Name, item.Checked); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	db.Delete(item)

	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 || !pushes[0].IsDeleted {
		t.Fatalf("want one delete push, got %+v", pushes)
	}
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T07:00:00.1111111Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}

	echo := rkItem("a-id", "Fig", deleted)
	if _, err := r.ApplyInbound([]ShoppingListItem{echo}); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if itemByName(t, db, "Fig", false) != nil {
		t.Error("deleted item was resurrected by its own echo")
	}
	after, _ := r.PendingPushes()
	if len(after) != 0 {
		t.Errorf("delete still pending after ack: %+v", after)
	}
}

// Undo of a delete, BEFORE the delete was pushed: the tombstone is simply
// forgotten and nothing goes to Recipe Keeper.
func TestUndoDeleteBeforePushCancelsIt(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)

	if err := r.TombstoneLinks(item.Name, item.Checked); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	db.Delete(item)

	// Undo replays a snapshot through PUT /api/grocery: the row returns with a
	// brand-new id, which the link must not care about.
	db.Create(&models.GroceryItem{
		ID: models.NewID(), SectionID: item.SectionID, Name: "Fig",
		CreatedAt: models.NowUTC(), UpdatedAt: models.NowUTC(),
	})

	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 0 {
		t.Errorf("undo before push must send nothing, got %+v", pushes)
	}
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Count(&n)
	if n != 0 {
		t.Errorf("tombstone should be gone, %d remain", n)
	}
}

// Undo of a delete AFTER the push: Recipe Keeper's deletes are soft, so the fix
// is to push IsDeleted:false rather than to recreate anything.
func TestUndoDeleteAfterPushUndeletes(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)

	_ = r.TombstoneLinks(item.Name, item.Checked)
	db.Delete(item)
	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 || !pushes[0].IsDeleted {
		t.Fatalf("want one delete push, got %+v", pushes)
	}
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T08:00:00.1111111Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}

	// Now undo.
	db.Create(&models.GroceryItem{
		ID: models.NewID(), SectionID: item.SectionID, Name: "Fig",
		CreatedAt: models.NowUTC(), UpdatedAt: models.NowUTC(),
	})

	after, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(after) != 1 || after[0].IsDeleted {
		t.Fatalf("want one un-delete push, got %+v", after)
	}
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T09:00:00.2222222Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Count(&n)
	if n != 0 {
		t.Errorf("tombstone should be spent after un-delete, %d remain", n)
	}
	settled, _ := r.PendingPushes()
	if len(settled) != 0 {
		t.Errorf("un-delete did not settle: %+v", settled)
	}
}

// A full list replace (merge, clear-undo, redo) churns every grocery id. Links
// must survive it — this is the failure that would silently detach the whole
// list from Recipe Keeper.
func TestReplaceStyleIDChurnPreservesLinks(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})

	// Exactly what handleReplaceGrocery does.
	var sections []models.GrocerySection
	db.Find(&sections)
	db.Where("1 = 1").Delete(&models.GrocerySection{})
	newSec := models.GrocerySection{ID: models.NewID(), Name: "Produce", CreatedAt: models.NowUTC()}
	db.Create(&newSec)
	qty := "2"
	db.Create(&models.GroceryItem{
		ID: models.NewID(), SectionID: newSec.ID, Name: "Lemon", Quantity: &qty,
		CreatedAt: models.NowUTC(), UpdatedAt: models.NowUTC(),
	})

	if n := linkCount(db, "Lemon", false); n != 2 {
		t.Fatalf("links after replace = %d, want 2", n)
	}
	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 0 {
		t.Errorf("an id churn must not push anything, got %+v", pushes)
	}
}
