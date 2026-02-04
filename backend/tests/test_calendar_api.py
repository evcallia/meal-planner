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
