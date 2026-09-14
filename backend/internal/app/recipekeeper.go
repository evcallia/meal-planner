// backend/internal/app/recipekeeper.go
package app

import (
	"net/http"

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
