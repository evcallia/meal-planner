// backend/internal/recipekeeper/pause_test.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"mealplanner/internal/models"
)

// TestSyncOnceNoopWhenPaused proves the pause switch stops SyncOnce before it
// ever contacts Recipe Keeper — no /token request, no /api/sync request, no
// watermark write — rather than merely suppressing the push/pull results.
func TestSyncOnceNoopWhenPaused(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: testAuth(srv)},
		Rec:    rec, DB: db,
	}
	SetPaused(db, true)

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce while paused should be a silent no-op, got: %v", err)
	}
	if got := atomic.LoadInt32(&requests); got != 0 {
		t.Errorf("requests = %d, want 0 — a paused sync must never contact Recipe Keeper", got)
	}
	if !svc.Status().Paused {
		t.Error("Status().Paused should be true")
	}
}

// TestSyncRecipesNoopWhenPaused mirrors TestSyncOnceNoopWhenPaused for the
// recipe-title cache refresh.
func TestSyncRecipesNoopWhenPaused(t *testing.T) {
	db := testDB(t)
	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: testAuth(srv)},
		Rec:    &Reconciler{DB: db}, DB: db,
	}
	SetPaused(db, true)

	if err := svc.SyncRecipes(context.Background()); err != nil {
		t.Fatalf("SyncRecipes while paused should be a silent no-op, got: %v", err)
	}
	if got := atomic.LoadInt32(&requests); got != 0 {
		t.Errorf("requests = %d, want 0", got)
	}
}

// TestPauseDoesNotAdvanceWatermark proves pausing never touches the item
// watermark, even though a normal SyncOnce against the same fixture would.
func TestPauseDoesNotAdvanceWatermark(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	lm := "2026-09-14T00:00:00.0000001Z"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingListItem: &ItemBucketResponse{
				UpdatedServerItems: []ShoppingListItem{{
					ID: "srv-1", Name: "Cilantro", ShoppingListID: "list-1", LastModified: &lm,
				}},
				MaxLastModified: lm,
			},
		})
	}))
	defer srv.Close()

	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: testAuth(srv)},
		Rec:    rec, DB: db,
	}

	before := getState(db, stateWatermarkItem, epochWatermark)
	if before != epochWatermark {
		t.Fatalf("precondition: watermark = %q, want epoch", before)
	}

	SetPaused(db, true)
	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if after := getState(db, stateWatermarkItem, epochWatermark); after != before {
		t.Errorf("watermark = %q after a paused sync, want unchanged %q", after, before)
	}

	// Sanity check the fixture actually WOULD have advanced the watermark
	// once unpaused, so the assertion above is proving something real.
	SetPaused(db, false)
	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce (resumed): %v", err)
	}
	if after := getState(db, stateWatermarkItem, epochWatermark); after != lm {
		t.Errorf("watermark = %q after resuming, want %q", after, lm)
	}
}

// TestTriggerGrocerySyncNoopWhenPaused proves the kick that a grocery
// mutation fires (checking an item, deleting it, etc.) does not even start a
// background goroutine while paused.
func TestTriggerGrocerySyncNoopWhenPaused(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: testAuth(srv)},
		Rec:    rec, DB: db,
	}
	SetPaused(db, true)

	svc.TriggerGrocerySync(ReasonUnspecified)
	// TriggerGrocerySync is fire-and-forget; give a would-be goroutine time
	// to reach the server before asserting it never did.
	time.Sleep(50 * time.Millisecond)

	if got := atomic.LoadInt32(&requests); got != 0 {
		t.Errorf("requests = %d, want 0 — TriggerGrocerySync must not even start while paused", got)
	}
}

// TestTriggerRecipeSyncNoopWhenPaused mirrors
// TestTriggerGrocerySyncNoopWhenPaused for the recipe-title cache trigger.
func TestTriggerRecipeSyncNoopWhenPaused(t *testing.T) {
	db := testDB(t)

	var requests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requests, 1)
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: testAuth(srv)},
		Rec:    &Reconciler{DB: db}, DB: db,
	}
	SetPaused(db, true)

	svc.TriggerRecipeSync(ReasonUnspecified)
	time.Sleep(50 * time.Millisecond)

	if got := atomic.LoadInt32(&requests); got != 0 {
		t.Errorf("requests = %d, want 0 — TriggerRecipeSync must not even start while paused", got)
	}
}

// TestRunPollsAreNoopWhilePaused proves Run's poll-driven cadence (both
// connected and idle) produces zero grocery syncs while paused, using a
// fast interval that would otherwise rack up many calls quickly.
func TestRunPollsAreNoopWhilePaused(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)
	SetPaused(db, true)

	var calls int32
	srv := syncCountingServer(t, &calls)
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: testAuth(srv)},
		Rec:    rec, DB: db,
		PollInterval:     5 * time.Millisecond,
		IdlePollInterval: 5 * time.Millisecond,
		SubscriberCount:  func() int { return 1 },
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go svc.Run(ctx)

	time.Sleep(150 * time.Millisecond)
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Errorf("calls = %d in 150ms of paused polling at a 5ms interval, want 0", got)
	}
}

// TestResumePushesTombstonedDeleteMadeWhilePaused is the core resume
// guarantee: a grocery item deleted (and thus tombstoned) while paused must
// push its delete on the very next sync after resume — nothing about
// pausing may cause it to be lost, since PendingPushes derives pending work
// from current DB state rather than a queue.
func TestResumePushesTombstonedDeleteMadeWhilePaused(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	lm := "2026-09-14T00:00:00.0000001Z"
	var pushed []ShoppingListItem
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.ShoppingListItem != nil {
			pushed = append(pushed, req.ShoppingListItem.SyncEntities...)
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingListItem: &ItemBucketResponse{
				UpdatedServerItems: []ShoppingListItem{{
					ID: "srv-1", Name: "Cilantro", ShoppingListID: "list-1", LastModified: &lm,
				}},
				MaxLastModified: lm,
			},
		})
	}))
	defer srv.Close()

	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: testAuth(srv)},
		Rec:    rec, DB: db,
	}

	// Import "Cilantro" (not paused) so a real link with cached
	// LastModified exists — buildPush refuses to push without one.
	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("initial sync: %v", err)
	}
	if itemByName(t, db, "Cilantro", false) == nil {
		t.Fatal("inbound item was not applied")
	}

	// Pause, then delete the item locally — mirroring the real grocery
	// delete handler (tombstone the links, then remove the row).
	SetPaused(db, true)
	if err := rec.TombstoneLinks("Cilantro", false); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	if err := db.Where("name = ? AND checked = ?", "Cilantro", false).
		Delete(&models.GroceryItem{}).Error; err != nil {
		t.Fatalf("delete grocery item: %v", err)
	}

	pushed = nil
	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("paused sync: %v", err)
	}
	if len(pushed) != 0 {
		t.Fatalf("push happened while paused: %+v", pushed)
	}

	SetPaused(db, false)
	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("resumed sync: %v", err)
	}
	if len(pushed) != 1 || !pushed[0].IsDeleted {
		t.Errorf("pushed = %+v, want exactly one delete after resume", pushed)
	}
}
