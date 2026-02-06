import pytest
import time
import asyncio
from datetime import date, datetime, timedelta
from unittest.mock import patch, MagicMock, AsyncMock
from icalendar import Calendar, Event

from app.ical_service import (
    fetch_ical_events, get_events_for_date, _parse_ical_date, _is_all_day,
    _get_selected_calendars_sync, _get_all_calendars_sync, _fetch_events_from_caldav, _get_events_from_db,
    _get_cache_range, _refresh_db_cache_sync, _fetch_and_cache_events_sync,
    CACHE_WEEKS_BEFORE, CACHE_WEEKS_AFTER, CalendarEventWithSource
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
    def test_get_all_calendars_no_credentials(self, mock_settings):
        """Test getting calendars when no credentials are configured."""
        mock_settings.apple_calendar_email = ""
        mock_settings.apple_calendar_app_password = ""
        mock_settings.debug_timing = False

        result = _get_all_calendars_sync()
        assert result == []

    @patch("app.ical_service._calendars_cache", (0, []))
    @patch("app.ical_service._get_all_calendars_sync")
    @patch("app.ical_service.get_settings")
    def test_get_selected_calendars_success(self, mock_get_settings, mock_get_all_calendars):
        """Test successful calendar retrieval."""
        mock_settings = MagicMock()
        mock_settings.apple_calendar_names = "Personal"
        mock_get_settings.return_value = mock_settings

        # Mock available calendars
        mock_calendar = MagicMock()
        mock_calendar.name = "Personal"
        mock_get_all_calendars.return_value = [mock_calendar]

        result = _get_selected_calendars_sync()
        assert len(result) == 1
        assert result[0].name == "Personal"

    @patch("app.ical_service._calendars_cache", (0, []))
    @patch("app.ical_service.caldav")
    @patch("app.ical_service.settings")
    def test_get_all_calendars_connection_error(self, mock_settings, mock_caldav):
        """Test calendar retrieval with connection error."""
        mock_settings.apple_calendar_email = "test@icloud.com"
        mock_settings.apple_calendar_app_password = "app-password"
        mock_settings.debug_timing = False

        # Mock connection error
        mock_caldav.DAVClient.side_effect = Exception("Connection failed")

        result = _get_all_calendars_sync()
        assert result == []

    @patch("app.ical_service._calendars_cache", (0, []))
    @patch("app.ical_service._get_all_calendars_sync")
    @patch("app.ical_service.get_settings")
    def test_get_selected_calendars_multiple(self, mock_get_settings, mock_get_all_calendars):
        """Test selecting multiple calendars."""
        mock_settings = MagicMock()
        mock_settings.apple_calendar_names = "Personal,Work"
        mock_get_settings.return_value = mock_settings

        # Mock available calendars
        mock_calendar1 = MagicMock()
        mock_calendar1.name = "Personal"
        mock_calendar2 = MagicMock()
        mock_calendar2.name = "Work"
        mock_calendar3 = MagicMock()
        mock_calendar3.name = "Other"
        mock_get_all_calendars.return_value = [mock_calendar1, mock_calendar2, mock_calendar3]

        result = _get_selected_calendars_sync()
        assert len(result) == 2
        names = [c.name for c in result]
        assert "Personal" in names
        assert "Work" in names
        assert "Other" not in names


class TestFetchEventsFromCalDAV:
    """Test fetching events from CalDAV."""

    @patch("app.ical_service._get_selected_calendars_sync")
    def test_fetch_events_no_calendar(self, mock_get_calendars):
        """Test fetching events when no calendar is available."""
        mock_get_calendars.return_value = []

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        result = _fetch_events_from_caldav(start_date, end_date)
        assert result == []

    @patch("app.ical_service._get_selected_calendars_sync")
    def test_fetch_events_success(self, mock_get_calendars):
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
        mock_calendar.name = "TestCalendar"
        mock_calendar.search.return_value = [mock_search_result]
        mock_get_calendars.return_value = [mock_calendar]

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        result = _fetch_events_from_caldav(start_date, end_date)

        assert len(result) == 1
        assert isinstance(result[0], CalendarEventWithSource)
        assert result[0].event.title == "Test Event"
        assert result[0].event.all_day is False
        assert result[0].calendar_name == "TestCalendar"

    @patch("app.ical_service._get_selected_calendars_sync")
    def test_fetch_events_all_day_event(self, mock_get_calendars):
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
        mock_calendar.name = "TestCalendar"
        mock_calendar.search.return_value = [mock_search_result]
        mock_get_calendars.return_value = [mock_calendar]

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        result = _fetch_events_from_caldav(start_date, end_date)

        assert len(result) == 1
        assert result[0].event.title == "All Day Event"
        assert result[0].event.all_day is True

    @patch("app.ical_service._get_selected_calendars_sync")
    def test_fetch_events_invalid_ical(self, mock_get_calendars):
        """Test handling invalid iCal data."""
        mock_search_result = MagicMock()
        mock_search_result.data = b"invalid ical data"

        mock_calendar = MagicMock()
        mock_calendar.name = "TestCalendar"
        mock_calendar.search.return_value = [mock_search_result]
        mock_get_calendars.return_value = [mock_calendar]

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        # Should handle parsing errors gracefully
        result = _fetch_events_from_caldav(start_date, end_date)
        assert result == []

    @patch("app.ical_service._get_selected_calendars_sync")
    def test_fetch_events_multiple_calendars(self, mock_get_calendars):
        """Test fetching events from multiple calendars."""
        # Create events for calendar 1
        cal1 = Calendar()
        cal1.add('prodid', '-//My calendar product//mxm.dk//')
        cal1.add('version', '2.0')
        event1 = Event()
        event1.add('summary', 'Event from Cal1')
        event1.add('dtstart', datetime(2024, 2, 15, 10, 0, 0))
        event1.add('uid', 'test-uid-1')
        cal1.add_component(event1)

        # Create events for calendar 2
        cal2 = Calendar()
        cal2.add('prodid', '-//My calendar product//mxm.dk//')
        cal2.add('version', '2.0')
        event2 = Event()
        event2.add('summary', 'Event from Cal2')
        event2.add('dtstart', datetime(2024, 2, 15, 14, 0, 0))
        event2.add('uid', 'test-uid-2')
        cal2.add_component(event2)

        mock_search_result1 = MagicMock()
        mock_search_result1.data = cal1.to_ical()
        mock_search_result2 = MagicMock()
        mock_search_result2.data = cal2.to_ical()

        mock_calendar1 = MagicMock()
        mock_calendar1.name = "Calendar1"
        mock_calendar1.search.return_value = [mock_search_result1]

        mock_calendar2 = MagicMock()
        mock_calendar2.name = "Calendar2"
        mock_calendar2.search.return_value = [mock_search_result2]

        mock_get_calendars.return_value = [mock_calendar1, mock_calendar2]

        start_date = date(2024, 2, 15)
        end_date = date(2024, 2, 15)

        result = _fetch_events_from_caldav(start_date, end_date)

        assert len(result) == 2
        calendar_names = [r.calendar_name for r in result]
        assert "Calendar1" in calendar_names
        assert "Calendar2" in calendar_names


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
            CalendarEvent(id="event-1", title="Event 1", start_time="2024-02-15T10:00:00", all_day=False),
            CalendarEvent(id="event-2", title="Event 2", start_time="2024-02-16T10:00:00", all_day=False),
            CalendarEvent(id="event-3", title="Event 3", start_time="2024-02-15T14:00:00", all_day=False),
        ]

        target_date = date(2024, 2, 15)
        result = get_events_for_date(events, target_date)

        assert len(result) == 2
        assert result[0].title == "Event 1"
        assert result[1].title == "Event 3"

    def test_get_events_for_date_all_day(self):
        """Test filtering all-day events."""
        events = [
            CalendarEvent(id="event-4", title="All Day", start_time="2024-02-15T00:00:00", all_day=True),
            CalendarEvent(id="event-5", title="Timed", start_time="2024-02-15T10:00:00", all_day=False),
        ]

        target_date = date(2024, 2, 15)
        result = get_events_for_date(events, target_date)

        assert len(result) == 2
        assert any(e.title == "All Day" for e in result)
        assert any(e.title == "Timed" for e in result)

    def test_get_events_for_date_empty(self):
        """Test filtering events when none match."""
        events = [
            CalendarEvent(id="event-6", title="Event 1", start_time="2024-02-16T10:00:00", all_day=False),
            CalendarEvent(id="event-7", title="Event 2", start_time="2024-02-17T10:00:00", all_day=False),
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
            calendar_name="TestCal",
            title="Event 1",
            start_time=datetime(2024, 2, 15, 10, 0, 0),
            end_time=datetime(2024, 2, 15, 11, 0, 0),
            all_day=False
        )
        event2 = CachedCalendarEvent(
            event_date=date(2024, 2, 15),
            calendar_name="TestCal",
            title="Event 2",
            start_time=datetime(2024, 2, 15, 14, 0, 0),
            end_time=datetime(2024, 2, 15, 15, 0, 0),
            all_day=False
        )
        event3 = CachedCalendarEvent(
            event_date=date(2024, 2, 16),
            calendar_name="TestCal",
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

        mock_event = CalendarEvent(
            id="event-8",
            title="Cached Event",
            start_time=datetime(2024, 2, 15, 10, 0, 0),
            end_time=datetime(2024, 2, 15, 11, 0, 0),
            all_day=False
        )
        mock_events_with_source = [
            CalendarEventWithSource(mock_event, "TestCalendar")
        ]

        with patch("app.ical_service._fetch_events_from_caldav", return_value=mock_events_with_source), \
             patch("app.ical_service.SessionLocal", return_value=db_session):
            _refresh_db_cache_sync()

        # Check events were cached
        cached = db_session.query(CachedCalendarEvent).all()
        assert len(cached) == 1
        assert cached[0].title == "Cached Event"
        assert cached[0].calendar_name == "TestCalendar"

        # Check metadata was updated
        metadata = db_session.query(CalendarCacheMetadata).first()
        assert metadata is not None
        assert metadata.last_refresh is not None

    def test_fetch_and_cache_events_sync(self, db_session):
        """Test fetching and caching events for specific range."""
        from app.models import CachedCalendarEvent

        mock_event = CalendarEvent(
            id="event-9",
            title="New Event",
            start_time=datetime(2024, 3, 1, 10, 0, 0),
            end_time=datetime(2024, 3, 1, 11, 0, 0),
            all_day=False
        )
        mock_events_with_source = [
            CalendarEventWithSource(mock_event, "TestCalendar")
        ]

        with patch("app.ical_service._fetch_events_from_caldav", return_value=mock_events_with_source), \
             patch("app.ical_service.SessionLocal", return_value=db_session):
            result = _fetch_and_cache_events_sync(date(2024, 3, 1), date(2024, 3, 1))

        assert len(result) == 1
        assert result[0].title == "New Event"

        # Check events were added to DB
        cached = db_session.query(CachedCalendarEvent).all()
        assert len(cached) == 1
        assert cached[0].calendar_name == "TestCalendar"


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
                id="event-10",
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
                id="event-11",
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


class TestCacheValidation:
    """Test cache validation functions."""

    def test_is_cache_valid_no_metadata(self, db_session):
        """Test cache validation when no metadata exists."""
        from app.ical_service import _is_cache_valid

        with patch("app.ical_service.SessionLocal", return_value=db_session):
            result = _is_cache_valid()

        assert result is False

    def test_is_cache_valid_no_last_refresh(self, db_session):
        """Test cache validation when last_refresh is None."""
        from app.ical_service import _is_cache_valid

        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=None,
            cache_start=date.today(),
            cache_end=date.today()
        )
        db_session.add(metadata)
        db_session.commit()

        with patch("app.ical_service.SessionLocal", return_value=db_session):
            result = _is_cache_valid()

        assert result is False

    def test_is_cache_valid_today_in_range(self, db_session):
        """Test cache validation when today is within cache range."""
        from app.ical_service import _is_cache_valid

        today = date.today()
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=today - timedelta(days=7),
            cache_end=today + timedelta(days=7)
        )
        db_session.add(metadata)
        db_session.commit()

        with patch("app.ical_service.SessionLocal", return_value=db_session):
            result = _is_cache_valid()

        assert result is True

    def test_is_cache_valid_today_outside_range(self, db_session):
        """Test cache validation when today is outside cache range."""
        from app.ical_service import _is_cache_valid

        # Cache range in the past
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=date(2020, 1, 1),
            cache_end=date(2020, 12, 31)
        )
        db_session.add(metadata)
        db_session.commit()

        with patch("app.ical_service.SessionLocal", return_value=db_session):
            result = _is_cache_valid()

        assert result is False


