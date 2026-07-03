package ical

// Ports the parsing-level tests from backend/tests/test_ical_service.py:
// TestICalServiceHelpers (_parse_ical_date / _is_all_day), the ICS-parsing
// half of TestFetchEventsFromCalDAV (Python stubbed calendar.search() with
// icalendar fixtures; here the equivalent fixtures go through parseICSEvents),
// TestGetEventsForDate, TestIsAllDayNoStart, and TestCalendarEventWithSource.

import (
	"strings"
	"testing"
	"time"
)

func d(y int, m time.Month, day int) time.Time {
	return time.Date(y, m, day, 0, 0, 0, 0, time.UTC)
}

func dt(y int, m time.Month, day, h, min int) time.Time {
	return time.Date(y, m, day, h, min, 0, 0, time.UTC)
}

func tp(t time.Time) *time.Time { return &t }

// ics builds a VCALENDAR fixture from raw VEVENT property lines.
func ics(events ...[]string) []byte {
	lines := []string{"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN"}
	for _, ev := range events {
		lines = append(lines, "BEGIN:VEVENT")
		lines = append(lines, ev...)
		lines = append(lines, "END:VEVENT")
	}
	lines = append(lines, "END:VCALENDAR", "")
	return []byte(strings.Join(lines, "\r\n"))
}

// test_parse_ical_date_datetime + test_is_all_day_false: naive datetimes
// parse as-is and are not all-day.
func TestParseICSEventsDatetime(t *testing.T) {
	events := parseICSEvents(ics([]string{
		"UID:test-uid-123",
		"SUMMARY:Test Event",
		"DTSTART:20240215T103000",
	}), "TestCalendar")
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	e := events[0].Event
	if !e.StartTime.Equal(dt(2024, 2, 15, 10, 30)) {
		t.Errorf("start_time = %v, want 2024-02-15T10:30:00", e.StartTime)
	}
	if e.AllDay {
		t.Error("timed event should not be all_day")
	}
}

// test_parse_ical_date_date + test_is_all_day_true: DATE values parse as
// midnight and mark the event all-day.
func TestParseICSEventsDateOnly(t *testing.T) {
	events := parseICSEvents(ics([]string{
		"UID:test-all-day-uid-123",
		"SUMMARY:All Day Event",
		"DTSTART;VALUE=DATE:20240215",
		"DTEND;VALUE=DATE:20240216",
	}), "TestCalendar")
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	e := events[0].Event
	if !e.StartTime.Equal(d(2024, 2, 15)) {
		t.Errorf("start_time = %v, want 2024-02-15T00:00:00", e.StartTime)
	}
	if !e.AllDay {
		t.Error("DATE-valued event should be all_day")
	}
	if e.EndTime == nil || !e.EndTime.Equal(d(2024, 2, 16)) {
		t.Errorf("end_time = %v, want 2024-02-16T00:00:00", e.EndTime)
	}
}

// test_parse_ical_date_timezone_aware: tz-aware datetimes are converted to
// UTC and stored naive.
func TestParseICSEventsTimezoneAware(t *testing.T) {
	events := parseICSEvents(ics([]string{
		"UID:tz-uid",
		"SUMMARY:UTC Event",
		"DTSTART:20240215T103000Z",
	}), "TestCalendar")
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	e := events[0].Event
	if !e.StartTime.Equal(dt(2024, 2, 15, 10, 30)) {
		t.Errorf("start_time = %v, want 2024-02-15T10:30:00 UTC", e.StartTime)
	}
	if e.StartTime.Location() != time.UTC {
		t.Errorf("start_time location = %v, want UTC", e.StartTime.Location())
	}
}

