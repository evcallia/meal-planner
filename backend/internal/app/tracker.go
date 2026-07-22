package app

import (
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

// ----- serialization helpers -----

func (a *App) trackerFullName(sub *string) *string {
	if sub == nil || *sub == "" {
		return nil
	}
	var u models.User
	if a.DB.Where("sub = ?", *sub).First(&u).Error != nil {
		return nil
	}
	if u.Name != nil && *u.Name != "" {
		return u.Name
	}
	if u.Email != nil && *u.Email != "" {
		return u.Email
	}
	return nil
}

func (a *App) trackerFirstName(sub *string) *string {
	name := a.trackerFullName(sub)
	if name == nil {
		return nil
	}
	fields := strings.Fields(*name)
	if len(fields) == 0 {
		return nil
	}
	return &fields[0]
}

func (a *App) trackerLogJSON(l *models.TrackerLog) J {
	kind := l.Kind
	if kind == "" {
		kind = "done"
	}
	return J{
		"id":              l.ID.String(),
		"task_id":         l.TaskID.String(),
		"done_at":         httpx.FormatDateTime(l.DoneAt),
		"kind":            kind,
		"note":            strOrNil(l.Note),
		"created_by_sub":  strOrNil(l.CreatedBySub),
		"created_by_name": strOrNilPtr(a.trackerFirstName(l.CreatedBySub)),
	}
}

func strOrNilPtr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func intOrNil(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

// trackerTaskJSON mirrors _task_dict: stats computed from logs server-side.
func (a *App) trackerTaskJSON(task *models.TrackerTask) J {
	var logs []models.TrackerLog
	a.DB.Where("task_id = ?", task.ID).Find(&logs)

	var doneLogs []models.TrackerLog
	for _, l := range logs {
		kind := l.Kind
		if kind == "" {
			kind = "done"
		}
		if kind != "skip" {
			doneLogs = append(doneLogs, l)
		}
	}
	doneTimes := make([]int64, 0, len(doneLogs))
	for _, l := range doneLogs {
		doneTimes = append(doneTimes, l.DoneAt.UnixMicro())
	}
	sort.Slice(doneTimes, func(i, j int) bool { return doneTimes[i] < doneTimes[j] })

	total := len(doneTimes)
	var lastDone any = nil
	if total > 0 {
		last := doneLogs[0].DoneAt
		for _, l := range doneLogs {
			if l.DoneAt.After(last) {
				last = l.DoneAt
			}
		}
		lastDone = httpx.FormatDateTime(last)
	}
	var lastEvent any = nil
	if len(logs) > 0 {
		last := logs[0].DoneAt
		for _, l := range logs {
			if l.DoneAt.After(last) {
				last = l.DoneAt
			}
		}
		lastEvent = httpx.FormatDateTime(last)
	}
	var latestDone *models.TrackerLog
	for i := range doneLogs {
		if latestDone == nil || doneLogs[i].DoneAt.After(latestDone.DoneAt) {
			latestDone = &doneLogs[i]
		}
	}

	recent := make([]models.TrackerLog, len(logs))
	copy(recent, logs)
	sort.SliceStable(recent, func(i, j int) bool { return recent[i].DoneAt.After(recent[j].DoneAt) })
	if len(recent) > 5 {
		recent = recent[:5]
	}
	recentJSON := make([]J, 0, len(recent))
	for i := range recent {
		recentJSON = append(recentJSON, a.trackerLogJSON(&recent[i]))
	}

	var avg any = nil
	if total >= 2 {
		sum := 0.0
		for i := 1; i < total; i++ {
			sum += float64(doneTimes[i]-doneTimes[i-1]) / 1e6 / 86400.0
		}
		// Python's round() is ties-to-even; math.Round is half-away-from-zero.
		avg = math.RoundToEven(sum/float64(total-1)*10) / 10
	}

	var lastDoneBy, lastNote any = nil, nil
	if latestDone != nil {
		lastDoneBy = strOrNilPtr(a.trackerFirstName(latestDone.CreatedBySub))
		lastNote = strOrNil(latestDone.Note)
	}

	return J{
		"id":                   task.ID.String(),
		"list_id":              task.ListID.String(),
		"name":                 task.Name,
		"target_interval_days": intOrNil(task.TargetIntervalDays),
		"notes":                strOrNil(task.Notes),
		"position":             task.Position,
		"archived":             task.Archived,
		"season_start_month":   intOrNil(task.SeasonStartMonth),
		"season_end_month":     intOrNil(task.SeasonEndMonth),
		"season_start_day":     intOrNil(task.SeasonStartDay),
		"season_end_day":       intOrNil(task.SeasonEndDay),
		"snooze_until":         httpx.FormatDateTimePtr(task.SnoozeUntil),
		"last_done_at":         lastDone,
		"last_event_at":        lastEvent,
		"last_done_by":         lastDoneBy,
		"last_note":            lastNote,
		"total_count":          total,
		"avg_interval_days":    avg,
		"recent_logs":          recentJSON,
	}
}

// trackerUserPosition mirrors _user_position.
func (a *App) trackerUserPosition(listID uuid.UUID, sub string, fallback int) int {
	var row models.TrackerListPosition
	if a.DB.Where("sub = ? AND list_id = ?", sub, listID).First(&row).Error == nil {
		return row.Position
	}
	return fallback
}

// trackerListJSON mirrors _list_dict (perspective-dependent: is_owner and
// position are per-viewer).
func (a *App) trackerListJSON(lst *models.TrackerList, currentSub string) J {
	sharedWith := []J{}
	for _, share := range lst.Shares {
		if share.LeftAt != nil {
			continue // member has left — not an active share
		}
		var u models.User
		var email, name any = nil, nil
		if a.DB.Where("sub = ?", share.Sub).First(&u).Error == nil {
			email, name = strOrNil(u.Email), strOrNil(u.Name)
		}
		sharedWith = append(sharedWith, J{"sub": share.Sub, "email": email, "name": name})
	}
	tasks := make([]models.TrackerTask, len(lst.Tasks))
	copy(tasks, lst.Tasks)
	sort.SliceStable(tasks, func(i, j int) bool { return tasks[i].Position < tasks[j].Position })
	taskJSON := make([]J, 0, len(tasks))
	for i := range tasks {
		taskJSON = append(taskJSON, a.trackerTaskJSON(&tasks[i]))
	}
	ownerSub := lst.OwnerSub
	return J{
		"id":          lst.ID.String(),
		"name":        lst.Name,
		"icon":        strOrNil(lst.Icon),
		"color":       strOrNil(lst.Color),
		"position":    a.trackerUserPosition(lst.ID, currentSub, lst.Position),
		"owner_sub":   lst.OwnerSub,
		"owner_name":  strOrNilPtr(a.trackerFullName(&ownerSub)),
		"is_owner":    lst.OwnerSub == currentSub,
		"shared_with": sharedWith,
		"tasks":       taskJSON,
	}
}

// ----- access control & broadcasting -----

// trackerAudience mirrors _audience: owner + active shares.
func trackerAudience(lst *models.TrackerList) map[string]bool {
	audience := map[string]bool{lst.OwnerSub: true}
	for _, share := range lst.Shares {
		if share.LeftAt == nil {
			audience[share.Sub] = true
		}
	}
	return audience
}

// trackerBroadcast mirrors _broadcast: identical payload for every recipient.
// A "pushDetail" entry in extra customizes the push-notification body and is
// stripped before the payload goes out on the wire.
func (a *App) trackerBroadcast(lst *models.TrackerList, action string, extra J, r *http.Request, extraSubs ...string) {
	detail, _ := extra["pushDetail"].(string)
	delete(extra, "pushDetail")
	payload := J{"action": action}
	for k, v := range extra {
		payload[k] = v
	}
	audience := trackerAudience(lst)
	for _, sub := range extraSubs {
		audience[sub] = true
	}
	for sub := range audience {
		a.Broadcaster.BroadcastToUser(sub, "tracker.updated", payload, httpx.SourceID(r))
	}
	if detail == "" {
		detail = trackerPushDetail(action, extra)
	}
	a.queueTrackerEditPush(lst, action, detail, r)
}

// trackerPushDetail derives a verb phrase from the broadcast payload for
// actions where it carries the task; ambiguous sites pass pushDetail instead.
func trackerPushDetail(action string, extra J) string {
	taskName := ""
	if task, ok := extra["task"].(J); ok {
		taskName, _ = task["name"].(string)
	}
	switch {
	case taskName == "":
		return ""
	case action == "task-added":
		return "added “" + taskName + "”"
	case action == "task-updated":
		return "updated “" + taskName + "”"
	case action == "task-logged":
		return "completed “" + taskName + "”"
	}
	return ""
}

// queueTrackerEditPush fans a tracker edit out as a push notification to the
// list's audience except the actor. Reorders are cosmetic (and per-user for
// list order), so they don't notify.
func (a *App) queueTrackerEditPush(lst *models.TrackerList, action, detail string, r *http.Request) {
	if strings.Contains(action, "reorder") {
		return
	}
	actor := session.UserFrom(a.Sessions.Get(r))
	if actor == nil {
		return
	}
	a.Push.QueueTrackerEdit(lst.ID.String(), lst.Name, trackerAudience(lst), actor.Sub, displayName(actor), detail)
	a.logActivity("lists", detail, actor, lst)
}

// trackerBroadcastList mirrors _broadcast_list: full-list payload recomputed
// per recipient so a shared user never receives the owner's perspective.
func (a *App) trackerBroadcastList(lst *models.TrackerList, action, detail string, r *http.Request, extraSubs ...string) {
	audience := trackerAudience(lst)
	for _, sub := range extraSubs {
		audience[sub] = true
	}
	for sub := range audience {
		a.Broadcaster.BroadcastToUser(sub, "tracker.updated",
			J{"action": action, "list": a.trackerListJSON(lst, sub)}, httpx.SourceID(r))
	}
	if detail == "" {
		switch action {
		case "list-added":
			detail = "created “" + lst.Name + "”"
		case "list-deleted":
			detail = "deleted “" + lst.Name + "”"
		}
	}
	a.queueTrackerEditPush(lst, action, detail, r)
}

// trackerMemberName is a member's display name for notification phrasing.
func (a *App) trackerMemberName(sub string) string {
	if n := a.trackerFirstName(&sub); n != nil && *n != "" {
		return *n
	}
	return "a member"
}

// trackerGetList mirrors _get_list (load + access check).
func (a *App) trackerGetList(listID uuid.UUID, sub string, ownerOnly bool) (*models.TrackerList, error) {
	var lst models.TrackerList
	err := a.DB.Preload("Tasks").Preload("Shares").Where("id = ?", listID).First(&lst).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, httpx.NewHTTPError(http.StatusNotFound, "List not found")
	}
	if err != nil {
		return nil, err
	}
	hasShare := false
	for _, s := range lst.Shares {
		if s.Sub == sub && s.LeftAt == nil {
			hasShare = true
		}
	}
	if lst.OwnerSub != sub && !hasShare {
		return nil, httpx.NewHTTPError(http.StatusForbidden, "No access to this list")
	}
	if ownerOnly && lst.OwnerSub != sub {
		return nil, httpx.NewHTTPError(http.StatusForbidden, "Only the owner can do this")
	}
	return &lst, nil
}

// trackerGetTask mirrors _get_task (authorize via parent list).
func (a *App) trackerGetTask(taskID uuid.UUID, sub string) (*models.TrackerTask, error) {
	var task models.TrackerTask
	err := a.DB.Where("id = ?", taskID).First(&task).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, httpx.NewHTTPError(http.StatusNotFound, "Task not found")
	}
	if err != nil {
		return nil, err
	}
	if _, err := a.trackerGetList(task.ListID, sub, false); err != nil {
		return nil, err
	}
	return &task, nil
}