class TestGetCacheMetadata:
    """Test getting cache metadata."""

    def test_get_cache_metadata_no_metadata(self, db_session):
        """Test getting cache metadata when none exists."""
        from app.ical_service import _get_cache_metadata

        with patch("app.ical_service.SessionLocal", return_value=db_session):
            start, end = _get_cache_metadata()

        assert start is None
        assert end is None

    def test_get_cache_metadata_with_data(self, db_session):
        """Test getting cache metadata with existing data."""
        from app.ical_service import _get_cache_metadata

        today = date.today()
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=today - timedelta(days=30),
            cache_end=today + timedelta(days=60)
        )
        db_session.add(metadata)
        db_session.commit()

        with patch("app.ical_service.SessionLocal", return_value=db_session):
            start, end = _get_cache_metadata()

        assert start == today - timedelta(days=30)
        assert end == today + timedelta(days=60)


class TestListAvailableCalendars:
    """Test listing available calendars."""

    @patch("app.ical_service._get_all_calendars_sync")
    def test_list_available_calendars_sync(self, mock_get_all):
        """Test listing available calendar names."""
        from app.ical_service import list_available_calendars_sync

        mock_cal1 = MagicMock()
        mock_cal1.name = "Personal"
        mock_cal2 = MagicMock()
        mock_cal2.name = "Work"
        mock_get_all.return_value = [mock_cal1, mock_cal2]

        result = list_available_calendars_sync()

        assert result == ["Personal", "Work"]

    @patch("app.ical_service._get_all_calendars_sync")
    def test_list_available_calendars_empty(self, mock_get_all):
        """Test listing calendars when none available."""
        from app.ical_service import list_available_calendars_sync

        mock_get_all.return_value = []

        result = list_available_calendars_sync()

        assert result == []


