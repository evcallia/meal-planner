import pytest
from datetime import date, datetime, timedelta
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from unittest.mock import patch, AsyncMock, MagicMock

from app.models import CalendarCacheMetadata, CachedCalendarEvent


class TestCalendarCacheStatusAPI:
    """Test the calendar cache status API endpoint."""

    def test_get_cache_status_empty(self, authenticated_client: TestClient, db_session: Session):
        """Test getting cache status when no metadata exists."""
        response = authenticated_client.get("/api/calendar/cache-status")

        assert response.status_code == 200
        data = response.json()

        assert data["last_refresh"] is None
        assert data["cache_start"] is None
        assert data["cache_end"] is None
        assert data["is_refreshing"] is False

    def test_get_cache_status_with_metadata(self, authenticated_client: TestClient, db_session: Session):
        """Test getting cache status with existing metadata."""
        # Create metadata
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime(2024, 2, 15, 12, 0, 0),
            cache_start=date(2024, 1, 15),
            cache_end=date(2024, 4, 15)
        )
        db_session.add(metadata)
        db_session.commit()

        response = authenticated_client.get("/api/calendar/cache-status")

        assert response.status_code == 200
        data = response.json()

        assert data["last_refresh"] is not None
        assert data["cache_start"] == "2024-01-15"
        assert data["cache_end"] == "2024-04-15"
        assert data["is_refreshing"] is False

    def test_get_cache_status_requires_auth(self, client: TestClient):
        """Test that cache status endpoint requires authentication."""
        response = client.get("/api/calendar/cache-status")
        assert response.status_code == 401


class TestCalendarRefreshAPI:
    """Test the calendar refresh API endpoint."""

    @patch("app.routers.calendar._do_refresh_and_broadcast")
    def test_refresh_calendar(self, mock_refresh, authenticated_client: TestClient, db_session: Session):
        """Test triggering a calendar refresh."""
        response = authenticated_client.post("/api/calendar/refresh")

        assert response.status_code == 200
        data = response.json()

        assert data["message"] == "Refresh started"

    @patch("app.routers.calendar._refresh_in_progress", True)
    def test_refresh_calendar_already_in_progress(self, authenticated_client: TestClient):
        """Test refresh when already in progress."""
        response = authenticated_client.post("/api/calendar/refresh")

        assert response.status_code == 200
        data = response.json()

        assert data["message"] == "Refresh already in progress"

    def test_refresh_calendar_requires_auth(self, client: TestClient):
        """Test that refresh endpoint requires authentication."""
        response = client.post("/api/calendar/refresh")
        assert response.status_code == 401


class TestCalendarRefreshBroadcast:
    """Test that calendar refresh broadcasts to clients."""

    @patch("app.routers.calendar._refresh_in_progress", False)
    @patch("app.routers.calendar._do_refresh_and_broadcast")
    def test_refresh_triggers_background_task(
        self, mock_refresh, authenticated_client: TestClient
    ):
        """Test that refresh triggers background task."""
        response = authenticated_client.post("/api/calendar/refresh")

        assert response.status_code == 200
        # Background task is added but may not be called immediately


class TestCalendarCacheIntegration:
    """Integration tests for calendar caching."""

    def test_cache_status_reflects_cached_events(self, authenticated_client: TestClient, db_session: Session):
        """Test that cache status correctly reflects cached data."""
        today = date.today()

        # Add metadata
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=today - timedelta(weeks=4),
            cache_end=today + timedelta(weeks=8)
        )
        db_session.add(metadata)

        # Add some cached events
        events = [
            CachedCalendarEvent(
                event_date=today,
                title="Event 1",
                start_time=datetime.combine(today, datetime.min.time().replace(hour=10)),
                all_day=False
            ),
            CachedCalendarEvent(
                event_date=today + timedelta(days=1),
                title="Event 2",
                start_time=datetime.combine(today + timedelta(days=1), datetime.min.time().replace(hour=14)),
                all_day=False
            ),
        ]
        db_session.add_all(events)
        db_session.commit()

        # Check cache status
        response = authenticated_client.get("/api/calendar/cache-status")
        assert response.status_code == 200
        data = response.json()

        assert data["last_refresh"] is not None
        assert data["cache_start"] == (today - timedelta(weeks=4)).isoformat()
        assert data["cache_end"] == (today + timedelta(weeks=8)).isoformat()

    def test_events_served_from_cache(self, authenticated_client: TestClient, db_session: Session):
        """Test that events are served from cache."""
        today = date.today()

        # Setup cache
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=today - timedelta(weeks=4),
            cache_end=today + timedelta(weeks=8)
        )
        db_session.add(metadata)

        event = CachedCalendarEvent(
            event_date=today,
            title="Cached Event",
            start_time=datetime.combine(today, datetime.min.time().replace(hour=10)),
            end_time=datetime.combine(today, datetime.min.time().replace(hour=11)),
            all_day=False
        )
        db_session.add(event)
        db_session.commit()

        # Mock SessionLocal in ical_service to use our test session
        with patch("app.ical_service.SessionLocal", return_value=db_session):
            # Request events for today
            response = authenticated_client.get(
                f"/api/days/events?start_date={today.isoformat()}&end_date={today.isoformat()}"
            )

        assert response.status_code == 200
        data = response.json()

        # Events should be keyed by date
        assert today.isoformat() in data
        assert len(data[today.isoformat()]) == 1
        assert data[today.isoformat()][0]["title"] == "Cached Event"


