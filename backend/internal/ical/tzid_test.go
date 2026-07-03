package ical

// Regression for the TZID audit finding: Python's _parse_ical_date drops the
// timezone but KEEPS the wall-clock reading. Event keys, event_date
// bucketing, and hidden-event rows depend on that.

import (
	"testing"
	_ "time/tzdata"

	"mealplanner/internal/httpx"
)

const tzidICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//test//EN
BEGIN:VEVENT
UID:tz-event-1
SUMMARY:Dinner
DTSTART;TZID=America/New_York:20240215T103000
DTEND;TZID=America/New_York:20240215T113000
END:VEVENT
END:VCALENDAR
`

func TestTZIDKeepsWallClock(t *testing.T) {
	events := parseICSEvents([]byte(tzidICS), "Family")
	if len(events) != 1 {
		t.Fatalf("parsed %d events, want 1", len(events))
	}
	e := events[0].Event
	if got := httpx.FormatDateTime(e.StartTime); got != "2024-02-15T10:30:00" {
		t.Fatalf("start = %s, want wall-clock 2024-02-15T10:30:00 (no UTC conversion)", got)
	}
	if e.EndTime == nil || httpx.FormatDateTime(*e.EndTime) != "2024-02-15T11:30:00" {
		t.Fatalf("end = %v, want 2024-02-15T11:30:00", e.EndTime)
	}
	if e.AllDay {
		t.Fatal("TZID datetime must not be all-day")
	}
	// Event key embeds the wall-clock start, matching Python-era hidden rows.
	if want := "tz-event-1|Family|2024-02-15T10:30:00"; e.ID != want {
		t.Fatalf("event key = %q, want %q", e.ID, want)
	}
}

func TestUTCAndFloatingUnaffected(t *testing.T) {
	ics := `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:utc-1
SUMMARY:Zulu
DTSTART:20240215T153000Z
END:VEVENT
BEGIN:VEVENT
UID:float-1
SUMMARY:Floating
DTSTART:20240215T090000
END:VEVENT
END:VCALENDAR
`
	events := parseICSEvents([]byte(ics), "Cal")
	if len(events) != 2 {
		t.Fatalf("parsed %d events, want 2", len(events))
	}
	if got := httpx.FormatDateTime(events[0].Event.StartTime); got != "2024-02-15T15:30:00" {
		t.Fatalf("UTC start = %s", got)
	}
	if got := httpx.FormatDateTime(events[1].Event.StartTime); got != "2024-02-15T09:00:00" {
		t.Fatalf("floating start = %s", got)
	}
}
