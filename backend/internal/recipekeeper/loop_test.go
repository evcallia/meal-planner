// backend/internal/recipekeeper/loop_test.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"mealplanner/internal/models"
)

func TestSyncOnceAppliesInboundAndPushesOutbound(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

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
		lm := "2026-09-14T00:00:00.0000001Z"
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

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if itemByName(t, db, "Cilantro", false) == nil {
		t.Error("inbound item was not applied")
	}
	if st := svc.Status(); st.LastError != "" {
		t.Errorf("LastError = %q, want empty", st.LastError)
	}

	// A local change must be pushed on the next pass. Checking an item flips
	// its row in place, so the link (keyed by name+checked) must be
	// retargeted the same way the real grocery item-update handler will
	// (reconcile.go's RetargetLinks doc) — without it PendingPushes finds no
	// row at the old (name, checked=false) key, treats the link as an
	// orphan, and silently drops it instead of pushing the check.
	it := itemByName(t, db, "Cilantro", false)
	it.Checked = true
	db.Save(it)
	if err := rec.RetargetLinks("Cilantro", false, "Cilantro", true); err != nil {
		t.Fatalf("RetargetLinks: %v", err)
	}
	pushed = nil
	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce 2: %v", err)
	}
	if len(pushed) != 1 || !pushed[0].IsChecked {
		t.Errorf("pushed = %+v, want one checked entity", pushed)
	}
}

func TestSyncOnceRecordsAuthFailureImmediately(t *testing.T) {
	db := testDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "bad",
		HTTP: srv.Client(), Now: time.Now}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    testReconciler(t, db), DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err == nil {
		t.Fatal("want error")
	}
	st := svc.Status()
	if !st.AuthFailed {
		t.Error("AuthFailed should be true — credential failures never self-heal")
	}
	if st.LastError == "" {
		t.Error("LastError should be recorded for the bell")
	}
	var row models.RecipeKeeperState
	if err := db.First(&row, "key = ?", stateLastError).Error; err != nil {
		t.Error("last error must persist across restarts")
	}
}

// TestSyncOnceStoresCategoriesAndRecipes closes the gap in the brief's
// SyncOnce sample: nothing pulls the category buckets unless SyncOnce itself
// requests them, and section placement for newly-imported items depends on
// that cache being populated (Reconciler.sectionFromRKCategory).
func TestSyncOnceStoresCategoriesAndPlacesSection(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)
	db.Create(&models.GrocerySection{ID: models.NewID(), Name: "Produce", Position: 1})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		// A successful SyncOnce also fires a background recipe-only pull
		// (Recipe bucket alone, via recordSuccess -> TriggerRecipeSync) once
		// this request completes. Respond like the real server would: only
		// the buckets actually asked for come back non-nil, so that
		// incidental request neither trips the assertion below nor gets a
		// ShoppingListItem bucket to (redundantly, racily) reapply.
		var resp SyncResponse
		lm := "2026-09-14T00:00:00.0000001Z"
		if req.ShoppingListItem != nil {
			if req.ShoppingListCategory == nil || req.ShoppingListCategoryItem == nil {
				t.Errorf("SyncOnce must request both category buckets, got %+v", req)
			}
			resp.ShoppingListCategory = &RawBucketResponse{
				UpdatedServerItems: []json.RawMessage{
					json.RawMessage(`{"Id":"cat-1","Name":"Produce","IsDeleted":false}`),
				},
				MaxLastModified: lm,
			}
			resp.ShoppingListCategoryItem = &RawBucketResponse{
				UpdatedServerItems: []json.RawMessage{
					json.RawMessage(`{"Name":"Cilantro","ShoppingListCategoryId":"cat-1","IsDeleted":false}`),
				},
				MaxLastModified: lm,
			}
			resp.ShoppingListItem = &ItemBucketResponse{
				UpdatedServerItems: []ShoppingListItem{{
					ID: "srv-1", Name: "Cilantro", ShoppingListID: "list-1", LastModified: &lm,
				}},
				MaxLastModified: lm,
			}
		}
		_ = json.NewEncoder(w).Encode(resp)
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	item := itemByName(t, db, "Cilantro", false)
	if item == nil {
		t.Fatal("Cilantro was not imported")
	}
	var sec models.GrocerySection
	if err := db.First(&sec, "id = ?", item.SectionID).Error; err != nil {
		t.Fatalf("section lookup: %v", err)
	}
	if sec.Name != "Produce" {
		t.Errorf("section = %q, want Produce (category placement did not apply)", sec.Name)
	}
	if got := getState(db, stateWatermarkCategory, ""); got != "2026-09-14T00:00:00.0000001Z" {
		t.Errorf("category watermark = %q", got)
	}
	if got := getState(db, stateWatermarkCatItem, ""); got != "2026-09-14T00:00:00.0000001Z" {
		t.Errorf("category-item watermark = %q", got)
	}
}

