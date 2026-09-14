package ical

// A calendar event carrying a FOREIGN timezone must render at the household's
// local time, not at its own wall clock. Before this, an event saved by a
// client on Paris time (DTSTART;TZID=Europe/Paris:20260912T183000) was stored
// as 18:30 and displayed as 6:30 PM, when it is really 9:30 AM in California.
//
// Events already in the local zone must be byte-identical to before, so their
// event keys — and the hidden_calendar_events rows keyed off them — don't move.

import (
	"testing"
	"time"
	_ "time/tzdata"

	"mealplanner/internal/httpx"
)

func withZone(t *testing.T, name string) {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("load %s: %v", name, err)
	}
	prev := eventZone
	eventZone = loc
	t.Cleanup(func() { eventZone = prev })
}

func parseOne(t *testing.T, vevent string) Event {
	t.Helper()
	ics := "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\n" + vevent + "\nEND:VEVENT\nEND:VCALENDAR\n"
	events := parseICSEvents([]byte(ics), "Family")
	if len(events) != 1 {
		t.Fatalf("parsed %d events, want 1", len(events))
	}
	return events[0].Event
}

func TestForeignTZIDConvertsToLocalZone(t *testing.T) {
	withZone(t, "America/Los_Angeles")
	e := parseOne(t, "UID:golf\nSUMMARY:Ev Golf Lesson\n"+
		"DTSTART;TZID=Europe/Paris:20260912T183000\n"+
		"DTEND;TZID=Europe/Paris:20260912T193000")
	// 18:30 CEST (UTC+2) = 16:30Z = 09:30 PDT (UTC-7).
	if got := httpx.FormatDateTime(e.StartTime); got != "2026-09-12T09:30:00" {
		t.Errorf("start = %s, want 2026-09-12T09:30:00 (Paris 18:30 in LA)", got)
	}
	if e.EndTime == nil || httpx.FormatDateTime(*e.EndTime) != "2026-09-12T10:30:00" {
		t.Errorf("end = %v, want 2026-09-12T10:30:00", e.EndTime)
	}
}

func TestLocalTZIDKeepsWallClockAndKey(t *testing.T) {
	withZone(t, "America/Los_Angeles")
	e := parseOne(t, "UID:local-1\nSUMMARY:Dinner\n"+
		"DTSTART;TZID=America/Los_Angeles:20260912T093000")
	if got := httpx.FormatDateTime(e.StartTime); got != "2026-09-12T09:30:00" {
		t.Errorf("start = %s, want the wall clock 2026-09-12T09:30:00 unchanged", got)
	}
	// The key is what hidden-event rows are matched on — it must not move.
	if want := "local-1|Family|2026-09-12T09:30:00"; e.ID != want {
		t.Errorf("event key = %q, want %q", e.ID, want)
	}
}

func TestUTCStampConvertsToLocalZone(t *testing.T) {
	withZone(t, "America/Los_Angeles")
	e := parseOne(t, "UID:zulu\nSUMMARY:Zulu\nDTSTART:20240215T153000Z")
	// February = PST (UTC-8).
	if got := httpx.FormatDateTime(e.StartTime); got != "2024-02-15T07:30:00" {
		t.Errorf("start = %s, want 2024-02-15T07:30:00 (15:30Z in LA)", got)
	}
}

// A floating time has no zone by definition — it means "this wall clock,
// wherever you are" — so it must pass through untouched.
func TestFloatingTimeUntouched(t *testing.T) {
	withZone(t, "America/Los_Angeles")
	e := parseOne(t, "UID:float\nSUMMARY:Floating\nDTSTART:20240215T090000")
	if got := httpx.FormatDateTime(e.StartTime); got != "2024-02-15T09:00:00" {
		t.Errorf("start = %s, want 2024-02-15T09:00:00 unchanged", got)
	}
}

// All-day events are DATE values with no time at all; converting one would
// shift it onto the wrong day.
func TestAllDayUntouched(t *testing.T) {
	withZone(t, "America/Los_Angeles")
	e := parseOne(t, "UID:allday\nSUMMARY:Holiday\nDTSTART;VALUE=DATE:20240215")
	if !e.AllDay {
		t.Fatal("want AllDay")
	}
	if got := httpx.FormatDateTime(e.StartTime); got != "2024-02-15T00:00:00" {
		t.Errorf("start = %s, want 2024-02-15T00:00:00 unchanged", got)
	}
}
