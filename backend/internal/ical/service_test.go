package ical

// Ports the service-level tests from backend/tests/test_ical_service.py:
// calendar selection (TestCalendarConnection, TestSelectedCalendarsWithCache,
// TestListAvailableCalendars), CalDAV fetch guards, cache range, DB caching
// (TestDatabaseCaching, TestGetCacheMetadata), the fetch_ical_events cache
// coverage logic (TestFetchICalEvents, TestFetchEventsPartialCache), error
// handling (TestRefreshDbCacheError, TestFetchAndCacheEventsError), lifecycle
// (TestInitializeAndShutdownCache), plus the holiday-feed parsing/caching and
// hidden-event filter/prune behavior exercised through the Go test seams.

import (
	"errors"
	"testing"
	"time"

	"mealplanner/internal/config"
	appdb "mealplanner/internal/db"
	"mealplanner/internal/models"
)

// emptyICS is a valid feed with no events (Python patched
// _fetch_holidays_sync to return []).
var emptyICS = ics()

func newTestService(t *testing.T, settings *config.Settings) *Service {
	t.Helper()
	gdb, err := appdb.OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := appdb.CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	if settings == nil {
		settings = &config.Settings{}
	}
	svc := NewService(settings, gdb)
	// No network in tests.
	svc.FetchCalDAVEvents = func(start, end time.Time) []EventWithSource { return nil }
	svc.FetchHolidaysRaw = func() ([]byte, error) { return emptyICS, nil }
	svc.ListCalendarsFn = func() ([]Calendar, error) { return nil, nil }
	return svc
}

func seedMetadata(t *testing.T, svc *Service, cacheStart, cacheEnd time.Time) {
	t.Helper()
	now := models.NowUTC()
	meta := models.CalendarCacheMetadata{
		ID: 1, LastRefresh: &now, CacheStart: &cacheStart, CacheEnd: &cacheEnd,
	}
	if err := svc.db.Create(&meta).Error; err != nil {
		t.Fatalf("seed metadata: %v", err)
	}
}

func seedCachedEvent(t *testing.T, svc *Service, calName, title string, start time.Time, end *time.Time) models.CachedCalendarEvent {
	t.Helper()
	uid := "uid-" + title
	row := models.CachedCalendarEvent{
		EventDate:    dateOf(start),
		EventUID:     uid,
		CalendarName: calName,
		Title:        title,
		StartTime:    start,
		EndTime:      end,
		AllDay:       false,
	}
	if err := svc.db.Create(&row).Error; err != nil {
		t.Fatalf("seed cached event: %v", err)
	}
	return row
}

// recordFetches replaces FetchCalDAVEvents with a recorder returning the
// given events, mirroring @patch(_fetch_events_from_caldav / _fetch_and_cache_events_sync).
func recordFetches(svc *Service, events []EventWithSource) *[][2]time.Time {
	calls := &[][2]time.Time{}
	svc.FetchCalDAVEvents = func(start, end time.Time) []EventWithSource {
		*calls = append(*calls, [2]time.Time{start, end})
		return events
	}
	return calls
}

func eventWithSource(calName, title string, start time.Time, end *time.Time) EventWithSource {
	uid := "uid-" + title
	return EventWithSource{
		Event: Event{
			ID:           EventKey(uid, calName, start),
			UID:          uid,
			CalendarName: calName,
			Title:        title,
			StartTime:    start,
			EndTime:      end,
		},
		CalendarName: calName,
	}
}

// ---- calendar connection / selection ----

// test_get_all_calendars_no_credentials: the real CalDAV lister short-circuits
// to nothing when credentials are missing.
func TestListCalendarsNoCredentials(t *testing.T) {
	svc := NewService(&config.Settings{}, nil) // default ListCalendarsFn, empty creds
	calendars, err := svc.listCalendarsCalDAV()
	if err != nil || len(calendars) != 0 {
		t.Errorf("expected no calendars without credentials, got %v, %v", calendars, err)
	}
	if names := svc.ListAvailableCalendars(); len(names) != 0 {
		t.Errorf("expected empty names, got %v", names)
	}
}