// ----- list endpoints -----

func (a *App) handleTrackerListLists(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	sub := user.Sub
	var owned []models.TrackerList
	if err := a.DB.Preload("Tasks").Preload("Shares").
		Where("owner_sub = ?", sub).Find(&owned).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	var shares []models.TrackerShare
	a.DB.Where("sub = ? AND left_at IS NULL", sub).Find(&shares)
	var shared []models.TrackerList
	if len(shares) > 0 {
		ids := make([]uuid.UUID, 0, len(shares))
		for _, s := range shares {
			ids = append(ids, s.ListID)
		}
		a.DB.Preload("Tasks").Preload("Shares").Where("id IN ?", ids).Find(&shared)
	}
	var positions []models.TrackerListPosition
	a.DB.Where("sub = ?", sub).Find(&positions)
	userPos := map[uuid.UUID]int{}
	for _, p := range positions {
		userPos[p.ListID] = p.Position
	}

	lists := append(owned, shared...)
	sort.SliceStable(lists, func(i, j int) bool {
		pi, pj := lists[i].Position, lists[j].Position
		if v, ok := userPos[lists[i].ID]; ok {
			pi = v
		}
		if v, ok := userPos[lists[j].ID]; ok {
			pj = v
		}
		if pi != pj {
			return pi < pj
		}
		return lists[i].Position < lists[j].Position
	})

	out := make([]J, 0, len(lists))
	for i := range lists {
		out = append(out, a.trackerListJSON(&lists[i], sub))
	}
	httpx.WriteJSON(w, 200, out)
}

