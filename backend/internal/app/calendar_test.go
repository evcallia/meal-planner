package app

// Port of backend/tests/test_calendar_api.py.
//
// Python patched ical_service/router internals with unittest.mock; here we use
// the ical.Service test seams (FetchCalDAVEvents / ListCalendarsFn) and the
// SSE broadcaster instead. POST /api/calendar/refresh runs the refresh in a
// goroutine, so broadcast assertions wait on a subscriber channel with a
// deadline rather than asserting immediately.

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"mealplanner/internal/httpx"
	"mealplanner/internal/ical"
	"mealplanner/internal/models"
	"mealplanner/internal/realtime"
)

func utcDate(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func utcDateTime(y int, m time.Month, d, hh, mm int) time.Time {
	return time.Date(y, m, d, hh, mm, 0, 0, time.UTC)
}

func todayMidnightUTC() time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
}

// waitForBroadcast blocks until an event of the given type arrives (the
// refresh endpoint broadcasts from a goroutine), failing after the timeout.
func waitForBroadcast(t *testing.T, ta *testApp, sub *realtime.Subscriber, eventType string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case msg := <-sub.Ch:
			trimmed := strings.TrimSpace(strings.TrimPrefix(msg, "data: "))
			var v map[string]any
			if json.Unmarshal([]byte(trimmed), &v) == nil && v["type"] == eventType {
				ta.App.Broadcaster.Unsubscribe(sub)
				payload, _ := v["payload"].(map[string]any)
				return payload
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q broadcast", eventType)
			return nil
		}
	}
}

// ---- TestCalendarCacheStatusAPI ----

func TestGetCacheStatusEmpty(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/calendar/cache-status")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["last_refresh"] != nil {
		t.Fatalf("last_refresh = %v, want nil", data["last_refresh"])
	}
	if data["cache_start"] != nil {
		t.Fatalf("cache_start = %v, want nil", data["cache_start"])
	}
	if data["cache_end"] != nil {
		t.Fatalf("cache_end = %v, want nil", data["cache_end"])
	}
	if data["is_refreshing"] != false {
		t.Fatalf("is_refreshing = %v, want false", data["is_refreshing"])
	}
}

func TestGetCacheStatusWithMetadata(t *testing.T) {
	ta := newTestApp(t)
	lastRefresh := utcDateTime(2024, 2, 15, 12, 0)
	cacheStart := utcDate(2024, 1, 15)
	cacheEnd := utcDate(2024, 4, 15)
	meta := models.CalendarCacheMetadata{
		ID: 1, LastRefresh: &lastRefresh, CacheStart: &cacheStart, CacheEnd: &cacheEnd,
	}
	if err := ta.App.DB.Create(&meta).Error; err != nil {
		t.Fatalf("seed metadata: %v", err)
	}

	resp := ta.GET("/api/calendar/cache-status")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	lr, _ := data["last_refresh"].(string)
	if lr == "" {
		t.Fatalf("last_refresh = %v, want non-nil", data["last_refresh"])
	}
	if !strings.HasSuffix(lr, "Z") {
		t.Fatalf("last_refresh = %q, want Z suffix", lr)
	}
	if data["cache_start"] != "2024-01-15" {
		t.Fatalf("cache_start = %v, want 2024-01-15", data["cache_start"])
	}
	if data["cache_end"] != "2024-04-15" {
		t.Fatalf("cache_end = %v, want 2024-04-15", data["cache_end"])
	}
	if data["is_refreshing"] != false {
		t.Fatalf("is_refreshing = %v, want false", data["is_refreshing"])
	}
}

func TestGetCacheStatusRequiresAuth(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/calendar/cache-status", nil)
	if resp.Status != 401 {
		t.Fatalf("status = %d, want 401: %s", resp.Status, resp.Body)
	}
}

// ---- TestCalendarRefreshAPI ----