class TestCalendarEventWithSource:
    """Test CalendarEventWithSource class."""

    def test_calendar_event_with_source_creation(self):
        """Test creating CalendarEventWithSource objects."""
        event = CalendarEvent(
            id="event-12",
            title="Test Event",
            start_time=datetime(2024, 2, 15, 10, 0, 0),
            all_day=False
        )

        event_with_source = CalendarEventWithSource(event, "TestCalendar")

        assert event_with_source.event == event
        assert event_with_source.calendar_name == "TestCalendar"
        assert event_with_source.event.title == "Test Event"


class TestInitializeAndShutdownCache:
    """Test cache initialization and shutdown."""

    @pytest.mark.asyncio
    async def test_shutdown_cache_with_no_task(self):
        """Test shutdown when no refresh task exists."""
        from app.ical_service import shutdown_cache, _refresh_task

        # Ensure _refresh_task is None
        import app.ical_service as ical_service
        original_task = ical_service._refresh_task
        ical_service._refresh_task = None

        try:
            # Should not raise
            await shutdown_cache()
        finally:
            ical_service._refresh_task = original_task

    @pytest.mark.asyncio
    async def test_shutdown_cache_cancels_task(self):
        """Test shutdown cancels the refresh task."""
        from app.ical_service import shutdown_cache
        import app.ical_service as ical_service

        # Create a real asyncio task that we can cancel
        async def dummy_task():
            while True:
                await asyncio.sleep(1)

        # Create and start a real task
        task = asyncio.create_task(dummy_task())

        original_task = ical_service._refresh_task
        ical_service._refresh_task = task

        try:
            await shutdown_cache()
            assert task.cancelled() or task.done()
        finally:
            ical_service._refresh_task = original_task
            # Clean up if test failed
            if not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass


