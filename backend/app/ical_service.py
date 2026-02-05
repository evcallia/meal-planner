import caldav
from datetime import datetime, date, timedelta
from icalendar import Calendar
import time
import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from app.config import get_settings
from app.schemas import CalendarEvent
from app.database import SessionLocal
from app.models import CachedCalendarEvent, CalendarCacheMetadata

# Clear settings cache to ensure fresh values are loaded after restart
get_settings.cache_clear()
settings = get_settings()

# Apple CalDAV URL
APPLE_CALDAV_URL = "https://caldav.icloud.com"


def _log(msg: str) -> None:
    """Print debug timing log if enabled."""
    if settings.debug_timing:
        print(msg, flush=True)


# Thread pool for running sync CalDAV operations
_executor = ThreadPoolExecutor(max_workers=2)

# Cache settings
CACHE_WEEKS_BEFORE = 4
CACHE_WEEKS_AFTER = 8
CACHE_REFRESH_INTERVAL = 1800  # 30 minutes

# Cache for CalDAV calendars (in-memory, short TTL)
# Now stores list of calendars instead of single calendar
_calendars_cache: tuple[float, list[caldav.Calendar]] = (0, [])
CALENDAR_CACHE_TTL = 600  # 10 minutes

# Background refresh task
_refresh_task: Optional[asyncio.Task] = None


def _parse_ical_date(dt) -> datetime:
    """Convert icalendar date/datetime to Python datetime."""
    if hasattr(dt, "dt"):
        dt = dt.dt
    if isinstance(dt, datetime):
        if dt.tzinfo is not None:
            return dt.replace(tzinfo=None)
        return dt
    if isinstance(dt, date):
        return datetime.combine(dt, datetime.min.time())
    return dt


def _is_all_day(component) -> bool:
    """Check if an event is an all-day event."""
    dtstart = component.get("dtstart")
    if dtstart:
        return isinstance(dtstart.dt, date) and not isinstance(dtstart.dt, datetime)
    return False


def _get_all_calendars_sync() -> list[caldav.Calendar]:
    """Get all available calendars from CalDAV (synchronous)."""
    if not settings.apple_calendar_email or not settings.apple_calendar_app_password:
        return []

    try:
        _log(f"[CalDAV] Connecting to {APPLE_CALDAV_URL}...")
        t1 = time.time()

        client = caldav.DAVClient(
            url=APPLE_CALDAV_URL,
            username=settings.apple_calendar_email,
            password=settings.apple_calendar_app_password,
        )

        t2 = time.time()
        _log(f"[CalDAV] Client created in {t2-t1:.2f}s, fetching principal...")

        principal = client.principal()

        t3 = time.time()
        _log(f"[CalDAV] Principal fetched in {t3-t2:.2f}s, fetching calendars...")

        calendars = principal.calendars()

        t4 = time.time()
        _log(f"[CalDAV] Calendars fetched in {t4-t3:.2f}s (total: {t4-t1:.2f}s)")

        return calendars or []

    except Exception as e:
        _log(f"Error connecting to CalDAV: {e}")
        return []


