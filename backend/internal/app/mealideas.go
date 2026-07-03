package app

import (
	"net/http"
	"strings"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

func (a *App) handleListMealIdeas(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var ideas []models.MealIdea
	if err := a.DB.Order("updated_at DESC").Find(&ideas).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]J, 0, len(ideas))
	for i := range ideas {
		out = append(out, mealIdeaJSON(&ideas[i]))
	}
	httpx.WriteJSON(w, 200, out)
}

func (a *App) handleCreateMealIdea(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		Title string `json:"title"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.Title == "" {
		httpx.ValidationError(w, "title is required")
		return
	}
	title := strings.TrimSpace(payload.Title)
	if title == "" {
		httpx.Detail(w, http.StatusBadRequest, "Title is required")
		return
	}
	idea := models.MealIdea{Title: title}
	if err := a.DB.Create(&idea).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("meal-ideas.updated", J{"action": "added", "idea": mealIdeaJSON(&idea)}, r)
	httpx.WriteJSON(w, 200, mealIdeaJSON(&idea))
}

func (a *App) handleUpdateMealIdea(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	ideaID, err := httpx.ParseUUID(r.PathValue("ideaId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Title *string `json:"title"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	if payload.Title != nil && *payload.Title == "" {
		httpx.ValidationError(w, "title must be non-empty")
		return
	}
	var idea models.MealIdea
	if a.DB.Where("id = ?", ideaID).First(&idea).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Idea not found")
		return
	}
	if payload.Title != nil {
		title := strings.TrimSpace(*payload.Title)
		if title == "" {
			httpx.Detail(w, http.StatusBadRequest, "Title is required")
			return
		}
		// Only write when the title actually changed — updated_at drives the
		// list ordering, so a no-op PUT must not jump the idea to the top.
		if title != idea.Title {
			idea.Title = title
			idea.UpdatedAt = models.NowUTC()
			if err := a.DB.Model(&models.MealIdea{}).Where("id = ?", idea.ID).Updates(map[string]any{
				"title": idea.Title, "updated_at": idea.UpdatedAt,
			}).Error; err != nil {
				httpx.WriteError(w, err)
				return
			}
		}
	}
	a.broadcast("meal-ideas.updated", J{"action": "updated", "idea": mealIdeaJSON(&idea)}, r)
	httpx.WriteJSON(w, 200, mealIdeaJSON(&idea))
}

func (a *App) handleDeleteMealIdea(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	ideaID, err := httpx.ParseUUID(r.PathValue("ideaId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var idea models.MealIdea
	if a.DB.Where("id = ?", ideaID).First(&idea).Error != nil {
		httpx.WriteJSON(w, 200, J{"status": "ok"}) // idempotent — already deleted
		return
	}
	if err := a.DB.Delete(&idea).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("meal-ideas.updated", J{"action": "deleted", "ideaId": idea.ID.String()}, r)
	httpx.WriteJSON(w, 200, J{"status": "deleted"})
}
