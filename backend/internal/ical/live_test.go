package ical

// Live CalDAV diagnostic against real iCloud credentials. Skipped unless
// APPLE_CALENDAR_EMAIL / APPLE_CALENDAR_APP_PASSWORD are set:
//
//	APPLE_CALENDAR_EMAIL=... APPLE_CALENDAR_APP_PASSWORD=... \
//	  go test -run TestLiveCalDAV -v ./internal/ical
//
// Never prints credentials; prints discovery hrefs, calendar names, and
// event counts so client breakage against the real server is diagnosable.

import (
	"os"
	"testing"
	"time"
)

func TestLiveCalDAV(t *testing.T) {
	email := os.Getenv("APPLE_CALENDAR_EMAIL")
	password := os.Getenv("APPLE_CALENDAR_APP_PASSWORD")
	if email == "" || password == "" {
		t.Skip("APPLE_CALENDAR_EMAIL / APPLE_CALENDAR_APP_PASSWORD not set")
	}
	client := newCalDAVClient(AppleCalDAVURL, email, password)

	principal, err := client.principalHref()
	if err != nil {
		t.Fatalf("principal discovery failed: %v", err)
	}
	t.Logf("principal href: %s", principal)

	home, err := client.calendarHomeHref(principal)
	if err != nil {
		t.Fatalf("calendar-home-set discovery failed: %v", err)
	}
	t.Logf("calendar home: %s", home)

	calendars, err := client.Calendars()
	if err != nil {
		t.Fatalf("calendar listing failed: %v", err)
	}
	t.Logf("calendars (%d):", len(calendars))
	for _, c := range calendars {
		t.Logf("  %q -> %s", c.Name, c.Href)
	}
	if len(calendars) == 0 {
		t.Fatal("no calendars discovered")
	}

	start := time.Now().AddDate(0, 0, -14)
	end := time.Now().AddDate(0, 0, 28)
	total := 0
	for _, cal := range calendars {
		blobs, err := client.Events(cal, start, end)
		if err != nil {
			t.Errorf("REPORT on %q failed: %v", cal.Name, err)
			continue
		}
		events := 0
		for _, blob := range blobs {
			events += len(parseICSEvents(blob, cal.Name))
		}
		t.Logf("  %q: %d objects, %d parsed events", cal.Name, len(blobs), events)
		total += events
	}
	t.Logf("total events in ±window: %d", total)
}
