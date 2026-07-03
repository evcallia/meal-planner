package app

import (
	"net/http"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

// handleListUsers is the directory used to pick a share collaborator;
// excludes the current user.
func (a *App) handleListUsers(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var rows []models.User
	if err := a.DB.Where("sub <> ?", user.Sub).Order("name ASC").Find(&rows).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]J, 0, len(rows))
	for _, u := range rows {
		out = append(out, J{"sub": u.Sub, "email": strOrNil(u.Email), "name": strOrNil(u.Name)})
	}
	httpx.WriteJSON(w, 200, out)
}