def _get_selected_calendars_sync() -> list[caldav.Calendar]:
    """Get cached selected calendars or create new connection (synchronous)."""
    global _calendars_cache
    now = time.time()

    # Get fresh settings each time to pick up env changes after restart
    current_settings = get_settings()

    # Parse the comma-separated calendar names from settings
    selected_names = [name.strip() for name in current_settings.apple_calendar_names.split(",") if name.strip()]

    cached_time, cached_calendars = _calendars_cache
    if cached_calendars and (now - cached_time) < CALENDAR_CACHE_TTL:
        # Verify cached calendars still match the selected names
        cached_names = [c.name for c in cached_calendars]
        if selected_names:
            # Check if cached matches what's configured
            if set(cached_names) == set(n for n in selected_names if n in cached_names):
                _log("[CalDAV] Using cached calendar connections")
                return cached_calendars
        elif len(cached_calendars) == 1:
            # No filter, using first calendar - cache is valid
            _log("[CalDAV] Using cached calendar connections")
            return cached_calendars
        # Cache doesn't match current settings, refresh

    all_calendars = _get_all_calendars_sync()
    if not all_calendars:
        return []

    # Always log what we're trying to match (helps debug config issues)
    available_names = [c.name for c in all_calendars]
    print(f"[CalDAV] Config calendar names: {selected_names}", flush=True)
    print(f"[CalDAV] Available calendars: {available_names}", flush=True)

    if selected_names:
        # Filter to only selected calendars
        selected_calendars = []
        for cal in all_calendars:
            if cal.name in selected_names:
                selected_calendars.append(cal)
                print(f"[CalDAV] Matched calendar: '{cal.name}'", flush=True)
        if not selected_calendars:
            print(f"[CalDAV] No matching calendars found for {selected_names}. Available: {available_names}", flush=True)
            # Fall back to first calendar if none match
            selected_calendars = [all_calendars[0]]
    else:
        # No filter specified - use first calendar (backward compatible)
        selected_calendars = [all_calendars[0]]

    print(f"[CalDAV] Using calendars: {[c.name for c in selected_calendars]}", flush=True)
    _calendars_cache = (now, selected_calendars)
    return selected_calendars


def list_available_calendars_sync() -> list[str]:
    """List all available calendar names (for UI selection)."""
    calendars = _get_all_calendars_sync()
    return [cal.name for cal in calendars]


class CalendarEventWithSource:
    """Internal class to track event source calendar."""
    def __init__(self, event: CalendarEvent, calendar_name: str):
        self.event = event
        self.calendar_name = calendar_name


def _fetch_events_from_caldav(start_date: date, end_date: date) -> list[CalendarEventWithSource]:
    """Fetch events from all selected CalDAV calendars (slow network call)."""
    t_start = time.time()
    calendars = _get_selected_calendars_sync()
    if not calendars:
        return []

    all_events: list[CalendarEventWithSource] = []

    try:
        start_dt = datetime.combine(start_date, datetime.min.time())
        end_dt = datetime.combine(end_date, datetime.max.time())

        for calendar in calendars:
            calendar_name = calendar.name or "Unknown"
            _log(f"[CalDAV] Searching events in '{calendar_name}' {start_date} to {end_date}...")
            t1 = time.time()

            try:
                caldav_events = calendar.search(
                    start=start_dt,
                    end=end_dt,
                    event=True,
                    expand=True,
                )

                t2 = time.time()
                _log(f"[CalDAV] Search in '{calendar_name}' completed in {t2-t1:.2f}s, found {len(caldav_events)} events")

                for caldav_event in caldav_events:
                    try:
                        cal = Calendar.from_ical(caldav_event.data)

                        for component in cal.walk():
                            if component.name != "VEVENT":
                                continue

                            dtstart = component.get("dtstart")
                            dtend = component.get("dtend")
                            summary = str(component.get("summary", ""))

                            if not dtstart:
                                continue

                            event_start = _parse_ical_date(dtstart)
                            event_end = _parse_ical_date(dtend) if dtend else None
                            event_date = event_start.date()

                            if event_date < start_date or event_date > end_date:
                                continue

                            event = CalendarEvent(
                                title=summary,
                                start_time=event_start,
                                end_time=event_end,
                                all_day=_is_all_day(component),
                            )
                            all_events.append(CalendarEventWithSource(event, calendar_name))
                    except Exception as e:
                        _log(f"Error parsing event: {e}")
                        continue

            except Exception as e:
                _log(f"Error fetching from calendar '{calendar_name}': {e}")
                continue

        # Sort by start time
        all_events.sort(key=lambda e: e.event.start_time)

        t_end = time.time()
        _log(f"[CalDAV] Total fetch time: {t_end-t_start:.2f}s, {len(all_events)} events from {len(calendars)} calendars")

        return all_events

    except Exception as e:
        _log(f"Error fetching from Apple Calendar: {e}")
        return []


def _get_cache_range() -> tuple[date, date]:
    """Calculate the date range to cache."""
    today = date.today()
    start = today - timedelta(weeks=CACHE_WEEKS_BEFORE)
    end = today + timedelta(weeks=CACHE_WEEKS_AFTER)
    return start, end


