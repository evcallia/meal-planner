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

	// defaultPollSeconds is RECIPE_KEEPER_POLL_SECONDS' default: the cadence
	// Run polls at while at least one client is connected (Service.PollInterval;
	// see Run and Service.SubscriberCount). Sync is entirely poll-driven — the
	// vendor's long-poll change notification never returns "something
	// changed" for this client even when the server-side data genuinely did
	// (see docs/recipe-keeper-api.md for the removed doorbell integration and
	// why), so it was implemented and then removed. A cheap delta once the
	// watermark is warm was measured sub-second, so polling this often while
	// someone's actually watching is reasonable.
	defaultPollSeconds = 60
	// minPollSeconds floors RECIPE_KEEPER_POLL_SECONDS: polling faster than
	// this is not "cheap delta" territory any more, it's hammering a third
	// party's live API. ResolvePollInterval clamps to this and logs when it
	// does.
	minPollSeconds = 30

	// idlePollSeconds is RECIPE_KEEPER_IDLE_POLL_SECONDS' default and the
	// cadence Run falls back to once the last SSE client disconnects (or
	// while none has ever connected): a household with the app closed on
	// every device doesn't need minute-level freshness, and polling a third
	// party's live API every 30 minutes instead of every minute is a real
	// reduction in unnecessary traffic.
	idlePollSeconds = 30 * 60

	// grocerySyncTimeout bounds TriggerGrocerySync's SyncOnce call. Must
	// comfortably exceed a real full drain — measured live at 14s for the
	// first one — so it is a backstop against a hung connection, never a
	// limit on normal work; a cancelled drain makes no progress at all,
	// because the watermark is only persisted once a drain completes.
	grocerySyncTimeout = 5 * time.Minute
	// recipeSyncTimeout bounds TriggerRecipeSync's SyncRecipes call. Recipe
	// entities embed base64 photos, so a cold pull runs to hundreds of MB —
	// far longer than a grocery drain — hence the much larger backstop.
	recipeSyncTimeout = 30 * time.Minute

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

	// maxRecipeSyncPages bounds SyncRecipes: a server that keeps claiming
	// HasMoreUpdatedServerItems without the watermark ever advancing must not
	// be allowed to spin this loop forever.
	maxRecipeSyncPages = 1000

	// maxItemSyncPages bounds SyncOnce's drain loop over the item and
	// category buckets, mirroring maxRecipeSyncPages: a server that keeps
	// claiming HasMoreUpdatedServerItems for any of them without that
	// bucket's watermark ever advancing must not be allowed to spin this
	// loop forever.
	maxItemSyncPages = 1000
)

// ResolvePollInterval converts RECIPE_KEEPER_POLL_SECONDS into the Duration
// Service.PollInterval expects: zero/negative falls back to
// defaultPollSeconds, and anything below minPollSeconds is clamped up to it
// (logged, since a misconfigured value silently hammering the vendor API
// would otherwise be invisible).
func ResolvePollInterval(seconds int) time.Duration {
	if seconds <= 0 {
		seconds = defaultPollSeconds
	} else if seconds < minPollSeconds {
		log.Printf("recipekeeper: RECIPE_KEEPER_POLL_SECONDS=%d is below the %ds floor, clamping to %ds", seconds, minPollSeconds, minPollSeconds)
		seconds = minPollSeconds
	}
	return time.Duration(seconds) * time.Second
}

// ResolveIdlePollInterval converts RECIPE_KEEPER_IDLE_POLL_SECONDS into the
// Duration Service.IdlePollInterval expects: zero/negative falls back to
// idlePollSeconds. No floor beyond that — an operator deliberately setting
// idle polling faster than the connected cadence is a narrower footgun than
// the connected-cadence floor guards against (nobody's even watching), so
// it isn't clamped.
func ResolveIdlePollInterval(seconds int) time.Duration {
	if seconds <= 0 {
		seconds = idlePollSeconds
	}
	return time.Duration(seconds) * time.Second
}

