package ical

// The household zone must come from explicit config, not from whatever zone
// the container happens to run in: prod leaves TZ unset (UTC) while dev
// defaults to America/Los_Angeles, so relying on time.Local rendered the same
// event at two different wall clocks depending on where it ran.

import (
	"testing"
	"time"
	_ "time/tzdata"

	"mealplanner/internal/httpx"
)

func TestSetEventZoneDrivesConversion(t *testing.T) {
	prev := EventZone()
	t.Cleanup(func() { eventZone = prev })

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	SetEventZone(la)
	if EventZone().String() != "America/Los_Angeles" {
		t.Fatalf("EventZone() = %s", EventZone())
	}

	// 18:30 CEST = 16:30Z = 09:30 PDT — the bug that started this.
	e := parseOne(t, "UID:golf\nSUMMARY:Golf\nDTSTART;TZID=Europe/Paris:20260912T183000")
	if got := httpx.FormatDateTime(e.StartTime); got != "2026-09-12T09:30:00" {
		t.Errorf("start = %s, want 2026-09-12T09:30:00", got)
	}
}

// A typo in CALENDAR_TIMEZONE must not silently move every event: the loader
// passes nil on failure and the previous zone stays in place.
func TestSetEventZoneIgnoresNil(t *testing.T) {
	prev := EventZone()
	t.Cleanup(func() { eventZone = prev })

	tokyo, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	SetEventZone(tokyo)
	SetEventZone(nil)
	if EventZone().String() != "Asia/Tokyo" {
		t.Errorf("nil overwrote the zone: %s", EventZone())
	}
}

// The actual production shape: docker-compose.yml leaves TZ unset, so the
// process zone is UTC while the household is in California. Config has to win
// over the process zone, or the Paris event lands at 16:30 (a 4:30 PM golf
// lesson) instead of 09:30.
func TestConfigZoneBeatsUTCProcessZone(t *testing.T) {
	prev := EventZone()
	t.Cleanup(func() { eventZone = prev })
	eventZone = time.UTC // stand in for time.Local on a TZ-less container

	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Fatalf("load zone: %v", err)
	}
	SetEventZone(la) // what main() does from CALENDAR_TIMEZONE

	e := parseOne(t, "UID:golf\nSUMMARY:Golf\nDTSTART;TZID=Europe/Paris:20260912T183000")
	if got := httpx.FormatDateTime(e.StartTime); got != "2026-09-12T09:30:00" {
		t.Fatalf("start = %s, want 2026-09-12T09:30:00 (16:30 before this fix)", got)
	}
}
