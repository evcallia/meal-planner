package app

// Port of test_api.py TestDaysAPI.

import (
	"fmt"
	"testing"
	"time"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
)

func mustDate(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := httpx.ParseDate(s)
	if err != nil {
		t.Fatalf("parse date %q: %v", s, err)
	}
	return d
}

// seedMealNote mirrors the sample_meal_note conftest fixture.
func seedMealNote(t *testing.T, ta *testApp) *models.MealNote {
	t.Helper()
	note := models.MealNote{
		Date:  mustDate(t, "2024-02-15"),
		Notes: "<p>Breakfast: Oatmeal</p><p>Lunch: Sandwich</p>",
	}
	if err := ta.App.DB.Create(&note).Error; err != nil {
		t.Fatalf("seed meal note: %v", err)
	}
	return &note
}

// seedMealItems mirrors the sample_meal_items conftest fixture.
func seedMealItems(t *testing.T, ta *testApp, note *models.MealNote) []models.MealItem {
	t.Helper()
	items := []models.MealItem{
		{MealNoteID: note.ID, LineIndex: 0, Itemized: true},
		{MealNoteID: note.ID, LineIndex: 1, Itemized: false},
	}
	for i := range items {
		if err := ta.App.DB.Create(&items[i]).Error; err != nil {
			t.Fatalf("seed meal item: %v", err)
		}
	}
	return items
}

// seedCalendarCache marks the DB calendar cache as covering [start, end] and
// inserts the given events, so include_events serves them without network
// (replaces Python's @patch of fetch_ical_events).
func seedCalendarCache(t *testing.T, ta *testApp, start, end time.Time, events ...models.CachedCalendarEvent) {
	t.Helper()
	now := models.NowUTC()
	meta := models.CalendarCacheMetadata{ID: 1, LastRefresh: &now, CacheStart: &start, CacheEnd: &end}
	if err := ta.App.DB.Create(&meta).Error; err != nil {
		t.Fatalf("seed cache metadata: %v", err)
	}
	for i := range events {
		if err := ta.App.DB.Create(&events[i]).Error; err != nil {
			t.Fatalf("seed cached event: %v", err)
		}
	}
}

func TestGetDaysEmpty(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/days?start_date=2024-02-15&end_date=2024-02-17")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.List()
	if len(data) != 3 {
		t.Fatalf("len(days) = %d, want 3", len(data))
	}
	wantDates := []string{"2024-02-15", "2024-02-16", "2024-02-17"}
	for i, want := range wantDates {
		day := data[i].(map[string]any)
		if day["date"] != want {
			t.Fatalf("days[%d].date = %v, want %s", i, day["date"], want)
		}
		if day["meal_note"] != nil {
			t.Fatalf("days[%d].meal_note = %v, want null", i, day["meal_note"])
		}
		events, ok := day["events"].([]any)
		if !ok || len(events) != 0 {
			t.Fatalf("days[%d].events = %v, want []", i, day["events"])
		}
	}
}

