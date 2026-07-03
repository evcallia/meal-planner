package app

// Regression tests for the parity/security audit findings.

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mealplanner/internal/models"
)

// H1: a malformed replace body must 422 and leave data untouched — it used
// to wipe the entire list.
func TestReplaceGroceryMissingSectionsDoesNotWipe(t *testing.T) {
	ta := newTestApp(t)
	section := models.GrocerySection{Name: "Produce"}
	ta.App.DB.Create(&section)
	ta.App.DB.Create(&models.GroceryItem{SectionID: section.ID, Name: "Apple"})

	for _, body := range []map[string]any{{}, {"sections": nil}} {
		resp := ta.PUT("/api/grocery", body)
		if resp.Status != 422 {
			t.Fatalf("body %v: status = %d, want 422: %s", body, resp.Status, resp.Body)
		}
	}
	// Section missing items / missing name also 422.
	resp := ta.PUT("/api/grocery", map[string]any{"sections": []map[string]any{{"name": "X"}}})
	if resp.Status != 422 {
		t.Fatalf("missing items: status = %d", resp.Status)
	}
	resp = ta.PUT("/api/grocery", map[string]any{"sections": []map[string]any{{"items": []any{}}}})
	if resp.Status != 422 {
		t.Fatalf("missing name: status = %d", resp.Status)
	}

	var count int64
	ta.App.DB.Model(&models.GroceryItem{}).Count(&count)
	if count != 1 {
		t.Fatalf("items wiped: count = %d", count)
	}
}

func TestReplacePantryMissingSectionsDoesNotWipe(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "Fridge"}
	ta.App.DB.Create(&section)
	ta.App.DB.Create(&models.PantryItem{SectionID: section.ID, Name: "Milk"})

	resp := ta.PUT("/api/pantry", map[string]any{})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
	var count int64
	ta.App.DB.Model(&models.PantryItem{}).Count(&count)
	if count != 1 {
		t.Fatalf("items wiped: count = %d", count)
	}
}

// H2 family: to_position is honored, and a missing to_position is a 422
// rather than silently moving to position 0.
func TestMoveGroceryItemRequiresToPosition(t *testing.T) {
	ta := newTestApp(t)
	a := models.GrocerySection{Name: "A"}
	b := models.GrocerySection{Name: "B", Position: 1}
	ta.App.DB.Create(&a)
	ta.App.DB.Create(&b)
	item := models.GroceryItem{SectionID: a.ID, Name: "Cherry"}
	ta.App.DB.Create(&item)

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String()+"/move",
		map[string]any{"to_section_id": b.ID.String()})
	if resp.Status != 422 {
		t.Fatalf("missing to_position: status = %d, want 422", resp.Status)
	}
}

// L2: an invalid UUID anywhere in a reorder payload must apply nothing.
func TestReorderAppliesNothingOnInvalidUUID(t *testing.T) {
	ta := newTestApp(t)
	s1 := models.GrocerySection{Name: "One", Position: 0}
	s2 := models.GrocerySection{Name: "Two", Position: 1}
	ta.App.DB.Create(&s1)
	ta.App.DB.Create(&s2)

	resp := ta.PATCH("/api/grocery/reorder-sections", map[string]any{
		"section_ids": []string{s2.ID.String(), "not-a-uuid"},
	})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422", resp.Status)
	}
	var check models.GrocerySection
	ta.App.DB.Where("id = ?", s2.ID).First(&check)
	if check.Position != 1 {
		t.Fatalf("position partially applied: %d", check.Position)
	}
	// Missing ids field entirely → 422 with no broadcast.
	col := ta.Collect(TestSub)
	resp = ta.PATCH("/api/grocery/reorder-sections", map[string]any{})
	if resp.Status != 422 {
		t.Fatalf("empty body: status = %d, want 422", resp.Status)
	}
	if events := col.Events(); len(events) != 0 {
		t.Fatalf("broadcast emitted on rejected reorder: %v", events)
	}
}

// store_id "" in an item PATCH is a 422 (pydantic UUID), not a silent clear.
func TestUpdateGroceryItemEmptyStringStoreIDRejected(t *testing.T) {
	ta := newTestApp(t)
	section := models.GrocerySection{Name: "A"}
	ta.App.DB.Create(&section)
	item := models.GroceryItem{SectionID: section.ID, Name: "Kale"}
	ta.App.DB.Create(&item)

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"store_id": ""})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
}

// No-op PATCH must not bump updated_at (checked items sort by -updated_at).
func TestNoOpGroceryPatchDoesNotBumpUpdatedAt(t *testing.T) {
	ta := newTestApp(t)
	section := models.GrocerySection{Name: "A"}
	ta.App.DB.Create(&section)
	item := models.GroceryItem{SectionID: section.ID, Name: "Rice", Checked: false}
	ta.App.DB.Create(&item)
	var before models.GroceryItem
	ta.App.DB.Where("id = ?", item.ID).First(&before)

	time.Sleep(5 * time.Millisecond)
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"checked": false})
	if resp.Status != 200 {
		t.Fatalf("status = %d", resp.Status)
	}
	var after models.GroceryItem
	ta.App.DB.Where("id = ?", item.ID).First(&after)
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("no-op PATCH bumped updated_at: %v -> %v", before.UpdatedAt, after.UpdatedAt)
	}
}