class TestFetchEventsPartialCache:
    """Test fetching events with partial cache coverage."""

    def test_fetch_events_pre_cache_range(self, db_session):
        """Test fetching events before cache range."""
        from app.models import CalendarCacheMetadata

        today = date.today()

        # Setup cache that starts from today
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=today,
            cache_end=today + timedelta(weeks=8)
        )
        db_session.add(metadata)
        db_session.commit()

        # Request events before cache start
        request_start = today - timedelta(days=7)
        request_end = today - timedelta(days=1)

        mock_events = [
            CalendarEvent(
                id="event-13",
                title="Past Event",
                start_time=datetime.combine(request_start, datetime.min.time().replace(hour=10)),
                all_day=False
            )
        ]

        with patch("app.ical_service.SessionLocal", return_value=db_session), \
             patch("app.ical_service._fetch_and_cache_events_sync", return_value=mock_events):
            result = asyncio.run(fetch_ical_events(request_start, request_end))

        assert len(result) == 1
        assert result[0].title == "Past Event"

    def test_fetch_events_post_cache_range(self, db_session):
        """Test fetching events after cache range."""
        from app.models import CalendarCacheMetadata, CachedCalendarEvent

        today = date.today()

        # Setup cache that ends at today + 8 weeks
        cache_end = today + timedelta(weeks=8)
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=today - timedelta(weeks=4),
            cache_end=cache_end
        )
        db_session.add(metadata)
        db_session.commit()

        # Request events after cache end
        request_start = cache_end + timedelta(days=1)
        request_end = cache_end + timedelta(days=7)

        mock_events = [
            CalendarEvent(
                id="event-14",
                title="Future Event",
                start_time=datetime.combine(request_start, datetime.min.time().replace(hour=10)),
                all_day=False
            )
        ]

        with patch("app.ical_service.SessionLocal", return_value=db_session), \
             patch("app.ical_service._fetch_and_cache_events_sync", return_value=mock_events):
            result = asyncio.run(fetch_ical_events(request_start, request_end))

        assert len(result) == 1
        assert result[0].title == "Future Event"