type Status struct {
	Enabled    bool       `json:"enabled"`
	LastSync   *time.Time `json:"last_sync"`
	LastError  string     `json:"last_error"`
	AuthFailed bool       `json:"auth_failed"`
	// SelectedListID/SelectedListName describe the household's chosen Recipe
	// Keeper shopping list (see state.go); both are "" until one is chosen
	// via PUT /api/recipe-keeper/list. The name is cached at selection time
	// so the UI can show "Groceries" rather than a GUID.
	SelectedListID   string `json:"selected_list_id"`
	SelectedListName string `json:"selected_list_name"`
	// Paused mirrors the household-global pause switch (see
	// stateSyncPaused): while true, SyncOnce/SyncRecipes and the triggers
	// that would call them are all no-ops, in both directions.
	Paused bool `json:"paused"`
}

// Service drives the sync. OnChange is called after any inbound change so the
// caller can broadcast SSE; it is nil in tests.
type Service struct {
	Client   *Client
	Rec      *Reconciler
	DB       *gorm.DB
	OnChange func(Changes)

	// PollInterval is how often Run polls (calls TriggerGrocerySync) while at
	// least one SSE client is connected — the fast, "someone's watching"
	// cadence. Zero means defaultPollSeconds; production wiring goes through
	// ResolvePollInterval so this is always already clamped/defaulted by the
	// time Run sees it. Tests set it directly to a short duration to exercise
	// periodic polling without a real 60s wait.
	PollInterval time.Duration

	// IdlePollInterval is how often Run polls while NO SSE client is
	// connected (including before the first one ever connects). Zero means
	// idlePollSeconds; production wiring goes through ResolveIdlePollInterval.
	IdlePollInterval time.Duration

	// SubscriberCount, if set, reports how many SSE clients are currently
	// connected — Run uses zero vs. nonzero to choose between IdlePollInterval
	// and PollInterval on each tick. nil (tests that don't care, or before
	// main.go wires it) is treated as "always disconnected", i.e. the idle
	// cadence. Production wiring is realtime.Broadcaster.Count — a plain func
	// field rather than an import so this package doesn't need to know about
	// realtime.Broadcaster's type, only that something can count subscribers.
	SubscriberCount func() int

	// Connected, if set, receives a value every time the SSE subscriber count
	// transitions from 0 to 1 (see realtime.Broadcaster.Connected, which
	// production wiring assigns here directly — the channel type alone is
	// enough coupling, no import needed). Run selects on it to fire an
	// immediate sync the moment a client connects, rather than waiting up to
	// IdlePollInterval for the next tick. nil is fine: connects are then only
	// noticed on the next tick, which still self-corrects to PollInterval.
	Connected <-chan struct{}

	// mu guards every field below. Task 9 adds POST /api/recipe-keeper/sync,
	// which calls SyncOnce concurrently with the background Run loop, so
	// these can no longer be plain unsynchronized ints/bools.
	mu           sync.Mutex
	failures     int  // consecutive failures of ANY kind; drives the transientAlertAt threshold
	authFailures int  // consecutive AUTH failures specifically; drives the latch
	stopped      bool // true once the auth latch has tripped — Run must stop

	// grocerySyncPending/recipeSyncPending coalesce a kick that arrives
	// while that sync is already in flight: TriggerGrocerySync/
	// TriggerRecipeSync set the flag instead of dropping the kick, and the
	// in-flight goroutine loops once more after finishing if the flag got
	// set — collapsing any number of kicks arriving mid-sync into exactly
	// one extra run, never zero (the old drop-on-busy bug) and never one
	// per kick.
	grocerySyncPending bool
	recipeSyncPending  bool

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

	// noListLogged guards the "no shopping list selected" log line to once
	// per transition into that state, rather than once per sync cycle (the
	// safety ticker alone would otherwise repeat it every 15 minutes
	// forever).
	noListLogged bool

	// pauseLogged mirrors noListLogged for the pause switch: logged once per
	// transition into the paused state, not once per skipped cycle.
	pauseLogged bool
}

// lastItemLastModified returns the LastModified of the LAST entity in a page
// of ShoppingListItem results, used to advance that bucket's page cursor.
// Must never be confused with a response's MaxLastModified — see the comment
// where this is called.
func lastItemLastModified(items []ShoppingListItem) (string, bool) {
	if len(items) == 0 {
		return "", false
	}
	last := items[len(items)-1]
	if last.LastModified == nil || *last.LastModified == "" {
		return "", false
	}
	return *last.LastModified, true
}