// TestSyncRecipesPopulatesCacheAndPaginates closes the other half of the same
// gap: nothing pulls the Recipe bucket unless SyncRecipes is called, and
// without it recipe titles used for attribution never populate.
func TestSyncRecipesPopulatesCacheAndPaginates(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe == nil {
			// t.Fatalf here would call Goexit on the server's own goroutine,
			// not the test goroutine — the test would just see a confusing
			// EOF instead of this message. Errorf + return reports it
			// correctly and still aborts the response.
			t.Errorf("expected a Recipe bucket in the request")
			return
		}
		n := atomic.AddInt32(&calls, 1)
		switch n {
		case 1:
			if req.Recipe.MaxLastModified != epochWatermark {
				t.Errorf("first pull watermark = %q, want epoch", req.Recipe.MaxLastModified)
			}
			_ = json.NewEncoder(w).Encode(SyncResponse{
				Recipe: &RawBucketResponse{
					UpdatedServerItems: []json.RawMessage{
						json.RawMessage(`{"Id":"rec-1","Title":"Fig Cocktail","LastModified":"2026-09-14T00:00:00.0000001Z"}`),
					},
					HasMoreUpdatedServerItems: true,
					MaxLastModified:           "2026-09-14T00:00:00.0000001Z",
				},
			})
		case 2:
			if req.Recipe.MaxLastModified != "2026-09-14T00:00:00.0000001Z" {
				t.Errorf("second pull did not carry the first page's watermark: got %q", req.Recipe.MaxLastModified)
			}
			_ = json.NewEncoder(w).Encode(SyncResponse{
				Recipe: &RawBucketResponse{
					UpdatedServerItems: []json.RawMessage{
						json.RawMessage(`{"Id":"rec-2","Title":"Lemon Tart","LastModified":"2026-09-14T00:00:01.0000001Z"}`),
					},
					HasMoreUpdatedServerItems: false,
					MaxLastModified:           "2026-09-14T00:00:01.0000001Z",
				},
			})
		default:
			t.Errorf("unexpected call %d — pagination should have stopped", n)
			return
		}
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	if err := svc.SyncRecipes(context.Background()); err != nil {
		t.Fatalf("SyncRecipes: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("calls = %d, want 2 (pagination not followed)", got)
	}

	var rec1, rec2 models.RecipeKeeperRecipe
	if err := db.First(&rec1, "rk_recipe_id = ?", "rec-1").Error; err != nil || rec1.Title != "Fig Cocktail" {
		t.Errorf("rec-1 not cached: err=%v row=%+v", err, rec1)
	}
	if err := db.First(&rec2, "rk_recipe_id = ?", "rec-2").Error; err != nil || rec2.Title != "Lemon Tart" {
		t.Errorf("rec-2 not cached: err=%v row=%+v", err, rec2)
	}
	if got := getState(db, stateWatermarkRecipe, ""); got != "2026-09-14T00:00:01.0000001Z" {
		t.Errorf("recipe watermark = %q, want the last page's MaxLastModified", got)
	}
}

// TestTriggerRecipeSyncSkipsWhileInFlight locks in the mutex guard: a second
// trigger while a pull is already running must be a no-op, not a second
// concurrent hundred-MB pull.
// TestTriggerRecipeSyncCoalescesWhileInFlight proves a burst of triggers
// arriving while a recipe pull is already in flight collapses into exactly
// one extra pull afterwards — not zero (the old drop-on-busy bug) and not
// one per trigger.
func TestTriggerRecipeSyncCoalescesWhileInFlight(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var calls int32
	entered := make(chan struct{}, 1)
	release := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		atomic.AddInt32(&calls, 1)
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	svc.TriggerRecipeSync()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("first recipe sync never reached the server")
	}

	// Several more triggers landing while the first pull is still in
	// flight (blocked on <-release below) — these must coalesce into
	// exactly one extra pull, not be dropped and not each start their own.
	svc.TriggerRecipeSync()
	svc.TriggerRecipeSync()
	svc.TriggerRecipeSync()

	close(release)
	deadline := time.After(2 * time.Second)
	for {
		if svc.recipeSyncMu.TryLock() {
			svc.recipeSyncMu.Unlock()
			break
		}
		select {
		case <-deadline:
			t.Fatal("recipe sync guard was never released")
		case <-time.After(10 * time.Millisecond):
		}
	}

	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("calls = %d, want 2 (the first pull plus exactly one coalesced extra pull for the burst of triggers that arrived mid-flight)", got)
	}
}

