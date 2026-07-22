package ical

import (
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/config"
	"mealplanner/internal/models"
)

const (
	CacheWeeksBefore     = 4
	CacheWeeksAfter      = 8
	CacheRefreshInterval = 30 * time.Minute
	CalendarCacheTTL     = 10 * time.Minute
	HolidaysCacheTTL     = 24 * time.Hour

	USHolidaysICalURL      = "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics"
	USHolidaysCalendarName = "US Holidays"
)

// Service owns the calendar caches and background refresh, mirroring the
// module-level state in ical_service.py.
type Service struct {
	settings *config.Settings
	db       *gorm.DB

	mu             sync.Mutex
	calendarsCache struct {
		at        time.Time
		calendars []Calendar
	}
	holidaysCache struct {
		at     time.Time
		events []EventWithSource
	}
	refreshInProgress bool

	stopRefresh chan struct{}
	stopOnce    sync.Once

	// Test seams: replace to stub network access.
	FetchCalDAVEvents func(start, end time.Time) []EventWithSource
	FetchHolidaysRaw  func() ([]byte, error)
	ListCalendarsFn   func() ([]Calendar, error)
}

func NewService(settings *config.Settings, db *gorm.DB) *Service {
	s := &Service{settings: settings, db: db, stopRefresh: make(chan struct{})}
	s.FetchCalDAVEvents = s.fetchEventsFromCalDAV
	s.FetchHolidaysRaw = s.fetchHolidaysHTTP
	s.ListCalendarsFn = s.listCalendarsCalDAV
	return s
}

func (s *Service) logf(format string, args ...any) {
	if s.settings.DebugTiming {
		log.Printf(format, args...)
	}
}

func todayUTC() time.Time { return dateOf(time.Now()) }

// CacheRange mirrors _get_cache_range.
func CacheRange() (time.Time, time.Time) {
	today := todayUTC()
	return today.AddDate(0, 0, -7*CacheWeeksBefore), today.AddDate(0, 0, 7*CacheWeeksAfter)
}

// ---- CalDAV ----

func (s *Service) client() *caldavClient {
	return newCalDAVClient(AppleCalDAVURL, s.settings.AppleCalendarEmail, s.settings.AppleCalendarAppPassword)
}

func (s *Service) listCalendarsCalDAV() ([]Calendar, error) {
	if s.settings.AppleCalendarEmail == "" || s.settings.AppleCalendarAppPassword == "" {
		return nil, nil
	}
	return s.client().Calendars()
}

// ListAvailableCalendars mirrors list_available_calendars_sync.
func (s *Service) ListAvailableCalendars() []string {
	calendars, err := s.ListCalendarsFn()
	if err != nil {
		s.logf("Error connecting to CalDAV: %v", err)
		return []string{}
	}
	names := make([]string, 0, len(calendars))
	for _, c := range calendars {
		names = append(names, c.Name)
	}
	return names
}

// SelectedCalendars mirrors _get_selected_calendars_sync (with its 10-minute
// connection cache and name filtering).
func (s *Service) SelectedCalendars() []Calendar {
	var selectedNames []string
	for _, name := range splitComma(s.settings.AppleCalendarNames) {
		selectedNames = append(selectedNames, name)
	}

	s.mu.Lock()
	cached := s.calendarsCache
	s.mu.Unlock()
	if len(cached.calendars) > 0 && time.Since(cached.at) < CalendarCacheTTL {
		if len(selectedNames) > 0 {
			cachedNames := map[string]bool{}
			for _, c := range cached.calendars {
				cachedNames[c.Name] = true
			}
			match := true
			for _, c := range cached.calendars {
				found := false
				for _, n := range selectedNames {
					if n == c.Name {
						found = true
					}
				}
				if !found {
					match = false
				}
			}
			if match {
				return cached.calendars
			}
		} else if len(cached.calendars) == 1 {
			return cached.calendars
		}
	}

	all, err := s.ListCalendarsFn()
	if err != nil || len(all) == 0 {
		if err != nil {
			s.logf("Error connecting to CalDAV: %v", err)
		}
		return nil
	}

	var selected []Calendar
	if len(selectedNames) > 0 {
		for _, c := range all {
			for _, n := range selectedNames {
				if c.Name == n {
					selected = append(selected, c)
					break
				}
			}
		}
		if len(selected) == 0 {
			selected = []Calendar{all[0]}
		}
	} else {
		selected = []Calendar{all[0]}
	}

	s.mu.Lock()
	s.calendarsCache.at = time.Now()
	s.calendarsCache.calendars = selected
	s.mu.Unlock()
	return selected
}