def _refresh_db_cache_sync() -> None:
    """Refresh the database cache with events from CalDAV."""
    start, end = _get_cache_range()
    _log(f"[CalDAV Cache] Refreshing DB cache for {start} to {end}...")

    # Fetch from CalDAV (now returns CalendarEventWithSource objects)
    events_with_source = _fetch_events_from_caldav(start, end)

    # Update database
    db = SessionLocal()
    try:
        # Delete old cached events in this range
        db.query(CachedCalendarEvent).filter(
            CachedCalendarEvent.event_date >= start,
            CachedCalendarEvent.event_date <= end
        ).delete()

        # Insert new events with calendar source
        for event_with_source in events_with_source:
            event = event_with_source.event
            cached_event = CachedCalendarEvent(
                event_date=event.start_time.date(),
                calendar_name=event_with_source.calendar_name,
                title=event.title,
                start_time=event.start_time,
                end_time=event.end_time,
                all_day=event.all_day,
            )
            db.add(cached_event)

        # Update metadata
        metadata = db.query(CalendarCacheMetadata).first()
        if not metadata:
            metadata = CalendarCacheMetadata(id=1)
            db.add(metadata)

        metadata.last_refresh = datetime.utcnow()
        metadata.cache_start = start
        metadata.cache_end = end

        db.commit()
        _log(f"[CalDAV Cache] DB cache refreshed with {len(events_with_source)} events")

    except Exception as e:
        db.rollback()
        _log(f"[CalDAV Cache] Error refreshing DB cache: {e}")
    finally:
        db.close()