// TestSyncOnceIsSafeForConcurrentCallers guards the failures/authFailures/
// stopped bookkeeping added for the auth latch. Task 9 adds
// POST /api/recipe-keeper/sync, which calls SyncOnce concurrently with the
// background Run loop — this must not race (run with -race).
func TestSyncOnceIsSafeForConcurrentCallers(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = svc.SyncOnce(context.Background())
		}()
	}
	wg.Wait()

	if st := svc.Status(); st.LastError != "" {
		t.Errorf("LastError = %q, want empty after concurrent successful syncs", st.LastError)
	}
}

// TestRecordErrorTransientThreeStrikes locks in the headline behavior of this
// task: a transient (non-auth) failure only surfaces to the bell after the
// third in a row, not the first.
func TestRecordErrorTransientThreeStrikes(t *testing.T) {
	db := testDB(t)
	svc := &Service{DB: db}
	transientErr := errors.New("connection reset")

	svc.recordError(transientErr)
	if got := svc.Status().LastError; got != "" {
		t.Errorf("after 1 failure LastError = %q, want empty", got)
	}
	svc.recordError(transientErr)
	if got := svc.Status().LastError; got != "" {
		t.Errorf("after 2 failures LastError = %q, want empty", got)
	}
	svc.recordError(transientErr)
	if got := svc.Status().LastError; got == "" {
		t.Error("after 3 failures LastError should be set")
	}
}

// TestRecordSuccessClearsPriorError proves a subsequent success clears a
// previously-recorded error rather than leaving a stale message on the bell.
func TestRecordSuccessClearsPriorError(t *testing.T) {
	db := testDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	// recordSuccess triggers a background recipe sync, which needs a real
	// Client — a bare &Service{DB: db} would panic in that goroutine.
	svc := &Service{Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth}, DB: db}

	svc.recordError(errors.New("boom"))
	svc.recordError(errors.New("boom"))
	svc.recordError(errors.New("boom"))
	if got := svc.Status().LastError; got == "" {
		t.Fatal("expected LastError to be set before recordSuccess")
	}

	svc.recordSuccess()
	if got := svc.Status().LastError; got != "" {
		t.Errorf("LastError = %q, want empty after recordSuccess", got)
	}
}

// TestRunPollsPeriodicallyWithoutDoorbellSignal proves Run syncs on its own
// regular schedule even when the doorbell NEVER signals a change (every
// Notify call returns 201) — measured live, this is exactly what happens
// against the real Recipe Keeper server for this client. PollInterval is set
// to a few milliseconds so the test can observe several poll-driven syncs
// without anywhere near a real 60s wait.
func TestRunPollsPeriodicallyWithoutDoorbellSignal(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var syncCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		if r.URL.Path == "/api/syncnotification" {
			// The doorbell never fires for this client — every long-poll
			// simply expires.
			w.WriteHeader(http.StatusCreated)
			return
		}
		atomic.AddInt32(&syncCalls, 1)
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
		PollInterval: 20 * time.Millisecond,
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go svc.Run(ctx)

	// The initial sync in Run accounts for 1 call; periodic polling (not the
	// doorbell, which never returns 200 here) must push it well past that
	// within a couple hundred milliseconds.
	deadline := time.After(2 * time.Second)
	for {
		if atomic.LoadInt32(&syncCalls) >= 4 {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("only %d sync(s) happened in 2s with PollInterval=20ms and no doorbell signal; periodic polling never kicked in", atomic.LoadInt32(&syncCalls))
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestResolvePollIntervalClampsBelowFloor proves a configured poll interval
// faster than minPollSeconds is clamped up to it rather than honored as-is —
// polling that fast is hammering a third party's live API, not a cheap
// delta.
func TestResolvePollIntervalClampsBelowFloor(t *testing.T) {
	if got, want := ResolvePollInterval(5), time.Duration(minPollSeconds)*time.Second; got != want {
		t.Errorf("ResolvePollInterval(5) = %v, want clamped to %v", got, want)
	}
	if got, want := ResolvePollInterval(0), time.Duration(defaultPollSeconds)*time.Second; got != want {
		t.Errorf("ResolvePollInterval(0) = %v, want default %v", got, want)
	}
	if got, want := ResolvePollInterval(120), 120*time.Second; got != want {
		t.Errorf("ResolvePollInterval(120) = %v, want unchanged %v", got, want)
	}
}

// deadlineCapturingTransport is a fake http.RoundTripper used to observe the
// deadline on the *client-side* context passed into an outbound request —
// note this is NOT the same thing as the request's wire-level timing, and
// specifically not the same as an httptest.Server handler's r.Context(),
// which is governed by the SERVER's own timeouts and carries none of the
// client's context.WithTimeout information across the network. Answering
// entirely in-process is what makes the deadline directly observable.
type deadlineCapturingTransport struct {
	deadlines chan time.Time
}

func (f *deadlineCapturingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := `{}`
	if req.URL.Path == "/token" {
		body = `{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`
	} else if dl, ok := req.Context().Deadline(); ok {
		select {
		case f.deadlines <- dl:
		default:
		}
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}, nil
}

// TestTriggerGrocerySyncTimeoutExceeds30Seconds proves SyncOnce is no longer
// bounded by the old 30s timeout, which was shorter than a real full drain
// (measured live at 14s for the FIRST one, before the watermark was warm —
// a cold cursor or a bigger household easily exceeds 30s). A cancelled
// drain makes no progress at all, since the watermark is only persisted
// once a drain completes.
func TestTriggerGrocerySyncTimeoutExceeds30Seconds(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	deadlines := make(chan time.Time, 1)
	httpClient := &http.Client{Transport: &deadlineCapturingTransport{deadlines: deadlines}}

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: "http://recipe-keeper.invalid", Username: "u", Password: "p",
		HTTP: httpClient, Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: "http://recipe-keeper.invalid", HTTP: httpClient, Auth: auth},
		Rec:    rec, DB: db,
	}

	start := time.Now()
	svc.TriggerGrocerySync()

	var dl time.Time
	select {
	case dl = <-deadlines:
	case <-time.After(2 * time.Second):
		t.Fatal("grocery sync request never reached the fake transport")
	}

	if got := dl.Sub(start); got <= 30*time.Second {
		t.Errorf("SyncOnce's context deadline was %v out, want > 30s (the old timeout that a real full drain could exceed)", got)
	}
}

// TestRunExitsOnContextCancellation proves Run's poll loop actually stops
// when its context is cancelled (app shutdown), rather than leaking forever.
func TestRunExitsOnContextCancellation(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		if r.URL.Path == "/api/syncnotification" {
			w.WriteHeader(http.StatusCreated) // 201: poll expired, nothing changed
			return
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.Run(ctx)
		close(done)
	}()

	time.Sleep(50 * time.Millisecond) // let it reach the poll loop
	cancel()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit after its context was cancelled")
	}
}