func TestGetDaysWithMealNotes(t *testing.T) {
	ta := newTestApp(t)
	note1 := models.MealNote{Date: mustDate(t, "2024-02-15"), Notes: "<p>Breakfast: Oatmeal</p>"}
	note2 := models.MealNote{Date: mustDate(t, "2024-02-16"), Notes: "<p>Lunch: Sandwich</p>"}
	ta.App.DB.Create(&note1)
	ta.App.DB.Create(&note2)
	ta.App.DB.Create(&models.MealItem{MealNoteID: note1.ID, LineIndex: 0, Itemized: true})
	ta.App.DB.Create(&models.MealItem{MealNoteID: note2.ID, LineIndex: 0, Itemized: false})

	resp := ta.GET("/api/days?start_date=2024-02-15&end_date=2024-02-17")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.List()
	if len(data) != 3 {
		t.Fatalf("len(days) = %d, want 3", len(data))
	}
	byDate := map[string]map[string]any{}
	for _, d := range data {
		day := d.(map[string]any)
		byDate[day["date"].(string)] = day
	}

	day1Note, _ := byDate["2024-02-15"]["meal_note"].(map[string]any)
	if day1Note == nil {
		t.Fatal("2024-02-15 meal_note is nil")
	}
	if day1Note["notes"] != "<p>Breakfast: Oatmeal</p>" {
		t.Fatalf("notes = %v", day1Note["notes"])
	}
	items, _ := day1Note["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	item := items[0].(map[string]any)
	if item["line_index"] != float64(0) || item["itemized"] != true {
		t.Fatalf("item = %v", item)
	}

	day2Note, _ := byDate["2024-02-16"]["meal_note"].(map[string]any)
	if day2Note == nil {
		t.Fatal("2024-02-16 meal_note is nil")
	}
	if day2Note["notes"] != "<p>Lunch: Sandwich</p>" {
		t.Fatalf("notes = %v", day2Note["notes"])
	}

	if byDate["2024-02-17"]["meal_note"] != nil {
		t.Fatalf("2024-02-17 meal_note = %v, want null", byDate["2024-02-17"]["meal_note"])
	}
}

func TestGetDaysWithEvents(t *testing.T) {
	ta := newTestApp(t)
	// Python patches fetch_ical_events; here the DB cache covers the range so
	// FetchICalEvents serves the seeded event without touching the network.
	seedCalendarCache(t, ta, mustDate(t, "2024-02-01"), mustDate(t, "2024-02-28"),
		models.CachedCalendarEvent{
			EventDate:    mustDate(t, "2024-02-15"),
			EventUID:     "event-1",
			CalendarName: "Personal",
			Title:        "Dinner with friends",
			StartTime:    time.Date(2024, 2, 15, 19, 0, 0, 0, time.UTC),
			AllDay:       false,
		})

	resp := ta.GET("/api/days?start_date=2024-02-15&end_date=2024-02-15&include_events=true")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.List()
	if len(data) != 1 {
		t.Fatalf("len(days) = %d, want 1", len(data))
	}
	day := data[0].(map[string]any)
	events, _ := day["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1: %v", len(events), day["events"])
	}
	event := events[0].(map[string]any)
	if event["title"] != "Dinner with friends" {
		t.Fatalf("title = %v", event["title"])
	}
	if event["start_time"] != "2024-02-15T19:00:00" {
		t.Fatalf("start_time = %v", event["start_time"])
	}
	if event["all_day"] != false {
		t.Fatalf("all_day = %v", event["all_day"])
	}
}

// Python's test asserted fetch_ical_events was called with
// include_holidays=True. Equivalent behavior check: with no include_holidays
// param a cached holiday event is served by default.
func TestGetDaysIncludesHolidaysByDefault(t *testing.T) {
	ta := newTestApp(t)
	seedCalendarCache(t, ta, mustDate(t, "2024-02-01"), mustDate(t, "2024-02-28"),
		models.CachedCalendarEvent{
			EventDate:    mustDate(t, "2024-02-15"),
			EventUID:     "holiday-1",
			CalendarName: "US Holidays",
			Title:        "Some Holiday",
			StartTime:    mustDate(t, "2024-02-15"),
			AllDay:       true,
		})

	resp := ta.GET("/api/days?start_date=2024-02-15&end_date=2024-02-15&include_events=true")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	day := resp.List()[0].(map[string]any)
	events, _ := day["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("holiday not included by default: events = %v", day["events"])
	}

	resp = ta.GET("/api/days?start_date=2024-02-15&end_date=2024-02-15&include_events=true&include_holidays=false")
	day = resp.List()[0].(map[string]any)
	events, _ = day["events"].([]any)
	if len(events) != 0 {
		t.Fatalf("holiday included despite include_holidays=false: %v", day["events"])
	}
}

func TestGetDaysInvalidDateRange(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/days?start_date=invalid&end_date=2024-02-17")
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
}

