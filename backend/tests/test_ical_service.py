import pytest
import time
import asyncio
from datetime import date, datetime, timedelta
from unittest.mock import patch, MagicMock, AsyncMock
from icalendar import Calendar, Event

from app.ical_service import (
    fetch_ical_events, get_events_for_date, _parse_ical_date, _is_all_day,
    _get_calendar_sync, _fetch_events_from_caldav, _get_events_from_db,
    _get_cache_range, _refresh_db_cache_sync, _fetch_and_cache_events_sync,
    CACHE_WEEKS_BEFORE, CACHE_WEEKS_AFTER
)
from app.schemas import CalendarEvent
from app.models import CachedCalendarEvent, CalendarCacheMetadata


class TestICalServiceHelpers:
    """Test iCal calendar service helper functions."""

    def test_parse_ical_date_datetime(self):
        """Test parsing datetime objects."""
        dt = datetime(2024, 2, 15, 10, 30, 0)
        result = _parse_ical_date(dt)
        assert result == dt
        assert isinstance(result, datetime)

    def test_parse_ical_date_date(self):
        """Test parsing date objects."""
        d = date(2024, 2, 15)
        result = _parse_ical_date(d)
        assert result == datetime(2024, 2, 15, 0, 0, 0)
        assert isinstance(result, datetime)

    def test_parse_ical_date_with_dt_attribute(self):
        """Test parsing objects with dt attribute."""
        class MockDateTime:
            def __init__(self, dt):
                self.dt = dt

        mock_dt = MockDateTime(datetime(2024, 2, 15, 14, 30, 0))
        result = _parse_ical_date(mock_dt)
        assert result == datetime(2024, 2, 15, 14, 30, 0)

    def test_parse_ical_date_timezone_aware(self):
        """Test parsing timezone-aware datetime."""
        from datetime import timezone
        dt = datetime(2024, 2, 15, 10, 30, 0, tzinfo=timezone.utc)
        result = _parse_ical_date(dt)
        # Should strip timezone info
        assert result == datetime(2024, 2, 15, 10, 30, 0)
        assert result.tzinfo is None

    def test_is_all_day_true(self):
        """Test detecting all-day events."""
        class MockComponent:
            def __init__(self, start_date):
                self._start = start_date

            def get(self, key):
                if key == 'dtstart':
                    class MockDate:
                        def __init__(self, dt):
                            self.dt = dt
                    return MockDate(self._start)
                return None

        # All-day events use date, not datetime
        component = MockComponent(date(2024, 2, 15))
        assert _is_all_day(component) is True

    def test_is_all_day_false(self):
        """Test detecting timed events."""
        class MockComponent:
            def __init__(self, start_datetime):
                self._start = start_datetime

            def get(self, key):
                if key == 'dtstart':
                    class MockDate:
                        def __init__(self, dt):
                            self.dt = dt
                    return MockDate(self._start)
                return None

        # Timed events use datetime
        component = MockComponent(datetime(2024, 2, 15, 10, 30, 0))
        assert _is_all_day(component) is False