// TestAuthFailureLatchStopsRun proves repeated auth failures stop the poll
// loop entirely instead of retrying a bad password forever — the loop is
// tripped directly via SyncOnce (real, fast) rather than waited out through
// Run's own backoff between auth retries, which is deliberately slow.
func TestAuthFailureLatchStopsRun(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.WriteHeader(http.StatusBadRequest) // credentials rejected, every time
			return
		}
	}))
	defer srv.Close()

	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "bad",
		HTTP: srv.Client(), Now: time.Now}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	for i := 0; i < authDisableAt; i++ {
		if err := svc.SyncOnce(context.Background()); err == nil {
			t.Fatalf("SyncOnce %d: want an auth error", i)
		}
	}
	if !svc.isStopped() {
		t.Fatal("latch should have tripped after authDisableAt consecutive auth failures")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		svc.Run(ctx)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop immediately when the latch was already tripped")
	}

	st := svc.Status()
	if !st.AuthFailed || st.LastError == "" {
		t.Errorf("Status after latch trip = %+v, want AuthFailed and LastError set", st)
	}
}

// TestTriggerGrocerySyncSkipsWhileInFlight mirrors
// TestTriggerRecipeSyncSkipsWhileInFlight: a burst of grocery mutations must
// collapse into one in-flight reconcile, not N concurrent SyncOnce calls
// racing on the same PendingPushes/watermark (the production echo-loop
// symptom).
// TestTriggerGrocerySyncCoalescesWhileInFlight proves a burst of grocery
// mutations landing while a sync is already in flight collapses into
// exactly one extra sync afterwards — not zero (the dropped-kick bug that
// meant a check-off made shortly after selecting a list, while the long
// initial drain was still running, never reached Recipe Keeper) and not one
// extra sync per kick.
func TestTriggerGrocerySyncCoalescesWhileInFlight(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var calls int32
	entered := make(chan struct{}, 1)
	release := make(chan struct{})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		// A successful SyncOnce opportunistically triggers a recipe-title
		// cache warm-up (recordSuccess -> TriggerRecipeSync), a second,
		// unrelated /api/sync request guarded by its own mutex. Only the
		// grocery-shaped request (carries the ShoppingListItem bucket) is
		// what this test is about — answer anything else immediately so it
		// can't be mistaken for a second concurrent grocery sync.
		body, _ := io.ReadAll(r.Body)
		var req struct {
			ShoppingListItem json.RawMessage `json:"ShoppingListItemSyncEntityRequest"`
		}
		_ = json.Unmarshal(body, &req)
		// A nil *ItemBucket marshals to the JSON literal null, which
		// json.RawMessage captures as the 4 bytes "null" rather than a nil
		// slice — compare content, not nil-ness.
		if len(req.ShoppingListItem) == 0 || string(req.ShoppingListItem) == "null" {
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		atomic.AddInt32(&calls, 1)
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		_ = json.NewEncoder(w).Encode(SyncResponse{})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	svc.TriggerGrocerySync()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("first grocery kick never reached the server")
	}

	// Several more mutations landing while the first sync is still in
	// flight — none of these may start a CONCURRENT second sync, but they
	// must not be dropped either: together they should coalesce into
	// exactly one extra sync once the first finishes.
	svc.TriggerGrocerySync()
	svc.TriggerGrocerySync()
	svc.TriggerGrocerySync()

	close(release)
	deadline := time.After(2 * time.Second)
	for {
		if svc.grocerySyncMu.TryLock() {
			svc.grocerySyncMu.Unlock()
			break
		}
		select {
		case <-deadline:
			t.Fatal("grocery sync guard was never released")
		case <-time.After(10 * time.Millisecond):
		}
	}

	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("calls = %d, want 2 (the first sync plus exactly one coalesced extra sync for the burst of kicks that arrived mid-flight)", got)
	}
}

