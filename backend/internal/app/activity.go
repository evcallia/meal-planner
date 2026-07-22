package app

// Activity feed: every human-phrased edit (the same verb phrases the push
// notifications use) is persisted so a user can see what changed since they
// last looked. Feed entries exclude the viewer's own edits, and tracker rows
// are visible only to the list's audience at the time of the edit.

import (
	"log"
	"net/http"

	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/push"
	"mealplanner/internal/session"
)

// activityFeedLimit caps the feed response — plenty for a household.
const activityFeedLimit = 100

var activityGenericDetail = map[string]string{
	"meals":   "updated the meal plan",
	"pantry":  "updated the pantry",
	"grocery": "updated the grocery list",
}

// activityEntryJSON is the feed entry shape shared by GET /api/activity and
// the live `activity.added` SSE event — the two must stay identical so
// client-appended entries match later fetches. list_id/task_id ride along so
// the client can apply the notification-pref cascade to live entries.
func activityEntryJSON(row *models.ActivityLog) J {
	entry := J{
		"id":         row.ID.String(),
		"at":         httpx.FormatDateTime(row.At),
		"actor_name": row.ActorName,
		"category":   row.Category,
		"detail":     row.Detail,
	}
	if row.ListName != "" {
		entry["list_name"] = row.ListName
	}
	if row.ListID != "" {
		entry["list_id"] = row.ListID
	}
	if row.TaskID != "" {
		entry["task_id"] = row.TaskID
	}
	return entry
}

// emitActivity pushes a live `activity.added` SSE event carrying the fully
// rendered entry, so clients update the bell without refetching the feed.
// audience nil = broadcast to every session (shared-global categories);
// recipients exclude the actor server-side where possible, and the payload's
// actor_sub lets the actor's OTHER devices self-exclude on the global path.
func (a *App) emitActivity(row *models.ActivityLog, audience map[string]bool, actorSub string) {
	payload := J{"entry": activityEntryJSON(row), "actor_sub": actorSub}
	if audience == nil {
		a.Broadcaster.BroadcastEvent("activity.added", payload, "")
		return
	}
	for sub := range audience {
		if sub != actorSub {
			a.Broadcaster.BroadcastToUser(sub, "activity.added", payload, "")
		}
	}
}

// logActivity persists one feed entry and emits it live. list non-nil scopes
// visibility to the list's audience (snapshotted, so entries survive list
// deletion with their privacy intact). Best-effort: a failed insert never
// breaks the mutation.
func (a *App) logActivity(category, detail string, actor *session.UserInfo, list *models.TrackerList) {
	if actor == nil {
		return
	}
	if detail == "" {
		if list != nil {
			detail = "updated “" + list.Name + "”"
		} else {
			detail = activityGenericDetail[category]
		}
	}
	row := models.ActivityLog{
		ActorSub:  actor.Sub,
		ActorName: displayName(actor),
		Category:  category,
		Detail:    detail,
	}
	var audience map[string]bool
	if list != nil {
		row.ListName = list.Name
		row.ListID = list.ID.String()
		audience = trackerAudience(list)
		snapshot := ""
		for sub := range audience {
			snapshot += "|" + sub
		}
		row.Audience = snapshot + "|"
	}
	if err := a.DB.Create(&row).Error; err != nil {
		log.Printf("activity: log failed: %v", err)
		return
	}
	a.emitActivity(&row, audience, actor.Sub)
}

func (a *App) handleGetActivity(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var rows []models.ActivityLog
	err := a.DB.
		Where("actor_sub <> ?", user.Sub).
		Where("audience = '' OR audience LIKE ?", "%|"+user.Sub+"|%").
		Order("at DESC").
		Limit(activityFeedLimit).
		Find(&rows).Error
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	// The feed mirrors what would actually alert this user: entries are
	// gated on the same notification preferences (category toggles +
	// per-list overrides) as pushes, evaluated at read time so toggling a
	// preference immediately re-filters history too.
	prefs := push.LoadNotifyPrefs(a.DB, user.Sub)
	entries := make([]J, 0, len(rows))
	for i := range rows {
		if rows[i].Category == "list-due" {
			if !prefs.DueTaskEnabled(rows[i].ListID, rows[i].TaskID) {
				continue
			}
		} else if !prefs.Enabled(rows[i].Category, rows[i].ListID) {
			continue
		}
		entries = append(entries, activityEntryJSON(&rows[i]))
	}

	var lastSeen any = nil
	var seen models.ActivitySeen
	if err := a.DB.Where("sub = ?", user.Sub).First(&seen).Error; err == nil {
		lastSeen = httpx.FormatDateTime(seen.SeenAt)
	}
	httpx.WriteJSON(w, 200, J{"entries": entries, "last_seen": lastSeen})
}

func (a *App) handleMarkActivitySeen(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	now := models.NowUTC()
	var seen models.ActivitySeen
	err := a.DB.Where("sub = ?", user.Sub).First(&seen).Error
	switch {
	case err == nil:
		if uerr := a.DB.Model(&models.ActivitySeen{}).Where("sub = ?", user.Sub).
			Update("seen_at", now).Error; uerr != nil {
			httpx.WriteError(w, uerr)
			return
		}
	case err == gorm.ErrRecordNotFound:
		if cerr := a.DB.Create(&models.ActivitySeen{Sub: user.Sub, SeenAt: now}).Error; cerr != nil {
			httpx.WriteError(w, cerr)
			return
		}
	default:
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, J{"status": "ok", "seen_at": httpx.FormatDateTime(now)})
}
