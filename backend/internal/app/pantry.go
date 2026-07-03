package app

import (
	"net/http"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
	"mealplanner/internal/textutil"
)

func (a *App) loadPantrySections() ([]models.PantrySection, error) {
	var sections []models.PantrySection
	err := a.DB.Preload("Items").Order("position ASC").Find(&sections).Error
	return sections, err
}

func pantrySectionsJSON(sections []models.PantrySection) []J {
	out := make([]J, 0, len(sections))
	for i := range sections {
		out = append(out, pantrySectionJSON(&sections[i]))
	}
	return out
}

func (a *App) handleListPantry(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	sections, err := a.loadPantrySections()
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, pantrySectionsJSON(sections))
}

func (a *App) handleReplacePantry(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		Sections []struct {
			Name  *string `json:"name"`
			Items []struct {
				Name     string `json:"name"`
				Quantity int    `json:"quantity"`
			} `json:"items"`
		} `json:"sections"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	// A missing/null `sections` must 422 like pydantic — otherwise a
	// malformed body would silently wipe the whole pantry.
	if payload.Sections == nil {
		httpx.ValidationError(w, "sections is required")
		return
	}
	for _, sec := range payload.Sections {
		if sec.Name == nil || sec.Items == nil {
			httpx.ValidationError(w, "each section requires name and items")
			return
		}
	}
	err := a.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("1 = 1").Delete(&models.PantrySection{}).Error; err != nil {
			return err
		}
		for i, sec := range payload.Sections {
			section := models.PantrySection{Name: textutil.ToTitleCase(*sec.Name), Position: i}
			if err := tx.Create(&section).Error; err != nil {
				return err
			}
			for j, item := range sec.Items {
				pi := models.PantryItem{
					SectionID: section.ID,
					Name:      item.Name,
					Quantity:  item.Quantity,
					Position:  j,
				}
				if err := tx.Create(&pi).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	sections, err := a.loadPantrySections()
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	result := pantrySectionsJSON(sections)
	a.broadcast("pantry.updated", J{"action": "replaced", "sections": result}, r)
	httpx.WriteJSON(w, 200, result)
}

func (a *App) handleUpdatePantrySection(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	sectionID, err := httpx.ParseUUID(r.PathValue("sectionId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name string `json:"name"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	var section models.PantrySection
	if a.DB.Preload("Items").Where("id = ?", sectionID).First(&section).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Section not found")
		return
	}
	section.Name = textutil.ToTitleCase(payload.Name)
	// Targeted update — Save() with preloaded Items would upsert the
	// association and resurrect concurrently-deleted items.
	if err := a.DB.Model(&models.PantrySection{}).Where("id = ?", section.ID).
		Update("name", section.Name).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("pantry.updated", J{
		"action": "section-renamed", "sectionId": section.ID.String(), "name": section.Name,
	}, r)
	httpx.WriteJSON(w, 200, pantrySectionJSON(&section))
}

func (a *App) handleReorderPantrySections(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		SectionIDs []string `json:"section_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	ids, err := parseUUIDList(payload.SectionIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		var section models.PantrySection
		if a.DB.Where("id = ?", id).First(&section).Error == nil {
			section.Position = i
			a.DB.Save(&section)
		}
	}
	var sections []models.PantrySection
	a.DB.Order("position ASC").Find(&sections)
	positions := make([]J, 0, len(sections))
	for _, s := range sections {
		positions = append(positions, J{"id": s.ID.String(), "position": s.Position})
	}
	a.broadcast("pantry.updated", J{"action": "section-reordered", "sections": positions}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

func (a *App) handleReorderPantryItems(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	sectionID, err := httpx.ParseUUID(r.PathValue("sectionId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		ItemIDs []string `json:"item_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	var section models.PantrySection
	if a.DB.Where("id = ?", sectionID).First(&section).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Section not found")
		return
	}
	ids, err := parseUUIDList(payload.ItemIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		var item models.PantryItem
		if a.DB.Where("id = ? AND section_id = ?", id, sectionID).First(&item).Error == nil {
			item.Position = i
			a.DB.Save(&item)
		}
	}
	var items []models.PantryItem
	a.DB.Where("section_id = ?", sectionID).Order("position ASC").Find(&items)
	positions := make([]J, 0, len(items))
	for _, item := range items {
		positions = append(positions, J{"id": item.ID.String(), "position": item.Position})
	}
	a.broadcast("pantry.updated", J{
		"action": "items-reordered", "sectionId": sectionID.String(), "items": positions,
	}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

func (a *App) handleAddPantryItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		SectionID string `json:"section_id"`
		Name      string `json:"name"`
		Quantity  int    `json:"quantity"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	if payload.Quantity < 0 {
		httpx.ValidationError(w, "quantity must be >= 0")
		return
	}
	sectionID, err := httpx.ParseUUID(payload.SectionID)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var section models.PantrySection
	if a.DB.Where("id = ?", sectionID).First(&section).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Section not found")
		return
	}
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		httpx.Detail(w, http.StatusBadRequest, "Name is required")
		return
	}
	var maxPos struct{ Position int }
	nextPos := 0
	if a.DB.Model(&models.PantryItem{}).Where("section_id = ?", sectionID).
		Order("position DESC").Limit(1).Scan(&maxPos).RowsAffected > 0 {
		nextPos = maxPos.Position + 1
	}
	item := models.PantryItem{
		SectionID: sectionID, Name: name, Quantity: payload.Quantity, Position: nextPos,
	}
	if err := a.DB.Create(&item).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("pantry.updated", J{
		"action": "item-added", "sectionId": item.SectionID.String(), "item": pantryItemJSON(&item),
	}, r)
	httpx.WriteJSON(w, 200, pantryItemJSON(&item))
}

func (a *App) handleUpdatePantryItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	itemID, err := httpx.ParseUUID(r.PathValue("itemId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name     *string `json:"name"`
		Quantity *int    `json:"quantity"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	if payload.Quantity != nil && *payload.Quantity < 0 {
		httpx.ValidationError(w, "quantity must be >= 0")
		return
	}
	var item models.PantryItem
	if a.DB.Where("id = ?", itemID).First(&item).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Item not found")
		return
	}
	updates := map[string]any{}
	if payload.Name != nil {
		name := strings.TrimSpace(*payload.Name)
		if name == "" {
			httpx.Detail(w, http.StatusBadRequest, "Name is required")
			return
		}
		if name != item.Name {
			item.Name = name
			updates["name"] = name
		}
	}
	if payload.Quantity != nil && *payload.Quantity != item.Quantity {
		item.Quantity = *payload.Quantity
		updates["quantity"] = item.Quantity
	}
	if len(updates) > 0 {
		updates["updated_at"] = models.NowUTC()
		if err := a.DB.Model(&models.PantryItem{}).Where("id = ?", itemID).Updates(updates).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	a.DB.Where("id = ?", itemID).First(&item)
	a.broadcast("pantry.updated", J{
		"action": "item-updated", "sectionId": item.SectionID.String(), "item": pantryItemJSON(&item),
	}, r)
	httpx.WriteJSON(w, 200, pantryItemJSON(&item))
}