// TestTriggerGrocerySyncSkipsWhenAuthLatchTripped proves a grocery edit made
// after the auth-failure latch has tripped does not re-attempt the bad
// password at all — retrying it on every edit is the exact account-lockout
// risk the latch exists to prevent.
func TestTriggerGrocerySyncSkipsWhenAuthLatchTripped(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var tokenRequests int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			atomic.AddInt32(&tokenRequests, 1)
			w.WriteHeader(http.StatusBadRequest) // credentials rejected, every time
			return
		}
	}))
	defer srv.Close()

	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "bad",
		HTTP: srv.Client(), Now: time.Now}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	for i := 0; i < authDisableAt; i++ {
		if err := svc.SyncOnce(context.Background()); err == nil {
			t.Fatalf("SyncOnce %d: want an auth error", i)
		}
	}
	if !svc.isStopped() {
		t.Fatal("latch should have tripped after authDisableAt consecutive auth failures")
	}
	before := atomic.LoadInt32(&tokenRequests)

	svc.TriggerGrocerySync()
	// TriggerGrocerySync is fire-and-forget; give a would-be goroutine time
	// to reach the server before asserting it never did.
	time.Sleep(50 * time.Millisecond)

	if after := atomic.LoadInt32(&tokenRequests); after != before {
		t.Errorf("token requests = %d -> %d, want no new request — the latch should have stopped TriggerGrocerySync before it started", before, after)
	}
}

