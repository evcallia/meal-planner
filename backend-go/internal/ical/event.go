// Package ical ports backend/app/ical_service.py: Google-holidays feed +
// Apple CalDAV fetching with a DB-backed cache.
package ical

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"time"

	"mealplanner/internal/httpx"
)

// Event mirrors schemas.CalendarEvent.
type Event struct {
	ID           string
	UID          string
	CalendarName string
	Title        string
	StartTime    time.Time
	EndTime      *time.Time
	AllDay       bool
}

func (e Event) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{
		"id":            e.ID,
		"uid":           e.UID,
		"calendar_name": e.CalendarName,
		"title":         e.Title,
		"start_time":    httpx.FormatDateTime(e.StartTime),
		"end_time":      httpx.FormatDateTimePtr(e.EndTime),
		"all_day":       e.AllDay,
	})
}

// EventWithSource tracks which calendar an event came from.
type EventWithSource struct {
	Event        Event
	CalendarName string
}

// NormalizeUID mirrors _normalize_uid.
func NormalizeUID(rawUID, calendarName string, eventStart time.Time, title string) string {
	if rawUID != "" {
		return rawUID
	}
	base := calendarName + "|" + title + "|" + httpx.FormatDateTime(eventStart)
	digest := sha1.Sum([]byte(base))
	return "fallback-" + hex.EncodeToString(digest[:])
}

// EventKey mirrors _event_key.
func EventKey(eventUID, calendarName string, eventStart time.Time) string {
	return eventUID + "|" + calendarName + "|" + httpx.FormatDateTime(eventStart)
}

// dateOf truncates to a midnight-UTC date.
func dateOf(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// GetEventsForDate filters events for a specific date, including multi-day
// events that span it. All-day DTEND is exclusive per the iCal spec.
func GetEventsForDate(events []Event, targetDate time.Time) []Event {
	target := dateOf(targetDate)
	result := []Event{}
	for _, e := range events {
		start := dateOf(e.StartTime)
		if e.EndTime != nil {
			end := dateOf(*e.EndTime)
			if e.AllDay && end.After(start) {
				end = end.AddDate(0, 0, -1)
			}
			if !target.Before(start) && !target.After(end) {
				result = append(result, e)
			}
		} else if start.Equal(target) {
			result = append(result, e)
		}
	}
	return result
}