// test_fetch_events_success (parse half): title/uid/calendar/all_day fields
// come through from the ICS blob the CalDAV search returns.
func TestParseICSEventsFields(t *testing.T) {
	events := parseICSEvents(ics([]string{
		"UID:test-uid-123",
		"SUMMARY:Test Event",
		"DTSTART:20240215T100000",
		"DTEND:20240215T110000",
	}), "TestCalendar")
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	got := events[0]
	if got.Event.Title != "Test Event" {
		t.Errorf("title = %q", got.Event.Title)
	}
	if got.Event.AllDay {
		t.Error("all_day should be false")
	}
	if got.CalendarName != "TestCalendar" || got.Event.CalendarName != "TestCalendar" {
		t.Errorf("calendar_name = %q / %q", got.CalendarName, got.Event.CalendarName)
	}
	if got.Event.UID != "test-uid-123" {
		t.Errorf("uid = %q", got.Event.UID)
	}
	wantID := EventKey("test-uid-123", "TestCalendar", dt(2024, 2, 15, 10, 0))
	if got.Event.ID != wantID {
		t.Errorf("id = %q, want %q", got.Event.ID, wantID)
	}
}

// test_fetch_events_multiple_calendars (parse half): events from separate
// blobs are tagged with their own calendar name.
func TestParseICSEventsMultipleCalendars(t *testing.T) {
	events1 := parseICSEvents(ics([]string{
		"UID:test-uid-1", "SUMMARY:Event from Cal1", "DTSTART:20240215T100000",
	}), "Calendar1")
	events2 := parseICSEvents(ics([]string{
		"UID:test-uid-2", "SUMMARY:Event from Cal2", "DTSTART:20240215T140000",
	}), "Calendar2")
	all := append(events1, events2...)
	if len(all) != 2 {
		t.Fatalf("expected 2 events, got %d", len(all))
	}
	names := map[string]bool{}
	for _, e := range all {
		names[e.CalendarName] = true
	}
	if !names["Calendar1"] || !names["Calendar2"] {
		t.Errorf("calendar names = %v", names)
	}
}

// test_fetch_events_invalid_ical: garbage data parses to no events.
func TestParseICSEventsInvalid(t *testing.T) {
	if events := parseICSEvents([]byte("invalid ical data"), "TestCalendar"); len(events) != 0 {
		t.Errorf("expected 0 events for invalid data, got %d", len(events))
	}
}

// test_fetch_events_missing_dtstart + test_is_all_day_no_dtstart: events
// without DTSTART are skipped.
func TestParseICSEventsMissingDTStart(t *testing.T) {
	events := parseICSEvents(ics([]string{
		"UID:test-uid",
		"SUMMARY:No Start",
	}), "TestCalendar")
	if len(events) != 0 {
		t.Errorf("event without dtstart should be skipped, got %d", len(events))
	}
}

// _normalize_uid: raw UID passes through; empty falls back to a stable hash.
func TestNormalizeUID(t *testing.T) {
	if got := NormalizeUID("real-uid", "Cal", dt(2024, 2, 15, 10, 0), "Title"); got != "real-uid" {
		t.Errorf("raw uid should pass through, got %q", got)
	}
	fb1 := NormalizeUID("", "Cal", dt(2024, 2, 15, 10, 0), "Title")
	fb2 := NormalizeUID("", "Cal", dt(2024, 2, 15, 10, 0), "Title")
	if !strings.HasPrefix(fb1, "fallback-") {
		t.Errorf("fallback uid = %q, want fallback- prefix", fb1)
	}
	if fb1 != fb2 {
		t.Errorf("fallback uid should be deterministic: %q != %q", fb1, fb2)
	}
	other := NormalizeUID("", "Cal", dt(2024, 2, 15, 10, 0), "Other Title")
	if other == fb1 {
		t.Error("different titles should hash to different fallback uids")
	}
}

// _event_key format: uid|calendar|isoformat(start).
func TestEventKey(t *testing.T) {
	got := EventKey("u1", "Cal", dt(2024, 2, 15, 10, 0))
	if got != "u1|Cal|2024-02-15T10:00:00" {
		t.Errorf("event key = %q", got)
	}
}

// test_calendar_event_with_source_creation.
func TestEventWithSourceCreation(t *testing.T) {
	event := Event{ID: "event-12", Title: "Test Event", StartTime: dt(2024, 2, 15, 10, 0)}
	ews := EventWithSource{Event: event, CalendarName: "TestCalendar"}
	if ews.CalendarName != "TestCalendar" || ews.Event.Title != "Test Event" {
		t.Errorf("unexpected EventWithSource: %+v", ews)
	}
}

// ---- get_events_for_date ----