// TestSyncOnceDrainsAllPagesBeforePersistingWatermark proves SyncOnce follows
// HasMoreUpdatedServerItems on the item bucket instead of stopping after one
// page. Against the live API, MaxLastModified is a GLOBAL "now", not the
// page's last entity — persisting it after page 1 would advance the
// watermark past every unread page and silently skip them forever. This
// test must fail against the unfixed SyncOnce, which never even looks at
// HasMoreUpdatedServerItems.
func TestSyncOnceDrainsAllPagesBeforePersistingWatermark(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var itemCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe != nil {
			// The background recipe-title cache warm-up kicked off by
			// recordSuccess — unrelated to this test.
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		n := atomic.AddInt32(&itemCalls, 1)
		switch n {
		case 1:
			if req.ShoppingListItem.MaxLastModified != epochWatermark {
				t.Errorf("first page watermark = %q, want epoch", req.ShoppingListItem.MaxLastModified)
			}
			_ = json.NewEncoder(w).Encode(SyncResponse{
				ShoppingListItem: &ItemBucketResponse{
					UpdatedServerItems:        []ShoppingListItem{rkItem("srv-1", "Cilantro")},
					HasMoreUpdatedServerItems: true,
					MaxLastModified:           "2026-09-14T00:00:00.0000001Z",
				},
			})
		case 2:
			if req.ShoppingListItem.MaxLastModified != "2026-09-14T00:00:00.0000001Z" {
				t.Errorf("second page did not carry the first page's watermark: got %q", req.ShoppingListItem.MaxLastModified)
			}
			_ = json.NewEncoder(w).Encode(SyncResponse{
				ShoppingListItem: &ItemBucketResponse{
					UpdatedServerItems:        []ShoppingListItem{rkItem("srv-2", "Basil")},
					HasMoreUpdatedServerItems: false,
					MaxLastModified:           "2026-09-14T00:00:01.0000001Z",
				},
			})
		default:
			t.Errorf("unexpected call %d — pagination should have stopped", n)
		}
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if got := atomic.LoadInt32(&itemCalls); got != 2 {
		t.Fatalf("item sync calls = %d, want 2 (pagination not followed)", got)
	}
	if itemByName(t, db, "Cilantro", false) == nil {
		t.Error("page 1's item was not applied")
	}
	if itemByName(t, db, "Basil", false) == nil {
		t.Error("page 2's item was not applied — it would be permanently skipped by the bug this fixes")
	}
	if got := getState(db, stateWatermarkItem, ""); got != "2026-09-14T00:00:01.0000001Z" {
		t.Errorf("watermark = %q, want the FINAL page's MaxLastModified", got)
	}
}

// TestSyncOnceKeepsWatermarkWhenDrainInterrupted proves an error mid-drain
// leaves the persisted watermark exactly where it was, so the next run
// re-reads the pages it never got to. Re-reading is harmless (inbound apply
// is idempotent on unchanged LastModified); advancing the watermark to a
// page it never applied is the data-loss bug.
func TestSyncOnceKeepsWatermarkWhenDrainInterrupted(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var itemCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe != nil {
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		n := atomic.AddInt32(&itemCalls, 1)
		if n == 1 {
			_ = json.NewEncoder(w).Encode(SyncResponse{
				ShoppingListItem: &ItemBucketResponse{
					UpdatedServerItems:        []ShoppingListItem{rkItem("srv-1", "Cilantro")},
					HasMoreUpdatedServerItems: true,
					MaxLastModified:           "2026-09-14T00:00:00.0000001Z",
				},
			})
			return
		}
		// Page 2: the upstream falls over mid-drain.
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	before := getState(db, stateWatermarkItem, epochWatermark)
	if err := svc.SyncOnce(context.Background()); err == nil {
		t.Fatal("want an error from the interrupted drain")
	}
	if got := getState(db, stateWatermarkItem, epochWatermark); got != before {
		t.Errorf("watermark = %q, want unchanged at %q (drain was interrupted before finishing)", got, before)
	}
	// Page 1's item was still applied — re-reading it on the next run is a
	// harmless no-op, unlike losing it would be.
	if itemByName(t, db, "Cilantro", false) == nil {
		t.Error("page 1's item should have been applied even though the drain later failed")
	}
}

// TestSyncOncePushesLocalChangesOnFirstPageOnly proves local changes are
// only sent on the drain's first request. Resending them on later pages
// would have the server re-apply (echo) the same pushed entities.
func TestSyncOncePushesLocalChangesOnFirstPageOnly(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)
	_, _ = rec.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Cilantro")})
	item := itemByName(t, db, "Cilantro", false)
	item.Checked = true
	db.Save(item)
	if err := rec.RetargetLinks("Cilantro", false, "Cilantro", true); err != nil {
		t.Fatalf("RetargetLinks: %v", err)
	}

	var itemCalls int32
	var page1Entities, page2Entities, page1IDs, page2IDs int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe != nil {
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		n := atomic.AddInt32(&itemCalls, 1)
		switch n {
		case 1:
			page1Entities = len(req.ShoppingListItem.SyncEntities)
			page1IDs = len(req.ShoppingListItem.LocalChangesIds)
			_ = json.NewEncoder(w).Encode(SyncResponse{
				ShoppingListItem: &ItemBucketResponse{
					// A page's cursor now advances by its LAST ENTITY's
					// LastModified, so a page claiming more must carry at
					// least one entity or the drain has nothing to advance
					// by.
					UpdatedServerItems:        []ShoppingListItem{rkItem("srv-x", "Ginger")},
					HasMoreUpdatedServerItems: true,
					MaxLastModified:           "2026-09-14T00:00:00.0000001Z",
				},
			})
		case 2:
			page2Entities = len(req.ShoppingListItem.SyncEntities)
			page2IDs = len(req.ShoppingListItem.LocalChangesIds)
			_ = json.NewEncoder(w).Encode(SyncResponse{
				ShoppingListItem: &ItemBucketResponse{
					HasMoreUpdatedServerItems: false,
					MaxLastModified:           "2026-09-14T00:00:01.0000001Z",
				},
			})
		default:
			t.Errorf("unexpected call %d", n)
		}
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if got := atomic.LoadInt32(&itemCalls); got != 2 {
		t.Fatalf("item sync calls = %d, want 2 (drain did not happen)", got)
	}
	if page1Entities != 1 || page1IDs != 1 {
		t.Errorf("page 1 SyncEntities=%d LocalChangesIds=%d, want 1 each", page1Entities, page1IDs)
	}
	if page2Entities != 0 || page2IDs != 0 {
		t.Errorf("page 2 SyncEntities=%d LocalChangesIds=%d, want 0 each — must not re-push", page2Entities, page2IDs)
	}
}

// TestSyncOnceStallGuardTripsWhenWatermarkNeverAdvances mirrors
// SyncRecipes' stall guard: a server that keeps claiming
// HasMoreUpdatedServerItems without the watermark ever advancing must error
// out rather than spin the drain loop forever.
func TestSyncOnceStallGuardTripsWhenWatermarkNeverAdvances(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe != nil {
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		// Always claims more pages but never advances the watermark.
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingListItem: &ItemBucketResponse{
				HasMoreUpdatedServerItems: true,
				MaxLastModified:           epochWatermark,
			},
		})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	err := svc.SyncOnce(context.Background())
	if err == nil {
		t.Fatal("want a stall error")
	}
	if !strings.Contains(err.Error(), "stalled") {
		t.Errorf("err = %v, want a stall-guard error", err)
	}
}

// farFutureMaxLastModified mimics the real server's response shape: every
// page of a drain reports the SAME global "now" value, no matter which page
// of entities it is actually returning. A cursor that (wrongly) advances by
// this value would ask for changes after "now" on the very next request and
// get back an empty page — which is exactly the bug this fix corrects.
const farFutureMaxLastModified = "2099-01-01T00:00:00.0000000Z"

// TestSyncOnceItemBucketAdvancesCursorByLastEntityNotGlobalMax proves the item
// bucket's page cursor is the LAST ENTITY's LastModified, not the response's
// MaxLastModified. The fake server below is keyed on the incoming cursor: it
// only reveals page 2/3 when asked with the correct per-entity cursor, and
// falls back to an (empty, done) page for any other request — exactly what
// the live API does when asked for changes after "now". Against the unfixed
// code (which advances by the constant MaxLastModified), this must fail: it
// would send that same far-future value on request 2, match the fallback
// branch, and stop having applied only page 1.
func TestSyncOnceItemBucketAdvancesCursorByLastEntityNotGlobalMax(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	const t1 = "2026-09-14T00:00:00.0000001Z"
	const t2 = "2026-09-14T00:00:01.0000001Z"
	const t3 = "2026-09-14T00:00:02.0000001Z"

	var itemCalls int32
	var requestedWMs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe != nil {
			// Background recipe-title cache warm-up, unrelated to this test.
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		atomic.AddInt32(&itemCalls, 1)
		got := req.ShoppingListItem.MaxLastModified
		requestedWMs = append(requestedWMs, got)

		var page []ShoppingListItem
		hasMore := true
		switch got {
		case epochWatermark:
			page = []ShoppingListItem{rkItem("srv-1", "Cilantro", func(i *ShoppingListItem) { i.LastModified = ptr(t1) })}
		case t1:
			page = []ShoppingListItem{rkItem("srv-2", "Basil", func(i *ShoppingListItem) { i.LastModified = ptr(t2) })}
		case t2:
			page = []ShoppingListItem{rkItem("srv-3", "Ginger", func(i *ShoppingListItem) { i.LastModified = ptr(t3) })}
			hasMore = false
		default:
			// Any other cursor (in particular, the buggy code's far-future
			// global value) gets treated the way the live API treats a
			// request for changes after "now": nothing more to give.
			hasMore = false
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingListItem: &ItemBucketResponse{
				UpdatedServerItems:        page,
				HasMoreUpdatedServerItems: hasMore,
				MaxLastModified:           farFutureMaxLastModified,
			},
		})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}

	if got := atomic.LoadInt32(&itemCalls); got != 3 {
		t.Fatalf("item sync calls = %d, want 3 (drain must follow the real per-page cursor, not the global MaxLastModified)", got)
	}
	for _, name := range []string{"Cilantro", "Basil", "Ginger"} {
		if itemByName(t, db, name, false) == nil {
			t.Errorf("%s was not applied — its page was never reached", name)
		}
	}

	// Request 2 must carry page 1's LAST ENTITY's LastModified (t1), never
	// the global MaxLastModified the server reported alongside it.
	if len(requestedWMs) < 3 {
		t.Fatalf("requestedWMs = %v, want at least 3 entries", requestedWMs)
	}
	if requestedWMs[1] != t1 {
		t.Errorf("request 2 watermark = %q, want %q (page 1's last entity), not the global MaxLastModified %q", requestedWMs[1], t1, farFutureMaxLastModified)
	}
	if requestedWMs[2] != t2 {
		t.Errorf("request 3 watermark = %q, want %q (page 2's last entity)", requestedWMs[2], t2)
	}

	// The watermark persists only once the drain finishes, and then it is the
	// FINAL response's MaxLastModified (the completed-drain persist path is
	// unchanged by this fix).
	if got := getState(db, stateWatermarkItem, ""); got != farFutureMaxLastModified {
		t.Errorf("persisted watermark = %q, want the final response's MaxLastModified %q", got, farFutureMaxLastModified)
	}
}