// lastRawLastModified returns the LastModified of the LAST entity in a page
// of raw (unmodeled) bucket results, used to advance that bucket's page
// cursor. Must never be confused with a response's MaxLastModified — see the
// comment where this is called.
func lastRawLastModified(items []json.RawMessage) (string, bool) {
	if len(items) == 0 {
		return "", false
	}
	var entity struct {
		LastModified string `json:"LastModified"`
	}
	if err := json.Unmarshal(items[len(items)-1], &entity); err != nil || entity.LastModified == "" {
		return "", false
	}
	return entity.LastModified, true
}

// SyncOnce performs one pull/apply/push cycle: shopping-list items (the only
// bucket this integration ever pushes to) plus the two category buckets that
// feed initial section placement for newly-imported items. The Recipe bucket
// is NOT pulled here — see SyncRecipes — because it can run to hundreds of
// megabytes and must never sit on the critical path of a grocery sync.
//
// It refreshes the Reconciler's list id from recipe_keeper_state (the
// persisted, authoritative selection — see state.go) at the start of every
// cycle, so a selection made via PUT /api/recipe-keeper/list takes effect on
// the next cycle without a restart. If no list is selected yet, the ENTIRE
// cycle is skipped, both directions: entityFor would otherwise build push
// entities carrying an empty ShoppingListId, which is not "sync nothing" —
// it is sending a malformed entity to a third party's live API. Skipping is
// silent after the first transition (noListLogged) rather than repeating a
// log line on every safety-timer tick.
//
// Each of the three buckets in play (item, category, category-item) is
// drained independently: the loop keeps requesting further pages for any
// bucket still reporting HasMoreUpdatedServerItems, applying each page as it
// arrives, until all three are done or maxItemSyncPages is hit. Local
// changes (SyncEntities/LocalChangesIds) are only sent on the first request
// of the drain — resending them on later pages would re-push the same
// entities. See the comment above the item-bucket persist below for why a
// bucket's watermark is only written to the DB once THAT bucket has
// finished draining.
func (s *Service) SyncOnce(ctx context.Context) error {
	// The pause switch is checked FIRST, before any watermark or list-id
	// read: pausing must never advance a watermark, even by a no-op read
	// that happens to fall in the same code path. A resumed sync starts
	// from exactly where it left off, and any local pushes/tombstones made
	// while paused are picked up by the very next (post-resume) SyncOnce —
	// see PendingPushes, which derives pending work from current DB state
	// rather than a queue, so nothing here needs to remember what happened
	// while paused.
	if IsPaused(s.DB) {
		s.mu.Lock()
		if !s.pauseLogged {
			s.pauseLogged = true
			log.Printf("recipekeeper: sync is paused — skipping until resumed (PUT /api/recipe-keeper/paused or the Settings toggle)")
		}
		s.mu.Unlock()
		return nil
	}
	s.mu.Lock()
	s.pauseLogged = false
	s.mu.Unlock()

	listID := SelectedListID(s.DB)
	s.Rec.SetListID(listID)
	if listID == "" {
		s.mu.Lock()
		if !s.noListLogged {
			s.noListLogged = true
			log.Printf("recipekeeper: no shopping list selected yet — skipping sync until one is chosen (GET /api/recipe-keeper/lists, then PUT /api/recipe-keeper/list)")
		}
		s.mu.Unlock()
		return nil
	}
	s.mu.Lock()
	s.noListLogged = false
	s.mu.Unlock()

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

	var changes Changes
	itemDone, catDone, catItemDone := false, false, false

	for page := 0; page < maxItemSyncPages; page++ {
		// Local changes are only meaningful on the first request of the
		// drain — every later page is a pure pull, or the server would see
		// the same pushed entities resubmitted on every page.
		itemEntities := []ShoppingListItem{}
		itemIDs := []string{}
		if page == 0 {
			itemEntities = pushes
			itemIDs = ids
		}

		resp, err := s.Client.Sync(ctx, SyncRequest{
			ShoppingListItem: &ItemBucket{
				MaxLastModified: wm,
				SyncEntities:    itemEntities,
				LocalChangesIds: itemIDs,
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

		// Categories are small (unlike Recipe) so they ride along on every
		// pass. Feed both bucket responses to StoreCategories together — it
		// joins them by id — then persist each bucket's own watermark
		// independently, once THAT bucket has finished draining (see the
		// item-bucket comment below for why persisting early is unsafe).
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

		if !catDone {
			catsResp := resp.ShoppingListCategory
			switch {
			case catsResp == nil:
				catDone = true
			case !catsResp.HasMoreUpdatedServerItems:
				if catsResp.MaxLastModified != "" {
					setState(s.DB, stateWatermarkCategory, catsResp.MaxLastModified)
				}
				catDone = true
			default:
				// Advance by the LAST ENTITY's LastModified, never by MaxLastModified:
				// the server returns MaxLastModified as its GLOBAL newest change ("now"),
				// so using it as a cursor asks for changes after now, gets an empty page,
				// and silently ends the drain after page 1. Verified live: correct
				// cursoring yields 3 pages / 22.8k entities where this yielded 1.
				next, ok := lastRawLastModified(catsResp.UpdatedServerItems)
				if !ok || next == wmCat {
					err := fmt.Errorf("recipekeeper: category sync stalled at watermark %q (HasMoreUpdatedServerItems but next cursor did not advance)", wmCat)
					s.recordError(err)
					return err
				}
				wmCat = next
			}
		}

		if !catItemDone {
			catItemsResp := resp.ShoppingListCategoryItem
			switch {
			case catItemsResp == nil:
				catItemDone = true
			case !catItemsResp.HasMoreUpdatedServerItems:
				if catItemsResp.MaxLastModified != "" {
					setState(s.DB, stateWatermarkCatItem, catItemsResp.MaxLastModified)
				}
				catItemDone = true
			default:
				// Advance by the LAST ENTITY's LastModified, never by MaxLastModified:
				// the server returns MaxLastModified as its GLOBAL newest change ("now"),
				// so using it as a cursor asks for changes after now, gets an empty page,
				// and silently ends the drain after page 1. Verified live: correct
				// cursoring yields 3 pages / 22.8k entities where this yielded 1.
				next, ok := lastRawLastModified(catItemsResp.UpdatedServerItems)
				if !ok || next == wmCatItem {
					err := fmt.Errorf("recipekeeper: category-item sync stalled at watermark %q (HasMoreUpdatedServerItems but next cursor did not advance)", wmCatItem)
					s.recordError(err)
					return err
				}
				wmCatItem = next
			}
		}

		if !itemDone {
			bucket := resp.ShoppingListItem
			if bucket == nil {
				itemDone = true
			} else {
				if err := s.Rec.ApplyAcks(bucket.UpdatedLocalItems); err != nil {
					s.recordError(err)
					return err
				}
				ch, err := s.Rec.ApplyInbound(bucket.UpdatedServerItems)
				if err != nil {
					s.recordError(err)
					return err
				}
				changes.Added = append(changes.Added, ch.Added...)
				changes.Updated = append(changes.Updated, ch.Updated...)
				changes.Deleted = append(changes.Deleted, ch.Deleted...)

				if !bucket.HasMoreUpdatedServerItems {
					// The server caps a page at ~10k entities and returns a GLOBAL
					// MaxLastModified ("now"), not the page's last entity. Persisting it
					// before draining HasMoreUpdatedServerItems would advance the watermark
					// past every unread page and skip those entities permanently. Verified
					// against the live API.
					if bucket.MaxLastModified != "" {
						setState(s.DB, stateWatermarkItem, bucket.MaxLastModified)
					}
					itemDone = true
				} else {
					// Advance by the LAST ENTITY's LastModified, never by MaxLastModified:
					// the server returns MaxLastModified as its GLOBAL newest change ("now"),
					// so using it as a cursor asks for changes after now, gets an empty page,
					// and silently ends the drain after page 1. Verified live: correct
					// cursoring yields 3 pages / 22.8k entities where this yielded 1.
					next, ok := lastItemLastModified(bucket.UpdatedServerItems)
					if !ok || next == wm {
						err := fmt.Errorf("recipekeeper: item sync stalled at watermark %q (HasMoreUpdatedServerItems but next cursor did not advance)", wm)
						s.recordError(err)
						return err
					}
					wm = next
				}
			}
		}

		if itemDone && catDone && catItemDone {
			s.recordSuccess()
			if changes.Any() && s.OnChange != nil {
				s.OnChange(changes)
			}
			return nil
		}
	}

	err = fmt.Errorf("recipekeeper: sync aborted after %d pages without finishing", maxItemSyncPages)
	s.recordError(err)
	return err
}

// SyncRecipes pulls the Recipe bucket and feeds it to the title cache,
// following HasMoreUpdatedServerItems until the server reports no more pages.
// Bounded by maxRecipeSyncPages and by the watermark actually advancing on
// every page that claims more are coming — see the constants' doc comments.
// Callers needing this in the background (startup, after a grocery sync) must
// go through TriggerRecipeSync rather than calling this directly, so only one
// pull is ever in flight.
func (s *Service) SyncRecipes(ctx context.Context) error {
	// Mirrors SyncOnce's pause guard (see its comment) — checked before the
	// watermark is even read, so pausing can never advance it.
	if IsPaused(s.DB) {
		return nil
	}
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
		// Advance by the LAST ENTITY's LastModified, never by MaxLastModified:
		// the server returns MaxLastModified as its GLOBAL newest change ("now"),
		// so using it as a cursor asks for changes after now, gets an empty page,
		// and silently ends the drain after page 1. Verified live: correct
		// cursoring yields 3 pages / 22.8k entities where this yielded 1.
		next, ok := lastRawLastModified(bucket.UpdatedServerItems)
		if !ok || next == wm {
			return fmt.Errorf("recipekeeper: recipe sync stalled at watermark %q (HasMoreUpdatedServerItems but next cursor did not advance)", wm)
		}
		wm = next
		setState(s.DB, stateWatermarkRecipe, wm)
	}
	return fmt.Errorf("recipekeeper: recipe sync aborted after %d pages without finishing", maxRecipeSyncPages)
}

// TriggerRecipeSync kicks off a recipe-title cache refresh in the background.
// When a pull is already in flight, it coalesces rather than dropping: it
// sets recipeSyncPending and returns, and the in-flight goroutine notices
// the flag once it finishes and runs exactly one more pull before releasing
// the mutex — so a burst of triggers (startup racing the first SyncOnce,
// then every subsequent SyncOnce) collapses to at most one extra run, never
// zero and never one per trigger.
func (s *Service) TriggerRecipeSync() {
	if IsPaused(s.DB) {
		return
	}
	if !s.recipeSyncMu.TryLock() {
		s.mu.Lock()
		s.recipeSyncPending = true
		s.mu.Unlock()
		return
	}
	parent := s.backgroundContext()
	go func() {
		defer s.recipeSyncMu.Unlock()
		for {
			ctx, cancel := context.WithTimeout(parent, recipeSyncTimeout)
			err := s.SyncRecipes(ctx)
			cancel()
			if err != nil {
				// Route through recordError like any other sync failure — an
				// auth failure during a recipe pull is exactly as real (and as
				// worth latching off) as one during a grocery pull, and a
				// transient one should count toward the same backoff/alert
				// bookkeeping rather than being log-only.
				s.recordError(err)
			}

			s.mu.Lock()
			pending := s.recipeSyncPending
			s.recipeSyncPending = false
			s.mu.Unlock()
			if !pending || s.isStopped() {
				return
			}
		}
	}()
}

// TriggerGrocerySync kicks an out-of-band SyncOnce after a local grocery
// mutation touched Recipe Keeper links, so the resulting push goes out
// within seconds instead of waiting for the safety timer. It never even
// starts once the auth-failure latch has tripped: retrying a rejected
// password on every grocery edit is the exact account-lockout risk that
// latch exists to prevent. Same for the pause switch (IsPaused): a paused
// household must be able to add/check/delete grocery items freely without
// any of it reaching Recipe Keeper — the local mutation still happens and
// still tombstones/retargets links as usual, only this trigger is inert.
//
// When a sync is already in flight, it coalesces rather than dropping: it
// sets grocerySyncPending and returns, and the in-flight goroutine notices
// the flag once it finishes and runs exactly one more sync before releasing
// the mutex — so a burst of kicks arriving mid-sync (e.g. checking off
// several items right after selecting a list, while the long initial drain
// is still running) collapses to at most one extra run, never zero (the
// dropped-kick bug) and never one per kick. Bounded to grocerySyncTimeout so
// a slow or hung upstream can't accumulate goroutines indefinitely, and so
// it is generously above a real full drain — a cancelled drain makes no
// progress, because the watermark is only persisted once a drain completes.
func (s *Service) TriggerGrocerySync() {
	if s.isStopped() || IsPaused(s.DB) {
		return
	}
	if !s.grocerySyncMu.TryLock() {
		s.mu.Lock()
		s.grocerySyncPending = true
		s.mu.Unlock()
		return
	}
	parent := s.backgroundContext()
	go func() {
		defer s.grocerySyncMu.Unlock()
		for {
			ctx, cancel := context.WithTimeout(parent, grocerySyncTimeout)
			_ = s.SyncOnce(ctx)
			cancel()

			s.mu.Lock()
			pending := s.grocerySyncPending
			s.grocerySyncPending = false
			s.mu.Unlock()
			if !pending || s.isStopped() {
				return
			}
		}
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
		Enabled:          true,
		LastError:        getState(s.DB, stateLastError, ""),
		AuthFailed:       getState(s.DB, stateAuthFailed, "false") == "true",
		SelectedListID:   SelectedListID(s.DB),
		SelectedListName: SelectedListName(s.DB),
		Paused:           IsPaused(s.DB),
	}
	if v := getState(s.DB, stateLastSync, ""); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			st.LastSync = &t
		}
	}
	return st
}

