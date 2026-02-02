import caldav
from datetime import datetime, date, timedelta
from icalendar import Calendar
import time
from typing import Optional

from app.config import get_settings
from app.schemas import CalendarEvent

settings = get_settings()

# Apple CalDAV URL
APPLE_CALDAV_URL = "https://caldav.icloud.com"

# Simple in-memory cache with TTL
_cache: dict[str, tuple[float, list[CalendarEvent]]] = {}
CACHE_TTL = 300  # 5 minutes


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


def _get_caldav_client() -> Optional[caldav.DAVClient]:
    """Create authenticated CalDAV client for Apple Calendar."""
    if not settings.apple_calendar_email or not settings.apple_calendar_app_password:
        return None

    return caldav.DAVClient(
        url=APPLE_CALDAV_URL,
        username=settings.apple_calendar_email,
        password=settings.apple_calendar_app_password,
    )


def _find_calendar(principal: caldav.Principal) -> Optional[caldav.Calendar]:
    """Find the target calendar by name, or return the first one."""
    calendars = principal.calendars()

    if not calendars:
        return None

    # If a specific calendar name is configured, find it
    if settings.apple_calendar_name:
        for cal in calendars:
            if cal.name == settings.apple_calendar_name:
                return cal
        print(f"Calendar '{settings.apple_calendar_name}' not found. Available: {[c.name for c in calendars]}")
        return None

    # Otherwise return the first calendar
    return calendars[0]


async def fetch_ical_events(start_date: date, end_date: date) -> list[CalendarEvent]:
    """Fetch events from Apple Calendar via CalDAV for a date range."""
    cache_key = f"{start_date}_{end_date}"
    now = time.time()

    # Check cache
    if cache_key in _cache:
        cached_time, cached_events = _cache[cache_key]
        if now - cached_time < CACHE_TTL:
            return cached_events

    client = _get_caldav_client()
    if not client:
        return []

    try:
        principal = client.principal()
        calendar = _find_calendar(principal)

        if not calendar:
            print("No calendar found")
            return []

        # Fetch events in date range
        # CalDAV uses datetime for search, so convert dates
        start_dt = datetime.combine(start_date, datetime.min.time())
        end_dt = datetime.combine(end_date, datetime.max.time())

        caldav_events = calendar.search(
            start=start_dt,
            end=end_dt,
            event=True,
            expand=True,  # Expand recurring events
        )

        events: list[CalendarEvent] = []

        for caldav_event in caldav_events:
            try:
                # Parse the iCalendar data
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

                    # Filter to date range (in case CalDAV returns extras)
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
                print(f"Error parsing event: {e}")
                continue

        # Sort by start time
        events.sort(key=lambda e: e.start_time)

        # Cache the results
        _cache[cache_key] = (now, events)

        return events

    except Exception as e:
        print(f"Error fetching from Apple Calendar: {e}")
        return []


def get_events_for_date(events: list[CalendarEvent], target_date: date) -> list[CalendarEvent]:
    """Filter events for a specific date."""
    return [e for e in events if e.start_time.date() == target_date]
