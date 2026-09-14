// backend/internal/recipekeeper/loop.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/models"
)

const (
	safetyInterval = 15 * time.Minute
	backoffBase    = 30 * time.Second
	backoffMax     = 30 * time.Minute

	// transientAlertAt is how many consecutive NON-auth failures must happen
	// before the bell surfaces "Can't reach Recipe Keeper" — a blip shouldn't
	// alert, a pattern should.
	transientAlertAt = 3

	// authDisableAt is how many consecutive auth failures latch the poll loop
	// off entirely. Bad credentials never self-heal, so retrying them forever
	// (even on a slow backoff) is a loop that keeps trying a wrong password
	// against someone else's infrastructure — the exact thing that trips
	// account lockout. A successful manual sync or a process restart clears
	// the latch.
	authDisableAt = 3

	// minPollInterval floors the time between Notify iterations. Client.Notify
	// normally blocks for up to ~90s (the long-poll hold), but if the server
	// (or a misconfigured proxy in front of it) ever answers instantly, this
	// stops Run from spinning in a hot loop.
	minPollInterval = 1 * time.Second

	// maxRecipeSyncPages bounds SyncRecipes: a server that keeps claiming
	// HasMoreUpdatedServerItems without the watermark ever advancing must not
	// be allowed to spin this loop forever.
	maxRecipeSyncPages = 1000
)

type Status struct {
	Enabled    bool       `json:"enabled"`
	LastSync   *time.Time `json:"last_sync"`
	LastError  string     `json:"last_error"`
	AuthFailed bool       `json:"auth_failed"`
}

// Service drives the sync. OnChange is called after any inbound change so the
// caller can broadcast SSE; it is nil in tests.
type Service struct {
	Client   *Client
	Rec      *Reconciler
	DB       *gorm.DB
	OnChange func(Changes)

	// mu guards every field below. Task 9 adds POST /api/recipe-keeper/sync,
	// which calls SyncOnce concurrently with the background Run loop, so
	// these can no longer be plain unsynchronized ints/bools.
	mu           sync.Mutex
	failures     int  // consecutive failures of ANY kind; drives backoff
	authFailures int  // consecutive AUTH failures specifically; drives the latch
	stopped      bool // true once the auth latch has tripped — Run must stop

	// recipeSyncMu guards SyncRecipes so only one full Recipe pull is ever in
	// flight. Recipe entities embed base64 photos (~100-300 KB each), so the
	// first pull legitimately runs to hundreds of MB — piling up concurrent
	// pulls would be wasteful at best and a memory problem at worst.
	recipeSyncMu sync.Mutex

	// grocerySyncMu guards TriggerGrocerySync the same way: a burst of
	// grocery mutations (e.g. ten quick check-offs) must collapse into one
	// in-flight reconcile, not N concurrent SyncOnce calls each reading the
	// same PendingPushes and pushing the same entity ids — the production
	// echo-loop symptom the plan's verification step warns about, and a race
	// on the watermark write besides.
	grocerySyncMu sync.Mutex

	// bgCtx is the context background recipe pulls run under. Run sets it to
	// its own ctx (so shutdown cancels an in-progress pull); until Run has
	// been called, TriggerRecipeSync falls back to context.Background(). It
	// deliberately does NOT use a caller's per-call context (e.g. the POST
	// /api/recipe-keeper/sync handler's r.Context()) — that context is
	// canceled the instant the handler returns, which would kill an
	// in-progress hundred-MB pull started from inside it.
	bgCtx context.Context
}