// Run drives the sync loop until ctx is cancelled. Sync is entirely
// poll-driven — the long-poll doorbell never returns 200 for this client
// (see docs/recipe-keeper-api.md), so it was implemented and then removed
// rather than kept as dead weight. Polling is adaptive instead of
// fixed-interval: while at least one SSE client is connected (see
// SubscriberCount) Run polls every PollInterval; otherwise it polls every
// IdlePollInterval. A client connecting fires an immediate sync (see
// Connected) rather than waiting for the next tick. A safety timer covers
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

	connectedInterval := s.PollInterval
	if connectedInterval <= 0 {
		connectedInterval = defaultPollSeconds * time.Second
	}
	idleInterval := s.IdlePollInterval
	if idleInterval <= 0 {
		idleInterval = idlePollSeconds * time.Second
	}
	countFn := s.SubscriberCount
	if countFn == nil {
		countFn = func() int { return 0 }
	}

	// A nil Connected channel is fine: a nil channel's case in a select is
	// never ready, so that branch simply never fires and connects are only
	// noticed on the next tick.
	connected := s.Connected

	nextInterval := idleInterval
	if countFn() > 0 {
		nextInterval = connectedInterval
	}
	timer := time.NewTimer(nextInterval)
	defer timer.Stop()

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

		case <-connected:
			if s.isStopped() {
				log.Printf("recipekeeper: sync disabled after repeated auth failures; fix credentials and restart, or trigger a manual sync, to resume")
				return
			}
			// A client just connected: sync now rather than waiting up to
			// IdlePollInterval for the next tick, and switch to the fast
			// cadence from here. TriggerGrocerySync is the coalescing,
			// latch-respecting entry point, so this is safe even if a sync
			// (safety timer, a previous tick, or a manual trigger) is
			// already in flight.
			s.TriggerGrocerySync()
			if !timer.Stop() {
				<-timer.C
			}
			timer.Reset(connectedInterval)

		case <-timer.C:
			if s.isStopped() {
				return
			}
			s.TriggerGrocerySync()
			// Re-evaluate presence for the NEXT tick's cadence: connected
			// stays fast, idle (including the last subscriber having just
			// disconnected) falls back to the slow cadence.
			nextInterval = idleInterval
			if countFn() > 0 {
				nextInterval = connectedInterval
			}
			timer.Reset(nextInterval)
		}
	}
}