func (a *App) handleTrackerCreateList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		Name  string  `json:"name"`
		Icon  *string `json:"icon"`
		Color *string `json:"color"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	var count int64
	a.DB.Model(&models.TrackerList{}).Where("owner_sub = ?", user.Sub).Count(&count)
	lst := models.TrackerList{
		OwnerSub: user.Sub,
		Name:     strings.TrimSpace(payload.Name),
		Icon:     payload.Icon,
		Color:    payload.Color,
		Position: int(count),
	}
	if err := a.DB.Create(&lst).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.DB.Preload("Tasks").Preload("Shares").Where("id = ?", lst.ID).First(&lst)
	data := a.trackerListJSON(&lst, user.Sub)
	a.trackerBroadcastList(&lst, "list-added", "", r)
	httpx.WriteJSON(w, http.StatusCreated, data)
}

func (a *App) handleTrackerRestoreList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		Name      string   `json:"name"`
		Icon      *string  `json:"icon"`
		Color     *string  `json:"color"`
		Position  *int     `json:"position"`
		ShareSubs []string `json:"share_subs"`
		Tasks     []struct {
			Name               string  `json:"name"`
			TargetIntervalDays *int    `json:"target_interval_days"`
			Notes              *string `json:"notes"`
			Position           int     `json:"position"`
			SeasonStartMonth   *int    `json:"season_start_month"`
			SeasonEndMonth     *int    `json:"season_end_month"`
			SeasonStartDay     *int    `json:"season_start_day"`
			SeasonEndDay       *int    `json:"season_end_day"`
			Logs               []struct {
				DoneAt       httpx.JSONTime `json:"done_at"`
				Kind         string         `json:"kind"`
				Note         *string        `json:"note"`
				CreatedBySub *string        `json:"created_by_sub"`
			} `json:"logs"`
		} `json:"tasks"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	sub := user.Sub
	var count int64
	a.DB.Model(&models.TrackerList{}).Where("owner_sub = ?", sub).Count(&count)
	position := int(count)
	if payload.Position != nil {
		position = *payload.Position
	}
	lst := models.TrackerList{
		OwnerSub: sub,
		Name:     strings.TrimSpace(payload.Name),
		Icon:     payload.Icon,
		Color:    payload.Color,
		Position: position,
	}
	err := a.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&lst).Error; err != nil {
			return err
		}
		// Pin the owner's personal position so their other devices place it correctly.
		if err := tx.Create(&models.TrackerListPosition{Sub: sub, ListID: lst.ID, Position: position}).Error; err != nil {
			return err
		}
		for _, shareSub := range payload.ShareSubs {
			if shareSub != "" && shareSub != sub {
				if err := tx.Create(&models.TrackerShare{ListID: lst.ID, Sub: shareSub}).Error; err != nil {
					return err
				}
			}
		}
		for _, t := range payload.Tasks {
			task := models.TrackerTask{
				ListID:             lst.ID,
				Name:               strings.TrimSpace(t.Name),
				TargetIntervalDays: t.TargetIntervalDays,
				Notes:              t.Notes,
				Position:           t.Position,
				SeasonStartMonth:   t.SeasonStartMonth,
				SeasonEndMonth:     t.SeasonEndMonth,
				SeasonStartDay:     t.SeasonStartDay,
				SeasonEndDay:       t.SeasonEndDay,
			}
			if err := tx.Create(&task).Error; err != nil {
				return err
			}
			for _, lg := range t.Logs {
				kind := "done"
				if lg.Kind == "skip" {
					kind = "skip"
				}
				doneAt := models.NowUTC()
				if lg.DoneAt.Valid {
					doneAt = lg.DoneAt.Time
				}
				createdBy := lg.CreatedBySub
				if createdBy == nil || *createdBy == "" {
					s := sub
					createdBy = &s
				}
				log := models.TrackerLog{TaskID: task.ID, DoneAt: doneAt, Kind: kind, Note: lg.Note, CreatedBySub: createdBy}
				if err := tx.Create(&log).Error; err != nil {
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
	a.DB.Preload("Tasks").Preload("Shares").Where("id = ?", lst.ID).First(&lst)
	data := a.trackerListJSON(&lst, sub)
	a.trackerBroadcastList(&lst, "list-added", "", r)
	httpx.WriteJSON(w, http.StatusCreated, data)
}

func (a *App) handleTrackerUpdateList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name  *string `json:"name"`
		Icon  *string `json:"icon"`
		Color *string `json:"color"`
	}
	present, err := httpx.DecodeBody(r, &payload)
	if err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	if payload.Name != nil && strings.TrimSpace(*payload.Name) == "" {
		httpx.ValidationError(w, "name must be non-empty")
		return
	}
	lst, lerr := a.trackerGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	oldListName := lst.Name
	updates := map[string]any{}
	if payload.Name != nil {
		lst.Name = strings.TrimSpace(*payload.Name)
		updates["name"] = lst.Name
	}
	if present["icon"] {
		lst.Icon = payload.Icon
		updates["icon"] = payload.Icon
	}
	if present["color"] {
		lst.Color = payload.Color
		updates["color"] = payload.Color
	}
	if len(updates) > 0 {
		updates["updated_at"] = models.NowUTC()
		if err := a.DB.Model(&models.TrackerList{}).Where("id = ?", lst.ID).Updates(updates).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	renameDetail := ""
	if payload.Name != nil && lst.Name != oldListName {
		renameDetail = "renamed “" + oldListName + "” to “" + lst.Name + "”"
	}
	data := a.trackerListJSON(lst, user.Sub)
	a.trackerBroadcastList(lst, "list-updated", renameDetail, r)
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handleTrackerDeleteList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var lst models.TrackerList
	if a.DB.Preload("Shares").Where("id = ?", listID).First(&lst).Error != nil {
		w.WriteHeader(http.StatusNoContent) // idempotent
		return
	}
	if lst.OwnerSub != user.Sub {
		httpx.Detail(w, http.StatusForbidden, "Only the owner can delete this list")
		return
	}
	audience := trackerAudience(&lst)
	// Capture task ids before the cascade delete so their per-task overrides
	// can be pruned from user settings too.
	var taskIDs []string
	a.DB.Model(&models.TrackerTask{}).Where("list_id = ?", lst.ID).Pluck("id", &taskIDs)
	if err := a.DB.Delete(&lst).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	payload := J{"action": "list-deleted", "listId": listID.String()}
	for member := range audience {
		a.Broadcaster.BroadcastToUser(member, "tracker.updated", payload, httpx.SourceID(r))
	}
	// lst.Shares was preloaded before the delete, so the push audience is intact.
	a.queueTrackerEditPush(&lst, "list-deleted", "deleted “"+lst.Name+"”", r)
	a.pruneNotifyOverrides([]string{listID.String()}, taskIDs, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleTrackerReorderLists(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		ListIDs []string `json:"list_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	sub := user.Sub
	ids, err := parseUUIDList(payload.ListIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	type applied struct {
		id  string
		pos int
	}
	var appliedList []applied
	for i, id := range ids {
		var lst models.TrackerList
		if a.DB.Where("id = ?", id).First(&lst).Error != nil {
			continue
		}
		hasAccess := lst.OwnerSub == sub
		if !hasAccess {
			var share models.TrackerShare
			// Any share row (even left) grants reorder access, mirroring Python.
			hasAccess = a.DB.Where("list_id = ? AND sub = ?", lst.ID, sub).First(&share).Error == nil
		}
		if !hasAccess {
			continue
		}
		var row models.TrackerListPosition
		if a.DB.Where("sub = ? AND list_id = ?", sub, lst.ID).First(&row).Error == nil {
			a.DB.Model(&models.TrackerListPosition{}).
				Where("sub = ? AND list_id = ?", sub, lst.ID).Update("position", i)
		} else {
			a.DB.Create(&models.TrackerListPosition{Sub: sub, ListID: lst.ID, Position: i})
		}
		appliedList = append(appliedList, applied{lst.ID.String(), i})
	}
	for _, ap := range appliedList {
		a.Broadcaster.BroadcastToUser(sub, "tracker.updated",
			J{"action": "list-reordered", "listId": ap.id, "position": ap.pos}, httpx.SourceID(r))
	}
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

// ----- sharing -----

func (a *App) handleTrackerAddShare(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Email *string `json:"email"`
		Sub   *string `json:"sub"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	lst, lerr := a.trackerGetList(listID, user.Sub, true)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	targetSub := ""
	if payload.Sub != nil {
		targetSub = *payload.Sub
	}
	if targetSub == "" && payload.Email != nil && *payload.Email != "" {
		var u models.User
		if a.DB.Where("LOWER(email) = ?", strings.ToLower(strings.TrimSpace(*payload.Email))).First(&u).Error != nil {
			httpx.Detail(w, http.StatusNotFound, "No user with that email has signed in yet")
			return
		}
		targetSub = u.Sub
	}
	if targetSub == "" {
		httpx.Detail(w, http.StatusBadRequest, "Provide an email or sub to share with")
		return
	}
	if targetSub == lst.OwnerSub {
		httpx.Detail(w, http.StatusBadRequest, "You already own this list")
		return
	}

	var existing models.TrackerShare
	serr := a.DB.Where("list_id = ? AND sub = ?", listID, targetSub).First(&existing).Error
	if errors.Is(serr, gorm.ErrRecordNotFound) {
		if err := a.DB.Create(&models.TrackerShare{ListID: listID, Sub: targetSub}).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	} else if serr == nil && existing.LeftAt != nil {
		if err := a.DB.Model(&existing).Update("left_at", nil).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	lst, lerr = a.trackerGetList(listID, user.Sub, true)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	data := a.trackerListJSON(lst, user.Sub)
	a.trackerBroadcastList(lst, "list-shared", "shared the list with "+a.trackerMemberName(targetSub), r, targetSub)
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handleTrackerRemoveShare(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	shareSub := r.PathValue("shareSub")
	lst, lerr := a.trackerGetList(listID, user.Sub, true)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	audienceBefore := trackerAudience(lst)
	var share models.TrackerShare
	if a.DB.Where("list_id = ? AND sub = ?", listID, shareSub).First(&share).Error == nil {
		if err := a.DB.Delete(&share).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
		lst, lerr = a.trackerGetList(listID, user.Sub, true)
		if lerr != nil {
			httpx.WriteError(w, lerr)
			return
		}
	}
	data := a.trackerListJSON(lst, user.Sub)
	a.trackerBroadcastList(lst, "list-updated", "removed "+a.trackerMemberName(shareSub)+" from the list", r)
	if audienceBefore[shareSub] {
		a.Broadcaster.BroadcastToUser(shareSub, "tracker.updated",
			J{"action": "list-deleted", "listId": listID.String()}, httpx.SourceID(r))
	}
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handleTrackerLeaveList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	sub := user.Sub
	var lst models.TrackerList
	if a.DB.Preload("Shares").Where("id = ?", listID).First(&lst).Error != nil {
		w.WriteHeader(http.StatusNoContent) // idempotent
		return
	}
	if lst.OwnerSub == sub {
		httpx.Detail(w, http.StatusBadRequest, "The owner can't leave their own list")
		return
	}
	var share models.TrackerShare
	if a.DB.Where("list_id = ? AND sub = ?", listID, sub).First(&share).Error != nil || share.LeftAt != nil {
		w.WriteHeader(http.StatusNoContent) // not an active member — idempotent
		return
	}
	now := models.NowUTC()
	if err := a.DB.Model(&share).Update("left_at", now).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.DB.Preload("Tasks").Preload("Shares").Where("id = ?", listID).First(&lst)
	a.trackerBroadcastList(&lst, "list-updated", "left the list", r)
	a.Broadcaster.BroadcastToUser(sub, "tracker.updated",
		J{"action": "list-deleted", "listId": listID.String()}, httpx.SourceID(r))
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleTrackerRejoinList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	sub := user.Sub
	var lst models.TrackerList
	if a.DB.Preload("Tasks").Preload("Shares").Where("id = ?", listID).First(&lst).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "List not found")
		return
	}
	var share models.TrackerShare
	if a.DB.Where("list_id = ? AND sub = ?", listID, sub).First(&share).Error != nil {
		httpx.Detail(w, http.StatusForbidden, "You were not a member of this list")
		return
	}
	if share.LeftAt != nil {
		if err := a.DB.Model(&share).Update("left_at", nil).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
		a.DB.Preload("Tasks").Preload("Shares").Where("id = ?", listID).First(&lst)
	}
	data := a.trackerListJSON(&lst, sub)
	a.trackerBroadcastList(&lst, "list-shared", "rejoined the list", r, sub)
	httpx.WriteJSON(w, 200, data)
}

// ----- task endpoints -----

func (a *App) handleTrackerCreateTask(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		ListID             string  `json:"list_id"`
		Name               string  `json:"name"`
		TargetIntervalDays *int    `json:"target_interval_days"`
		Notes              *string `json:"notes"`
		SeasonStartMonth   *int    `json:"season_start_month"`
		SeasonEndMonth     *int    `json:"season_end_month"`
		SeasonStartDay     *int    `json:"season_start_day"`
		SeasonEndDay       *int    `json:"season_end_day"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	if err := validateTaskFields(payload.TargetIntervalDays, payload.SeasonStartMonth, payload.SeasonEndMonth, payload.SeasonStartDay, payload.SeasonEndDay); err != nil {
		httpx.WriteError(w, err)
		return
	}
	listID, err := httpx.ParseUUID(payload.ListID)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	lst, lerr := a.trackerGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	var maxPos struct{ Position int }
	nextPos := 0
	if a.DB.Model(&models.TrackerTask{}).Where("list_id = ?", listID).
		Order("position DESC").Limit(1).Scan(&maxPos).RowsAffected > 0 {
		nextPos = maxPos.Position + 1
	}
	task := models.TrackerTask{
		ListID:             listID,
		Name:               strings.TrimSpace(payload.Name),
		TargetIntervalDays: payload.TargetIntervalDays,
		Notes:              payload.Notes,
		Position:           nextPos,
		SeasonStartMonth:   payload.SeasonStartMonth,
		SeasonEndMonth:     payload.SeasonEndMonth,
		SeasonStartDay:     payload.SeasonStartDay,
		SeasonEndDay:       payload.SeasonEndDay,
	}
	if err := a.DB.Create(&task).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	data := a.trackerTaskJSON(&task)
	a.trackerBroadcast(lst, "task-added", J{"listId": lst.ID.String(), "task": data}, r)
	httpx.WriteJSON(w, http.StatusCreated, data)
}

func validateTaskFields(interval, ssm, sem, ssd, sed *int) error {
	if interval != nil && *interval < 1 {
		return httpx.NewHTTPError(http.StatusUnprocessableEntity, "target_interval_days must be >= 1")
	}
	for _, m := range []*int{ssm, sem} {
		if m != nil && (*m < 1 || *m > 12) {
			return httpx.NewHTTPError(http.StatusUnprocessableEntity, "month must be between 1 and 12")
		}
	}
	for _, d := range []*int{ssd, sed} {
		if d != nil && (*d < 1 || *d > 31) {
			return httpx.NewHTTPError(http.StatusUnprocessableEntity, "day must be between 1 and 31")
		}
	}
	return nil
}

func (a *App) handleTrackerUpdateTask(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	taskID, err := httpx.ParseUUID(r.PathValue("taskId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name               *string        `json:"name"`
		TargetIntervalDays *int           `json:"target_interval_days"`
		Notes              *string        `json:"notes"`
		Archived           *bool          `json:"archived"`
		SeasonStartMonth   *int           `json:"season_start_month"`
		SeasonEndMonth     *int           `json:"season_end_month"`
		SeasonStartDay     *int           `json:"season_start_day"`
		SeasonEndDay       *int           `json:"season_end_day"`
		SnoozeUntil        httpx.JSONTime `json:"snooze_until"`
	}
	present, err := httpx.DecodeBody(r, &payload)
	if err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	if payload.Name != nil && strings.TrimSpace(*payload.Name) == "" {
		httpx.ValidationError(w, "name must be non-empty")
		return
	}
	if err := validateTaskFields(payload.TargetIntervalDays, payload.SeasonStartMonth, payload.SeasonEndMonth, payload.SeasonStartDay, payload.SeasonEndDay); err != nil {
		httpx.WriteError(w, err)
		return
	}
	task, terr := a.trackerGetTask(taskID, user.Sub)
	if terr != nil {
		httpx.WriteError(w, terr)
		return
	}
	updates := map[string]any{}
	if payload.Name != nil {
		updates["name"] = strings.TrimSpace(*payload.Name)
	}
	if present["target_interval_days"] {
		updates["target_interval_days"] = payload.TargetIntervalDays
	}
	if present["notes"] {
		updates["notes"] = payload.Notes
	}
	if payload.Archived != nil {
		updates["archived"] = *payload.Archived
	}
	if present["season_start_month"] {
		updates["season_start_month"] = payload.SeasonStartMonth
	}
	if present["season_end_month"] {
		updates["season_end_month"] = payload.SeasonEndMonth
	}
	if present["season_start_day"] {
		updates["season_start_day"] = payload.SeasonStartDay
	}
	if present["season_end_day"] {
		updates["season_end_day"] = payload.SeasonEndDay
	}
	if present["snooze_until"] {
		updates["snooze_until"] = payload.SnoozeUntil.Ptr()
	}
	if len(updates) > 0 {
		updates["updated_at"] = models.NowUTC()
		if err := a.DB.Model(&models.TrackerTask{}).Where("id = ?", task.ID).Updates(updates).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	a.DB.Where("id = ?", taskID).First(task)
	lst, lerr := a.trackerGetList(task.ListID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	data := a.trackerTaskJSON(task)
	taskExtra := J{"listId": lst.ID.String(), "task": data}
	if payload.Archived != nil {
		if *payload.Archived {
			taskExtra["pushDetail"] = "archived “" + task.Name + "”"
		} else {
			taskExtra["pushDetail"] = "restored “" + task.Name + "”"
		}
	}
	a.trackerBroadcast(lst, "task-updated", taskExtra, r)
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handleTrackerDeleteTask(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	taskID, err := httpx.ParseUUID(r.PathValue("taskId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var task models.TrackerTask
	if a.DB.Where("id = ?", taskID).First(&task).Error != nil {
		w.WriteHeader(http.StatusNoContent) // idempotent
		return
	}
	lst, lerr := a.trackerGetList(task.ListID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	if err := a.DB.Delete(&task).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.trackerBroadcast(lst, "task-deleted", J{
		"listId": task.ListID.String(), "taskId": taskID.String(),
		"pushDetail": "deleted “" + task.Name + "”",
	}, r)
	a.pruneNotifyOverrides(nil, []string{taskID.String()}, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleTrackerReorderTasks(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		TaskIDs []string `json:"task_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	lst, lerr := a.trackerGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	ids, err := parseUUIDList(payload.TaskIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		a.DB.Model(&models.TrackerTask{}).
			Where("id = ? AND list_id = ?", id, listID).Update("position", i)
	}
	var tasks []models.TrackerTask
	a.DB.Where("list_id = ?", listID).Order("position ASC").Find(&tasks)
	positions := make([]J, 0, len(tasks))
	for _, t := range tasks {
		positions = append(positions, J{"id": t.ID.String(), "position": t.Position})
	}
	a.trackerBroadcast(lst, "tasks-reordered", J{"listId": listID.String(), "tasks": positions}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

// ----- completion logs -----

func (a *App) handleTrackerListLogs(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	taskID, err := httpx.ParseUUID(r.PathValue("taskId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	task, terr := a.trackerGetTask(taskID, user.Sub)
	if terr != nil {
		httpx.WriteError(w, terr)
		return
	}
	var logs []models.TrackerLog
	a.DB.Where("task_id = ?", task.ID).Order("done_at DESC").Find(&logs)
	out := make([]J, 0, len(logs))
	for i := range logs {
		out = append(out, a.trackerLogJSON(&logs[i]))
	}
	httpx.WriteJSON(w, 200, out)
}

func (a *App) handleTrackerAddLog(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	taskID, err := httpx.ParseUUID(r.PathValue("taskId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		DoneAt       httpx.JSONTime `json:"done_at"`
		Kind         string         `json:"kind"`
		Note         *string        `json:"note"`
		CreatedBySub *string        `json:"created_by_sub"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	task, terr := a.trackerGetTask(taskID, user.Sub)
	if terr != nil {
		httpx.WriteError(w, terr)
		return
	}
	attributed := user.Sub
	if payload.CreatedBySub != nil && *payload.CreatedBySub != "" {
		attributed = *payload.CreatedBySub
	}
	kind := "done"
	if payload.Kind == "skip" {
		kind = "skip"
	}
	doneAt := models.NowUTC()
	if payload.DoneAt.Valid {
		doneAt = payload.DoneAt.Time
	}
	log := models.TrackerLog{
		TaskID: taskID, DoneAt: doneAt, Kind: kind, Note: payload.Note, CreatedBySub: &attributed,
	}
	if err := a.DB.Create(&log).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	lst, lerr := a.trackerGetList(task.ListID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	verb := "completed"
	if kind == "skip" {
		verb = "skipped"
	}
	a.trackerBroadcast(lst, "task-logged", J{
		"listId": lst.ID.String(), "task": a.trackerTaskJSON(task),
		"pushDetail": verb + " “" + task.Name + "”",
	}, r)
	httpx.WriteJSON(w, http.StatusCreated, a.trackerLogJSON(&log))
}

func (a *App) handleTrackerSkipTask(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	taskID, err := httpx.ParseUUID(r.PathValue("taskId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	task, terr := a.trackerGetTask(taskID, user.Sub)
	if terr != nil {
		httpx.WriteError(w, terr)
		return
	}
	sub := user.Sub
	log := models.TrackerLog{TaskID: taskID, DoneAt: models.NowUTC(), Kind: "skip", CreatedBySub: &sub}
	if err := a.DB.Create(&log).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	lst, lerr := a.trackerGetList(task.ListID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	data := a.trackerTaskJSON(task)
	a.trackerBroadcast(lst, "task-updated", J{
		"listId": lst.ID.String(), "task": data,
		"pushDetail": "skipped “" + task.Name + "” this cycle",
	}, r)
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handleTrackerDeleteLog(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	logID, err := httpx.ParseUUID(r.PathValue("logId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var log models.TrackerLog
	if a.DB.Where("id = ?", logID).First(&log).Error != nil {
		w.WriteHeader(http.StatusNoContent) // idempotent
		return
	}
	task, terr := a.trackerGetTask(log.TaskID, user.Sub)
	if terr != nil {
		httpx.WriteError(w, terr)
		return
	}
	if err := a.DB.Delete(&log).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	lst, lerr := a.trackerGetList(task.ListID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	a.trackerBroadcast(lst, "task-logged", J{
		"listId": lst.ID.String(), "task": a.trackerTaskJSON(task),
		"pushDetail": "removed a completion of “" + task.Name + "”",
	}, r)
	w.WriteHeader(http.StatusNoContent)
}