class TestSelectedCalendarsWithCache:
    """Test calendar selection with caching."""

    @patch("app.ical_service._get_all_calendars_sync")
    @patch("app.ical_service.get_settings")
    def test_get_selected_calendars_no_filter(self, mock_get_settings, mock_get_all_calendars):
        """Test getting calendars when no filter is specified."""
        import app.ical_service as ical_service

        # Clear cache
        ical_service._calendars_cache = (0, [])

        mock_settings = MagicMock()
        mock_settings.apple_calendar_names = ""  # No filter
        mock_get_settings.return_value = mock_settings

        # Mock available calendars
        mock_calendar = MagicMock()
        mock_calendar.name = "Default"
        mock_get_all_calendars.return_value = [mock_calendar]

        result = _get_selected_calendars_sync()

        # Should return first calendar when no filter
        assert len(result) == 1
        assert result[0].name == "Default"

    @patch("app.ical_service._get_all_calendars_sync")
    @patch("app.ical_service.get_settings")
    def test_get_selected_calendars_no_match_fallback(self, mock_get_settings, mock_get_all_calendars):
        """Test fallback to first calendar when no names match."""
        import app.ical_service as ical_service

        # Clear cache
        ical_service._calendars_cache = (0, [])

        mock_settings = MagicMock()
        mock_settings.apple_calendar_names = "NonExistent"
        mock_get_settings.return_value = mock_settings

        # Mock available calendars
        mock_calendar = MagicMock()
        mock_calendar.name = "ActualCalendar"
        mock_get_all_calendars.return_value = [mock_calendar]

        result = _get_selected_calendars_sync()

        # Should fallback to first calendar
        assert len(result) == 1
        assert result[0].name == "ActualCalendar"


class TestFetchEventsCalendarError:
    """Test error handling in event fetching."""

    @patch("app.ical_service._get_selected_calendars_sync")
    def test_fetch_events_calendar_search_error(self, mock_get_calendars):
        """Test handling search error from calendar."""
        mock_calendar = MagicMock()
        mock_calendar.name = "TestCalendar"
        mock_calendar.search.side_effect = Exception("Search failed")
        mock_get_calendars.return_value = [mock_calendar]

        result = _fetch_events_from_caldav(date(2024, 2, 15), date(2024, 2, 15))

        # Should handle error gracefully and return empty list
        assert result == []

    @patch("app.ical_service._get_selected_calendars_sync")
    def test_fetch_events_missing_dtstart(self, mock_get_calendars):
        """Test handling events without dtstart."""
        cal = Calendar()
        cal.add('prodid', '-//My calendar product//mxm.dk//')
        cal.add('version', '2.0')

        # Event without dtstart
        event = Event()
        event.add('summary', 'No Start')
        event.add('uid', 'test-uid')
        cal.add_component(event)

        mock_search_result = MagicMock()
        mock_search_result.data = cal.to_ical()

        mock_calendar = MagicMock()
        mock_calendar.name = "TestCalendar"
        mock_calendar.search.return_value = [mock_search_result]
        mock_get_calendars.return_value = [mock_calendar]

        result = _fetch_events_from_caldav(date(2024, 2, 15), date(2024, 2, 15))

        # Event without dtstart should be skipped
        assert result == []

    @patch("app.ical_service._get_selected_calendars_sync")
    def test_fetch_events_event_outside_range(self, mock_get_calendars):
        """Test that events outside requested range are filtered."""
        cal = Calendar()
        cal.add('prodid', '-//My calendar product//mxm.dk//')
        cal.add('version', '2.0')

        # Event on different date
        event = Event()
        event.add('summary', 'Wrong Date Event')
        event.add('dtstart', datetime(2024, 2, 20, 10, 0, 0))  # Outside requested range
        event.add('uid', 'test-uid')
        cal.add_component(event)

        mock_search_result = MagicMock()
        mock_search_result.data = cal.to_ical()

        mock_calendar = MagicMock()
        mock_calendar.name = "TestCalendar"
        mock_calendar.search.return_value = [mock_search_result]
        mock_get_calendars.return_value = [mock_calendar]

        # Request only Feb 15
        result = _fetch_events_from_caldav(date(2024, 2, 15), date(2024, 2, 15))

        # Event should be filtered out
        assert result == []


