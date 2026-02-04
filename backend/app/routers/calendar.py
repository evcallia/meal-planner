from datetime import datetime
from fastapi import APIRouter, Depends, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import SessionLocal, get_db
from app.models import CalendarCacheMetadata
from app.ical_service import _refresh_db_cache_sync, _get_events_from_db, _get_cache_range
from app.realtime import broadcast_event
from app.schemas import CalendarEvent

router = APIRouter(prefix="/api/calendar", tags=["calendar"])


class CacheStatusResponse(BaseModel):
    last_refresh: datetime | None
    cache_start: str | None
    cache_end: str | None
    is_refreshing: bool


class RefreshResponse(BaseModel):
    message: str


# Track if a refresh is in progress
_refresh_in_progress = False


def _do_refresh_and_broadcast():
    """Refresh cache and broadcast events to all clients."""
    global _refresh_in_progress
    _refresh_in_progress = True

    try:
        # Refresh the cache
        _refresh_db_cache_sync()

        # Get the refreshed events
        start, end = _get_cache_range()
        events = _get_events_from_db(start, end)

        # Group events by date for broadcast
        events_by_date: dict[str, list[dict]] = {}
        for event in events:
            date_str = event.start_time.date().isoformat()
            if date_str not in events_by_date:
                events_by_date[date_str] = []
            events_by_date[date_str].append({
                "title": event.title,
                "start_time": event.start_time.isoformat(),
                "end_time": event.end_time.isoformat() if event.end_time else None,
                "all_day": event.all_day,
            })

        # Get updated metadata
        db = SessionLocal()
        try:
            metadata = db.query(CalendarCacheMetadata).first()
            last_refresh = metadata.last_refresh.isoformat() if metadata and metadata.last_refresh else None
        finally:
            db.close()

        # Broadcast to all clients - need to run in async context
        import asyncio
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        loop.run_until_complete(broadcast_event("calendar.refreshed", {
            "events_by_date": events_by_date,
            "last_refresh": last_refresh,
        }))

    finally:
        _refresh_in_progress = False


@router.get("/cache-status", response_model=CacheStatusResponse)
async def get_cache_status(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get the current calendar cache status."""
    metadata = db.query(CalendarCacheMetadata).first()

    if not metadata:
        return CacheStatusResponse(
            last_refresh=None,
            cache_start=None,
            cache_end=None,
            is_refreshing=_refresh_in_progress,
        )

    return CacheStatusResponse(
        last_refresh=metadata.last_refresh,
        cache_start=metadata.cache_start.isoformat() if metadata.cache_start else None,
        cache_end=metadata.cache_end.isoformat() if metadata.cache_end else None,
        is_refreshing=_refresh_in_progress,
    )


@router.post("/refresh", response_model=RefreshResponse)
async def refresh_calendar(
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
):
    """Manually trigger a calendar cache refresh."""
    global _refresh_in_progress

    if _refresh_in_progress:
        return RefreshResponse(message="Refresh already in progress")

    # Run refresh in background
    background_tasks.add_task(_do_refresh_and_broadcast)

    return RefreshResponse(message="Refresh started")