// test_get_selected_calendars_success.
func TestSelectedCalendarsSuccess(t *testing.T) {
	svc := newTestService(t, &config.Settings{AppleCalendarNames: "Personal"})
	svc.ListCalendarsFn = func() ([]Calendar, error) {
		return []Calendar{{Name: "Personal"}}, nil
	}
	result := svc.SelectedCalendars()
	if len(result) != 1 || result[0].Name != "Personal" {
		t.Errorf("selected = %v, want [Personal]", result)
	}
}

// test_get_all_calendars_connection_error (adapted: the Go seam is
// ListCalendarsFn returning an error instead of caldav.DAVClient raising).
func TestSelectedCalendarsConnectionError(t *testing.T) {
	svc := newTestService(t, &config.Settings{AppleCalendarNames: "Personal"})
	svc.ListCalendarsFn = func() ([]Calendar, error) {
		return nil, errors.New("Connection failed")
	}
	if result := svc.SelectedCalendars(); len(result) != 0 {
		t.Errorf("expected no calendars on connection error, got %v", result)
	}
	if names := svc.ListAvailableCalendars(); len(names) != 0 {
		t.Errorf("expected empty names on connection error, got %v", names)
	}
}

// test_get_selected_calendars_multiple.
func TestSelectedCalendarsMultiple(t *testing.T) {
	svc := newTestService(t, &config.Settings{AppleCalendarNames: "Personal,Work"})
	svc.ListCalendarsFn = func() ([]Calendar, error) {
		return []Calendar{{Name: "Personal"}, {Name: "Work"}, {Name: "Other"}}, nil
	}
	result := svc.SelectedCalendars()
	if len(result) != 2 {
		t.Fatalf("expected 2 calendars, got %d", len(result))
	}
	names := map[string]bool{}
	for _, c := range result {
		names[c.Name] = true
	}
	if !names["Personal"] || !names["Work"] || names["Other"] {
		t.Errorf("names = %v", names)
	}
}

// test_get_selected_calendars_no_filter: no configured names -> first calendar.
func TestSelectedCalendarsNoFilter(t *testing.T) {
	svc := newTestService(t, &config.Settings{AppleCalendarNames: ""})
	svc.ListCalendarsFn = func() ([]Calendar, error) {
		return []Calendar{{Name: "Default"}, {Name: "Second"}}, nil
	}
	result := svc.SelectedCalendars()
	if len(result) != 1 || result[0].Name != "Default" {
		t.Errorf("selected = %v, want [Default]", result)
	}
}

// test_get_selected_calendars_no_match_fallback.
func TestSelectedCalendarsNoMatchFallback(t *testing.T) {
	svc := newTestService(t, &config.Settings{AppleCalendarNames: "NonExistent"})
	svc.ListCalendarsFn = func() ([]Calendar, error) {
		return []Calendar{{Name: "ActualCalendar"}}, nil
	}
	result := svc.SelectedCalendars()
	if len(result) != 1 || result[0].Name != "ActualCalendar" {
		t.Errorf("selected = %v, want fallback [ActualCalendar]", result)
	}
}

// The 10-minute connection cache: a second call within the TTL must not hit
// the CalDAV lister again.
func TestSelectedCalendarsTTLCache(t *testing.T) {
	svc := newTestService(t, &config.Settings{AppleCalendarNames: "Personal"})
	calls := 0
	svc.ListCalendarsFn = func() ([]Calendar, error) {
		calls++
		return []Calendar{{Name: "Personal"}, {Name: "Work"}}, nil
	}
	first := svc.SelectedCalendars()
	second := svc.SelectedCalendars()
	if calls != 1 {
		t.Errorf("expected 1 CalDAV connection, got %d", calls)
	}
	if len(first) != 1 || len(second) != 1 || second[0].Name != "Personal" {
		t.Errorf("selected = %v then %v", first, second)
	}
}

