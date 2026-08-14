package ical

// Regression for the TZID audit finding: Python's _parse_ical_date drops the
// timezone but KEEPS the wall-clock reading. Event keys, event_date
// bucketing, and hidden-event rows depend on that.

import (
	"testing"
	"time"
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

// Regression: dateOf (and therefore todayUTC/CacheRange) must yield the UTC
// date regardless of the process's local zone. The compose files set
// TZ=America/Los_Angeles for log timestamps, on the documented invariant
// that server date logic is TZ-independent — a "fix" that truncated before
// converting to UTC would shift the cache range by a day during 00:00–07:00
// UTC.
func TestDateOfIgnoresLocalZone(t *testing.T) {
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	// 03:00 UTC on Aug 14 = 20:00 Aug 13 in LA — the danger window where
	// local and UTC dates disagree.
	instant := time.Date(2026, 8, 14, 3, 0, 0, 0, time.UTC)
	got := dateOf(instant.In(la))
	want := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) || got.Location() != time.UTC {
		t.Fatalf("dateOf(LA evening) = %v, want %v (UTC date, not local)", got, want)
	}
	// And the same instant expressed in any zone agrees.
	if !dateOf(instant).Equal(got) {
		t.Fatal("dateOf differs across zone representations of one instant")
	}
}