func TestRefreshCalendar(t *testing.T) {
	ta := newTestApp(t)
	sub := ta.App.Broadcaster.Subscribe(TestSub)

	resp := ta.POST("/api/calendar/refresh", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["message"] != "Refresh started" {
		t.Fatalf("message = %v, want %q", resp.Obj()["message"], "Refresh started")
	}
	// Wait for the background refresh to finish so its goroutine doesn't leak
	// DB work past the end of the test.
	waitForBroadcast(t, ta, sub, "calendar.refreshed", 2*time.Second)
}

func TestRefreshCalendarAlreadyInProgress(t *testing.T) {
	ta := newTestApp(t)
	ta.App.Calendar.SetRefreshing(true)

	resp := ta.POST("/api/calendar/refresh", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["message"] != "Refresh already in progress" {
		t.Fatalf("message = %v, want %q", resp.Obj()["message"], "Refresh already in progress")
	}
}

func TestRefreshCalendarRequiresAuth(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("POST", "/api/calendar/refresh", nil)
	if resp.Status != 401 {
		t.Fatalf("status = %d, want 401: %s", resp.Status, resp.Body)
	}
}

// ---- TestCalendarRefreshBroadcast ----

func TestRefreshBroadcastIncludesCacheBounds(t *testing.T) {
	ta := newTestApp(t)
	sub := ta.App.Broadcaster.Subscribe(TestSub)

	resp := ta.POST("/api/calendar/refresh", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}

	payload := waitForBroadcast(t, ta, sub, "calendar.refreshed", 2*time.Second)
	if _, ok := payload["events_by_date"]; !ok {
		t.Fatalf("events_by_date missing from payload: %v", payload)
	}
	start, _ := payload["cache_start"].(string)
	end, _ := payload["cache_end"].(string)
	if start == "" {
		t.Fatal("cache_start is nil")
	}
	if end == "" {
		t.Fatal("cache_end is nil")
	}
	if !(start < end) {
		t.Fatalf("cache_start %q not before cache_end %q", start, end)
	}
}

// ---- TestCalendarCacheIntegration ----

func TestCacheStatusReflectsCachedEvents(t *testing.T) {
	ta := newTestApp(t)
	today := todayMidnightUTC()

	lastRefresh := models.NowUTC()
	cacheStart := today.AddDate(0, 0, -7*4)
	cacheEnd := today.AddDate(0, 0, 7*8)
	meta := models.CalendarCacheMetadata{
		ID: 1, LastRefresh: &lastRefresh, CacheStart: &cacheStart, CacheEnd: &cacheEnd,
	}
	if err := ta.App.DB.Create(&meta).Error; err != nil {
		t.Fatalf("seed metadata: %v", err)
	}
	events := []models.CachedCalendarEvent{
		{EventDate: today, Title: "Event 1", StartTime: today.Add(10 * time.Hour), AllDay: false},
		{EventDate: today.AddDate(0, 0, 1), Title: "Event 2",
			StartTime: today.AddDate(0, 0, 1).Add(14 * time.Hour), AllDay: false},
	}
	for i := range events {
		if err := ta.App.DB.Create(&events[i]).Error; err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}

	resp := ta.GET("/api/calendar/cache-status")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["last_refresh"] == nil {
		t.Fatal("last_refresh is nil")
	}
	if data["cache_start"] != httpx.FormatDate(cacheStart) {
		t.Fatalf("cache_start = %v, want %s", data["cache_start"], httpx.FormatDate(cacheStart))
	}
	if data["cache_end"] != httpx.FormatDate(cacheEnd) {
		t.Fatalf("cache_end = %v, want %s", data["cache_end"], httpx.FormatDate(cacheEnd))
	}
}

func TestEventsServedFromCache(t *testing.T) {
	ta := newTestApp(t)
	today := todayMidnightUTC()

	lastRefresh := models.NowUTC()
	cacheStart := today.AddDate(0, 0, -7*4)
	cacheEnd := today.AddDate(0, 0, 7*8)
	meta := models.CalendarCacheMetadata{
		ID: 1, LastRefresh: &lastRefresh, CacheStart: &cacheStart, CacheEnd: &cacheEnd,
	}
	if err := ta.App.DB.Create(&meta).Error; err != nil {
		t.Fatalf("seed metadata: %v", err)
	}
	endTime := today.Add(11 * time.Hour)
	event := models.CachedCalendarEvent{
		EventDate: today, Title: "Cached Event",
		StartTime: today.Add(10 * time.Hour), EndTime: &endTime, AllDay: false,
	}
	if err := ta.App.DB.Create(&event).Error; err != nil {
		t.Fatalf("seed event: %v", err)
	}

	todayStr := httpx.FormatDate(today)
	resp := ta.GET(fmt.Sprintf("/api/days/events?start_date=%s&end_date=%s", todayStr, todayStr))
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	dayEvents, ok := data[todayStr].([]any)
	if !ok {
		t.Fatalf("no events under %s: %v", todayStr, data)
	}
	if len(dayEvents) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(dayEvents))
	}
	if title := dayEvents[0].(map[string]any)["title"]; title != "Cached Event" {
		t.Fatalf("title = %v, want %q", title, "Cached Event")
	}
}

// ---- TestCalendarListAPI ----

func TestListCalendars(t *testing.T) {
	ta := newTestApp(t)
	// Python mocked list_available_calendars_sync and
	// _get_selected_calendars_sync; here the CalDAV listing seam plus the
	// selected-names setting produce the same available/selected split.
	ta.App.Settings.AppleCalendarNames = "Personal,Work"
	ta.App.Calendar.ListCalendarsFn = func() ([]ical.Calendar, error) {
		return []ical.Calendar{{Name: "Personal"}, {Name: "Work"}, {Name: "Family"}}, nil
	}

	resp := ta.GET("/api/calendar/list")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	available, _ := data["available"].([]any)
	if len(available) != 3 || available[0] != "Personal" || available[1] != "Work" || available[2] != "Family" {
		t.Fatalf("available = %v", available)
	}
	selected, _ := data["selected"].([]any)
	got := map[any]bool{}
	for _, s := range selected {
		got[s] = true
	}
	if len(got) != 2 || !got["Personal"] || !got["Work"] {
		t.Fatalf("selected = %v, want {Personal, Work}", selected)
	}
}