// TTL cache also covers the no-filter single-calendar case.
func TestSelectedCalendarsTTLCacheNoFilter(t *testing.T) {
	svc := newTestService(t, &config.Settings{AppleCalendarNames: ""})
	calls := 0
	svc.ListCalendarsFn = func() ([]Calendar, error) {
		calls++
		return []Calendar{{Name: "Default"}}, nil
	}
	svc.SelectedCalendars()
	result := svc.SelectedCalendars()
	if calls != 1 {
		t.Errorf("expected 1 CalDAV connection, got %d", calls)
	}
	if len(result) != 1 || result[0].Name != "Default" {
		t.Errorf("selected = %v", result)
	}
}

// ---- fetching from CalDAV ----

// test_fetch_events_no_calendar: no selectable calendars -> no events (and no
// network access, since SelectedCalendars comes back empty).
func TestFetchEventsFromCalDAVNoCalendar(t *testing.T) {
	svc := newTestService(t, &config.Settings{
		AppleCalendarEmail:       "test@icloud.com",
		AppleCalendarAppPassword: "app-password",
	})
	svc.ListCalendarsFn = func() ([]Calendar, error) { return nil, nil }
	if result := svc.fetchEventsFromCalDAV(d(2024, 2, 15), d(2024, 2, 15)); len(result) != 0 {
		t.Errorf("expected no events, got %v", result)
	}
}

// Without credentials the fetch is skipped entirely.
func TestFetchEventsFromCalDAVNoCredentials(t *testing.T) {
	svc := newTestService(t, &config.Settings{})
	if result := svc.fetchEventsFromCalDAV(d(2024, 2, 15), d(2024, 2, 15)); len(result) != 0 {
		t.Errorf("expected no events without credentials, got %v", result)
	}
}

// ---- cache range ----

// test_get_cache_range.
func TestCacheRange(t *testing.T) {
	start, end := CacheRange()
	today := todayUTC()
	if !start.Equal(today.AddDate(0, 0, -7*CacheWeeksBefore)) {
		t.Errorf("cache start = %v", start)
	}
	if !end.Equal(today.AddDate(0, 0, 7*CacheWeeksAfter)) {
		t.Errorf("cache end = %v", end)
	}
}

// ---- database caching ----

// test_get_events_from_db.
func TestGetEventsFromDB(t *testing.T) {
	svc := newTestService(t, nil)
	seedCachedEvent(t, svc, "TestCal", "Event 1", dt(2024, 2, 15, 10, 0), tp(dt(2024, 2, 15, 11, 0)))
	seedCachedEvent(t, svc, "TestCal", "Event 2", dt(2024, 2, 15, 14, 0), tp(dt(2024, 2, 15, 15, 0)))
	seedCachedEvent(t, svc, "TestCal", "Event 3", dt(2024, 2, 16, 10, 0), tp(dt(2024, 2, 16, 11, 0)))

	result := svc.GetEventsFromDB(d(2024, 2, 15), d(2024, 2, 15))
	if len(result) != 2 {
		t.Fatalf("expected 2 events, got %d", len(result))
	}
	for _, e := range result {
		if !dateOf(e.StartTime).Equal(d(2024, 2, 15)) {
			t.Errorf("event %q not on Feb 15: %v", e.Title, e.StartTime)
		}
	}
	// Ordered by start_time.
	if result[0].Title != "Event 1" || result[1].Title != "Event 2" {
		t.Errorf("order = %q, %q", result[0].Title, result[1].Title)
	}
}

// Multi-day events whose end_time extends into the requested range are
// included even though their event_date is earlier.
func TestGetEventsFromDBMultiDayOverlap(t *testing.T) {
	svc := newTestService(t, nil)
	seedCachedEvent(t, svc, "TestCal", "Trip", dt(2024, 2, 13, 10, 0), tp(dt(2024, 2, 16, 11, 0)))
	result := svc.GetEventsFromDB(d(2024, 2, 15), d(2024, 2, 15))
	if len(result) != 1 || result[0].Title != "Trip" {
		t.Errorf("expected spanning event, got %v", result)
	}
}

