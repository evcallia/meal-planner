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
	// delayNanos is read per request so a test can select a list through
	// PUT /api/recipe-keeper/list at full speed and only then slow the
	// drain down. Without that, a test that wants a slow drain has to
	// start slow, and the selection it needs first would be slow too —
	// or it skips selecting, SyncOnce no-ops on "no list selected", and
	// every timing assertion passes vacuously.
	delayNanos int64
}

func (c *recipeKeeperSyncCounter) grocery() int { return int(atomic.LoadInt32(&c.groceryHits)) }
func (c *recipeKeeperSyncCounter) setDelay(d time.Duration) {
	atomic.StoreInt64(&c.delayNanos, int64(d))
}
func (c *recipeKeeperSyncCounter) delay() time.Duration {
	return time.Duration(atomic.LoadInt64(&c.delayNanos))
}
func (c *recipeKeeperSyncCounter) recipe() int { return int(atomic.LoadInt32(&c.recipeHits)) }

// enableRecipeKeeperWithListsAndCounter is enableRecipeKeeperWithLists (see
// recipekeeper_test.go) plus a counter of which sync bucket each /api/sync
// request carried. delay, if non-zero, is applied only to grocery/recipe
// bucket requests (never to the ShoppingList bucket FetchLists/SelectList use
// for id validation) so a test can prove the HTTP handler doesn't wait on the
// triggered background sync.
func enableRecipeKeeperWithListsAndCounter(t *testing.T, ta *testApp, entities []map[string]any, delay time.Duration) *recipeKeeperSyncCounter {
	t.Helper()
	counter := &recipeKeeperSyncCounter{delayNanos: int64(delay)}
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
			if d := counter.delay(); d > 0 {
				time.Sleep(d)
			}
		}
		if isSet("RecipeSyncEntityRequest") {
			atomic.AddInt32(&counter.recipeHits, 1)
			if d := counter.delay(); d > 0 {
				time.Sleep(d)
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

// selectListForSync selects a list through the real endpoint and waits for
// the drains that selection kicks to finish, leaving the service idle so a
// following manual sync is measured on its own. Selecting is what makes a
// drain do real work at all — SyncOnce no-ops on "no list selected", which
// silently turns every timing assertion below into a vacuous pass.
func selectListForSync(t *testing.T, ta *testApp, counter *recipeKeeperSyncCounter) {
	t.Helper()
	if resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "list-a"}); resp.Status != 200 {
		t.Fatalf("selecting the list failed: status = %d: %s", resp.Status, resp.Body)
	}
	waitForCount(t, 2*time.Second, 1, counter.grocery, "the selection's own grocery sync")
	waitForSyncIdle(t, ta)
}

// waitForSyncIdle blocks until no drain is in flight, so a test's own kick
// isn't coalesced into one already running.
func waitForSyncIdle(t *testing.T, ta *testApp) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if ta.GET("/api/recipe-keeper/status").Obj()["syncing"] == false {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the sync to go idle")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// The manual "Sync now" button must not block its HTTP response on the
// drain. This is the regression test for a defect that shipped because the
// endpoint had no happy-path coverage at all (only not-configured,
// unauthenticated and paused): the handler called SyncOnce(r.Context())
// directly, so a drain outlived the frontend's 5s fetch abort, the browser
// cancelled the request, Go cancelled r.Context(), and the in-flight vendor
// POST died with "context canceled" — persisting no watermark, so the press
// accomplished nothing while the background poll loop running the same
// SyncOnce succeeded seconds later.
func TestSyncEndpointReturnsPromptlyDespiteSlowDrain(t *testing.T) {
	ta := newTestApp(t)
	counter := enableRecipeKeeperWithListsAndCounter(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	}, 0)
	selectListForSync(t, ta, counter)
	counter.setDelay(2 * time.Second)

	start := time.Now()
	resp := ta.POST("/api/recipe-keeper/sync", nil)
	elapsed := time.Since(start)

	if elapsed > time.Second {
		t.Errorf("request took %v, want well under the 2s drain — the handler is awaiting it", elapsed)
	}
	if resp.Status != http.StatusAccepted {
		t.Errorf("status = %d, want 202: %s", resp.Status, resp.Body)
	}
}

// Returning promptly is only correct if the drain actually happens: the
// handler must kick the same single-flight trigger the poll loop uses, on a
// background context, rather than skipping the work.
func TestSyncEndpointTriggersBackgroundDrain(t *testing.T) {
	ta := newTestApp(t)
	counter := enableRecipeKeeperWithListsAndCounter(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	}, 0)
	selectListForSync(t, ta, counter)
	baseline := counter.grocery()

	if resp := ta.POST("/api/recipe-keeper/sync", nil); resp.Status != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", resp.Status, resp.Body)
	}

	// The drain runs after the response, so this proves both that it
	// happened and that it survived the request context being done.
	waitForCount(t, 2*time.Second, baseline+1, counter.grocery, "the grocery drain to fire after the response")
}

// Because the response can no longer carry the drain's outcome, the status
// endpoint has to report that one is in flight — that is the only signal the
// UI has to keep its button busy and then show the result.
func TestStatusEndpointReportsSyncingWhileDraining(t *testing.T) {
	ta := newTestApp(t)
	counter := enableRecipeKeeperWithListsAndCounter(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	}, 0)
	selectListForSync(t, ta, counter)
	counter.setDelay(time.Second)

	resp := ta.POST("/api/recipe-keeper/sync", nil)
	if resp.Status != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", resp.Status, resp.Body)
	}
	// Set synchronously by the trigger, so the 202 itself already says so —
	// no polling race for the UI to lose on its first read.
	if resp.Obj()["syncing"] != true {
		t.Errorf("202 body syncing = %v, want true", resp.Obj()["syncing"])
	}
	if obj := ta.GET("/api/recipe-keeper/status").Obj(); obj["syncing"] != true {
		t.Errorf("status syncing = %v, want true while draining", obj["syncing"])
	}

	counter.setDelay(0)
	waitForSyncIdle(t, ta)
}