func TestListCalendarsRequiresAuth(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/calendar/list", nil)
	if resp.Status != 401 {
		t.Fatalf("status = %d, want 401: %s", resp.Status, resp.Body)
	}
}

// ---- TestDoRefreshAndBroadcast ----

func TestDoRefreshBroadcastsEvents(t *testing.T) {
	ta := newTestApp(t)
	today := todayMidnightUTC()
	endTime := today.Add(11 * time.Hour)
	ta.App.Calendar.FetchCalDAVEvents = func(start, end time.Time) []ical.EventWithSource {
		return []ical.EventWithSource{{
			CalendarName: "Personal",
			Event: ical.Event{
				UID: "uid-refresh", CalendarName: "Personal", Title: "Test Event",
				StartTime: today.Add(10 * time.Hour), EndTime: &endTime, AllDay: false,
			},
		}}
	}
	sub := ta.App.Broadcaster.Subscribe(TestSub)

	// Direct call, mirroring the Python test invoking _do_refresh_and_broadcast.
	ta.App.doRefreshAndBroadcast()

	// The refresh cached the event...
	var count int64
	ta.App.DB.Model(&models.CachedCalendarEvent{}).Where("title = ?", "Test Event").Count(&count)
	if count != 1 {
		t.Fatalf("cached events = %d, want 1", count)
	}
	// ...and broadcast it under today's date.
	payload := waitForBroadcast(t, ta, sub, "calendar.refreshed", 2*time.Second)
	byDate, _ := payload["events_by_date"].(map[string]any)
	dayEvents, _ := byDate[httpx.FormatDate(today)].([]any)
	if len(dayEvents) != 1 {
		t.Fatalf("events for today = %v", byDate)
	}
	if title := dayEvents[0].(map[string]any)["title"]; title != "Test Event" {
		t.Fatalf("title = %v", title)
	}
	if payload["last_refresh"] == nil {
		t.Fatal("last_refresh missing from broadcast payload")
	}
	if ta.App.Calendar.IsRefreshing() {
		t.Fatal("refresh flag still set after completion")
	}
}

// ---- TestRefreshBroadcastMultidayEvents ----

func TestRefreshBroadcastExpandsMultidayEvents(t *testing.T) {
	ta := newTestApp(t)
	startDay := todayMidnightUTC()
	end := startDay.AddDate(0, 0, 3) // all-day exclusive end => spans 3 days
	ta.App.Calendar.FetchCalDAVEvents = func(s, e time.Time) []ical.EventWithSource {
		return []ical.EventWithSource{{
			CalendarName: "Personal",
			Event: ical.Event{
				UID: "uid-1", CalendarName: "Personal", Title: "Camping Trip",
				StartTime: startDay, EndTime: &end, AllDay: true,
			},
		}}
	}
	sub := ta.App.Broadcaster.Subscribe(TestSub)

	resp := ta.POST("/api/calendar/refresh", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}

	payload := waitForBroadcast(t, ta, sub, "calendar.refreshed", 2*time.Second)
	byDate, _ := payload["events_by_date"].(map[string]any)
	d0 := httpx.FormatDate(startDay)
	d1 := httpx.FormatDate(startDay.AddDate(0, 0, 1))
	d2 := httpx.FormatDate(startDay.AddDate(0, 0, 2))
	d3 := httpx.FormatDate(startDay.AddDate(0, 0, 3))
	for _, d := range []string{d0, d1, d2} {
		if _, ok := byDate[d]; !ok {
			t.Fatalf("day %s missing from events_by_date: %v", d, byDate)
		}
	}
	if _, ok := byDate[d3]; ok {
		t.Fatalf("day %s should not appear (exclusive all-day end)", d3)
	}
	d1Events, _ := byDate[d1].([]any)
	if len(d1Events) == 0 || d1Events[0].(map[string]any)["title"] != "Camping Trip" {
		t.Fatalf("day 1 events = %v", byDate[d1])
	}
}

// ---- TestCacheStatusWithNullFields ----

func TestCacheStatusWithNullLastRefresh(t *testing.T) {
	ta := newTestApp(t)
	today := todayMidnightUTC()
	meta := models.CalendarCacheMetadata{ID: 1, CacheStart: &today, CacheEnd: &today}
	if err := ta.App.DB.Create(&meta).Error; err != nil {
		t.Fatalf("seed metadata: %v", err)
	}

	resp := ta.GET("/api/calendar/cache-status")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["last_refresh"] != nil {
		t.Fatalf("last_refresh = %v, want nil", resp.Obj()["last_refresh"])
	}
}

func TestCacheStatusWithNullDates(t *testing.T) {
	ta := newTestApp(t)
	lastRefresh := models.NowUTC()
	meta := models.CalendarCacheMetadata{ID: 1, LastRefresh: &lastRefresh}
	if err := ta.App.DB.Create(&meta).Error; err != nil {
		t.Fatalf("seed metadata: %v", err)
	}

	resp := ta.GET("/api/calendar/cache-status")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["cache_start"] != nil {
		t.Fatalf("cache_start = %v, want nil", data["cache_start"])
	}
	if data["cache_end"] != nil {
		t.Fatalf("cache_end = %v, want nil", data["cache_end"])
	}
}
