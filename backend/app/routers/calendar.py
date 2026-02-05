from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import asyncio

from fastapi import APIRouter, Depends, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.config import get_settings
from app.database import SessionLocal, get_db
from app.models import CalendarCacheMetadata
from app.ical_service import _refresh_db_cache_sync, _get_events_from_db, _get_cache_range, list_available_calendars_sync
from app.realtime import broadcast_event
from app.schemas import CalendarEvent

router = APIRouter(prefix="/api/calendar", tags=["calendar"])
_executor = ThreadPoolExecutor(max_workers=2)


class CacheStatusResponse(BaseModel):
    last_refresh: str | None
    cache_start: str | None
    cache_end: str | None
    is_refreshing: bool


class RefreshResponse(BaseModel):
    message: str


class CalendarListResponse(BaseModel):
    available: list[str]
    selected: list[str]


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

    # Add Z suffix to indicate UTC time so frontend parses it correctly
    last_refresh_str = metadata.last_refresh.isoformat() + "Z" if metadata.last_refresh else None

    return CacheStatusResponse(
        last_refresh=last_refresh_str,
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


@router.get("/list", response_model=CalendarListResponse)
async def list_calendars(
    user: dict = Depends(get_current_user),
):
    """List available calendars and which ones are selected."""
    # Run the sync CalDAV call in a thread pool to get available calendars
    loop = asyncio.get_event_loop()
    available = await loop.run_in_executor(_executor, list_available_calendars_sync)

    # Import here to get the selected calendars from the actual ical_service
    # which determines what calendars are being used for fetching events
    from app.ical_service import _get_selected_calendars_sync
    selected_cals = await loop.run_in_executor(_executor, _get_selected_calendars_sync)
    selected_names = [cal.name for cal in selected_cals]

    return CalendarListResponse(
        available=available,
        selected=selected_names,
    )
