// backend/internal/recipekeeper/reconcile_echo_test.go
package recipekeeper

import (
	"encoding/json"
	"testing"

	"mealplanner/internal/models"
)

// The full loop: check locally, push, ack, then receive our own change back
// through the doorbell. Nothing further may be pushed. Without the echo
// guard in applyOne, this would push forever: every sync cycle would see its
// own prior push reflected back and re-diff it as a fresh change.
//
// By the time the echo arrives, ApplyAcks has already synced the link's
// cached RKName/RKChecked to match the row, so a same-row moveLink write
// would be byte-identical for those fields — asserting on them wouldn't
// distinguish "the guard fired" from "the guard is gone but there was
// nothing to write anyway". The echo therefore carries a Position the link
// does NOT have cached (42, vs the 1 every rkItem fixture defaults to): if
// the guard is absent, applyOne falls through to moveLink's same-row branch
// and unconditionally overwrites link.RKPosition with it.
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

	var cached models.RecipeKeeperLink
	if err := db.First(&cached, "rk_item_id = ?", "a-id").Error; err != nil {
		t.Fatalf("link lookup: %v", err)
	}
	if cached.RKPosition == 42 {
		t.Fatalf("test fixture bug: cached RKPosition already 42")
	}

	// The doorbell fires for our own write and the server replays the entity
	// — with a Position the link doesn't have cached, so a same-row moveLink
	// write (what happens if the echo guard is missing) is observable.
	echo := rkItem("a-id", "Fig", withRecipe("r1"), checked)
	lm := serverLM
	echo.LastModified = &lm
	echo.Position = 42
	ch, err := r.ApplyInbound([]ShoppingListItem{echo})
	if err != nil {
		t.Fatalf("ApplyInbound(echo): %v", err)
	}
	if ch.Any() {
		t.Errorf("echo produced changes: %+v", ch)
	}

	var link models.RecipeKeeperLink
	if err := db.First(&link, "rk_item_id = ?", "a-id").Error; err != nil {
		t.Fatalf("link lookup: %v", err)
	}
	if link.RKPosition != cached.RKPosition {
		t.Errorf("ECHO WAS NOT SUPPRESSED: RKPosition = %d, want unchanged at %d (moveLink wrote the echo's Position)",
			link.RKPosition, cached.RKPosition)
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
//
// Replaying the entity back tombstoned (IsDeleted:true) does not actually
// exercise the resurrection guard (isTombstoned in ApplyInbound): even with
// that guard removed, the replay would still route through detachLink, find
// no row, and delete the now-redundant link — producing the same "item
// absent, nothing pending" outcome for an unrelated reason. The real
// scenario isTombstoned exists for is the server sending the entity back
// LIVE (IsDeleted:false) because its own copy hasn't caught up with our
// delete yet — that is what actually reaches attachNew and recreates the row
// if the guard is missing.
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

	// The actual resurrection scenario: the server's next pull still shows
	// the entity LIVE, because its own state hasn't caught up with our
	// already-acked delete. isTombstoned must block this unconditionally —
	// without it, this reaches attachNew (the link that used to resolve it
	// was already dropped by the tombstoned echo above) and recreates the row.
	live := rkItem("a-id", "Fig", withRecipe("r1"))
	if _, err := r.ApplyInbound([]ShoppingListItem{live}); err != nil {
		t.Fatalf("ApplyInbound(live replay): %v", err)
	}
	if got := itemByName(t, db, "Fig", false); got != nil {
		t.Errorf("RESURRECTED: a live replay of a tombstoned id recreated the row: %+v", got)
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
	if err := r.StoreRecipes([]json.RawMessage{
		json.RawMessage(`{"Id":"r1","Title":"Fig Cocktail"}`),
		json.RawMessage(`{"Id":"r2","Title":"Thai Curry"}`),
	}); err != nil {
		t.Fatalf("StoreRecipes: %v", err)
	}

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

	// Sanity check only: links are string-keyed by (name, checked), so a raw
	// row delete/recreate at the DB layer can't touch them regardless of
	// whether the reconciler's own id-resolution logic (findRow) still
	// works. This would hold even with reconcile.go deleted from the build.
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

	// The postcondition that actually matters: if the id-churn bug this test
	// exists to catch regressed findRow's name matching, PendingPushes would
	// classify both links as unresolvable orphans and SILENTLY DELETE them
	// (see the "orphan link, dropping" path) — which also produces zero
	// pushes above. So re-check survival AFTER PendingPushes has run, and
	// check identity, not just count, so a drop-and-somehow-replace couldn't
	// slip past a bare count check either.
	if n := linkCount(db, "Lemon", false); n != 2 {
		t.Fatalf("DETACHED FROM RECIPE KEEPER: links after PendingPushes = %d, want 2 (orphan-drop leaves zero pushes too)", n)
	}
	var links []models.RecipeKeeperLink
	db.Where("mp_name = ? AND mp_checked = ?", "lemon", false).Order("rk_item_id asc").Find(&links)
	if len(links) != 2 || links[0].RKItemID != "a-id" || links[1].RKItemID != "b-id" {
		t.Errorf("surviving links = %+v, want rk_item_id a-id and b-id intact", links)
	}

	// Attribution must survive the id churn too.
	refs, err := r.RecipeTitles("Lemon", false)
	if err != nil {
		t.Fatalf("RecipeTitles: %v", err)
	}
	if len(refs) != 2 {
		t.Errorf("recipe refs after churn = %d, want 2", len(refs))
	}
}
