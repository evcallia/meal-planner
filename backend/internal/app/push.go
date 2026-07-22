package app

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

// editPushDetail derives a specific verb phrase for an edit notification from
// the SSE payload (which already carries the item/section data). Phrases are
// short — the notification title names the list — so burst summaries read
// well: "made 4 edits: added “Milk”, updated “Eggs”, …". Returns notify=false
// for cosmetic actions (reorders) that shouldn't ping anyone. An empty detail
// with notify=true falls back to the category's generic verb.
func editPushDetail(eventType string, payload J) (detail string, notify bool) {
	action, _ := payload["action"].(string)
	if strings.Contains(action, "reordered") {
		return "", false
	}

	var place string
	switch eventType {
	case "grocery.updated":
		place = "the grocery list"
	case "pantry.updated":
		place = "the pantry"
	case "notes.updated":
		if date, ok := payload["date"].(string); ok {
			if t, err := time.Parse("2006-01-02", date); err == nil {
				return "updated meals for " + t.Format("Mon, Jan 2"), true
			}
		}
		return "", true
	default:
		return "", true
	}

	name := func(key string) string {
		if m, ok := payload[key].(J); ok {
			if s, ok := m["name"].(string); ok {
				return s
			}
		}
		return ""
	}
	switch action {
	case "item-added":
		if n := name("item"); n != "" {
			return "added “" + n + "”", true
		}
	case "item-updated":
		if n := name("item"); n != "" {
			return "updated “" + n + "”", true
		}
	case "item-moved":
		if n := name("item"); n != "" {
			return "moved “" + n + "”", true
		}
	case "item-deleted":
		return "removed an item", true
	case "section-added":
		if n := name("section"); n != "" {
			return "added a “" + n + "” section", true
		}
	case "section-renamed":
		if n, ok := payload["name"].(string); ok && n != "" {
			return "renamed a section to “" + n + "”", true
		}
	case "section-deleted":
		return "removed a section", true
	case "cleared-checked":
		return "cleared the checked items", true
	case "cleared-all":
		return "cleared " + place, true
	}
	return "", true
}

// countNoun renders "3 sections" / "1 item" for notification phrasing.
func countNoun(n int, noun string) string {
	s := strconv.Itoa(n) + " " + noun
	if n != 1 {
		s += "s"
	}
	return s
}

// displayName picks the actor's human-readable name for notification bodies.
func displayName(user *session.UserInfo) string {
	if user == nil {
		return "Someone"
	}
	if user.Name != nil && *user.Name != "" {
		return *user.Name
	}
	if user.Email != nil && *user.Email != "" {
		return *user.Email
	}
	return "Someone"
}

// handleGetPushPublicKey returns the VAPID public key the browser needs as
// applicationServerKey.
func (a *App) handleGetPushPublicKey(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	key, err := a.Push.VapidPublicKey()
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, J{"key": key})
}

// handleSavePushSubscription upserts a device's push subscription, keyed by
// endpoint (a browser may re-register the same endpoint after a login or a
// subscription refresh).
func (a *App) handleSavePushSubscription(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil ||
		payload.Endpoint == "" || payload.Keys.P256dh == "" || payload.Keys.Auth == "" {
		httpx.ValidationError(w, "endpoint and keys are required")
		return
	}
	var row models.PushSubscription
	err := a.DB.Where("endpoint = ?", payload.Endpoint).First(&row).Error
	switch {
	case err == nil:
		row.Sub = user.Sub
		row.P256dh = payload.Keys.P256dh
		row.Auth = payload.Keys.Auth
		if err := a.DB.Save(&row).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	case err == gorm.ErrRecordNotFound:
		row = models.PushSubscription{
			Sub:      user.Sub,
			Endpoint: payload.Endpoint,
			P256dh:   payload.Keys.P256dh,
			Auth:     payload.Keys.Auth,
		}
		if err := a.DB.Create(&row).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	default:
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, 201, J{"status": "ok"})
}

// handleTestPush sends a test notification to all of the CALLER's devices,
// bypassing edit suppression and preference gating, and returns per-device
// delivery results — so "why am I not getting notifications" is answerable
// from the Settings UI instead of server logs.
func (a *App) handleTestPush(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	results := a.Push.SendTestNotification(user.Sub)
	httpx.WriteJSON(w, 200, J{"sent": len(results), "results": results})
}

// handleDeletePushSubscription is an idempotent unsubscribe for one of the
// caller's devices.
func (a *App) handleDeletePushSubscription(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		Endpoint string `json:"endpoint"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.Endpoint == "" {
		httpx.ValidationError(w, "endpoint is required")
		return
	}
	if err := a.DB.Where("endpoint = ? AND sub = ?", payload.Endpoint, user.Sub).
		Delete(&models.PushSubscription{}).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