async def _refresh_cache_async() -> None:
    """Refresh cache in background thread."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(_executor, _refresh_db_cache_sync)


async def _background_refresh_loop() -> None:
    """Background task that periodically refreshes the cache."""
    while True:
        try:
            await asyncio.sleep(CACHE_REFRESH_INTERVAL)
            _log("[CalDAV Cache] Background refresh starting...")
            await _refresh_cache_async()
        except asyncio.CancelledError:
            _log("[CalDAV Cache] Background refresh task cancelled")
            break
        except Exception as e:
            _log(f"[CalDAV Cache] Background refresh error: {e}")


def _is_cache_valid() -> bool:
    """Check if we have valid cached data in the database."""
    db = SessionLocal()
    try:
        metadata = db.query(CalendarCacheMetadata).first()
        if not metadata or not metadata.last_refresh:
            return False

        # Check if cache covers today
        today = date.today()
        if metadata.cache_start and metadata.cache_end:
            return metadata.cache_start <= today <= metadata.cache_end

        return False
    finally:
        db.close()


async def initialize_cache() -> None:
    """Initialize the cache on startup. Called from app lifespan."""
    global _refresh_task

    _log("[CalDAV Cache] Refreshing cache on startup...")

    # Always refresh on startup to pick up any config changes (e.g., new calendars)
    await _refresh_cache_async()

    # Start background refresh task
    _refresh_task = asyncio.create_task(_background_refresh_loop())
    _log("[CalDAV Cache] Background refresh task started (interval: 30min)")


async def shutdown_cache() -> None:
    """Shutdown cache refresh task. Called from app lifespan."""
    global _refresh_task

    if _refresh_task:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass
        _refresh_task = None
        _log("[CalDAV Cache] Cache shutdown complete")


def _get_events_from_db(start_date: date, end_date: date) -> list[CalendarEvent]:
    """Get events from database cache."""
    db = SessionLocal()
    try:
        cached = db.query(CachedCalendarEvent).filter(
            CachedCalendarEvent.event_date >= start_date,
            CachedCalendarEvent.event_date <= end_date
        ).order_by(CachedCalendarEvent.start_time).all()

        return [
            CalendarEvent(
                title=e.title,
                start_time=e.start_time,
                end_time=e.end_time,
                all_day=e.all_day,
            )
            for e in cached
        ]
    finally:
        db.close()


def _get_cache_metadata() -> tuple[date | None, date | None]:
    """Get the current cache date range from metadata."""
    db = SessionLocal()
    try:
        metadata = db.query(CalendarCacheMetadata).first()
        if metadata:
            return metadata.cache_start, metadata.cache_end
        return None, None
    finally:
        db.close()


def _fetch_and_cache_events_sync(start_date: date, end_date: date) -> list[CalendarEvent]:
    """Fetch events from CalDAV and add them to the DB cache."""
    _log(f"[CalDAV Cache] Fetching and caching events for {start_date} to {end_date}...")

    # Fetch from CalDAV (now returns CalendarEventWithSource objects)
    events_with_source = _fetch_events_from_caldav(start_date, end_date)

    # Add to database cache
    db = SessionLocal()
    try:
        # Delete any existing cached events in this range (to avoid duplicates)
        db.query(CachedCalendarEvent).filter(
            CachedCalendarEvent.event_date >= start_date,
            CachedCalendarEvent.event_date <= end_date
        ).delete()

        # Insert new events with calendar source
        for event_with_source in events_with_source:
            event = event_with_source.event
            cached_event = CachedCalendarEvent(
                event_date=event.start_time.date(),
                calendar_name=event_with_source.calendar_name,
                title=event.title,
                start_time=event.start_time,
                end_time=event.end_time,
                all_day=event.all_day,
            )
            db.add(cached_event)

        db.commit()
        _log(f"[CalDAV Cache] Added {len(events_with_source)} events to cache for {start_date} to {end_date}")

    except Exception as e:
        db.rollback()
        _log(f"[CalDAV Cache] Error caching events: {e}")
    finally:
        db.close()

    # Return just the CalendarEvent objects (without source) for API compatibility
    return [e.event for e in events_with_source]


async def fetch_ical_events(start_date: date, end_date: date) -> list[CalendarEvent]:
    """
    Fetch events for a date range.

    - If fully within cache range: serve from DB instantly
    - If outside cache range: fetch from CalDAV and add to cache
    """
    cache_start, cache_end = _get_cache_metadata()

    # Check if requested range is fully within cache
    if cache_start and cache_end and start_date >= cache_start and end_date <= cache_end:
        _log(f"[CalDAV Cache] Serving {start_date} to {end_date} from DB cache")
        return _get_events_from_db(start_date, end_date)

    # Check if there's partial overlap - serve what we have from cache, fetch the rest
    if cache_start and cache_end:
        # Determine what parts are outside cache
        events = []

        # Part before cache
        if start_date < cache_start:
            fetch_start = start_date
            fetch_end = min(end_date, cache_start - timedelta(days=1))
            _log(f"[CalDAV Cache] Fetching pre-cache range {fetch_start} to {fetch_end}")
            loop = asyncio.get_event_loop()
            pre_events = await loop.run_in_executor(
                _executor, _fetch_and_cache_events_sync, fetch_start, fetch_end
            )
            events.extend(pre_events)

        # Part within cache
        overlap_start = max(start_date, cache_start)
        overlap_end = min(end_date, cache_end)
        if overlap_start <= overlap_end:
            _log(f"[CalDAV Cache] Serving cached range {overlap_start} to {overlap_end}")
            cached_events = _get_events_from_db(overlap_start, overlap_end)
            events.extend(cached_events)

        # Part after cache
        if end_date > cache_end:
            fetch_start = max(start_date, cache_end + timedelta(days=1))
            fetch_end = end_date
            _log(f"[CalDAV Cache] Fetching post-cache range {fetch_start} to {fetch_end}")
            loop = asyncio.get_event_loop()
            post_events = await loop.run_in_executor(
                _executor, _fetch_and_cache_events_sync, fetch_start, fetch_end
            )
            events.extend(post_events)

        # Sort combined events
        events.sort(key=lambda e: e.start_time)
        return events

    # No cache at all - fetch everything
    _log(f"[CalDAV Cache] No cache, fetching {start_date} to {end_date} from CalDAV")
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        _executor, _fetch_and_cache_events_sync, start_date, end_date
    )


def get_events_for_date(events: list[CalendarEvent], target_date: date) -> list[CalendarEvent]:
    """Filter events for a specific date."""
    return [e for e in events if e.start_time.date() == target_date]


# Alias for backward compatibility with tests
_get_calendar = _get_selected_calendars_sync
