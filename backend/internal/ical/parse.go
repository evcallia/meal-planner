package ical

import (
	"strings"
	"time"
	// Zone lookups must work on a scratch base image with no /usr/share/zoneinfo
	// — without the embedded database, a TZID event fails to parse and vanishes.
	_ "time/tzdata"

	goical "github.com/emersion/go-ical"
)

// eventZone is the household's timezone: the zone a zone-qualified event is
// rendered into before its wall clock is stored. It follows the process TZ
// (the compose files set TZ=America/Los_Angeles); tests override it.
var eventZone = time.Local

// parseICSEvents extracts VEVENTs from raw ICS data, mirroring the icalendar
// walk in Python: naive datetimes (tz-aware converted then stripped), DATE
// values as midnight, all_day when DTSTART is a DATE.
func parseICSEvents(data []byte, calendarName string) []EventWithSource {
	cal, err := goical.NewDecoder(strings.NewReader(string(data))).Decode()
	if err != nil {
		return nil
	}
	return extractEvents(cal, calendarName)
}

func extractEvents(cal *goical.Calendar, calendarName string) []EventWithSource {
	var out []EventWithSource
	for _, child := range cal.Children {
		if child.Name != goical.CompEvent {
			continue
		}
		dtstart := child.Props.Get(goical.PropDateTimeStart)
		if dtstart == nil {
			continue
		}
		summary := ""
		if p := child.Props.Get(goical.PropSummary); p != nil {
			if txt, err := p.Text(); err == nil {
				summary = txt
			}
		}
		rawUID := ""
		if p := child.Props.Get(goical.PropUID); p != nil {
			rawUID = p.Value
		}

		start, allDay, ok := parseICalTime(dtstart)
		if !ok {
			continue
		}
		var endPtr *time.Time
		if dtend := child.Props.Get(goical.PropDateTimeEnd); dtend != nil {
			if end, _, ok := parseICalTime(dtend); ok {
				endPtr = &end
			}
		}
		uid := NormalizeUID(rawUID, calendarName, start, summary)
		out = append(out, EventWithSource{
			Event: Event{
				ID:           EventKey(uid, calendarName, start),
				UID:          uid,
				CalendarName: calendarName,
				Title:        summary,
				StartTime:    start,
				EndTime:      endPtr,
				AllDay:       allDay,
			},
			CalendarName: calendarName,
		})
	}
	return out
}

// parseICalTime returns the naive time to store and whether the property was
// a DATE (all-day) value.
//
// Storage is naive wall-clock — no zone — and the frontend renders it as-is.
// That only reads correctly if the wall clock is the VIEWER's, so a
// zone-qualified value (TZID=... or a trailing Z) is first converted into
// `eventZone`: an event saved on Paris time at 18:30 is 09:30 here, and
// showing "6:30 PM" for it was simply wrong.
//
// Two kinds of value are deliberately left alone:
//   - a FLOATING time (no TZID, no Z) already means "this wall clock, wherever
//     you are" — converting it would invent an offset that isn't there;
//   - a DATE has no time to convert, and shifting one moves it off its day.
//
// For the common case — an event in the household's own zone — the stored
// value is unchanged, so event keys, event_date bucketing and the
// hidden_calendar_events rows keyed off them all stay put.
func parseICalTime(prop *goical.Prop) (time.Time, bool, bool) {
	isDate := prop.ValueType() == goical.ValueDate ||
		(len(strings.TrimSpace(prop.Value)) == 8 && !strings.Contains(prop.Value, "T"))
	t, err := prop.DateTime(time.UTC)
	if err != nil {
		return time.Time{}, false, false
	}
	if !isDate && zoneQualified(prop) {
		t = t.In(eventZone)
	}
	naive := time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(),
		t.Nanosecond(), time.UTC)
	return naive, isDate, true
}

// zoneQualified reports whether the property names a real instant — either via
// a TZID parameter or the UTC "Z" suffix — as opposed to a floating time.
func zoneQualified(prop *goical.Prop) bool {
	if prop.Params.Get(goical.PropTimezoneID) != "" {
		return true
	}
	return strings.HasSuffix(strings.ToUpper(strings.TrimSpace(prop.Value)), "Z")
}
