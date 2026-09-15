// backend/internal/app/recipekeeper_paused_test.go
package app

import (
	"net/http"
	"testing"
	"time"

	"mealplanner/internal/recipekeeper"
)

// TestSyncEndpointRefusesWhilePaused proves the manual "Sync now" button
// gets a clear, distinguishable refusal while paused — never a silent
// no-op success — matching handleRecipeKeeperSync's explicit IsPaused check.
func TestSyncEndpointRefusesWhilePaused(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)
	recipekeeper.SetPaused(ta.App.DB, true)

	resp := ta.POST("/api/recipe-keeper/sync", nil)
	if resp.Status != http.StatusConflict {
		t.Fatalf("status = %d, want 409: %s", resp.Status, resp.Body)
	}
	if len(resp.Body) == 0 {
		t.Error("expected a detail message explaining the refusal")
	}
}

// TestSyncEndpointWorksWhenNotPaused is the control for
// TestSyncEndpointRefusesWhilePaused — proves the paused check isn't
// accidentally refusing every request regardless of state.
func TestSyncEndpointWorksWhenNotPaused(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta) // fake server 401s every /token call

	resp := ta.POST("/api/recipe-keeper/sync", nil)
	// The fake server always 401s, so this is a 502 (upstream failure) —
	// the important thing is it is NOT the 409 a paused refusal would be.
	if resp.Status == http.StatusConflict {
		t.Fatalf("status = 409, want anything but that when not paused: %s", resp.Body)
	}
}

// TestStatusEndpointReportsPaused proves GET /status surfaces the pause
// switch so the Settings UI can render an unambiguous state.
func TestStatusEndpointReportsPaused(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)

	resp := ta.GET("/api/recipe-keeper/status")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if obj := resp.Obj(); obj["paused"] != false {
		t.Errorf("paused = %v, want false by default", obj["paused"])
	}

	recipekeeper.SetPaused(ta.App.DB, true)
	resp = ta.GET("/api/recipe-keeper/status")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if obj := resp.Obj(); obj["paused"] != true {
		t.Errorf("paused = %v, want true after SetPaused", obj["paused"])
	}
}

// TestSetPausedEndpointRejectsWhenNotConfigured mirrors the other Recipe
// Keeper endpoints' "not configured" behavior.
func TestSetPausedEndpointRejectsWhenNotConfigured(t *testing.T) {
	ta := newTestApp(t)

	resp := ta.PUT("/api/recipe-keeper/paused", map[string]any{"paused": true})
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400: %s", resp.Status, resp.Body)
	}
}

// TestSetPausedEndpointRequiresBody proves a missing "paused" field is
// rejected rather than silently defaulting to false (which would look
// identical to "resume" and defeat the safety switch).
func TestSetPausedEndpointRequiresBody(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)

	resp := ta.PUT("/api/recipe-keeper/paused", map[string]any{})
	if resp.Status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
}

// TestSetPausedEndpointPersists proves PUT /paused round-trips through
// recipe_keeper_state (household-global, not per-user), not just in-memory.
func TestSetPausedEndpointPersists(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeper(t, ta)

	resp := ta.PUT("/api/recipe-keeper/paused", map[string]any{"paused": true})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if obj := resp.Obj(); obj["paused"] != true {
		t.Errorf("response paused = %v, want true", obj["paused"])
	}
	if !recipekeeper.IsPaused(ta.App.DB) {
		t.Error("IsPaused should be true after PUT paused=true")
	}

	resp = ta.PUT("/api/recipe-keeper/paused", map[string]any{"paused": false})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if obj := resp.Obj(); obj["paused"] != false {
		t.Errorf("response paused = %v, want false", obj["paused"])
	}
	if recipekeeper.IsPaused(ta.App.DB) {
		t.Error("IsPaused should be false after PUT paused=false")
	}
}

// TestSetPausedEndpointResumeTriggersImmediateSync proves resuming (paused:
// false) kicks a sync right away rather than leaving the household waiting
// up to the idle poll interval or the 15-minute safety timer — the same
// promise PUT /list already makes on selection.
func TestSetPausedEndpointResumeTriggersImmediateSync(t *testing.T) {
	ta := newTestApp(t)
	counter := enableRecipeKeeperWithListsAndCounter(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	}, 0)
	// A list must be selected for SyncOnce to do anything at all (see
	// loop.go's SyncOnce skipping the whole cycle otherwise). This selection
	// itself also kicks a sync — wait for it so it isn't mistaken for the
	// resume-driven one below.
	if resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "list-a"}); resp.Status != 200 {
		t.Fatalf("selecting a list (setup): %d %s", resp.Status, resp.Body)
	}
	waitForCount(t, 2*time.Second, 1, counter.grocery, "the setup selection's own sync")

	recipekeeper.SetPaused(ta.App.DB, true)

	resp := ta.PUT("/api/recipe-keeper/paused", map[string]any{"paused": false})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	waitForCount(t, 2*time.Second, 2, counter.grocery, "an additional grocery sync fired by resume")
}

// TestPausedRouteRequiresAuth mirrors TestRecipeKeeperRoutesRequireAuth for
// the new route.
func TestPausedRouteRequiresAuth(t *testing.T) {
	ta := newTestApp(t)

	if resp := ta.Anon("PUT", "/api/recipe-keeper/paused", map[string]any{"paused": true}); resp.Status != 401 {
		t.Errorf("paused route unauth status = %d, want 401", resp.Status)
	}
}
