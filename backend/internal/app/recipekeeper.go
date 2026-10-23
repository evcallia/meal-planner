// backend/internal/app/recipekeeper.go
package app

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"mealplanner/internal/httpx"
	"mealplanner/internal/recipekeeper"
	"mealplanner/internal/session"
)

// handleRecipeKeeperStatus reports whether the sync loop is running, when it
// last succeeded, and its last error (including the auth-failure latch — see
// recipekeeper.Service.recordError). a.RecipeKeeper is nil whenever the
// integration isn't configured (no RECIPE_KEEPER_* env vars), which must
// report disabled rather than panic or 500.
func (a *App) handleRecipeKeeperStatus(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	if a.RecipeKeeper == nil {
		httpx.WriteJSON(w, http.StatusOK, recipekeeper.Status{Enabled: false})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, a.RecipeKeeper.Status())
}

// handleRecipeKeeperSync triggers one immediate pull/apply/push cycle — a
// manual "sync now" a user can hit instead of waiting for the background
// loop's poll. SyncOnce is safe to call concurrently with the running Run
// loop (Service holds its own mutex around the shared counters); no locking
// needed here.
func (a *App) handleRecipeKeeperSync(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	if a.RecipeKeeper == nil {
		httpx.Detail(w, http.StatusBadRequest, "Recipe Keeper sync is not configured")
		return
	}
	// The manual button must refuse loudly while paused rather than silently
	// no-op: SyncOnce itself already treats "paused" as a no-op success (so
	// the background poll/safety-timer loops don't need special-casing), but
	// a user who explicitly asked for a sync deserves to know why nothing
	// happened rather than see a bare "synced" with no visible effect.
	if recipekeeper.IsPaused(a.RecipeKeeper.DB) {
		httpx.Detail(w, http.StatusConflict, "Recipe Keeper sync is paused — resume it in Settings before syncing")
		return
	}
	// Deliberately NOT SyncOnce(r.Context()): a full drain runs ~14s, the
	// frontend aborts every fetch at 5s (API_TIMEOUT in api/client.ts), and
	// a cancelled drain persists no watermark — so a request-scoped sync
	// could never complete. It burned ~18s of vendor API calls per press
	// and failed with "context canceled" while the background poll loop,
	// running the same SyncOnce on its own context, succeeded seconds
	// later. Kick the same trigger the loop uses (background context, 5-min
	// timeout, mutex + coalescing so this can't race a poll-driven drain)
	// and report 202; the UI polls Status until `syncing` clears.
	a.RecipeKeeper.TriggerGrocerySync(recipekeeper.ReasonManual)
	httpx.WriteJSON(w, http.StatusAccepted, a.RecipeKeeper.Status())
}

// handleRecipeKeeperLists is the discovery endpoint: a Recipe Keeper shopping
// list's id is a GUID that exists only inside the vendor's API, so this is
// the only way to learn which lists exist and pick one. It needs credentials
// only — no list needs to be selected yet, which is exactly the state a user
// is in the first time they call this.
func (a *App) handleRecipeKeeperLists(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	if a.RecipeKeeper == nil {
		httpx.Detail(w, http.StatusBadRequest, "Recipe Keeper sync is not configured")
		return
	}
	lists, err := a.RecipeKeeper.FetchLists(r.Context())
	if err != nil {
		httpx.Detail(w, http.StatusBadGateway, err.Error())
		return
	}
	out := make([]map[string]any, len(lists))
	for i, l := range lists {
		out[i] = map[string]any{"id": l.ID, "name": l.Name}
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// handleRecipeKeeperSelectList sets which Recipe Keeper shopping list to
// mirror. The id is validated against the live list — an unknown id (almost
// always a typo) would otherwise silently sync nothing forever — and, on a
// genuine change from a previously-selected list, resets every stale
// link/tombstone/watermark so the new list imports cleanly without deleting
// any grocery rows (see recipekeeper.SelectList).
func (a *App) handleRecipeKeeperSelectList(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	if a.RecipeKeeper == nil {
		httpx.Detail(w, http.StatusBadRequest, "Recipe Keeper sync is not configured")
		return
	}
	var payload struct {
		ListID string `json:"list_id"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.ListID) == "" {
		httpx.ValidationError(w, "list_id is required")
		return
	}

	lists, err := a.RecipeKeeper.SelectList(r.Context(), strings.TrimSpace(payload.ListID))
	var unknown *recipekeeper.UnknownListError
	if errors.As(err, &unknown) {
		names := make([]string, len(lists))
		for i, l := range lists {
			names[i] = l.Name
		}
		httpx.Detail(w, http.StatusBadRequest,
			fmt.Sprintf("unknown Recipe Keeper list id; valid options: %s", strings.Join(names, ", ")))
		return
	}
	if err != nil {
		httpx.Detail(w, http.StatusBadGateway, err.Error())
		return
	}

	// A newly-selected (or changed) list otherwise sits idle until the next
	// long-poll doorbell or the ~15-minute safety timer — a user who just
	// picked a list in Settings would see nothing happen for up to 15
	// minutes. Both triggers are non-blocking, single-flight, and already
	// latch-aware, so it's safe to fire them here without waiting on either.
	// TriggerGrocerySync pulls the list itself; TriggerRecipeSync warms the
	// recipe-title cache a freshly-imported list needs for attribution.
	a.RecipeKeeper.TriggerGrocerySync(recipekeeper.ReasonListSelected)
	a.RecipeKeeper.TriggerRecipeSync(recipekeeper.ReasonListSelected)

	httpx.WriteJSON(w, http.StatusOK, a.RecipeKeeper.Status())
}

// handleRecipeKeeperSetPaused flips the household-global pause switch (see
// recipekeeper.IsPaused): a safety valve so a household can keep grocery
// shopping through a misbehaving sync without it writing to (or reading
// from) their real Recipe Keeper account. Pausing itself needs no extra
// work — every sync entry point (SyncOnce, SyncRecipes, and both Trigger*
// methods) already checks the flag directly. Resuming does need a nudge:
// otherwise a household would sit idle until the next poll tick or the
// 15-minute safety timer, exactly like a fresh list selection (see
// handleRecipeKeeperSelectList) — so this fires the same two non-blocking,
// latch-aware triggers on resume, and skips them on pause since there is
// nothing to kick.
func (a *App) handleRecipeKeeperSetPaused(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	if a.RecipeKeeper == nil {
		httpx.Detail(w, http.StatusBadRequest, "Recipe Keeper sync is not configured")
		return
	}
	var payload struct {
		Paused bool `json:"paused"`
	}
	present, err := httpx.DecodeBody(r, &payload)
	if err != nil || !present["paused"] {
		httpx.ValidationError(w, "paused is required")
		return
	}

	recipekeeper.SetPaused(a.RecipeKeeper.DB, payload.Paused)
	if !payload.Paused {
		a.RecipeKeeper.TriggerGrocerySync(recipekeeper.ReasonResume)
		a.RecipeKeeper.TriggerRecipeSync(recipekeeper.ReasonResume)
	}

	httpx.WriteJSON(w, http.StatusOK, a.RecipeKeeper.Status())
}