func TestGetDaysWithoutAuthentication(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/days?start_date=2024-02-15&end_date=2024-02-17", nil)
	if resp.Status != 401 {
		t.Fatalf("status = %d, want 401: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Not authenticated" {
		t.Fatalf("detail = %q, want %q", detail, "Not authenticated")
	}
}

func TestUpdateMealNoteCreateNew(t *testing.T) {
	ta := newTestApp(t)
	testDate := "2024-02-15"
	testNotes := "<p>New meal notes</p>"

	resp := ta.PUT("/api/days/"+testDate+"/notes", map[string]any{"notes": testNotes})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["date"] != testDate {
		t.Fatalf("date = %v", data["date"])
	}
	if data["notes"] != testNotes {
		t.Fatalf("notes = %v", data["notes"])
	}
	items, _ := data["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	item := items[0].(map[string]any)
	if item["line_index"] != float64(0) || item["itemized"] != false {
		t.Fatalf("item = %v", item)
	}

	var note models.MealNote
	if err := ta.App.DB.Where("date = ?", mustDate(t, testDate)).First(&note).Error; err != nil {
		t.Fatalf("meal note not in database: %v", err)
	}
	if note.Notes != testNotes {
		t.Fatalf("db notes = %q", note.Notes)
	}
}

func TestUpdateMealNoteHTMLLinesCreateItems(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/days/2024-02-18/notes",
		map[string]any{"notes": "<div>Breakfast</div><div>Dinner</div>"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["date"] != "2024-02-18" {
		t.Fatalf("date = %v", data["date"])
	}
	items, _ := data["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("len(items) = %d, want 2", len(items))
	}
	if items[0].(map[string]any)["line_index"] != float64(0) {
		t.Fatalf("items[0] = %v", items[0])
	}
	if items[1].(map[string]any)["line_index"] != float64(1) {
		t.Fatalf("items[1] = %v", items[1])
	}
}

func TestUpdateMealNoteBroadcasts(t *testing.T) {
	ta := newTestApp(t)
	col := ta.Collect(TestSub)
	resp := ta.PUT("/api/days/2024-02-19/notes", map[string]any{"notes": "<div>Breakfast</div>"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if payload := col.LastPayload("notes.updated"); payload == nil {
		t.Fatal("expected a notes.updated broadcast")
	}
}

func TestUpdateMealNoteModifyExisting(t *testing.T) {
	ta := newTestApp(t)
	note := seedMealNote(t, ta)
	newNotes := "<p>Updated meal notes</p>"

	resp := ta.PUT("/api/days/"+httpx.FormatDate(note.Date)+"/notes", map[string]any{"notes": newNotes})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["date"] != httpx.FormatDate(note.Date) {
		t.Fatalf("date = %v", data["date"])
	}
	if data["notes"] != newNotes {
		t.Fatalf("notes = %v", data["notes"])
	}

	var fresh models.MealNote
	ta.App.DB.Where("id = ?", note.ID).First(&fresh)
	if fresh.Notes != newNotes {
		t.Fatalf("db notes = %q", fresh.Notes)
	}
}

func TestToggleMealItemNewItem(t *testing.T) {
	ta := newTestApp(t)
	note := seedMealNote(t, ta)

	resp := ta.PATCH("/api/days/"+httpx.FormatDate(note.Date)+"/items/5",
		map[string]any{"itemized": true})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["line_index"] != float64(5) {
		t.Fatalf("line_index = %v", data["line_index"])
	}
	if data["itemized"] != true {
		t.Fatalf("itemized = %v", data["itemized"])
	}

	var item models.MealItem
	err := ta.App.DB.Where("meal_note_id = ? AND line_index = ?", note.ID, 5).First(&item).Error
	if err != nil {
		t.Fatalf("meal item not in database: %v", err)
	}
	if !item.Itemized {
		t.Fatal("db itemized = false, want true")
	}
}

func TestToggleMealItemExistingItem(t *testing.T) {
	ta := newTestApp(t)
	note := seedMealNote(t, ta)
	items := seedMealItems(t, ta, note)
	existing := items[0]
	originalStatus := existing.Itemized

	resp := ta.PATCH(
		fmt.Sprintf("/api/days/%s/items/%d", httpx.FormatDate(note.Date), existing.LineIndex),
		map[string]any{"itemized": !originalStatus})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["line_index"] != float64(existing.LineIndex) {
		t.Fatalf("line_index = %v", data["line_index"])
	}
	if data["itemized"] != !originalStatus {
		t.Fatalf("itemized = %v, want %v", data["itemized"], !originalStatus)
	}

	var fresh models.MealItem
	ta.App.DB.Where("id = ?", existing.ID).First(&fresh)
	if fresh.Itemized != !originalStatus {
		t.Fatalf("db itemized = %v, want %v", fresh.Itemized, !originalStatus)
	}
}

func TestToggleMealItemBroadcasts(t *testing.T) {
	ta := newTestApp(t)
	note := seedMealNote(t, ta)
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/days/"+httpx.FormatDate(note.Date)+"/items/0",
		map[string]any{"itemized": true})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if payload := col.LastPayload("item.updated"); payload == nil {
		t.Fatal("expected an item.updated broadcast")
	}
}

func TestToggleMealItemNoMealNote(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/days/2024-02-15/items/0", map[string]any{"itemized": true})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["line_index"] != float64(0) {
		t.Fatalf("line_index = %v", data["line_index"])
	}
	if data["itemized"] != true {
		t.Fatalf("itemized = %v", data["itemized"])
	}
}

func TestGetEventsEndpoint(t *testing.T) {
	ta := newTestApp(t)
	seedCalendarCache(t, ta, mustDate(t, "2024-02-01"), mustDate(t, "2024-02-28"),
		models.CachedCalendarEvent{
			EventDate:    mustDate(t, "2024-02-15"),
			EventUID:     "event-2",
			CalendarName: "Personal",
			Title:        "Test Event",
			StartTime:    time.Date(2024, 2, 15, 10, 0, 0, 0, time.UTC),
			AllDay:       false,
		})

	resp := ta.GET("/api/days/events?start_date=2024-02-15&end_date=2024-02-15")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	events, ok := data["2024-02-15"].([]any)
	if !ok {
		t.Fatalf("no 2024-02-15 key in response: %v", data)
	}
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	if events[0].(map[string]any)["title"] != "Test Event" {
		t.Fatalf("title = %v", events[0])
	}
}

func TestAPIEndpointsRequireAuthentication(t *testing.T) {
	ta := newTestApp(t)
	note := seedMealNote(t, ta)
	noteDate := httpx.FormatDate(note.Date)

	cases := []struct {
		method, path string
		body         any
	}{
		{"GET", "/api/days?start_date=2024-02-15&end_date=2024-02-15", nil},
		{"PUT", "/api/days/" + noteDate + "/notes", map[string]any{"notes": "test"}},
		{"PATCH", "/api/days/" + noteDate + "/items/0", map[string]any{"itemized": true}},
		{"GET", "/api/days/events?start_date=2024-02-15&end_date=2024-02-15", nil},
		{"GET", "/api/pantry", nil},
		{"POST", "/api/pantry/items", map[string]any{
			"section_id": "00000000-0000-0000-0000-000000000000", "name": "test", "quantity": 1}},
		{"PUT", "/api/pantry/items/00000000-0000-0000-0000-000000000000",
			map[string]any{"name": "test", "quantity": 1}},
		{"DELETE", "/api/pantry/items/00000000-0000-0000-0000-000000000000", nil},
		{"GET", "/api/meal-ideas", nil},
		{"POST", "/api/meal-ideas", map[string]any{"title": "test"}},
		{"PUT", "/api/meal-ideas/00000000-0000-0000-0000-000000000000", map[string]any{"title": "test"}},
		{"DELETE", "/api/meal-ideas/00000000-0000-0000-0000-000000000000", nil},
	}
	for _, c := range cases {
		resp := ta.Anon(c.method, c.path, c.body)
		if resp.Status != 401 {
			t.Errorf("%s %s: status = %d, want 401", c.method, c.path, resp.Status)
		}
	}
}

func TestLargeDateRanges(t *testing.T) {
	ta := newTestApp(t)
	start := time.Now().UTC()
	end := start.AddDate(0, 0, 365)
	resp := ta.GET(fmt.Sprintf("/api/days?start_date=%s&end_date=%s",
		httpx.FormatDate(start), httpx.FormatDate(end)))
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if got := len(resp.List()); got != 366 { // both start and end dates included
		t.Fatalf("len(days) = %d, want 366", got)
	}
}

func TestUpdateMealNoteValidation(t *testing.T) {
	ta := newTestApp(t)

	// Missing notes field.
	resp := ta.PUT("/api/days/2024-02-15/notes", map[string]any{})
	if resp.Status != 422 {
		t.Fatalf("missing notes: status = %d, want 422: %s", resp.Status, resp.Body)
	}

	// Invalid date format.
	resp = ta.PUT("/api/days/invalid-date/notes", map[string]any{"notes": "test"})
	if resp.Status != 422 {
		t.Fatalf("invalid date: status = %d, want 422: %s", resp.Status, resp.Body)
	}
}
