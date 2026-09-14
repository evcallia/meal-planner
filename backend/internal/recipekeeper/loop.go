// backend/internal/recipekeeper/loop.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/models"
)

const (
	safetyInterval   = 15 * time.Minute
	transientAlertAt = 3
	backoffBase      = 30 * time.Second
	backoffMax       = 30 * time.Minute
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

	failures int

	// recipeSyncMu guards SyncRecipes so only one full Recipe pull is ever in
	// flight. Recipe entities embed base64 photos (~100-300 KB each), so the
	// first pull legitimately runs to hundreds of MB — piling up concurrent
	// pulls would be wasteful at best and a memory problem at worst.
	recipeSyncMu sync.Mutex
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
		return err
	}
	ch, err := s.Rec.ApplyInbound(bucket.UpdatedServerItems)
	if err != nil {
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
// Callers needing this in the background (startup, after a grocery sync) must
// go through TriggerRecipeSync rather than calling this directly, so only one
// pull is ever in flight.
func (s *Service) SyncRecipes(ctx context.Context) error {
	wm := getState(s.DB, stateWatermarkRecipe, epochWatermark)
	for {
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
		if bucket.MaxLastModified != "" {
			wm = bucket.MaxLastModified
			setState(s.DB, stateWatermarkRecipe, wm)
		}
		if !bucket.HasMoreUpdatedServerItems {
			return nil
		}
	}
}

// TriggerRecipeSync kicks off a recipe-title cache refresh in the background.
// It is a no-op when a sync is already in flight — the mutex is held for the
// life of the goroutine, so a burst of triggers (startup racing the first
// SyncOnce, then every subsequent SyncOnce) collapses to one running pull at
// a time. It deliberately does NOT take the caller's context: the first pull
// can run for minutes and must outlive a single request (e.g. the POST
// /api/recipe-keeper/sync handler's context, which is canceled the instant
// that handler returns).
func (s *Service) TriggerRecipeSync() {
	if !s.recipeSyncMu.TryLock() {
		return
	}
	go func() {
		defer s.recipeSyncMu.Unlock()
		if err := s.SyncRecipes(context.Background()); err != nil {
			log.Printf("recipekeeper: recipe sync failed: %v", err)
		}
	}()
}

func (s *Service) recordSuccess() {
	s.failures = 0
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
// does not raise an alert that trains the user to ignore it.
func (s *Service) recordError(err error) {
	s.failures++
	if IsAuthError(err) {
		setState(s.DB, stateAuthFailed, "true")
		setState(s.DB, stateLastError, "Recipe Keeper sign-in failed — check RECIPE_KEEPER_PASSWORD")
		log.Printf("recipekeeper: auth failure: %v", err)
		return
	}
	log.Printf("recipekeeper: sync failed (%d consecutive): %v", s.failures, err)
	if s.failures >= transientAlertAt {
		setState(s.DB, stateLastError, "Can't reach Recipe Keeper")
	}
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
	// Kick off the recipe-title cache warm-up in parallel — it must never
	// block the first grocery sync below, which is why it runs detached.
	s.TriggerRecipeSync()

	if err := s.SyncOnce(ctx); err != nil {
		log.Printf("recipekeeper: initial sync: %v", err)
	}
	safety := time.NewTicker(safetyInterval)
	defer safety.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-safety.C:
			_ = s.SyncOnce(ctx)
		default:
		}

		changed, err := s.Client.Notify(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.recordError(err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.backoff()):
			}
			continue
		}
		if changed {
			_ = s.SyncOnce(ctx)
		}
	}
}

func (s *Service) backoff() time.Duration {
	d := backoffBase << min(s.failures, 6)
	if d > backoffMax {
		return backoffMax
	}
	return d
}