// test_get_events_for_date.
func TestGetEventsForDate(t *testing.T) {
	events := []Event{
		{ID: "event-1", Title: "Event 1", StartTime: dt(2024, 2, 15, 10, 0)},
		{ID: "event-2", Title: "Event 2", StartTime: dt(2024, 2, 16, 10, 0)},
		{ID: "event-3", Title: "Event 3", StartTime: dt(2024, 2, 15, 14, 0)},
	}
	result := GetEventsForDate(events, d(2024, 2, 15))
	if len(result) != 2 {
		t.Fatalf("expected 2 events, got %d", len(result))
	}
	if result[0].Title != "Event 1" || result[1].Title != "Event 3" {
		t.Errorf("titles = %q, %q", result[0].Title, result[1].Title)
	}
}

// test_get_events_for_date_all_day.
func TestGetEventsForDateAllDay(t *testing.T) {
	events := []Event{
		{ID: "event-4", Title: "All Day", StartTime: d(2024, 2, 15), AllDay: true},
		{ID: "event-5", Title: "Timed", StartTime: dt(2024, 2, 15, 10, 0)},
	}
	result := GetEventsForDate(events, d(2024, 2, 15))
	if len(result) != 2 {
		t.Fatalf("expected 2 events, got %d", len(result))
	}
	titles := map[string]bool{}
	for _, e := range result {
		titles[e.Title] = true
	}
	if !titles["All Day"] || !titles["Timed"] {
		t.Errorf("titles = %v", titles)
	}
}

// test_get_events_for_date_empty.
func TestGetEventsForDateEmpty(t *testing.T) {
	events := []Event{
		{ID: "event-6", Title: "Event 1", StartTime: dt(2024, 2, 16, 10, 0)},
		{ID: "event-7", Title: "Event 2", StartTime: dt(2024, 2, 17, 10, 0)},
	}
	if result := GetEventsForDate(events, d(2024, 2, 15)); len(result) != 0 {
		t.Errorf("expected 0 events, got %d", len(result))
	}
}

// Multi-day timed events appear on every day they span (inclusive end).
func TestGetEventsForDateMultiDaySpan(t *testing.T) {
	events := []Event{{
		ID: "multi", Title: "Trip",
		StartTime: dt(2024, 2, 15, 10, 0),
		EndTime:   tp(dt(2024, 2, 17, 11, 0)),
	}}
	for _, day := range []int{15, 16, 17} {
		if got := GetEventsForDate(events, d(2024, 2, day)); len(got) != 1 {
			t.Errorf("expected event on Feb %d, got %d events", day, len(got))
		}
	}
	if got := GetEventsForDate(events, d(2024, 2, 14)); len(got) != 0 {
		t.Errorf("event should not appear before its start, got %d", len(got))
	}
	if got := GetEventsForDate(events, d(2024, 2, 18)); len(got) != 0 {
		t.Errorf("event should not appear after its end, got %d", len(got))
	}
}

// All-day DTEND is exclusive per the iCal spec: a one-day all-day event with
// DTEND on the next day only appears on its start date.
func TestGetEventsForDateAllDayEndExclusive(t *testing.T) {
	events := []Event{{
		ID: "allday", Title: "Holiday", AllDay: true,
		StartTime: d(2024, 2, 15),
		EndTime:   tp(d(2024, 2, 16)),
	}}
	if got := GetEventsForDate(events, d(2024, 2, 15)); len(got) != 1 {
		t.Errorf("expected event on start date, got %d", len(got))
	}
	if got := GetEventsForDate(events, d(2024, 2, 16)); len(got) != 0 {
		t.Errorf("all-day end date is exclusive, got %d events", len(got))
	}
}

// Events without an end only appear on their start date.
func TestGetEventsForDateNoEnd(t *testing.T) {
	events := []Event{{ID: "noend", Title: "Point", StartTime: dt(2024, 2, 15, 10, 0)}}
	if got := GetEventsForDate(events, d(2024, 2, 15)); len(got) != 1 {
		t.Errorf("expected event on its date, got %d", len(got))
	}
	if got := GetEventsForDate(events, d(2024, 2, 16)); len(got) != 0 {
		t.Errorf("expected no event on next date, got %d", len(got))
	}
}