// TestSyncOnceItemStallGuardTripsOnLastEntityMatchingCursor proves the stall
// guard compares the newly computed cursor (the page's last entity) against
// the CURRENT cursor, not the global MaxLastModified. A server that reports a
// constantly-advancing global MaxLastModified while its last entity never
// moves past the current cursor is still a stall — and must be caught on the
// very first offending page, not several rounds later (or never, if the
// global value keeps moving).
func TestSyncOnceItemStallGuardTripsOnLastEntityMatchingCursor(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var itemCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe != nil {
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		atomic.AddInt32(&itemCalls, 1)
		// The last (only) entity's LastModified equals the epoch watermark
		// this request was sent with — no real progress — while the global
		// MaxLastModified keeps claiming a far-future "now".
		lm := epochWatermark
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingListItem: &ItemBucketResponse{
				UpdatedServerItems:        []ShoppingListItem{rkItem("srv-1", "Cilantro", func(i *ShoppingListItem) { i.LastModified = ptr(lm) })},
				HasMoreUpdatedServerItems: true,
				MaxLastModified:           farFutureMaxLastModified,
			},
		})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	err := svc.SyncOnce(context.Background())
	if err == nil {
		t.Fatal("want a stall error")
	}
	if !strings.Contains(err.Error(), "stalled") {
		t.Errorf("err = %v, want a stall-guard error", err)
	}
	if got := atomic.LoadInt32(&itemCalls); got != 1 {
		t.Errorf("item sync calls = %d, want 1 — the stall must be caught on the first offending page by comparing against the real cursor, not several rounds later against the ever-advancing global MaxLastModified", got)
	}
}