func splitComma(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// fetchEventsFromCalDAV mirrors _fetch_events_from_caldav.
func (s *Service) fetchEventsFromCalDAV(startDate, endDate time.Time) []EventWithSource {
	if s.settings.AppleCalendarEmail == "" || s.settings.AppleCalendarAppPassword == "" {
		return nil
	}
	calendars := s.SelectedCalendars()
	if len(calendars) == 0 {
		return nil
	}
	client := s.client()
	startDT := dateOf(startDate)
	endDT := dateOf(endDate).Add(24*time.Hour - time.Second) // datetime.max.time() ≈ end of day

	var all []EventWithSource
	for _, cal := range calendars {
		blobs, err := client.Events(cal, startDT, endDT)
		if err != nil {
			s.logf("Error fetching from calendar %q: %v", cal.Name, err)
			continue
		}
		for _, blob := range blobs {
			for _, ev := range parseICSEvents(blob, cal.Name) {
				eventDate := dateOf(ev.Event.StartTime)
				endDate2 := eventDate
				if ev.Event.EndTime != nil {
					endDate2 = dateOf(*ev.Event.EndTime)
				}
				if endDate2.Before(dateOf(startDate)) || eventDate.After(dateOf(endDate)) {
					continue
				}
				all = append(all, ev)
			}
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		return all[i].Event.StartTime.Before(all[j].Event.StartTime)
	})
	return all
}

// ---- Holidays ----

func (s *Service) fetchHolidaysHTTP() ([]byte, error) {
	req, err := http.NewRequest("GET", USHolidaysICalURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "meal-planner/1.0")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

// FetchHolidays mirrors _fetch_holidays_sync with its 24h in-memory cache.
func (s *Service) FetchHolidays(startDate, endDate time.Time) []EventWithSource {
	s.mu.Lock()
	cache := s.holidaysCache
	s.mu.Unlock()

	filter := func(events []EventWithSource) []EventWithSource {
		var out []EventWithSource
		for _, e := range events {
			d := dateOf(e.Event.StartTime)
			if !d.Before(dateOf(startDate)) && !d.After(dateOf(endDate)) {
				out = append(out, e)
			}
		}
		return out
	}

	if len(cache.events) > 0 && time.Since(cache.at) < HolidaysCacheTTL {
		return filter(cache.events)
	}

	data, err := s.FetchHolidaysRaw()
	if err != nil {
		s.logf("[Holidays] Error fetching holidays: %v", err)
		return nil
	}
	all := parseICSEvents(data, USHolidaysCalendarName)
	sort.SliceStable(all, func(i, j int) bool {
		return all[i].Event.StartTime.Before(all[j].Event.StartTime)
	})

	s.mu.Lock()
	s.holidaysCache.at = time.Now()
	s.holidaysCache.events = all
	s.mu.Unlock()
	return filter(all)
}

// ---- DB cache ----

// pruneHiddenEvents mirrors _prune_hidden_events.
func (s *Service) pruneHiddenEvents(tx *gorm.DB, startDate, endDate time.Time, events []EventWithSource) {
	var hidden []models.HiddenCalendarEvent
	if tx.Where("event_date >= ? AND event_date <= ?", startDate, endDate).Find(&hidden).Error != nil {
		return
	}
	if len(hidden) == 0 {
		return
	}
	valid := map[string]bool{}
	for _, e := range events {
		valid[EventKey(e.Event.UID, e.CalendarName, e.Event.StartTime)] = true
	}
	for i := range hidden {
		key := EventKey(hidden[i].EventUID, hidden[i].CalendarName, hidden[i].StartTime)
		if !valid[key] {
			tx.Delete(&hidden[i])
		}
	}
}

func cachedFromEvent(e EventWithSource, calendarName string) models.CachedCalendarEvent {
	return models.CachedCalendarEvent{
		EventDate:    dateOf(e.Event.StartTime),
		EventUID:     e.Event.UID,
		CalendarName: calendarName,
		Title:        e.Event.Title,
		StartTime:    e.Event.StartTime,
		EndTime:      e.Event.EndTime,
		AllDay:       e.Event.AllDay,
	}
}

// RefreshDBCache mirrors _refresh_db_cache_sync.
func (s *Service) RefreshDBCache() {
	start, end := CacheRange()
	events := s.FetchCalDAVEvents(start, end)

	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("event_date >= ? AND event_date <= ?", start, end).
			Delete(&models.CachedCalendarEvent{}).Error; err != nil {
			return err
		}
		for _, e := range events {
			row := cachedFromEvent(e, e.CalendarName)
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		for _, e := range s.FetchHolidays(start, end) {
			row := cachedFromEvent(e, USHolidaysCalendarName)
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		s.pruneHiddenEvents(tx, start, end, events)

		var meta models.CalendarCacheMetadata
		if tx.First(&meta).Error != nil {
			meta = models.CalendarCacheMetadata{ID: 1}
			if err := tx.Create(&meta).Error; err != nil {
				return err
			}
		}
		now := models.NowUTC()
		startD, endD := start, end
		return tx.Model(&models.CalendarCacheMetadata{}).Where("id = ?", meta.ID).Updates(map[string]any{
			"last_refresh": now, "cache_start": startD, "cache_end": endD,
		}).Error
	})
	if err != nil {
		s.logf("[CalDAV Cache] Error refreshing DB cache: %v", err)
	}
}

// GetEventsFromDB mirrors _get_events_from_db.
func (s *Service) GetEventsFromDB(startDate, endDate time.Time) []Event {
	var cached []models.CachedCalendarEvent
	err := s.db.Where("event_date <= ? AND (event_date >= ? OR end_time >= ?)",
		endDate, startDate, dateOf(startDate)).
		Order("start_time").Find(&cached).Error
	if err != nil {
		return nil
	}
	events := make([]Event, 0, len(cached))
	for _, e := range cached {
		events = append(events, Event{
			ID:           EventKey(e.EventUID, e.CalendarName, e.StartTime),
			UID:          e.EventUID,
			CalendarName: e.CalendarName,
			Title:        e.Title,
			StartTime:    e.StartTime,
			EndTime:      e.EndTime,
			AllDay:       e.AllDay,
		})
	}
	return events
}

// CacheMetadata mirrors _get_cache_metadata.
func (s *Service) CacheMetadata() (*time.Time, *time.Time) {
	var meta models.CalendarCacheMetadata
	if s.db.First(&meta).Error != nil {
		return nil, nil
	}
	return meta.CacheStart, meta.CacheEnd
}

// fetchAndCacheEvents mirrors _fetch_and_cache_events_sync.
func (s *Service) fetchAndCacheEvents(startDate, endDate time.Time) []Event {
	events := s.FetchCalDAVEvents(startDate, endDate)
	holidays := s.FetchHolidays(startDate, endDate)

	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("event_date >= ? AND event_date <= ?", startDate, endDate).
			Delete(&models.CachedCalendarEvent{}).Error; err != nil {
			return err
		}
		for _, e := range events {
			row := cachedFromEvent(e, e.CalendarName)
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		for _, e := range holidays {
			row := cachedFromEvent(e, USHolidaysCalendarName)
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		s.pruneHiddenEvents(tx, startDate, endDate, events)
		return nil
	})
	if err != nil {
		s.logf("[CalDAV Cache] Error caching events: %v", err)
	}

	out := make([]Event, 0, len(events)+len(holidays))
	for _, e := range events {
		out = append(out, e.Event)
	}
	for _, e := range holidays {
		out = append(out, e.Event)
	}
	return out
}

// filterHiddenEvents mirrors _filter_hidden_events. Hides are per-user: only
// rows belonging to sub are applied.
func (s *Service) filterHiddenEvents(events []Event, startDate, endDate time.Time, sub string) []Event {
	if len(events) == 0 {
		return events
	}
	var hidden []models.HiddenCalendarEvent
	err := s.db.Where("sub = ? AND event_date <= ? AND (event_date >= ? OR end_time >= ?)",
		sub, endDate, startDate, dateOf(startDate)).Find(&hidden).Error
	if err != nil || len(hidden) == 0 {
		return events
	}
	hiddenKeys := map[string]bool{}
	for _, h := range hidden {
		hiddenKeys[EventKey(h.EventUID, h.CalendarName, h.StartTime)] = true
	}
	out := make([]Event, 0, len(events))
	for _, e := range events {
		if !hiddenKeys[e.ID] {
			out = append(out, e)
		}
	}
	return out
}

// FetchICalEvents mirrors fetch_ical_events: serve from the DB cache when the
// range is covered, otherwise fetch the uncovered parts from CalDAV.
// hiddenForSub is whose hidden-event rows to apply when includeHidden is false.
func (s *Service) FetchICalEvents(startDate, endDate time.Time, includeHidden, includeHolidays bool, hiddenForSub string) []Event {
	cacheStart, cacheEnd := s.CacheMetadata()

	applyFilters := func(events []Event) []Event {
		if !includeHidden {
			events = s.filterHiddenEvents(events, startDate, endDate, hiddenForSub)
		}
		if !includeHolidays {
			out := make([]Event, 0, len(events))
			for _, e := range events {
				if e.CalendarName != USHolidaysCalendarName {
					out = append(out, e)
				}
			}
			events = out
		}
		return events
	}

	if cacheStart != nil && cacheEnd != nil &&
		!startDate.Before(*cacheStart) && !endDate.After(*cacheEnd) {
		return applyFilters(s.GetEventsFromDB(startDate, endDate))
	}

	if cacheStart != nil && cacheEnd != nil {
		var events []Event
		if startDate.Before(*cacheStart) {
			fetchEnd := *cacheStart
			fetchEnd = fetchEnd.AddDate(0, 0, -1)
			if endDate.Before(fetchEnd) {
				fetchEnd = endDate
			}
			events = append(events, s.fetchAndCacheEvents(startDate, fetchEnd)...)
		}
		overlapStart, overlapEnd := startDate, endDate
		if overlapStart.Before(*cacheStart) {
			overlapStart = *cacheStart
		}
		if overlapEnd.After(*cacheEnd) {
			overlapEnd = *cacheEnd
		}
		if !overlapStart.After(overlapEnd) {
			events = append(events, s.GetEventsFromDB(overlapStart, overlapEnd)...)
		}
		if endDate.After(*cacheEnd) {
			fetchStart := cacheEnd.AddDate(0, 0, 1)
			if startDate.After(fetchStart) {
				fetchStart = startDate
			}
			events = append(events, s.fetchAndCacheEvents(fetchStart, endDate)...)
		}
		sort.SliceStable(events, func(i, j int) bool {
			return events[i].StartTime.Before(events[j].StartTime)
		})
		return applyFilters(events)
	}

	return applyFilters(s.fetchAndCacheEvents(startDate, endDate))
}

// ---- lifecycle ----

// SetRefreshing tracks the calendar.refresh in-progress flag.
func (s *Service) SetRefreshing(v bool) {
	s.mu.Lock()
	s.refreshInProgress = v
	s.mu.Unlock()
}

// TryStartRefresh atomically claims the refresh flag; callers that get true
// must SetRefreshing(false) when done. Closes the check-then-spawn race
// where two concurrent refresh requests both passed IsRefreshing.
func (s *Service) TryStartRefresh() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refreshInProgress {
		return false
	}
	s.refreshInProgress = true
	return true
}

func (s *Service) IsRefreshing() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refreshInProgress
}

// InitializeCache refreshes on startup and starts the 30-minute refresh loop
// (in a goroutine — startup isn't blocked, mirroring asyncio.create_task).
func (s *Service) InitializeCache() {
	refresh := func() {
		if s.TryStartRefresh() {
			defer s.SetRefreshing(false)
			s.RefreshDBCache()
		}
	}
	go func() {
		refresh()
		ticker := time.NewTicker(CacheRefreshInterval)
		defer ticker.Stop()
		for {
			select {
			case <-s.stopRefresh:
				return
			case <-ticker.C:
				refresh()
			}
		}
	}()
}

// Shutdown stops the background refresh loop.
func (s *Service) Shutdown() {
	s.stopOnce.Do(func() { close(s.stopRefresh) })
}
