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

// The default is UTC, so an unconfigured deployment renders a foreign event at
// its UTC wall clock — wrong for a California household, but the SAME wrong
// everywhere, which is the point: it no longer depends on the container's TZ.
func TestDefaultZoneIsUTCNotProcessZone(t *testing.T) {
	if EventZone() != time.UTC {
		t.Fatalf("default eventZone = %s, want UTC (must not follow time.Local)", EventZone())
	}
}

// The production shape: CALENDAR_TIMEZONE supplies the household zone and must
// win over the UTC default, or the Paris event lands at 16:30 (a 4:30 PM golf
// lesson) instead of 09:30.
func TestConfigZoneBeatsUTCDefault(t *testing.T) {
	prev := EventZone()
	t.Cleanup(func() { eventZone = prev })
	eventZone = time.UTC

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