// test_refresh_db_cache_sync.
func TestRefreshDBCache(t *testing.T) {
	svc := newTestService(t, nil)
	recordFetches(svc, []EventWithSource{
		eventWithSource("TestCalendar", "Cached Event", dt(2024, 2, 15, 10, 0), tp(dt(2024, 2, 15, 11, 0))),
	})

	svc.RefreshDBCache()

	var cached []models.CachedCalendarEvent
	if err := svc.db.Find(&cached).Error; err != nil {
		t.Fatalf("query cached: %v", err)
	}
	if len(cached) != 1 {
		t.Fatalf("expected 1 cached event, got %d", len(cached))
	}
	if cached[0].Title != "Cached Event" || cached[0].CalendarName != "TestCalendar" {
		t.Errorf("cached = %+v", cached[0])
	}

	var meta models.CalendarCacheMetadata
	if err := svc.db.First(&meta).Error; err != nil {
		t.Fatalf("metadata missing: %v", err)
	}
	if meta.LastRefresh == nil {
		t.Error("last_refresh should be set")
	}
	start, end := CacheRange()
	if meta.CacheStart == nil || !dateOf(*meta.CacheStart).Equal(start) {
		t.Errorf("cache_start = %v, want %v", meta.CacheStart, start)
	}
	if meta.CacheEnd == nil || !dateOf(*meta.CacheEnd).Equal(end) {
		t.Errorf("cache_end = %v, want %v", meta.CacheEnd, end)
	}
}

// test_fetch_and_cache_events_sync.
func TestFetchAndCacheEvents(t *testing.T) {
	svc := newTestService(t, nil)
	recordFetches(svc, []EventWithSource{
		eventWithSource("TestCalendar", "New Event", dt(2024, 3, 1, 10, 0), tp(dt(2024, 3, 1, 11, 0))),
	})

	result := svc.fetchAndCacheEvents(d(2024, 3, 1), d(2024, 3, 1))
	if len(result) != 1 || result[0].Title != "New Event" {
		t.Fatalf("result = %v", result)
	}

	var cached []models.CachedCalendarEvent
	svc.db.Find(&cached)
	if len(cached) != 1 || cached[0].CalendarName != "TestCalendar" {
		t.Errorf("cached = %+v", cached)
	}
}

// ---- fetch_ical_events cache coverage ----

// test_fetch_events_from_cache: range fully covered -> served from DB, no
// CalDAV fetch.
func TestFetchICalEventsFromCache(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	seedMetadata(t, svc, today.AddDate(0, 0, -28), today.AddDate(0, 0, 56))
	seedCachedEvent(t, svc, "TestCal", "Today's Event",
		today.Add(10*time.Hour), tp(today.Add(11*time.Hour)))
	calls := recordFetches(svc, nil)

	result := svc.FetchICalEvents(today, today, true, true)
	if len(result) != 1 || result[0].Title != "Today's Event" {
		t.Fatalf("result = %v", result)
	}
	if len(*calls) != 0 {
		t.Errorf("expected no CalDAV fetch when range is cached, got %d", len(*calls))
	}
}

// test_fetch_events_outside_cache: range beyond cache_end -> fetched from
// CalDAV once.
func TestFetchICalEventsOutsideCache(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	seedMetadata(t, svc, today.AddDate(0, 0, -28), today.AddDate(0, 0, 56))
	farFuture := today.AddDate(0, 0, 365)
	calls := recordFetches(svc, []EventWithSource{
		eventWithSource("TestCal", "Future Event", farFuture.Add(10*time.Hour), nil),
	})

	result := svc.FetchICalEvents(farFuture, farFuture, true, true)
	if len(*calls) != 1 {
		t.Fatalf("expected 1 CalDAV fetch, got %d", len(*calls))
	}
	if got := (*calls)[0]; !got[0].Equal(farFuture) || !got[1].Equal(farFuture) {
		t.Errorf("fetched range = %v, want [%v, %v]", got, farFuture, farFuture)
	}
	if len(result) != 1 || result[0].Title != "Future Event" {
		t.Errorf("result = %v", result)
	}
}

