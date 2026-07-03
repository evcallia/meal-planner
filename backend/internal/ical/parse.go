package ical

import (
	"strings"
	"time"

	goical "github.com/emersion/go-ical"
)

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

// parseICalTime mirrors _parse_ical_date + _is_all_day: returns the naive
// time and whether the property was a DATE (all-day) value.
//
// Python's `dt.replace(tzinfo=None)` DROPS the timezone but KEEPS the
// wall-clock reading — a TZID=America/New_York 10:30 stays 10:30, it is NOT
// converted to UTC. Event keys, event_date bucketing, and existing
// hidden-event rows all depend on that behavior, so mirror it exactly.
func parseICalTime(prop *goical.Prop) (time.Time, bool, bool) {
	isDate := prop.ValueType() == goical.ValueDate ||
		(len(strings.TrimSpace(prop.Value)) == 8 && !strings.Contains(prop.Value, "T"))
	t, err := prop.DateTime(time.UTC)
	if err != nil {
		return time.Time{}, false, false
	}
	naive := time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(),
		t.Nanosecond(), time.UTC)
	return naive, isDate, true
}
