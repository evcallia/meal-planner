// backend/internal/recipekeeper/loop_test.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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
func TestTriggerRecipeSyncSkipsWhileInFlight(t *testing.T) {
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

	svc.TriggerRecipeSync() // must be a no-op: the guard is held by the first call

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

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("calls = %d, want 1 (second trigger should have been skipped while the first was in flight)", got)
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
func TestTriggerGrocerySyncSkipsWhileInFlight(t *testing.T) {
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
	// flight — none of these may start a second concurrent sync.
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

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("calls = %d, want 1 (later triggers should have been skipped while the first was in flight)", got)
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