// test_fetch_events_no_cache: no metadata -> everything fetched.
func TestFetchICalEventsNoCache(t *testing.T) {
	svc := newTestService(t, nil)
	calls := recordFetches(svc, []EventWithSource{
		eventWithSource("TestCal", "New Event", dt(2024, 2, 15, 10, 0), nil),
	})

	result := svc.FetchICalEvents(d(2024, 2, 15), d(2024, 2, 15), true, true)
	if len(*calls) != 1 {
		t.Fatalf("expected 1 CalDAV fetch, got %d", len(*calls))
	}
	if len(result) != 1 || result[0].Title != "New Event" {
		t.Errorf("result = %v", result)
	}
}

// test_fetch_events_pre_cache_range: request entirely before cache_start.
func TestFetchICalEventsPreCacheRange(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	seedMetadata(t, svc, today, today.AddDate(0, 0, 56))

	requestStart := today.AddDate(0, 0, -7)
	requestEnd := today.AddDate(0, 0, -1)
	calls := recordFetches(svc, []EventWithSource{
		eventWithSource("TestCal", "Past Event", requestStart.Add(10*time.Hour), nil),
	})

	result := svc.FetchICalEvents(requestStart, requestEnd, true, true)
	if len(result) != 1 || result[0].Title != "Past Event" {
		t.Fatalf("result = %v", result)
	}
	if len(*calls) != 1 {
		t.Fatalf("expected 1 CalDAV fetch, got %d", len(*calls))
	}
	if got := (*calls)[0]; !got[0].Equal(requestStart) || !got[1].Equal(requestEnd) {
		t.Errorf("fetched range = %v, want [%v, %v]", got, requestStart, requestEnd)
	}
}

// test_fetch_events_post_cache_range: request entirely after cache_end.
func TestFetchICalEventsPostCacheRange(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	cacheEnd := today.AddDate(0, 0, 56)
	seedMetadata(t, svc, today.AddDate(0, 0, -28), cacheEnd)

	requestStart := cacheEnd.AddDate(0, 0, 1)
	requestEnd := cacheEnd.AddDate(0, 0, 7)
	calls := recordFetches(svc, []EventWithSource{
		eventWithSource("TestCal", "Future Event", requestStart.Add(10*time.Hour), nil),
	})

	result := svc.FetchICalEvents(requestStart, requestEnd, true, true)
	if len(result) != 1 || result[0].Title != "Future Event" {
		t.Fatalf("result = %v", result)
	}
	if len(*calls) != 1 {
		t.Fatalf("expected 1 CalDAV fetch, got %d", len(*calls))
	}
	if got := (*calls)[0]; !got[0].Equal(requestStart) || !got[1].Equal(requestEnd) {
		t.Errorf("fetched range = %v, want [%v, %v]", got, requestStart, requestEnd)
	}
}

// A request straddling cache_start fetches only the uncovered head and serves
// the covered tail from the DB, merged and sorted.
func TestFetchICalEventsPartialOverlap(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	seedMetadata(t, svc, today, today.AddDate(0, 0, 56))
	seedCachedEvent(t, svc, "TestCal", "Cached Event", today.Add(10*time.Hour), nil)

	requestStart := today.AddDate(0, 0, -3)
	requestEnd := today.AddDate(0, 0, 3)
	calls := recordFetches(svc, []EventWithSource{
		eventWithSource("TestCal", "Fetched Event", today.AddDate(0, 0, -2).Add(9*time.Hour), nil),
	})

	result := svc.FetchICalEvents(requestStart, requestEnd, true, true)
	if len(*calls) != 1 {
		t.Fatalf("expected 1 CalDAV fetch, got %d", len(*calls))
	}
	wantFetchEnd := today.AddDate(0, 0, -1)
	if got := (*calls)[0]; !got[0].Equal(requestStart) || !got[1].Equal(wantFetchEnd) {
		t.Errorf("fetched range = %v, want [%v, %v]", got, requestStart, wantFetchEnd)
	}
	if len(result) != 2 {
		t.Fatalf("expected fetched + cached events, got %v", result)
	}
	if result[0].Title != "Fetched Event" || result[1].Title != "Cached Event" {
		t.Errorf("merged order = %q, %q", result[0].Title, result[1].Title)
	}
}