class TestRefreshDbCacheError:
    """Test error handling in cache refresh."""

    def test_refresh_db_cache_handles_db_error(self, db_session):
        """Test that refresh_db_cache handles database errors gracefully."""
        mock_events_with_source = [
            CalendarEventWithSource(
                CalendarEvent(
                    id="event-15",
                    title="Event",
                    start_time=datetime(2024, 2, 15, 10, 0, 0),
                    all_day=False
                ),
                "TestCalendar"
            )
        ]

        # Create a mock session that fails on commit
        mock_session = MagicMock()
        mock_session.query.return_value.filter.return_value.delete.return_value = None
        mock_session.add = MagicMock()
        mock_session.commit.side_effect = Exception("DB Error")
        mock_session.rollback = MagicMock()
        mock_session.close = MagicMock()

        with patch("app.ical_service._fetch_events_from_caldav", return_value=mock_events_with_source), \
             patch("app.ical_service.SessionLocal", return_value=mock_session):
            # Should not raise exception
            _refresh_db_cache_sync()

        # Verify rollback was called
        mock_session.rollback.assert_called_once()
        mock_session.close.assert_called_once()


class TestFetchAndCacheEventsError:
    """Test error handling in fetch_and_cache_events."""

    def test_fetch_and_cache_handles_db_error(self, db_session):
        """Test that fetch_and_cache handles database errors gracefully."""
        mock_events_with_source = [
            CalendarEventWithSource(
                CalendarEvent(
                    id="event-16",
                    title="Event",
                    start_time=datetime(2024, 2, 15, 10, 0, 0),
                    all_day=False
                ),
                "TestCalendar"
            )
        ]

        # Create a mock session that fails on commit
        mock_session = MagicMock()
        mock_session.query.return_value.filter.return_value.delete.return_value = None
        mock_session.add = MagicMock()
        mock_session.commit.side_effect = Exception("DB Error")
        mock_session.rollback = MagicMock()
        mock_session.close = MagicMock()

        with patch("app.ical_service._fetch_events_from_caldav", return_value=mock_events_with_source), \
             patch("app.ical_service.SessionLocal", return_value=mock_session):
            # Should still return events even if DB caching fails
            result = _fetch_and_cache_events_sync(date(2024, 2, 15), date(2024, 2, 15))

        # Events should still be returned
        assert len(result) == 1
        assert result[0].title == "Event"

        # Verify rollback was called
        mock_session.rollback.assert_called_once()


class TestIsAllDayNoStart:
    """Test _is_all_day with no start date."""

    def test_is_all_day_no_dtstart(self):
        """Test _is_all_day when component has no dtstart."""
        class MockComponent:
            def get(self, key):
                return None

        component = MockComponent()
        assert _is_all_day(component) is False


class TestRefreshCacheAsync:
    """Test async cache refresh."""

    @pytest.mark.asyncio
    async def test_refresh_cache_async(self):
        """Test that _refresh_cache_async calls the sync function."""
        from app.ical_service import _refresh_cache_async

        with patch("app.ical_service._refresh_db_cache_sync") as mock_refresh:
            await _refresh_cache_async()
            mock_refresh.assert_called_once()
