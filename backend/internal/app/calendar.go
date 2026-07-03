package app

import (
	"net/http"
	"time"

	"github.com/google/uuid"

	"mealplanner/internal/httpx"
	"mealplanner/internal/ical"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

func (a *App) handleCacheStatus(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var meta models.CalendarCacheMetadata
	if a.DB.First(&meta).Error != nil {
		httpx.WriteJSON(w, 200, J{
			"last_refresh": nil, "cache_start": nil, "cache_end": nil,
			"is_refreshing": a.Calendar.IsRefreshing(),
		})
		return
	}
	var lastRefresh any
	if meta.LastRefresh != nil {
		// Z suffix so the frontend parses this as UTC.
		lastRefresh = httpx.FormatDateTime(*meta.LastRefresh) + "Z"
	}
	var cacheStart, cacheEnd any
	if meta.CacheStart != nil {
		cacheStart = httpx.FormatDate(*meta.CacheStart)
	}
	if meta.CacheEnd != nil {
		cacheEnd = httpx.FormatDate(*meta.CacheEnd)
	}
	httpx.WriteJSON(w, 200, J{
		"last_refresh": lastRefresh, "cache_start": cacheStart, "cache_end": cacheEnd,
		"is_refreshing": a.Calendar.IsRefreshing(),
	})
}

// doRefreshAndBroadcast mirrors calendar._do_refresh_and_broadcast. The
// caller must have claimed the refresh flag via TryStartRefresh.
func (a *App) doRefreshAndBroadcast() {
	defer a.Calendar.SetRefreshing(false)

	a.Calendar.RefreshDBCache()

	start, end := ical.CacheRange()
	events := a.Calendar.GetEventsFromDB(start, end)

	eventsByDate := J{}
	for current := start; !current.After(end); current = current.AddDate(0, 0, 1) {
		dayEvents := ical.GetEventsForDate(events, current)
		if len(dayEvents) > 0 {
			eventsByDate[httpx.FormatDate(current)] = dayEvents
		}
	}

	var lastRefresh any
	var meta models.CalendarCacheMetadata
	if a.DB.First(&meta).Error == nil && meta.LastRefresh != nil {
		lastRefresh = httpx.FormatDateTime(*meta.LastRefresh)
	}

	a.Broadcaster.BroadcastEvent("calendar.refreshed", J{
		"events_by_date": eventsByDate,
		"cache_start":    httpx.FormatDate(start),
		"cache_end":      httpx.FormatDate(end),
		"last_refresh":   lastRefresh,
	}, "")
}

func (a *App) handleCalendarRefresh(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	if !a.Calendar.TryStartRefresh() {
		httpx.WriteJSON(w, 200, J{"message": "Refresh already in progress"})
		return
	}
	go a.doRefreshAndBroadcast()
	httpx.WriteJSON(w, 200, J{"message": "Refresh started"})
}

func (a *App) handleCalendarList(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	available := a.Calendar.ListAvailableCalendars()
	selected := []string{}
	for _, cal := range a.Calendar.SelectedCalendars() {
		selected = append(selected, cal.Name)
	}
	httpx.WriteJSON(w, 200, J{"available": available, "selected": selected})
}

func (a *App) handleListHidden(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var hidden []models.HiddenCalendarEvent
	if err := a.DB.Order("start_time DESC").Find(&hidden).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]J, 0, len(hidden))
	for i := range hidden {
		out = append(out, hiddenEventJSON(&hidden[i]))
	}
	httpx.WriteJSON(w, 200, out)
}

func (a *App) handleHideEvent(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		EventUID     *string        `json:"event_uid"`
		CalendarName string         `json:"calendar_name"`
		Title        *string        `json:"title"`
		StartTime    httpx.JSONTime `json:"start_time"`
		EndTime      httpx.JSONTime `json:"end_time"`
		AllDay       bool           `json:"all_day"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil ||
		payload.EventUID == nil || payload.Title == nil || !payload.StartTime.Valid {
		httpx.ValidationError(w, "event_uid, title and start_time are required")
		return
	}
	st := payload.StartTime.Time
	eventDate := time.Date(st.Year(), st.Month(), st.Day(), 0, 0, 0, 0, time.UTC)

	var existing models.HiddenCalendarEvent
	err := a.DB.Where("event_uid = ? AND start_time = ? AND calendar_name = ?",
		*payload.EventUID, payload.StartTime.Time, payload.CalendarName).First(&existing).Error
	if err == nil {
		httpx.WriteJSON(w, 200, hiddenEventJSON(&existing))
		return
	}

	hidden := models.HiddenCalendarEvent{
		EventUID:     *payload.EventUID,
		EventDate:    eventDate,
		CalendarName: payload.CalendarName,
		Title:        *payload.Title,
		StartTime:    payload.StartTime.Time,
		EndTime:      payload.EndTime.Ptr(),
		AllDay:       payload.AllDay,
	}
	if err := a.DB.Create(&hidden).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("calendar.hidden", J{
		"hidden_id":     hidden.ID.String(),
		"event_id":      ical.EventKey(*payload.EventUID, payload.CalendarName, payload.StartTime.Time),
		"event_uid":     *payload.EventUID,
		"calendar_name": payload.CalendarName,
		"start_time":    httpx.FormatDateTime(payload.StartTime.Time),
		"end_time":      httpx.FormatDateTimePtr(payload.EndTime.Ptr()),
		"all_day":       payload.AllDay,
		"title":         *payload.Title,
	}, r)
	httpx.WriteJSON(w, 200, hiddenEventJSON(&hidden))
}

func (a *App) handleUnhideEvent(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	hiddenID, err := uuid.Parse(r.PathValue("hiddenId"))
	if err != nil {
		httpx.WriteJSON(w, 200, J{"status": "not_found"})
		return
	}
	var hidden models.HiddenCalendarEvent
	if a.DB.Where("id = ?", hiddenID).First(&hidden).Error != nil {
		httpx.WriteJSON(w, 200, J{"status": "not_found"})
		return
	}
	eventID := ical.EventKey(hidden.EventUID, hidden.CalendarName, hidden.StartTime)
	startTime := httpx.FormatDateTime(hidden.StartTime)
	endTime := httpx.FormatDateTimePtr(hidden.EndTime)
	allDay := hidden.AllDay
	if err := a.DB.Delete(&hidden).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("calendar.unhidden", J{
		"hidden_id":     hiddenID.String(),
		"event_id":      eventID,
		"event_uid":     hidden.EventUID,
		"calendar_name": hidden.CalendarName,
		"start_time":    startTime,
		"end_time":      endTime,
		"all_day":       allDay,
	}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}