// ---- cache metadata ----

// test_get_cache_metadata_no_metadata.
func TestCacheMetadataNone(t *testing.T) {
	svc := newTestService(t, nil)
	start, end := svc.CacheMetadata()
	if start != nil || end != nil {
		t.Errorf("expected nil metadata, got %v, %v", start, end)
	}
}

// test_get_cache_metadata_with_data.
func TestCacheMetadataWithData(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	wantStart := today.AddDate(0, 0, -30)
	wantEnd := today.AddDate(0, 0, 60)
	seedMetadata(t, svc, wantStart, wantEnd)

	start, end := svc.CacheMetadata()
	if start == nil || !dateOf(*start).Equal(wantStart) {
		t.Errorf("cache_start = %v, want %v", start, wantStart)
	}
	if end == nil || !dateOf(*end).Equal(wantEnd) {
		t.Errorf("cache_end = %v, want %v", end, wantEnd)
	}
}

// ---- list available calendars ----

// test_list_available_calendars_sync.
func TestListAvailableCalendars(t *testing.T) {
	svc := newTestService(t, nil)
	svc.ListCalendarsFn = func() ([]Calendar, error) {
		return []Calendar{{Name: "Personal"}, {Name: "Work"}}, nil
	}
	names := svc.ListAvailableCalendars()
	if len(names) != 2 || names[0] != "Personal" || names[1] != "Work" {
		t.Errorf("names = %v", names)
	}
}

// test_list_available_calendars_empty.
func TestListAvailableCalendarsEmpty(t *testing.T) {
	svc := newTestService(t, nil)
	if names := svc.ListAvailableCalendars(); len(names) != 0 {
		t.Errorf("names = %v", names)
	}
}

// ---- holidays ----

var holidaysICS = ics(
	[]string{
		"UID:holiday-1",
		"SUMMARY:New Year's Day",
		"DTSTART;VALUE=DATE:20260101",
		"DTEND;VALUE=DATE:20260102",
	},
	[]string{
		// No UID -> exercises the fallback hashing.
		"SUMMARY:Independence Day",
		"DTSTART;VALUE=DATE:20260704",
		"DTEND;VALUE=DATE:20260705",
	},
)

// Holiday feed parsing: DATE values are all-day, the calendar name is
// "US Holidays", missing UIDs fall back to a stable hash, and results are
// filtered to the requested range.
func TestFetchHolidaysParsing(t *testing.T) {
	svc := newTestService(t, nil)
	svc.FetchHolidaysRaw = func() ([]byte, error) { return holidaysICS, nil }

	result := svc.FetchHolidays(d(2026, 1, 1), d(2026, 1, 31))
	if len(result) != 1 {
		t.Fatalf("expected only January holiday, got %d", len(result))
	}
	e := result[0].Event
	if e.Title != "New Year's Day" || !e.AllDay {
		t.Errorf("event = %+v", e)
	}
	if e.UID != "holiday-1" || result[0].CalendarName != USHolidaysCalendarName {
		t.Errorf("uid = %q, source = %q", e.UID, result[0].CalendarName)
	}

	july := svc.FetchHolidays(d(2026, 7, 1), d(2026, 7, 31))
	if len(july) != 1 || july[0].Event.Title != "Independence Day" {
		t.Fatalf("july = %v", july)
	}
	if uid := july[0].Event.UID; len(uid) < 9 || uid[:9] != "fallback-" {
		t.Errorf("missing UID should hash to fallback, got %q", uid)
	}
}

