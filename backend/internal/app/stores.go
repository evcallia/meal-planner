package app

import (
	"net/http"
	"strings"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
	"mealplanner/internal/textutil"
)

func (a *App) handleListStores(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var stores []models.Store
	if err := a.DB.Order("position ASC, name ASC").Find(&stores).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]J, 0, len(stores))
	for i := range stores {
		out = append(out, storeJSON(&stores[i]))
	}
	httpx.WriteJSON(w, 200, out)
}

func (a *App) handleCreateStore(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		Name     string `json:"name"`
		Position *int   `json:"position"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	name := textutil.ToTitleCase(payload.Name)
	var existing models.Store
	if a.DB.Where("LOWER(name) = LOWER(?)", name).First(&existing).Error == nil {
		httpx.WriteJSON(w, 200, storeJSON(&existing))
		return
	}
	nextPos := 0
	if payload.Position != nil {
		nextPos = *payload.Position
	} else {
		var maxPos struct{ Position int }
		if a.DB.Model(&models.Store{}).Order("position DESC").Limit(1).Scan(&maxPos).RowsAffected > 0 {
			nextPos = maxPos.Position + 1
		}
	}
	store := models.Store{Name: name, Position: nextPos}
	if err := a.DB.Create(&store).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("stores.updated", J{"action": "added", "store": storeJSON(&store)}, r)
	httpx.WriteJSON(w, 200, storeJSON(&store))
}

func (a *App) handleReorderStores(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		StoreIDs []string `json:"store_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	ids, err := parseUUIDList(payload.StoreIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		a.DB.Model(&models.Store{}).Where("id = ?", id).Update("position", i)
	}
	var stores []models.Store
	a.DB.Order("position ASC").Find(&stores)
	positions := make([]J, 0, len(stores))
	for _, s := range stores {
		positions = append(positions, J{"id": s.ID.String(), "position": s.Position})
	}
	a.broadcast("stores.updated", J{"action": "reordered", "stores": positions}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

func (a *App) handleUpdateStore(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	storeID, err := httpx.ParseUUID(r.PathValue("storeId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name     *string `json:"name"`
		Position *int    `json:"position"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	if payload.Name != nil && strings.TrimSpace(*payload.Name) == "" {
		httpx.ValidationError(w, "name must be non-empty")
		return
	}
	var store models.Store
	if a.DB.Where("id = ?", storeID).First(&store).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Store not found")
		return
	}
	if payload.Name != nil {
		name := textutil.ToTitleCase(*payload.Name)
		var existing models.Store
		if a.DB.Where("LOWER(name) = LOWER(?) AND id <> ?", name, storeID).First(&existing).Error == nil {
			httpx.Detail(w, http.StatusConflict, "Store name already exists")
			return
		}
		store.Name = name
	}
	if payload.Position != nil {
		store.Position = *payload.Position
	}
	if err := a.DB.Model(&models.Store{}).Where("id = ?", store.ID).Updates(map[string]any{
		"name": store.Name, "position": store.Position,
	}).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("stores.updated", J{"action": "updated", "store": storeJSON(&store)}, r)
	httpx.WriteJSON(w, 200, storeJSON(&store))
}

func (a *App) handleDeleteStore(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	storeID, err := httpx.ParseUUID(r.PathValue("storeId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var store models.Store
	if a.DB.Where("id = ?", storeID).First(&store).Error != nil {
		httpx.WriteJSON(w, 200, J{"status": "ok"}) // idempotent — already deleted
		return
	}
	// Mirror SET NULL semantics for references before deleting. These must
	// succeed or we'd delete the store and leave dangling references.
	if err := a.DB.Model(&models.GroceryItem{}).Where("store_id = ?", storeID).Update("store_id", nil).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	if err := a.DB.Model(&models.ItemDefault{}).Where("store_id = ?", storeID).Update("store_id", nil).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	if err := a.DB.Delete(&store).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("stores.updated", J{"action": "deleted", "storeId": storeID.String()}, r)
	// Store ids also live in users' grocery chip-filter settings — prune them
	// like the tracker notification overrides.
	a.pruneNotifyOverrides(nil, nil, []string{storeID.String()})
	httpx.WriteJSON(w, 200, J{"status": "deleted"})
}