// TestSyncOnceCategoryBucketAdvancesCursorByLastEntityNotGlobalMax is the
// RawBucket equivalent of the item-bucket test above: category entities
// arrive as json.RawMessage, so the cursor must be read out of the last raw
// entity's own LastModified field rather than the bucket response's global
// MaxLastModified.
func TestSyncOnceCategoryBucketAdvancesCursorByLastEntityNotGlobalMax(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	const t1 = "2026-09-14T00:00:00.0000001Z"
	const t2 = "2026-09-14T00:00:01.0000001Z"

	var catCalls int32
	var requestedWMs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe != nil {
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		atomic.AddInt32(&catCalls, 1)
		got := req.ShoppingListCategory.MaxLastModified
		requestedWMs = append(requestedWMs, got)

		var page []json.RawMessage
		hasMore := true
		switch got {
		case epochWatermark:
			page = []json.RawMessage{json.RawMessage(`{"Id":"cat-1","Name":"Produce","IsDeleted":false,"LastModified":"` + t1 + `"}`)}
		case t1:
			page = []json.RawMessage{json.RawMessage(`{"Id":"cat-2","Name":"Dairy","IsDeleted":false,"LastModified":"` + t2 + `"}`)}
			hasMore = false
		default:
			hasMore = false
		}
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingListCategory: &RawBucketResponse{
				UpdatedServerItems:        page,
				HasMoreUpdatedServerItems: hasMore,
				MaxLastModified:           farFutureMaxLastModified,
			},
		})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if got := atomic.LoadInt32(&catCalls); got != 2 {
		t.Fatalf("category sync calls = %d, want 2 (drain must follow the real per-page cursor, not the global MaxLastModified)", got)
	}
	if len(requestedWMs) < 2 || requestedWMs[1] != t1 {
		t.Errorf("request 2 watermark = %v, want %q (page 1's last raw entity), not the global MaxLastModified %q", requestedWMs, t1, farFutureMaxLastModified)
	}
	if got := getState(db, stateWatermarkCategory, ""); got != farFutureMaxLastModified {
		t.Errorf("persisted category watermark = %q, want the final response's MaxLastModified %q", got, farFutureMaxLastModified)
	}
}

// TestSyncOnceCategoryStallGuardTripsOnLastEntityMatchingCursor mirrors
// TestSyncOnceItemStallGuardTripsOnLastEntityMatchingCursor for the RawBucket
// (category) case: the last raw entity's own LastModified equals the current
// cursor while the global MaxLastModified keeps claiming a far-future "now".
func TestSyncOnceCategoryStallGuardTripsOnLastEntityMatchingCursor(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var catCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Recipe != nil {
			_ = json.NewEncoder(w).Encode(SyncResponse{})
			return
		}
		atomic.AddInt32(&catCalls, 1)
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingListCategory: &RawBucketResponse{
				UpdatedServerItems: []json.RawMessage{
					json.RawMessage(`{"Id":"cat-1","Name":"Produce","IsDeleted":false,"LastModified":"` + epochWatermark + `"}`),
				},
				HasMoreUpdatedServerItems: true,
				MaxLastModified:           farFutureMaxLastModified,
			},
		})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	err := svc.SyncOnce(context.Background())
	if err == nil {
		t.Fatal("want a stall error")
	}
	if !strings.Contains(err.Error(), "stalled") {
		t.Errorf("err = %v, want a stall-guard error", err)
	}
	if got := atomic.LoadInt32(&catCalls); got != 1 {
		t.Errorf("category sync calls = %d, want 1 — the stall must be caught on the first offending page", got)
	}
}

func ptr(s string) *string { return &s }
