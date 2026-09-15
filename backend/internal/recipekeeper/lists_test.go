// backend/internal/recipekeeper/lists_test.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/models"
)

// rawShoppingListJSON builds the vendor's PascalCase entity JSON for a
// ShoppingList bucket item.
func rawShoppingListJSON(id, name string, deleted bool) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"Id": id, "Name": name, "IsDeleted": deleted})
	return b
}

// listsTestServer builds a fake Recipe Keeper server answering /token (a
// well-formed, never-expiring JWT) and /api/sync with a ShoppingList bucket
// built from entities. Every /api/sync call is recorded in calls so tests can
// assert whether the server was ever contacted.
func listsTestServer(t *testing.T, entities []json.RawMessage, calls *int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		if calls != nil {
			*calls++
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingList: &RawBucketResponse{
				UpdatedServerItems: entities,
				MaxLastModified:    "2026-09-14T00:00:00.0000001Z",
			},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func testService(t *testing.T, db *gorm.DB, srv *httptest.Server) *Service {
	t.Helper()
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	return &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    &Reconciler{DB: db},
		DB:     db,
	}
}

// FetchLists must work with credentials alone and NO list selected — that is
// exactly the state a user discovering their lists is in — and must exclude
// deleted lists and sort the rest by name.
func TestFetchListsWorksWithNoListSelectedAndSortsExcludingDeleted(t *testing.T) {
	db := testDB(t)
	entities := []json.RawMessage{
		rawShoppingListJSON("z-id", "Zeta List", false),
		rawShoppingListJSON("a-id", "Alpha List", false),
		rawShoppingListJSON("d-id", "Deleted List", true),
	}
	svc := testService(t, db, listsTestServer(t, entities, nil))

	// No list selected at all — SelectedListID(db) == "".
	if got := SelectedListID(db); got != "" {
		t.Fatalf("SelectedListID = %q, want empty before any selection", got)
	}

	lists, err := svc.FetchLists(context.Background())
	if err != nil {
		t.Fatalf("FetchLists: %v", err)
	}
	if len(lists) != 2 {
		t.Fatalf("lists = %+v, want 2 (deleted excluded)", lists)
	}
	if lists[0].ID != "a-id" || lists[1].ID != "z-id" {
		t.Errorf("lists = %+v, want sorted by name (Alpha, Zeta)", lists)
	}
}

// An unknown id is a typo that would otherwise silently sync nothing forever
// — SelectList must reject it and name the valid options via UnknownListError.
func TestSelectListRejectsUnknownID(t *testing.T) {
	db := testDB(t)
	entities := []json.RawMessage{rawShoppingListJSON("real-id", "Groceries", false)}
	svc := testService(t, db, listsTestServer(t, entities, nil))

	_, err := svc.SelectList(context.Background(), "typo-id")
	var uerr *UnknownListError
	if !errors.As(err, &uerr) {
		t.Fatalf("err = %v (%T), want *UnknownListError", err, err)
	}
	if len(uerr.Available) != 1 || uerr.Available[0].ID != "real-id" {
		t.Errorf("Available = %+v, want the one real list", uerr.Available)
	}
	if got := SelectedListID(db); got != "" {
		t.Errorf("SelectedListID = %q, want unchanged (empty) after a rejected selection", got)
	}
}

// The very first selection (no prior one) must reset nothing: links and
// tombstones some earlier best-effort sync attempt may have left behind (an
// unusual but not impossible state — RECIPE_KEEPER_ENABLED could have been
// on with credentials but no list before this feature existed) survive.
func TestSelectListFirstTimeResetsNothing(t *testing.T) {
	db := testDB(t)
	seedGroceryRow(t, db, "Lemon", false)
	mustCreate(t, db, &models.RecipeKeeperLink{RKItemID: "rk-1", MPName: "lemon", RKName: "Lemon", RKLastModified: "2026-01-01T00:00:00Z"})
	mustCreate(t, db, &models.RecipeKeeperTombstone{RKItemID: "rk-2"})
	setState(db, stateWatermarkItem, "2026-01-01T00:00:00Z")

	entities := []json.RawMessage{rawShoppingListJSON("list-a", "Groceries", false)}
	svc := testService(t, db, listsTestServer(t, entities, nil))

	if _, err := svc.SelectList(context.Background(), "list-a"); err != nil {
		t.Fatalf("SelectList: %v", err)
	}

	if SelectedListID(db) != "list-a" {
		t.Errorf("SelectedListID = %q, want list-a", SelectedListID(db))
	}
	if SelectedListName(db) != "Groceries" {
		t.Errorf("SelectedListName = %q, want Groceries", SelectedListName(db))
	}
	var linkCount, tombCount int64
	db.Model(&models.RecipeKeeperLink{}).Count(&linkCount)
	db.Model(&models.RecipeKeeperTombstone{}).Count(&tombCount)
	if linkCount != 1 || tombCount != 1 {
		t.Errorf("link/tombstone counts = %d/%d, want 1/1 — first-time selection must reset nothing", linkCount, tombCount)
	}
	if wm := getState(db, stateWatermarkItem, ""); wm != "2026-01-01T00:00:00Z" {
		t.Errorf("watermark = %q, want unchanged — first-time selection must reset nothing", wm)
	}
	if svc.Rec.ListID() != "list-a" {
		t.Errorf("Rec.ListID() = %q, want list-a set immediately", svc.Rec.ListID())
	}
}

// A genuine CHANGE from a previously-selected list must wipe every stale
// link/tombstone (they address rows in the OLD list) and reset the item
// watermark so the new list imports cleanly — but must NEVER delete grocery
// rows themselves, which simply go unlinked until the new list's items
// collapse back onto them by name.
func TestSelectListChangeResetsLinksTombstonesAndWatermarkButKeepsGroceryItems(t *testing.T) {
	db := testDB(t)
	item := seedGroceryRow(t, db, "Lemon", false)
	mustCreate(t, db, &models.RecipeKeeperLink{RKItemID: "rk-old-1", MPName: "lemon", RKName: "Lemon", RKLastModified: "2026-01-01T00:00:00Z"})
	mustCreate(t, db, &models.RecipeKeeperTombstone{RKItemID: "rk-old-2"})
	setState(db, stateWatermarkItem, "2026-01-01T00:00:00Z")
	setState(db, stateSelectedList, "list-old")
	setState(db, stateSelectedListName, "Old List")

	entities := []json.RawMessage{
		rawShoppingListJSON("list-old", "Old List", false),
		rawShoppingListJSON("list-new", "New List", false),
	}
	svc := testService(t, db, listsTestServer(t, entities, nil))

	if _, err := svc.SelectList(context.Background(), "list-new"); err != nil {
		t.Fatalf("SelectList: %v", err)
	}

	if SelectedListID(db) != "list-new" || SelectedListName(db) != "New List" {
		t.Errorf("selection = %q/%q, want list-new/New List", SelectedListID(db), SelectedListName(db))
	}
	var linkCount, tombCount int64
	db.Model(&models.RecipeKeeperLink{}).Count(&linkCount)
	db.Model(&models.RecipeKeeperTombstone{}).Count(&tombCount)
	if linkCount != 0 || tombCount != 0 {
		t.Errorf("link/tombstone counts = %d/%d, want 0/0 after a genuine list change", linkCount, tombCount)
	}
	if wm := getState(db, stateWatermarkItem, ""); wm != epochWatermark {
		t.Errorf("watermark = %q, want reset to the epoch", wm)
	}
	// The grocery row itself must survive untouched — only unlinked.
	var reloaded models.GroceryItem
	if err := db.First(&reloaded, "id = ?", item.ID).Error; err != nil {
		t.Fatalf("grocery item was deleted on a list change: %v", err)
	}
	if svc.Rec.ListID() != "list-new" {
		t.Errorf("Rec.ListID() = %q, want list-new applied immediately, not just on the next cycle", svc.Rec.ListID())
	}
}

// The critical safety property: with no list selected, SyncOnce must not
// contact Recipe Keeper at all — building a push would otherwise carry an
// empty ShoppingListId, which is not "sync nothing" but sending a malformed
// entity to a third party's live API.
func TestSyncOnceSkipsEntirelyWhenNoListSelected(t *testing.T) {
	db := testDB(t)
	var calls int
	svc := testService(t, db, listsTestServer(t, nil, &calls))
	// No SetListID call, no state row: fresh "credentials configured, no
	// list chosen yet" state.

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce should no-op quietly, got: %v", err)
	}
	if calls != 0 {
		t.Errorf("server was contacted %d times, want 0 — no list is selected", calls)
	}
	if svc.Rec.ListID() != "" {
		t.Errorf("Rec.ListID() = %q, want empty", svc.Rec.ListID())
	}

	st := svc.Status()
	if st.SelectedListID != "" || st.SelectedListName != "" {
		t.Errorf("Status = %+v, want empty selection", st)
	}
}

func seedGroceryRow(t *testing.T, db *gorm.DB, name string, checked bool) *models.GroceryItem {
	t.Helper()
	var sec models.GrocerySection
	if err := db.First(&sec, "LOWER(name) = ?", "uncategorized").Error; err != nil {
		t.Fatalf("uncategorized section missing: %v", err)
	}
	item := &models.GroceryItem{ID: models.NewID(), SectionID: sec.ID, Name: name, Checked: checked, Position: 0}
	mustCreate(t, db, item)
	return item
}

func mustCreate(t *testing.T, db *gorm.DB, v any) {
	t.Helper()
	if err := db.Create(v).Error; err != nil {
		t.Fatalf("create %T: %v", v, err)
	}
}