class TestCalendarConnection:
    """Test CalDAV calendar connection."""

    @patch("app.ical_service.settings")
    def test_get_calendar_no_credentials(self, mock_settings):
        """Test getting calendar when no credentials are configured."""
        mock_settings.apple_calendar_email = None
        mock_settings.apple_calendar_app_password = None
        mock_settings.apple_calendar_name = None
        mock_settings.debug_timing = False

        result = _get_calendar_sync()
        assert result is None

    @patch("app.ical_service._calendar_cache", (0, None))
    @patch("app.ical_service.caldav")
    @patch("app.ical_service.settings")
    def test_get_calendar_success(self, mock_settings, mock_caldav):
        """Test successful calendar retrieval."""
        mock_settings.apple_calendar_email = "test@icloud.com"
        mock_settings.apple_calendar_app_password = "app-password"
        mock_settings.apple_calendar_name = "Personal"
        mock_settings.debug_timing = False

        # Mock CalDAV client and calendar
        mock_calendar = MagicMock()
        mock_calendar.name = "Personal"

        mock_principal = MagicMock()
        mock_principal.calendars.return_value = [mock_calendar]

        mock_client = MagicMock()
        mock_client.principal.return_value = mock_principal

        mock_caldav.DAVClient.return_value = mock_client

        result = _get_calendar_sync()
        assert result == mock_calendar

    @patch("app.ical_service._calendar_cache", (0, None))
    @patch("app.ical_service.caldav")
    @patch("app.ical_service.settings")
    def test_get_calendar_connection_error(self, mock_settings, mock_caldav):
        """Test calendar retrieval with connection error."""
        mock_settings.apple_calendar_email = "test@icloud.com"
        mock_settings.apple_calendar_app_password = "app-password"
        mock_settings.apple_calendar_name = "Personal"
        mock_settings.debug_timing = False

        # Mock connection error
        mock_caldav.DAVClient.side_effect = Exception("Connection failed")

        result = _get_calendar_sync()
        assert result is None


class TestFetchEventsFromCalDAV:
    """Test fetching events from CalDAV."""

    @patch("app.ical_service._get_calendar_sync")
    def test_fetch_events_no_calendar(self, mock_get_calendar):
        """Test fetching events when no calendar is available."""
        mock_get_calendar.return_value = None

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        result = _fetch_events_from_caldav(start_date, end_date)
        assert result == []

    @patch("app.ical_service._get_calendar_sync")
    def test_fetch_events_success(self, mock_get_calendar_sync):
        """Test successful event fetching."""
        # Create a mock iCal calendar with proper structure
        cal = Calendar()
        cal.add('prodid', '-//My calendar product//mxm.dk//')
        cal.add('version', '2.0')

        # Create a mock event
        event = Event()
        event.add('summary', 'Test Event')
        event.add('dtstart', datetime(2024, 2, 15, 10, 0, 0))
        event.add('dtend', datetime(2024, 2, 15, 11, 0, 0))
        event.add('uid', 'test-uid-123')
        cal.add_component(event)

        # Mock calendar search result
        mock_search_result = MagicMock()
        mock_search_result.data = cal.to_ical()

        mock_calendar = MagicMock()
        mock_calendar.search.return_value = [mock_search_result]
        mock_get_calendar_sync.return_value = mock_calendar

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        result = _fetch_events_from_caldav(start_date, end_date)

        assert len(result) == 1
        assert result[0].title == "Test Event"
        assert result[0].all_day is False

    @patch("app.ical_service._get_calendar_sync")
    def test_fetch_events_all_day_event(self, mock_get_calendar_sync):
        """Test fetching all-day events."""
        cal = Calendar()
        cal.add('prodid', '-//My calendar product//mxm.dk//')
        cal.add('version', '2.0')

        # Create all-day event
        event = Event()
        event.add('summary', 'All Day Event')
        event.add('dtstart', date(2024, 2, 15))  # Date only, not datetime
        event.add('dtend', date(2024, 2, 16))
        event.add('uid', 'test-all-day-uid-123')
        cal.add_component(event)

        mock_search_result = MagicMock()
        mock_search_result.data = cal.to_ical()

        mock_calendar = MagicMock()
        mock_calendar.search.return_value = [mock_search_result]
        mock_get_calendar_sync.return_value = mock_calendar

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        result = _fetch_events_from_caldav(start_date, end_date)

        assert len(result) == 1
        assert result[0].title == "All Day Event"
        assert result[0].all_day is True

    @patch("app.ical_service._get_calendar_sync")
    def test_fetch_events_invalid_ical(self, mock_get_calendar):
        """Test handling invalid iCal data."""
        mock_search_result = MagicMock()
        mock_search_result.data = b"invalid ical data"

        mock_calendar = MagicMock()
        mock_calendar.search.return_value = [mock_search_result]
        mock_get_calendar.return_value = mock_calendar

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        # Should handle parsing errors gracefully
        result = _fetch_events_from_caldav(start_date, end_date)
        assert result == []