// The 24-hour in-memory holidays cache: a second call must not re-fetch.
func TestFetchHolidays24hCache(t *testing.T) {
	svc := newTestService(t, nil)
	calls := 0
	svc.FetchHolidaysRaw = func() ([]byte, error) {
		calls++
		return holidaysICS, nil
	}

	first := svc.FetchHolidays(d(2026, 1, 1), d(2026, 12, 31))
	second := svc.FetchHolidays(d(2026, 7, 1), d(2026, 7, 31))
	if calls != 1 {
		t.Errorf("expected 1 feed fetch, got %d", calls)
	}
	if len(first) != 2 {
		t.Errorf("full-year fetch = %d events, want 2 (sorted)", len(first))
	} else if first[0].Event.Title != "New Year's Day" {
		t.Errorf("events should be sorted by start, got %q first", first[0].Event.Title)
	}
	if len(second) != 1 || second[0].Event.Title != "Independence Day" {
		t.Errorf("cached range filter = %v", second)
	}
}

// Feed errors degrade to no holidays.
func TestFetchHolidaysError(t *testing.T) {
	svc := newTestService(t, nil)
	svc.FetchHolidaysRaw = func() ([]byte, error) { return nil, errors.New("network down") }
	if result := svc.FetchHolidays(d(2026, 1, 1), d(2026, 12, 31)); len(result) != 0 {
		t.Errorf("expected no holidays on fetch error, got %v", result)
	}
}

// Holidays are cached to the DB under the "US Holidays" calendar name during
// a refresh.
func TestRefreshDBCacheIncludesHolidays(t *testing.T) {
	svc := newTestService(t, nil)
	start, _ := CacheRange()
	holidayDay := start.AddDate(0, 0, 3)
	svc.FetchHolidaysRaw = func() ([]byte, error) {
		return ics([]string{
			"UID:h1",
			"SUMMARY:Test Holiday",
			"DTSTART;VALUE=DATE:" + holidayDay.Format("20060102"),
		}), nil
	}

	svc.RefreshDBCache()

	var cached []models.CachedCalendarEvent
	svc.db.Where("calendar_name = ?", USHolidaysCalendarName).Find(&cached)
	if len(cached) != 1 || cached[0].Title != "Test Holiday" {
		t.Errorf("cached holidays = %+v", cached)
	}
}

// ---- hidden events ----

// fetch_ical_events include_hidden=False filters events with a matching
// HiddenCalendarEvent row; include_hidden=True returns them.
func TestFetchICalEventsFilterHidden(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	seedMetadata(t, svc, today.AddDate(0, 0, -28), today.AddDate(0, 0, 56))
	visible := seedCachedEvent(t, svc, "TestCal", "Visible", today.Add(9*time.Hour), nil)
	hidden := seedCachedEvent(t, svc, "TestCal", "Hidden", today.Add(10*time.Hour), nil)
	_ = visible
	if err := svc.db.Create(&models.HiddenCalendarEvent{
		EventUID:     hidden.EventUID,
		EventDate:    hidden.EventDate,
		CalendarName: hidden.CalendarName,
		Title:        hidden.Title,
		StartTime:    hidden.StartTime,
	}).Error; err != nil {
		t.Fatalf("seed hidden: %v", err)
	}

	withHidden := svc.FetchICalEvents(today, today, true, true)
	if len(withHidden) != 2 {
		t.Errorf("include_hidden=true should return both, got %d", len(withHidden))
	}
	filtered := svc.FetchICalEvents(today, today, false, true)
	if len(filtered) != 1 || filtered[0].Title != "Visible" {
		t.Errorf("include_hidden=false result = %v", filtered)
	}
}

// include_holidays=False strips events sourced from the US Holidays feed.
func TestFetchICalEventsExcludeHolidays(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	seedMetadata(t, svc, today.AddDate(0, 0, -28), today.AddDate(0, 0, 56))
	seedCachedEvent(t, svc, "Personal", "Meeting", today.Add(9*time.Hour), nil)
	seedCachedEvent(t, svc, USHolidaysCalendarName, "Some Holiday", today, nil)

	all := svc.FetchICalEvents(today, today, true, true)
	if len(all) != 2 {
		t.Errorf("include_holidays=true should return both, got %d", len(all))
	}
	noHolidays := svc.FetchICalEvents(today, today, true, false)
	if len(noHolidays) != 1 || noHolidays[0].Title != "Meeting" {
		t.Errorf("include_holidays=false result = %v", noHolidays)
	}
}

