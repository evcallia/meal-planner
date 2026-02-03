import caldav
from datetime import datetime, date, timedelta
from icalendar import Calendar
import time
import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from app.config import get_settings
from app.schemas import CalendarEvent

settings = get_settings()

# Apple CalDAV URL
APPLE_CALDAV_URL = "https://caldav.icloud.com"


def _log(msg: str) -> None:
    """Print debug timing log if enabled."""
    if settings.debug_timing:
        print(msg)

# Thread pool for running sync CalDAV operations
_executor = ThreadPoolExecutor(max_workers=2)

# Cache for events (broader date range)
_events_cache: dict[str, tuple[float, list[CalendarEvent]]] = {}
CACHE_TTL = 300  # 5 minutes

# Cache for CalDAV client/calendar (longer TTL)
_calendar_cache: tuple[float, Optional[caldav.Calendar]] = (0, None)
CALENDAR_CACHE_TTL = 600  # 10 minutes


def _parse_ical_date(dt) -> datetime:
    """Convert icalendar date/datetime to Python datetime."""
    if hasattr(dt, "dt"):
        dt = dt.dt
    if isinstance(dt, datetime):
        # Handle timezone-aware datetimes
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


def _get_calendar_sync() -> Optional[caldav.Calendar]:
    """Get cached calendar or create new connection (synchronous)."""
    global _calendar_cache
    now = time.time()

    cached_time, cached_calendar = _calendar_cache
    if cached_calendar and (now - cached_time) < CALENDAR_CACHE_TTL:
        _log("[CalDAV] Using cached calendar")
        return cached_calendar

    if not settings.apple_calendar_email or not settings.apple_calendar_app_password:
        return None

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

        if not calendars:
            return None

        calendar = None
        if settings.apple_calendar_name:
            for cal in calendars:
                if cal.name == settings.apple_calendar_name:
                    calendar = cal
                    break
            if not calendar:
                _log(f"Calendar '{settings.apple_calendar_name}' not found. Available: {[c.name for c in calendars]}")
                return None
        else:
            calendar = calendars[0]

        _calendar_cache = (now, calendar)
        return calendar

    except Exception as e:
        _log(f"Error connecting to CalDAV: {e}")
        return None


# Alias for backward compatibility with tests
_get_calendar = _get_calendar_sync


def _fetch_events_sync(start_date: date, end_date: date) -> list[CalendarEvent]:
    """Fetch events synchronously (runs in thread pool)."""
    t_start = time.time()
    calendar = _get_calendar_sync()
    if not calendar:
        return []

    try:
        start_dt = datetime.combine(start_date, datetime.min.time())
        end_dt = datetime.combine(end_date, datetime.max.time())

        _log(f"[CalDAV] Searching events {start_date} to {end_date}...")
        t1 = time.time()

        caldav_events = calendar.search(
            start=start_dt,
            end=end_dt,
            event=True,
            expand=True,
        )

        t2 = time.time()
        _log(f"[CalDAV] Search completed in {t2-t1:.2f}s, found {len(caldav_events)} events")

        events: list[CalendarEvent] = []

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

                    events.append(
                        CalendarEvent(
                            title=summary,
                            start_time=event_start,
                            end_time=event_end,
                            all_day=_is_all_day(component),
                        )
                    )
            except Exception as e:
                _log(f"Error parsing event: {e}")
                continue

        events.sort(key=lambda e: e.start_time)

        t_end = time.time()
        _log(f"[CalDAV] Total fetch time: {t_end-t_start:.2f}s")

        return events

    except Exception as e:
        _log(f"Error fetching from Apple Calendar: {e}")
        return []


async def fetch_ical_events(start_date: date, end_date: date) -> list[CalendarEvent]:
    """Fetch events from Apple Calendar via CalDAV for a date range."""
    cache_key = f"{start_date}_{end_date}"
    now = time.time()

    # Check cache first
    if cache_key in _events_cache:
        cached_time, cached_events = _events_cache[cache_key]
        if now - cached_time < CACHE_TTL:
            return cached_events

    # Run synchronous CalDAV operations in thread pool to not block
    loop = asyncio.get_event_loop()
    events = await loop.run_in_executor(_executor, _fetch_events_sync, start_date, end_date)

    # Cache the results
    _events_cache[cache_key] = (now, events)

    return events


def get_events_for_date(events: list[CalendarEvent], target_date: date) -> list[CalendarEvent]:
    """Filter events for a specific date."""
    return [e for e in events if e.start_time.date() == target_date]
