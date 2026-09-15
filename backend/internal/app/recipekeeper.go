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
	if err := a.RecipeKeeper.SyncOnce(r.Context()); err != nil {
		httpx.Detail(w, http.StatusBadGateway, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, a.RecipeKeeper.Status())
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
	httpx.WriteJSON(w, http.StatusOK, a.RecipeKeeper.Status())
}