// SyncOnce performs one pull/apply/push cycle: shopping-list items (the only
// bucket this integration ever pushes to) plus the two category buckets that
// feed initial section placement for newly-imported items. The Recipe bucket
// is NOT pulled here — see SyncRecipes — because it can run to hundreds of
// megabytes and must never sit on the critical path of a grocery sync.
func (s *Service) SyncOnce(ctx context.Context) error {
	wm := getState(s.DB, stateWatermarkItem, epochWatermark)
	wmCat := getState(s.DB, stateWatermarkCategory, epochWatermark)
	wmCatItem := getState(s.DB, stateWatermarkCatItem, epochWatermark)

	pushes, err := s.Rec.PendingPushes()
	if err != nil {
		s.recordError(err)
		return err
	}
	ids := make([]string, 0, len(pushes))
	for _, p := range pushes {
		ids = append(ids, p.ID)
	}

	resp, err := s.Client.Sync(ctx, SyncRequest{
		ShoppingListItem: &ItemBucket{
			MaxLastModified: wm,
			SyncEntities:    pushes,
			LocalChangesIds: ids,
		},
		ShoppingListCategory: &RawBucket{
			MaxLastModified: wmCat,
			SyncEntities:    []json.RawMessage{},
			LocalChangesIds: []string{},
		},
		ShoppingListCategoryItem: &RawBucket{
			MaxLastModified: wmCatItem,
			SyncEntities:    []json.RawMessage{},
			LocalChangesIds: []string{},
		},
	})
	if err != nil {
		s.recordError(err)
		return err
	}

	// Categories are small (unlike Recipe) so they ride along on every pass.
	// Feed both bucket responses to StoreCategories together — it joins them
	// by id — then persist each bucket's own watermark independently.
	var cats, catItems []json.RawMessage
	if catsResp := resp.ShoppingListCategory; catsResp != nil {
		cats = catsResp.UpdatedServerItems
	}
	if catItemsResp := resp.ShoppingListCategoryItem; catItemsResp != nil {
		catItems = catItemsResp.UpdatedServerItems
	}
	if err := s.Rec.StoreCategories(cats, catItems); err != nil {
		s.recordError(err)
		return err
	}
	if catsResp := resp.ShoppingListCategory; catsResp != nil && catsResp.MaxLastModified != "" {
		setState(s.DB, stateWatermarkCategory, catsResp.MaxLastModified)
	}
	if catItemsResp := resp.ShoppingListCategoryItem; catItemsResp != nil && catItemsResp.MaxLastModified != "" {
		setState(s.DB, stateWatermarkCatItem, catItemsResp.MaxLastModified)
	}

	bucket := resp.ShoppingListItem
	if bucket == nil {
		s.recordSuccess()
		return nil
	}
	if err := s.Rec.ApplyAcks(bucket.UpdatedLocalItems); err != nil {
		s.recordError(err)
		return err
	}
	ch, err := s.Rec.ApplyInbound(bucket.UpdatedServerItems)
	if err != nil {
		s.recordError(err)
		return err
	}
	if bucket.MaxLastModified != "" {
		setState(s.DB, stateWatermarkItem, bucket.MaxLastModified)
	}
	s.recordSuccess()
	if ch.Any() && s.OnChange != nil {
		s.OnChange(ch)
	}
	return nil
}