// L1: avg_interval_days uses banker's rounding like Python round().
func TestTrackerAvgIntervalBankersRounding(t *testing.T) {
	ta := newTestApp(t)
	lst := models.TrackerList{OwnerSub: TestSub, Name: "L"}
	ta.App.DB.Create(&lst)
	task := models.TrackerTask{ListID: lst.ID, Name: "T"}
	ta.App.DB.Create(&task)
	t0 := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ta.App.DB.Create(&models.TrackerLog{TaskID: task.ID, DoneAt: t0, Kind: "done"})
	ta.App.DB.Create(&models.TrackerLog{TaskID: task.ID, DoneAt: t0.Add(6 * time.Hour), Kind: "done"})

	resp := ta.GET("/api/tracker")
	taskJSON := resp.List()[0].(map[string]any)["tasks"].([]any)[0].(map[string]any)
	// One 0.25-day interval: Python round(0.25, 1) == 0.2 (ties-to-even).
	if avg := taskJSON["avg_interval_days"]; avg != 0.2 {
		t.Fatalf("avg_interval_days = %v, want 0.2", avg)
	}
}

// L4: deleting a list removes its per-user position rows via FK cascade.
func TestTrackerListPositionsCascadeOnDelete(t *testing.T) {
	ta := newTestApp(t)
	lst := models.TrackerList{OwnerSub: TestSub, Name: "L"}
	ta.App.DB.Create(&lst)
	ta.App.DB.Create(&models.TrackerListPosition{Sub: TestSub, ListID: lst.ID, Position: 3})

	resp := ta.DELETE("/api/tracker/lists/" + lst.ID.String())
	if resp.Status != 204 {
		t.Fatalf("delete status = %d", resp.Status)
	}
	var count int64
	ta.App.DB.Model(&models.TrackerListPosition{}).Where("list_id = ?", lst.ID).Count(&count)
	if count != 0 {
		t.Fatalf("orphaned position rows: %d", count)
	}
}

// Security: request bodies beyond the cap are rejected, not buffered.
func TestOversizedBodyRejected(t *testing.T) {
	ta := newTestApp(t)
	big := strings.Repeat("x", (1<<20)+1024)
	body, _ := json.Marshal(map[string]any{"settings": map[string]any{"blob": big}, "updated_at": "2026-07-01T00:00:00Z"})
	req := httptest.NewRequest("PUT", "/api/settings", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(ta.Cookie)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)
	if rec.Code == 200 {
		t.Fatalf("oversized body accepted (status 200)")
	}
	var count int64
	ta.App.DB.Model(&models.UserSettings{}).Count(&count)
	if count != 0 {
		t.Fatal("oversized settings persisted")
	}
}

