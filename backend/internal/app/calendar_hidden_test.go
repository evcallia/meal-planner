package app

// Per-user hidden calendar events: hiding an event affects only the user who
// hid it — not other household members.

import (
	"encoding/json"
	"testing"
	"time"

	"mealplanner/internal/models"
)

func hidePayload(uid, title string, start time.Time) map[string]any {
	return map[string]any{
		"event_uid":     uid,
		"calendar_name": "TestCal",
		"title":         title,
		"start_time":    start.Format("2006-01-02T15:04:05"),
		"all_day":       false,
	}
}

func TestHiddenEventsArePerUser(t *testing.T) {
	ta := newTestApp(t)
	cookieB := ta.LoginAs("wife-sub", "wife@example.com", "Wife")
	start := time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC)
	day := time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC)
	seedCalendarCache(t, ta, day.AddDate(0, 0, -28), day.AddDate(0, 0, 56), models.CachedCalendarEvent{
		EventDate: day, EventUID: "evt-1", CalendarName: "TestCal", Title: "Dentist", StartTime: start,
	})

	// User A hides the event.
	res := ta.POST("/api/calendar/hidden", hidePayload("evt-1", "Dentist", start))
	if res.Status != 200 {
		t.Fatalf("hide status %d: %s", res.Status, res.Body)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &created)

	// A's hidden list has it; B's is empty.
	var listA, listB []map[string]any
	_ = json.Unmarshal(ta.GET("/api/calendar/hidden").Body, &listA)
	_ = json.Unmarshal(ta.do("GET", "/api/calendar/hidden", nil, cookieB).Body, &listB)
	if len(listA) != 1 || len(listB) != 0 {
		t.Fatalf("expected A=1 B=0 hidden, got A=%d B=%d", len(listA), len(listB))
	}

	// The event is filtered from A's calendar but still visible to B.
	dateStr := "2026-07-20"
	query := "/api/days/events?start_date=" + dateStr + "&end_date=" + dateStr
	var eventsA, eventsB map[string][]map[string]any
	_ = json.Unmarshal(ta.GET(query).Body, &eventsA)
	_ = json.Unmarshal(ta.do("GET", query, nil, cookieB).Body, &eventsB)
	if len(eventsA[dateStr]) != 0 {
		t.Fatalf("A should not see the hidden event, got %v", eventsA[dateStr])
	}
	if len(eventsB[dateStr]) != 1 {
		t.Fatalf("B should still see the event, got %v", eventsB[dateStr])
	}

	// B cannot unhide A's row.
	res = ta.do("DELETE", "/api/calendar/hidden/"+created.ID, nil, cookieB)
	var status struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(res.Body, &status)
	if status.Status != "not_found" {
		t.Fatalf("B unhiding A's row should be not_found, got %q", status.Status)
	}
	var count int64
	ta.App.DB.Model(&models.HiddenCalendarEvent{}).Count(&count)
	if count != 1 {
		t.Fatalf("A's hidden row should survive, got %d rows", count)
	}

	// B hiding the same event creates B's own row; A unhides only A's.
	if res := ta.do("POST", "/api/calendar/hidden", hidePayload("evt-1", "Dentist", start), cookieB); res.Status != 200 {
		t.Fatalf("B hide status %d", res.Status)
	}
	ta.App.DB.Model(&models.HiddenCalendarEvent{}).Count(&count)
	if count != 2 {
		t.Fatalf("expected one row per user, got %d", count)
	}
	if res := ta.DELETE("/api/calendar/hidden/" + created.ID); res.Status != 200 {
		t.Fatalf("A unhide status %d", res.Status)
	}
	ta.App.DB.Model(&models.HiddenCalendarEvent{}).Count(&count)
	if count != 1 {
		t.Fatalf("B's row should survive A's unhide, got %d rows", count)
	}
}

func TestHideEventDedupsPerUser(t *testing.T) {
	ta := newTestApp(t)
	start := time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC)

	res1 := ta.POST("/api/calendar/hidden", hidePayload("evt-1", "Dentist", start))
	res2 := ta.POST("/api/calendar/hidden", hidePayload("evt-1", "Dentist", start))
	var h1, h2 struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res1.Body, &h1)
	_ = json.Unmarshal(res2.Body, &h2)
	if h1.ID == "" || h1.ID != h2.ID {
		t.Fatalf("repeat hide should return the existing row, got %q vs %q", h1.ID, h2.ID)
	}
}

func TestHiddenSSEGoesOnlyToTheHider(t *testing.T) {
	ta := newTestApp(t)
	start := time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC)

	collectorA := ta.Collect(TestSub)
	collectorB := ta.Collect("wife-sub")

	if res := ta.POST("/api/calendar/hidden", hidePayload("evt-1", "Dentist", start)); res.Status != 200 {
		t.Fatalf("hide status %d", res.Status)
	}

	if p := collectorA.LastPayload("calendar.hidden"); p == nil {
		t.Fatal("hider's other sessions should receive calendar.hidden")
	}
	if p := collectorB.LastPayload("calendar.hidden"); p != nil {
		t.Fatalf("other users must not receive calendar.hidden, got %v", p)
	}
}