func (a *App) handleMovePantryItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	itemID, err := httpx.ParseUUID(r.PathValue("itemId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		ToSectionID string `json:"to_section_id"`
		ToPosition  *int   `json:"to_position"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.ToPosition == nil {
		httpx.ValidationError(w, "to_section_id and to_position are required")
		return
	}
	toSectionID, err := httpx.ParseUUID(payload.ToSectionID)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var item models.PantryItem
	if a.DB.Where("id = ?", itemID).First(&item).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Item not found")
		return
	}
	var target models.PantrySection
	if a.DB.Where("id = ?", toSectionID).First(&target).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Target section not found")
		return
	}
	oldSectionID := item.SectionID
	item.SectionID = toSectionID
	item.Position = *payload.ToPosition
	if err := a.DB.Save(&item).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	reindex := func(sectionID uuid.UUID) {
		var items []models.PantryItem
		a.DB.Where("section_id = ?", sectionID).Order("position ASC").Find(&items)
		for i := range items {
			if items[i].Position != i {
				a.DB.Model(&items[i]).Update("position", i)
			}
		}
	}
	reindex(oldSectionID)
	reindex(toSectionID)

	a.DB.Where("id = ?", itemID).First(&item)
	a.broadcast("pantry.updated", J{
		"action":        "item-moved",
		"fromSectionId": oldSectionID.String(),
		"toSectionId":   item.SectionID.String(),
		"item":          pantryItemJSON(&item),
	}, r)
	httpx.WriteJSON(w, 200, pantryItemJSON(&item))
}

func (a *App) handleCreatePantrySection(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		Name string `json:"name"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	name := textutil.ToTitleCase(payload.Name)
	var existing models.PantrySection
	if a.DB.Preload("Items").Where("name = ?", name).First(&existing).Error == nil {
		httpx.WriteJSON(w, 200, pantrySectionJSON(&existing))
		return
	}
	var maxPos struct{ Position int }
	nextPos := 0
	if a.DB.Model(&models.PantrySection{}).Order("position DESC").Limit(1).Scan(&maxPos).RowsAffected > 0 {
		nextPos = maxPos.Position + 1
	}
	section := models.PantrySection{Name: name, Position: nextPos}
	if err := a.DB.Create(&section).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("pantry.updated", J{
		"action":  "section-added",
		"section": J{"id": section.ID.String(), "name": section.Name, "position": section.Position, "items": []J{}},
	}, r)
	section.Items = []models.PantryItem{}
	httpx.WriteJSON(w, 200, pantrySectionJSON(&section))
}

func (a *App) handleDeletePantrySection(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	sectionID, err := httpx.ParseUUID(r.PathValue("sectionId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var section models.PantrySection
	if a.DB.Where("id = ?", sectionID).First(&section).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Section not found")
		return
	}
	if err := a.DB.Delete(&section).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("pantry.updated", J{"action": "section-deleted", "sectionId": sectionID.String()}, r)
	httpx.WriteJSON(w, 200, J{"status": "deleted"})
}

func (a *App) handleDeletePantryItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	itemID, err := httpx.ParseUUID(r.PathValue("itemId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var item models.PantryItem
	if a.DB.Where("id = ?", itemID).First(&item).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Item not found")
		return
	}
	sectionID := item.SectionID
	if err := a.DB.Delete(&item).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("pantry.updated", J{
		"action": "item-deleted", "sectionId": sectionID.String(), "itemId": itemID.String(),
	}, r)
	httpx.WriteJSON(w, 200, J{"status": "deleted"})
}

func (a *App) handleClearPantryItems(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	if r.URL.Query().Get("mode") != "all" {
		httpx.ValidationError(w, "mode must match ^(all)$")
		return
	}
	if err := a.DB.Where("1 = 1").Delete(&models.PantrySection{}).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	sections, err := a.loadPantrySections()
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("pantry.updated", J{"action": "cleared-all"}, r)
	httpx.WriteJSON(w, 200, pantrySectionsJSON(sections))
}