class TestCacheRange:
    """Test cache range calculation."""

    def test_get_cache_range(self):
        """Test cache range calculation."""
        start, end = _get_cache_range()
        today = date.today()

        # Cache should span from CACHE_WEEKS_BEFORE to CACHE_WEEKS_AFTER
        expected_start = today - timedelta(weeks=CACHE_WEEKS_BEFORE)
        expected_end = today + timedelta(weeks=CACHE_WEEKS_AFTER)

        assert start == expected_start
        assert end == expected_end


class TestGetEventsForDate:
    """Test filtering events by date."""

    def test_get_events_for_date(self):
        """Test filtering events by specific date."""
        events = [
            CalendarEvent(title="Event 1", start_time="2024-02-15T10:00:00", all_day=False),
            CalendarEvent(title="Event 2", start_time="2024-02-16T10:00:00", all_day=False),
            CalendarEvent(title="Event 3", start_time="2024-02-15T14:00:00", all_day=False),
        ]

        target_date = date(2024, 2, 15)
        result = get_events_for_date(events, target_date)

        assert len(result) == 2
        assert result[0].title == "Event 1"
        assert result[1].title == "Event 3"

    def test_get_events_for_date_all_day(self):
        """Test filtering all-day events."""
        events = [
            CalendarEvent(title="All Day", start_time="2024-02-15T00:00:00", all_day=True),
            CalendarEvent(title="Timed", start_time="2024-02-15T10:00:00", all_day=False),
        ]

        target_date = date(2024, 2, 15)
        result = get_events_for_date(events, target_date)

        assert len(result) == 2
        assert any(e.title == "All Day" for e in result)
        assert any(e.title == "Timed" for e in result)

    def test_get_events_for_date_empty(self):
        """Test filtering events when none match."""
        events = [
            CalendarEvent(title="Event 1", start_time="2024-02-16T10:00:00", all_day=False),
            CalendarEvent(title="Event 2", start_time="2024-02-17T10:00:00", all_day=False),
        ]

        target_date = date(2024, 2, 15)
        result = get_events_for_date(events, target_date)

        assert len(result) == 0


class TestDatabaseCaching:
    """Test database caching functions."""

    def test_get_events_from_db(self, db_session):
        """Test retrieving events from database cache."""
        from app.models import CachedCalendarEvent

        # Add test events to DB
        event1 = CachedCalendarEvent(
            event_date=date(2024, 2, 15),
            title="Event 1",
            start_time=datetime(2024, 2, 15, 10, 0, 0),
            end_time=datetime(2024, 2, 15, 11, 0, 0),
            all_day=False
        )
        event2 = CachedCalendarEvent(
            event_date=date(2024, 2, 15),
            title="Event 2",
            start_time=datetime(2024, 2, 15, 14, 0, 0),
            end_time=datetime(2024, 2, 15, 15, 0, 0),
            all_day=False
        )
        event3 = CachedCalendarEvent(
            event_date=date(2024, 2, 16),
            title="Event 3",
            start_time=datetime(2024, 2, 16, 10, 0, 0),
            end_time=datetime(2024, 2, 16, 11, 0, 0),
            all_day=False
        )

        db_session.add_all([event1, event2, event3])
        db_session.commit()

        # Mock SessionLocal to use our test session
        with patch("app.ical_service.SessionLocal", return_value=db_session):
            result = _get_events_from_db(date(2024, 2, 15), date(2024, 2, 15))

        assert len(result) == 2
        assert all(e.start_time.date() == date(2024, 2, 15) for e in result)

    def test_refresh_db_cache_sync(self, db_session):
        """Test refreshing database cache from CalDAV."""
        from app.models import CachedCalendarEvent, CalendarCacheMetadata

        mock_events = [
            CalendarEvent(
                title="Cached Event",
                start_time=datetime(2024, 2, 15, 10, 0, 0),
                end_time=datetime(2024, 2, 15, 11, 0, 0),
                all_day=False
            )
        ]

        with patch("app.ical_service._fetch_events_from_caldav", return_value=mock_events), \
             patch("app.ical_service.SessionLocal", return_value=db_session):
            _refresh_db_cache_sync()

        # Check events were cached
        cached = db_session.query(CachedCalendarEvent).all()
        assert len(cached) == 1
        assert cached[0].title == "Cached Event"

        # Check metadata was updated
        metadata = db_session.query(CalendarCacheMetadata).first()
        assert metadata is not None
        assert metadata.last_refresh is not None

    def test_fetch_and_cache_events_sync(self, db_session):
        """Test fetching and caching events for specific range."""
        from app.models import CachedCalendarEvent

        mock_events = [
            CalendarEvent(
                title="New Event",
                start_time=datetime(2024, 3, 1, 10, 0, 0),
                end_time=datetime(2024, 3, 1, 11, 0, 0),
                all_day=False
            )
        ]

        with patch("app.ical_service._fetch_events_from_caldav", return_value=mock_events), \
             patch("app.ical_service.SessionLocal", return_value=db_session):
            result = _fetch_and_cache_events_sync(date(2024, 3, 1), date(2024, 3, 1))

        assert len(result) == 1
        assert result[0].title == "New Event"

        # Check events were added to DB
        cached = db_session.query(CachedCalendarEvent).all()
        assert len(cached) == 1


