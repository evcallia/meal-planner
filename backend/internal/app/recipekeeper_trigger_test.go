// backend/internal/app/recipekeeper_trigger_test.go
package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"mealplanner/internal/recipekeeper"
)

// recipeKeeperSyncCounter counts fake-server /api/sync hits by which bucket
// the request body carries, so the background syncs a successful
// PUT /api/recipe-keeper/list kicks (TriggerGrocerySync / TriggerRecipeSync)
// can be observed even though they run detached in a goroutine. Counting the
// wire-level request is the seam: it doesn't require any new hook in
// production code, and it exercises the same single-flight Service methods
// the handler actually calls.
type recipeKeeperSyncCounter struct {
	groceryHits int32
	recipeHits  int32
}

func (c *recipeKeeperSyncCounter) grocery() int { return int(atomic.LoadInt32(&c.groceryHits)) }
func (c *recipeKeeperSyncCounter) recipe() int  { return int(atomic.LoadInt32(&c.recipeHits)) }

// enableRecipeKeeperWithListsAndCounter is enableRecipeKeeperWithLists (see
// recipekeeper_test.go) plus a counter of which sync bucket each /api/sync
// request carried. delay, if non-zero, is applied only to grocery/recipe
// bucket requests (never to the ShoppingList bucket FetchLists/SelectList use
// for id validation) so a test can prove the HTTP handler doesn't wait on the
// triggered background sync.
func enableRecipeKeeperWithListsAndCounter(t *testing.T, ta *testApp, entities []map[string]any, delay time.Duration) *recipeKeeperSyncCounter {
	t.Helper()
	counter := &recipeKeeperSyncCounter{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + rkTestJWT(time.Now().Add(48*time.Hour)) + `"}`))
			return
		}
		// SyncRequest's fields carry no `omitempty` (see client.go) — every
		// bucket key is present on every request, null or not — so a bucket
		// is "requested" only when its value is non-null, never merely when
		// its key string appears in the body.
		body, _ := io.ReadAll(r.Body)
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(body, &fields)
		isSet := func(key string) bool {
			raw, ok := fields[key]
			return ok && string(raw) != "null"
		}
		if isSet("ShoppingListItemSyncEntityRequest") {
			atomic.AddInt32(&counter.groceryHits, 1)
			if delay > 0 {
				time.Sleep(delay)
			}
		}
		if isSet("RecipeSyncEntityRequest") {
			atomic.AddInt32(&counter.recipeHits, 1)
			if delay > 0 {
				time.Sleep(delay)
			}
		}
		raw := make([]json.RawMessage, len(entities))
		for i, e := range entities {
			b, _ := json.Marshal(e)
			raw[i] = b
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ShoppingListSyncEntityResponse": map[string]any{
				"UpdatedServerItems": raw,
				"MaxLastModified":    "2026-09-14T00:00:00.0000001Z",
			},
		})
	}))
	t.Cleanup(srv.Close)
	authr := &recipekeeper.Authenticator{BaseURL: srv.URL, Username: "test", Password: "test", HTTP: &http.Client{}}
	ta.App.RecipeKeeper = &recipekeeper.Service{
		DB:     ta.App.DB,
		Rec:    &recipekeeper.Reconciler{DB: ta.App.DB},
		Client: recipekeeper.NewClient(srv.URL, authr, recipekeeper.Headers{}, nil),
	}
	return counter
}

// waitForCount polls got until it reaches (or exceeds) want, or fails the
// test after timeout — needed because TriggerGrocerySync/TriggerRecipeSync
// run detached goroutines that the HTTP response does not wait on.
func waitForCount(t *testing.T, timeout time.Duration, want int, got func() int, what string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if got() >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s (got %d, want >= %d)", what, got(), want)
}

// A successful selection must kick both the grocery sync (pulls the list
// itself) and the recipe sync (populates the title-attribution cache a
// freshly-selected list needs) in the background, rather than leaving the
// grocery list empty until the next long-poll doorbell or the ~15-minute
// safety timer.
func TestSelectListEndpointTriggersBackgroundSync(t *testing.T) {
	ta := newTestApp(t)
	counter := enableRecipeKeeperWithListsAndCounter(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	}, 0)

	resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "list-a"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	waitForCount(t, 2*time.Second, 1, counter.grocery, "the grocery sync to fire")
	waitForCount(t, 2*time.Second, 1, counter.recipe, "the recipe sync to fire")
}

// A rejected selection (unknown list id) must not touch the sync triggers at
// all — SelectList returns before persisting anything, and the handler must
// not kick a sync for a selection that never took effect.
func TestSelectListEndpointRejectedSelectionDoesNotTriggerSync(t *testing.T) {
	ta := newTestApp(t)
	counter := enableRecipeKeeperWithListsAndCounter(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	}, 0)

	resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "does-not-exist"})
	if resp.Status < 400 || resp.Status >= 500 {
		t.Fatalf("status = %d, want a 4xx: %s", resp.Status, resp.Body)
	}

	// Give an errant background goroutine a moment to fire before asserting
	// its absence — there is nothing to positively wait for here.
	time.Sleep(150 * time.Millisecond)
	if got := counter.grocery(); got != 0 {
		t.Errorf("grocery sync hits = %d, want 0 after a rejected selection", got)
	}
	if got := counter.recipe(); got != 0 {
		t.Errorf("recipe sync hits = %d, want 0 after a rejected selection", got)
	}
}

// The handler must not block the HTTP response on the triggered background
// sync. The fake server sleeps well past a reasonable request budget on the
// grocery/recipe buckets only (never on the ShoppingList bucket SelectList
// itself uses); if the kick were awaited instead of fire-and-forget, this
// request would take that long too.
func TestSelectListEndpointReturnsPromptlyDespiteSlowBackgroundSync(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeperWithListsAndCounter(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	}, 2*time.Second)

	start := time.Now()
	resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "list-a"})
	elapsed := time.Since(start)

	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if elapsed >= 1*time.Second {
		t.Errorf("PUT took %s, want well under the background sync's 2s delay (handler must not wait on it)", elapsed)
	}
}