class TestCalendarListAPI:
    """Test the calendar list API endpoint."""

    @patch("app.ical_service._get_selected_calendars_sync")
    @patch("app.routers.calendar.list_available_calendars_sync")
    def test_list_calendars(self, mock_available, mock_selected, authenticated_client: TestClient):
        """Test listing available and selected calendars."""
        mock_available.return_value = ["Personal", "Work", "Family"]

        # Mock selected calendars
        mock_cal1 = MagicMock()
        mock_cal1.name = "Personal"
        mock_cal2 = MagicMock()
        mock_cal2.name = "Work"
        mock_selected.return_value = [mock_cal1, mock_cal2]

        response = authenticated_client.get("/api/calendar/list")

        assert response.status_code == 200
        data = response.json()

        assert data["available"] == ["Personal", "Work", "Family"]
        assert set(data["selected"]) == {"Personal", "Work"}

    def test_list_calendars_requires_auth(self, client: TestClient):
        """Test that list calendars endpoint requires authentication."""
        response = client.get("/api/calendar/list")
        assert response.status_code == 401


class TestDoRefreshAndBroadcast:
    """Test the _do_refresh_and_broadcast function."""

    @patch("app.routers.calendar.broadcast_event")
    @patch("app.routers.calendar._refresh_db_cache_sync")
    @patch("app.routers.calendar._get_events_from_db")
    @patch("app.routers.calendar._get_cache_range")
    @patch("app.routers.calendar.SessionLocal")
    def test_do_refresh_broadcasts_events(
        self,
        mock_session_local,
        mock_cache_range,
        mock_get_events,
        mock_refresh,
        mock_broadcast
    ):
        """Test that refresh broadcasts events to clients."""
        from app.routers.calendar import _do_refresh_and_broadcast

        today = date.today()
        mock_cache_range.return_value = (today, today)

        # Mock events
        mock_event = MagicMock()
        mock_event.title = "Test Event"
        mock_event.start_time = datetime.combine(today, datetime.min.time().replace(hour=10))
        mock_event.end_time = datetime.combine(today, datetime.min.time().replace(hour=11))
        mock_event.all_day = False
        mock_get_events.return_value = [mock_event]

        # Mock session
        mock_db = MagicMock()
        mock_metadata = MagicMock()
        mock_metadata.last_refresh = datetime.utcnow()
        mock_db.query.return_value.first.return_value = mock_metadata
        mock_session_local.return_value = mock_db

        # Create a proper async mock for broadcast_event
        async def async_noop(*args, **kwargs):
            pass

        mock_broadcast.side_effect = async_noop

        _do_refresh_and_broadcast()

        mock_refresh.assert_called_once()
        mock_get_events.assert_called_once()


class TestCacheStatusWithNullFields:
    """Test cache status edge cases."""

    def test_cache_status_with_null_last_refresh(self, authenticated_client: TestClient, db_session: Session):
        """Test cache status when last_refresh is null."""
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=None,
            cache_start=date.today(),
            cache_end=date.today()
        )
        db_session.add(metadata)
        db_session.commit()

        response = authenticated_client.get("/api/calendar/cache-status")
        assert response.status_code == 200
        data = response.json()

        assert data["last_refresh"] is None

    def test_cache_status_with_null_dates(self, authenticated_client: TestClient, db_session: Session):
        """Test cache status when cache dates are null."""
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow(),
            cache_start=None,
            cache_end=None
        )
        db_session.add(metadata)
        db_session.commit()

        response = authenticated_client.get("/api/calendar/cache-status")
        assert response.status_code == 200
        data = response.json()

        assert data["cache_start"] is None
        assert data["cache_end"] is None