// SyncRecipes pulls the Recipe bucket and feeds it to the title cache,
// following HasMoreUpdatedServerItems until the server reports no more pages.
// Bounded by maxRecipeSyncPages and by the watermark actually advancing on
// every page that claims more are coming — see the constants' doc comments.
// Callers needing this in the background (startup, after a grocery sync) must
// go through TriggerRecipeSync rather than calling this directly, so only one
// pull is ever in flight.
func (s *Service) SyncRecipes(ctx context.Context) error {
	wm := getState(s.DB, stateWatermarkRecipe, epochWatermark)
	for page := 0; page < maxRecipeSyncPages; page++ {
		resp, err := s.Client.Sync(ctx, SyncRequest{
			Recipe: &RawBucket{
				MaxLastModified: wm,
				SyncEntities:    []json.RawMessage{},
				LocalChangesIds: []string{},
			},
		})
		if err != nil {
			return err
		}
		bucket := resp.Recipe
		if bucket == nil {
			return nil
		}
		if err := s.Rec.StoreRecipes(bucket.UpdatedServerItems); err != nil {
			return err
		}
		if !bucket.HasMoreUpdatedServerItems {
			if bucket.MaxLastModified != "" {
				setState(s.DB, stateWatermarkRecipe, bucket.MaxLastModified)
			}
			return nil
		}
		// The server claims more pages exist; the watermark must actually
		// advance, or the next iteration would just re-request this same
		// page forever.
		if bucket.MaxLastModified == "" || bucket.MaxLastModified == wm {
			return fmt.Errorf("recipekeeper: recipe sync stalled at watermark %q (HasMoreUpdatedServerItems but MaxLastModified did not advance)", wm)
		}
		wm = bucket.MaxLastModified
		setState(s.DB, stateWatermarkRecipe, wm)
	}
	return fmt.Errorf("recipekeeper: recipe sync aborted after %d pages without finishing", maxRecipeSyncPages)
}

// TriggerRecipeSync kicks off a recipe-title cache refresh in the background.
// It is a no-op when a sync is already in flight — the mutex is held for the
// life of the goroutine, so a burst of triggers (startup racing the first
// SyncOnce, then every subsequent SyncOnce) collapses to one running pull at
// a time.
func (s *Service) TriggerRecipeSync() {
	if !s.recipeSyncMu.TryLock() {
		return
	}
	ctx := s.backgroundContext()
	go func() {
		defer s.recipeSyncMu.Unlock()
		if err := s.SyncRecipes(ctx); err != nil {
			// Route through recordError like any other sync failure — an
			// auth failure during a recipe pull is exactly as real (and as
			// worth latching off) as one during a grocery pull, and a
			// transient one should count toward the same backoff/alert
			// bookkeeping rather than being log-only.
			s.recordError(err)
		}
	}()
}

// TriggerGrocerySync kicks an out-of-band SyncOnce after a local grocery
// mutation touched Recipe Keeper links, so the resulting push goes out
// within seconds instead of waiting for the safety timer. It no-ops —
// rather than piling up a concurrent sync — when one is already in flight,
// and it never even starts once the auth-failure latch has tripped:
// retrying a rejected password on every grocery edit is the exact
// account-lockout risk that latch exists to prevent. Bounded to 30s so a
// slow or hung upstream can't accumulate goroutines indefinitely.
func (s *Service) TriggerGrocerySync() {
	if s.isStopped() {
		return
	}
	if !s.grocerySyncMu.TryLock() {
		return
	}
	parent := s.backgroundContext()
	go func() {
		defer s.grocerySyncMu.Unlock()
		ctx, cancel := context.WithTimeout(parent, 30*time.Second)
		defer cancel()
		_ = s.SyncOnce(ctx)
	}()
}

// backgroundContext returns the context a detached recipe pull should run
// under: the Run loop's own ctx once Run has started (so shutdown cancels an
// in-progress pull), or a bare Background() before that.
func (s *Service) backgroundContext() context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bgCtx != nil {
		return s.bgCtx
	}
	return context.Background()
}

func (s *Service) recordSuccess() {
	s.mu.Lock()
	s.failures = 0
	s.authFailures = 0
	s.stopped = false
	s.mu.Unlock()

	setState(s.DB, stateLastSync, models.NowUTC().Format(time.RFC3339))
	setState(s.DB, stateLastError, "")
	setState(s.DB, stateAuthFailed, "false")
	// Once the item bucket is caught up, opportunistically top up the recipe
	// title cache too. TriggerRecipeSync no-ops if one is already running, and
	// once the cache is warm the watermark makes each of these calls trivial.
	s.TriggerRecipeSync()
}

