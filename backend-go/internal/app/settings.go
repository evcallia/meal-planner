package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"

	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

// decodeSettingsBlob re-decodes the stored JSON for responses, preserving
// number fidelity (UseNumber keeps int64s > 2^53 and "1.0" intact — a plain
// unmarshal would round-trip everything through float64).
func decodeSettingsBlob(raw string) any {
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.UseNumber()
	var settings any
	if dec.Decode(&settings) != nil {
		return J{}
	}
	return settings
}

func (a *App) handleGetSettings(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var row models.UserSettings
	err := a.DB.Where("sub = ?", user.Sub).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		httpx.WriteJSON(w, 200, J{"settings": J{}, "updated_at": nil})
		return
	}
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	settings := decodeSettingsBlob(row.Settings)
	httpx.WriteJSON(w, 200, J{"settings": settings, "updated_at": httpx.FormatDateTime(row.UpdatedAt)})
}

func (a *App) handlePutSettings(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		Settings  json.RawMessage `json:"settings"`
		UpdatedAt httpx.JSONTime  `json:"updated_at"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.Settings == nil || !payload.UpdatedAt.Valid {
		httpx.ValidationError(w, "settings and updated_at are required")
		return
	}
	// pydantic requires `settings: dict` — reject non-object blobs. A JSON
	// `null` unmarshals into a map without error (leaving it nil), so the
	// nil check is what actually rejects `"settings": null`.
	var settingsObj map[string]json.RawMessage
	if json.Unmarshal(payload.Settings, &settingsObj) != nil || settingsObj == nil {
		httpx.ValidationError(w, "settings must be an object")
		return
	}
	var row models.UserSettings
	err := a.DB.Where("sub = ?", user.Sub).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		row = models.UserSettings{Sub: user.Sub, Settings: string(payload.Settings), UpdatedAt: payload.UpdatedAt.Time}
		if err := a.DB.Create(&row).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	} else if err != nil {
		httpx.WriteError(w, err)
		return
	} else {
		row.Settings = string(payload.Settings)
		row.UpdatedAt = payload.UpdatedAt.Time
		if err := a.DB.Model(&row).Select("settings", "updated_at").Updates(map[string]any{
			"settings": row.Settings, "updated_at": row.UpdatedAt,
		}).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	settings := decodeSettingsBlob(row.Settings)
	a.Broadcaster.BroadcastToUser(user.Sub, "settings.updated", J{
		"settings": settings, "updated_at": httpx.FormatDateTime(row.UpdatedAt),
	}, httpx.SourceID(r))
	httpx.WriteJSON(w, 200, J{"settings": settings, "updated_at": httpx.FormatDateTime(row.UpdatedAt)})
}