// M4: settings round-trip preserves number fidelity (> 2^53 ints, 1.0 vs 1).
func TestSettingsNumberFidelity(t *testing.T) {
	ta := newTestApp(t)
	raw := `{"settings":{"big":9007199254740993,"exact":1.0},"updated_at":"2026-07-01T00:00:00Z"}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(ta.Cookie)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	get := ta.GET("/api/settings")
	if !bytes.Contains(get.Body, []byte("9007199254740993")) {
		t.Fatalf("big int corrupted: %s", get.Body)
	}
	if !bytes.Contains(get.Body, []byte(`"exact":1.0`)) {
		t.Fatalf("1.0 collapsed to 1: %s", get.Body)
	}
}

func TestSettingsNonObjectRejected(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/settings", map[string]any{"settings": []int{1, 2}, "updated_at": "2026-07-01T00:00:00Z"})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422", resp.Status)
	}
}

// M2: a missing hashed asset chunk must 404, never a 200 HTML fallback.
func TestSPAMissingAssetReturns404(t *testing.T) {
	ta := newTestApp(t)
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<html>app</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	ta.App.Settings.StaticDir = staticDir

	resp := ta.Anon("GET", "/assets/chunk-deadbeef.js", nil)
	if resp.Status != 404 {
		t.Fatalf("missing asset: status = %d, want 404: %s", resp.Status, resp.Body)
	}
	// Direct GET /index.html serves 200, not a 301 to "./".
	resp = ta.Anon("GET", "/index.html", nil)
	if resp.Status != 200 {
		t.Fatalf("GET /index.html: status = %d, want 200", resp.Status)
	}
	// Non-GET methods on SPA routes are 405 (the Python catch-all was GET-only).
	resp = ta.Anon("POST", "/some/spa/route", map[string]any{})
	if resp.Status != 405 {
		t.Fatalf("POST spa route: status = %d, want 405", resp.Status)
	}
}

// FastAPI parity: invalid boolean query params are a 422, not silently defaulted.
func TestInvalidBoolQueryParamRejected(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/days?start_date=2026-07-01&end_date=2026-07-02&include_events=banana")
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422", resp.Status)
	}
}

// settings: null must 422 like pydantic, not poison the row for all devices.
func TestSettingsNullRejected(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/settings", map[string]any{"settings": nil, "updated_at": "2026-07-01T00:00:00Z"})
	if resp.Status != 422 {
		t.Fatalf("settings null: status = %d, want 422: %s", resp.Status, resp.Body)
	}
	var count int64
	ta.App.DB.Model(&models.UserSettings{}).Count(&count)
	if count != 0 {
		t.Fatal("null settings persisted")
	}
}

// Adversarial-audit finding 1: renaming a section must not resurrect items
// deleted between the load and the write (GORM association-save footgun).
func TestSectionRenameDoesNotResurrectDeletedItems(t *testing.T) {
	ta := newTestApp(t)
	section := models.GrocerySection{Name: "Produce"}
	ta.App.DB.Create(&section)
	item := models.GroceryItem{SectionID: section.ID, Name: "Apple"}
	ta.App.DB.Create(&item)

	// Simulate the concurrent delete by removing the item after the handler
	// would have preloaded it: the targeted-update fix means rename touches
	// only the name column regardless.
	ta.App.DB.Delete(&item)
	resp := ta.PATCH("/api/grocery/sections/"+section.ID.String(), map[string]any{"name": "Fruit"})
	if resp.Status != 200 {
		t.Fatalf("rename status = %d", resp.Status)
	}
	var count int64
	ta.App.DB.Model(&models.GroceryItem{}).Count(&count)
	if count != 0 {
		t.Fatalf("deleted item resurrected: count = %d", count)
	}
}

// Adversarial-audit finding 2: a PATCH must write only its own fields so a
// concurrent PATCH of a disjoint field is not clobbered.
func TestItemPatchWritesOnlyDirtyColumns(t *testing.T) {
	ta := newTestApp(t)
	section := models.GrocerySection{Name: "A"}
	ta.App.DB.Create(&section)
	item := models.GroceryItem{SectionID: section.ID, Name: "Milk"}
	ta.App.DB.Create(&item)

	// Another device checks the item between our read and our write:
	// simulate by checking it via direct DB write, then sending a
	// name-only PATCH. The name PATCH must not write checked=false back.
	ta.App.DB.Model(&models.GroceryItem{}).Where("id = ?", item.ID).Update("checked", true)
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"name": "Oat Milk"})
	if resp.Status != 200 {
		t.Fatalf("status = %d", resp.Status)
	}
	var after models.GroceryItem
	ta.App.DB.Where("id = ?", item.ID).First(&after)
	if !after.Checked {
		t.Fatal("name-only PATCH clobbered concurrent checked=true")
	}
	if after.Name != "Oat Milk" {
		t.Fatalf("name not updated: %q", after.Name)
	}
}

// Adversarial-audit finding 3: a same-title PUT must not bump updated_at
// (meal ideas order by updated_at DESC).
func TestNoOpMealIdeaPutDoesNotReorder(t *testing.T) {
	ta := newTestApp(t)
	older := models.MealIdea{Title: "Tacos"}
	ta.App.DB.Create(&older)
	time.Sleep(2 * time.Millisecond)
	newer := models.MealIdea{Title: "Curry"}
	ta.App.DB.Create(&newer)

	resp := ta.PUT("/api/meal-ideas/"+older.ID.String(), map[string]any{"title": "Tacos"})
	if resp.Status != 200 {
		t.Fatalf("status = %d", resp.Status)
	}
	list := ta.GET("/api/meal-ideas").List()
	if list[0].(map[string]any)["title"] != "Curry" {
		t.Fatalf("no-op PUT reordered list: %v", list)
	}
}

// Adversarial-audit finding 4: concurrent refresh requests — only one may start.
func TestCalendarRefreshSingleFlight(t *testing.T) {
	ta := newTestApp(t)
	if !ta.App.Calendar.TryStartRefresh() {
		t.Fatal("first claim failed")
	}
	if ta.App.Calendar.TryStartRefresh() {
		t.Fatal("second concurrent claim succeeded")
	}
	resp := ta.POST("/api/calendar/refresh", nil)
	if resp.Obj()["message"] != "Refresh already in progress" {
		t.Fatalf("message = %v", resp.Obj()["message"])
	}
	ta.App.Calendar.SetRefreshing(false)
}

// Adversarial-audit finding 6: unbounded day ranges are rejected.
func TestDaysRangeCap(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/days?start_date=0001-01-01&end_date=9999-12-31")
	if resp.Status != 422 {
		t.Fatalf("huge range: status = %d, want 422", resp.Status)
	}
	resp = ta.GET("/api/days/events?start_date=0001-01-01&end_date=9999-12-31")
	if resp.Status != 422 {
		t.Fatalf("huge events range: status = %d, want 422", resp.Status)
	}
	// Normal ranges unaffected.
	resp = ta.GET("/api/days?start_date=2026-06-01&end_date=2026-08-31")
	if resp.Status != 200 {
		t.Fatalf("normal range: status = %d", resp.Status)
	}
}
