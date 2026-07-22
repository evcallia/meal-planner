package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
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

// pruneNotifyOverrides removes settings references to DELETED entities from
// every user's blob: per-list/per-task notification overrides and store ids
// in the grocery chip-filter arrays. It scans ALL users deliberately — a user
// who left a list long ago still gets their orphans cleaned when it dies. The server normally never
// writes settings (client-owned, last-write-wins), so a prune must bump
// updated_at and broadcast settings.updated — otherwise a client's in-memory
// copy would resurrect the orphans on its next save. Restores reissue ids, so
// pruning at delete time can never strip settings an undo could reclaim.
// Best-effort housekeeping: failures are logged, never surfaced.
func (a *App) pruneNotifyOverrides(listIDs, taskIDs, storeIDs []string) {
	if len(listIDs) == 0 && len(taskIDs) == 0 && len(storeIDs) == 0 {
		return
	}
	var rows []models.UserSettings
	if err := a.DB.Find(&rows).Error; err != nil {
		log.Printf("settings prune: load failed: %v", err)
		return
	}
	for i := range rows {
		// UseNumber-decoded (decodeSettingsBlob) so re-marshaling preserves
		// number representations exactly.
		blob, ok := decodeSettingsBlob(rows[i].Settings).(map[string]any)
		if !ok {
			continue
		}
		changed := false
		removeKeys := func(field string, ids []string) {
			overrides, ok := blob[field].(map[string]any)
			if !ok {
				return
			}
			for _, id := range ids {
				if _, exists := overrides[id]; exists {
					delete(overrides, id)
					changed = true
				}
			}
		}
		removeKeys("listNotifyOverrides", listIDs)
		removeKeys("taskNotifyOverrides", taskIDs)
		removeFromArray := func(field string, ids []string) {
			arr, ok := blob[field].([]any)
			if !ok || len(arr) == 0 {
				return
			}
			kept := arr[:0]
			for _, v := range arr {
				s, _ := v.(string)
				remove := false
				for _, id := range ids {
					if s == id {
						remove = true
						break
					}
				}
				if remove {
					changed = true
				} else {
					kept = append(kept, v)
				}
			}
			blob[field] = kept
		}
		removeFromArray("grocerySelectedStoreIds", storeIDs)
		removeFromArray("groceryExcludedStoreIds", storeIDs)
		if !changed {
			continue
		}
		raw, err := json.Marshal(blob)
		if err != nil {
			continue
		}
		now := models.NowUTC()
		if err := a.DB.Model(&models.UserSettings{}).Where("sub = ?", rows[i].Sub).
			Updates(map[string]any{"settings": string(raw), "updated_at": now}).Error; err != nil {
			log.Printf("settings prune: update for %s failed: %v", rows[i].Sub, err)
			continue
		}
		a.Broadcaster.BroadcastToUser(rows[i].Sub, "settings.updated",
			J{"settings": decodeSettingsBlob(string(raw)), "updated_at": httpx.FormatDateTime(now)}, "")
	}
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