// Refresh prunes hidden-event rows whose source event no longer exists, but
// keeps rows that still match a fetched event.
func TestRefreshDBCachePrunesStaleHiddenEvents(t *testing.T) {
	svc := newTestService(t, nil)
	today := todayUTC()
	live := eventWithSource("TestCal", "Still There", today.Add(10*time.Hour), nil)
	recordFetches(svc, []EventWithSource{live})

	mustCreate := func(uid, title string, start time.Time) {
		if err := svc.db.Create(&models.HiddenCalendarEvent{
			EventUID: uid, EventDate: dateOf(start), CalendarName: "TestCal",
			Title: title, StartTime: start,
		}).Error; err != nil {
			t.Fatalf("seed hidden: %v", err)
		}
	}
	mustCreate(live.Event.UID, "Still There", live.Event.StartTime)
	mustCreate("gone-uid", "Deleted Upstream", today.Add(12*time.Hour))

	svc.RefreshDBCache()

	var remaining []models.HiddenCalendarEvent
	svc.db.Find(&remaining)
	if len(remaining) != 1 {
		t.Fatalf("expected 1 hidden row after prune, got %d", len(remaining))
	}
	if remaining[0].EventUID != live.Event.UID {
		t.Errorf("kept hidden row = %+v, want uid %q", remaining[0], live.Event.UID)
	}
}

// ---- error handling ----

// test_refresh_db_cache_handles_db_error: a failing transaction is rolled
// back and logged, not raised.
func TestRefreshDBCacheHandlesDBError(t *testing.T) {
	svc := newTestService(t, nil)
	recordFetches(svc, []EventWithSource{
		eventWithSource("TestCalendar", "Event", dt(2024, 2, 15, 10, 0), nil),
	})
	if err := svc.db.Exec("DROP TABLE cached_calendar_events").Error; err != nil {
		t.Fatalf("drop table: %v", err)
	}
	// Should not panic.
	svc.RefreshDBCache()
}

// test_fetch_and_cache_handles_db_error: events are still returned when the
// DB write fails.
func TestFetchAndCacheEventsHandlesDBError(t *testing.T) {
	svc := newTestService(t, nil)
	recordFetches(svc, []EventWithSource{
		eventWithSource("TestCalendar", "Event", dt(2024, 2, 15, 10, 0), nil),
	})
	if err := svc.db.Exec("DROP TABLE cached_calendar_events").Error; err != nil {
		t.Fatalf("drop table: %v", err)
	}
	result := svc.fetchAndCacheEvents(d(2024, 2, 15), d(2024, 2, 15))
	if len(result) != 1 || result[0].Title != "Event" {
		t.Errorf("events should still be returned on DB error, got %v", result)
	}
}

// ---- lifecycle ----

// test_shutdown_cache_with_no_task: Shutdown without InitializeCache (and
// called twice) must not panic.
func TestShutdownWithoutInitialize(t *testing.T) {
	svc := newTestService(t, nil)
	svc.Shutdown()
	svc.Shutdown()
}

// test_shutdown_cache_cancels_task (adapted): InitializeCache runs an initial
// refresh in the background; Shutdown stops the loop.
func TestInitializeCacheAndShutdown(t *testing.T) {
	svc := newTestService(t, nil)
	refreshed := make(chan struct{}, 1)
	svc.FetchCalDAVEvents = func(start, end time.Time) []EventWithSource {
		select {
		case refreshed <- struct{}{}:
		default:
		}
		return nil
	}

	svc.InitializeCache()
	select {
	case <-refreshed:
	case <-time.After(5 * time.Second):
		t.Fatal("initial refresh never ran")
	}
	svc.Shutdown()

	var meta models.CalendarCacheMetadata
	if err := svc.db.First(&meta).Error; err != nil {
		t.Fatalf("initial refresh should have written metadata: %v", err)
	}
}