// recordError surfaces auth failures immediately — they never self-heal — but
// holds transient failures back until they have repeated, so a momentary blip
// does not raise an alert that trains the user to ignore it. Auth failures
// additionally latch the poll loop off entirely after authDisableAt in a row
// (see that constant's doc comment); Run checks the latch and stops.
func (s *Service) recordError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.failures++
	if IsAuthError(err) {
		s.authFailures++
		setState(s.DB, stateAuthFailed, "true")
		if s.authFailures >= authDisableAt {
			s.stopped = true
			setState(s.DB, stateLastError,
				"Recipe Keeper sign-in failed repeatedly — sync disabled until RECIPE_KEEPER_USERNAME/RECIPE_KEEPER_PASSWORD are fixed (restart, or a manual sync, to retry)")
			log.Printf("recipekeeper: %d consecutive auth failures, disabling sync until credentials are fixed or the process restarts: %v", s.authFailures, err)
			return
		}
		setState(s.DB, stateLastError, "Recipe Keeper sign-in failed — check RECIPE_KEEPER_PASSWORD")
		log.Printf("recipekeeper: auth failure (%d consecutive): %v", s.authFailures, err)
		return
	}

	s.authFailures = 0
	log.Printf("recipekeeper: sync failed (%d consecutive): %v", s.failures, err)
	if s.failures >= transientAlertAt {
		setState(s.DB, stateLastError, "Can't reach Recipe Keeper")
	}
}

// isStopped reports whether the auth-failure latch has tripped.
func (s *Service) isStopped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopped
}

func (s *Service) Status() Status {
	st := Status{
		Enabled:    true,
		LastError:  getState(s.DB, stateLastError, ""),
		AuthFailed: getState(s.DB, stateAuthFailed, "false") == "true",
	}
	if v := getState(s.DB, stateLastSync, ""); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			st.LastSync = &t
		}
	}
	return st
}

// Run drives the long-poll doorbell until ctx is cancelled. A 200 means
// something changed; a 201 means the poll simply expired. A safety timer covers
// anything missed while the process was down.
func (s *Service) Run(ctx context.Context) {
	s.mu.Lock()
	s.bgCtx = ctx
	s.mu.Unlock()

	// Kick off the recipe-title cache warm-up in parallel — it must never
	// block the first grocery sync below, which is why it runs detached.
	s.TriggerRecipeSync()

	if err := s.SyncOnce(ctx); err != nil {
		log.Printf("recipekeeper: initial sync: %v", err)
	}
	if s.isStopped() {
		log.Printf("recipekeeper: sync disabled after repeated auth failures; fix credentials and restart, or trigger a manual sync, to resume")
		return
	}

	safety := time.NewTicker(safetyInterval)
	defer safety.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-safety.C:
			_ = s.SyncOnce(ctx)
			if s.isStopped() {
				log.Printf("recipekeeper: sync disabled after repeated auth failures; fix credentials and restart, or trigger a manual sync, to resume")
				return
			}
		default:
		}

		pollStart := time.Now()
		changed, err := s.Client.Notify(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.recordError(err)
			if s.isStopped() {
				log.Printf("recipekeeper: sync disabled after repeated auth failures; fix credentials and restart, or trigger a manual sync, to resume")
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.backoff()):
			}
			continue
		}
		if changed {
			_ = s.SyncOnce(ctx)
			if s.isStopped() {
				log.Printf("recipekeeper: sync disabled after repeated auth failures; fix credentials and restart, or trigger a manual sync, to resume")
				return
			}
		}

		// Floor the loop period so a server (or proxy) that ever answers
		// Notify instantly cannot spin this into a hot loop.
		if elapsed := time.Since(pollStart); elapsed < minPollInterval {
			select {
			case <-ctx.Done():
				return
			case <-time.After(minPollInterval - elapsed):
			}
		}
	}
}

func (s *Service) backoff() time.Duration {
	s.mu.Lock()
	f := s.failures
	s.mu.Unlock()
	d := backoffBase << min(f, 6)
	if d > backoffMax {
		return backoffMax
	}
	return d
}