class TestFetchICalEvents:
    """Test the main fetch_ical_events async function."""

    def test_fetch_events_from_cache(self, db_session):
        """Test fetching events when fully within cache range."""
        from app.models import CachedCalendarEvent, CalendarCacheMetadata

        today = date.today()

        # Setup cache metadata
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=today - timedelta(weeks=4),
            cache_end=today + timedelta(weeks=8)
        )
        db_session.add(metadata)

        # Add cached event
        event = CachedCalendarEvent(
            event_date=today,
            title="Today's Event",
            start_time=datetime.combine(today, datetime.min.time().replace(hour=10)),
            end_time=datetime.combine(today, datetime.min.time().replace(hour=11)),
            all_day=False
        )
        db_session.add(event)
        db_session.commit()

        with patch("app.ical_service.SessionLocal", return_value=db_session):
            result = asyncio.run(fetch_ical_events(today, today))

        assert len(result) == 1
        assert result[0].title == "Today's Event"

    def test_fetch_events_outside_cache(self, db_session):
        """Test fetching events outside cache range fetches from CalDAV."""
        from app.models import CalendarCacheMetadata

        today = date.today()
        far_future = today + timedelta(days=365)

        # Setup cache metadata that doesn't include far_future
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=today - timedelta(weeks=4),
            cache_end=today + timedelta(weeks=8)
        )
        db_session.add(metadata)
        db_session.commit()

        mock_events = [
            CalendarEvent(
                title="Future Event",
                start_time=datetime.combine(far_future, datetime.min.time().replace(hour=10)),
                all_day=False
            )
        ]

        with patch("app.ical_service.SessionLocal", return_value=db_session), \
             patch("app.ical_service._fetch_and_cache_events_sync", return_value=mock_events) as mock_fetch:
            result = asyncio.run(fetch_ical_events(far_future, far_future))

        mock_fetch.assert_called_once()
        assert len(result) == 1
        assert result[0].title == "Future Event"

    def test_fetch_events_no_cache(self, db_session):
        """Test fetching events when no cache exists."""
        mock_events = [
            CalendarEvent(
                title="New Event",
                start_time=datetime(2024, 2, 15, 10, 0, 0),
                all_day=False
            )
        ]

        with patch("app.ical_service.SessionLocal", return_value=db_session), \
             patch("app.ical_service._fetch_and_cache_events_sync", return_value=mock_events) as mock_fetch:
            result = asyncio.run(fetch_ical_events(date(2024, 2, 15), date(2024, 2, 15)))

        mock_fetch.assert_called_once()
        assert len(result) == 1
