from datetime import date, timedelta
import time
import re
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.models import MealNote, MealItem
from app.schemas import DayData, MealNoteSchema, MealNoteUpdate, MealItemToggle, MealItemSchema, CalendarEvent
from app.ical_service import fetch_ical_events, get_events_for_date
from app.auth import get_current_user
from app.realtime import broadcast_event

settings = get_settings()
router = APIRouter(prefix="/api/days", tags=["days"])


def _log(msg: str) -> None:
    """Print debug timing log if enabled."""
    if settings.debug_timing:
        print(msg)


def _split_note_lines(notes: str) -> list[str]:
    """Split notes into display lines consistent with frontend rendering."""
    normalized = (
        notes
        .replace("\r\n", "\n")
        .replace("\r", "\n")
    )
    normalized = re.sub(r"<br\s*/?>", "\n", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"</div>\s*<div>", "\n", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"<div>", "\n", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"</div>", "", normalized, flags=re.IGNORECASE)
    lines = normalized.split("\n")
    filtered: list[str] = []
    for line in lines:
        text_content = re.sub(r"<[^>]*>", "", line).strip()
        if text_content:
            filtered.append(line)
    return filtered


@router.get("", response_model=list[DayData])
async def get_days(
    start_date: date = Query(...),
    end_date: date = Query(...),
    include_events: bool = Query(default=False),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get days with meal notes for a date range. Events are optional."""
    # Fetch meal notes for date range (fast - from DB)
    t1 = time.time()
    meal_notes = (
        db.query(MealNote)
        .filter(MealNote.date >= start_date, MealNote.date <= end_date)
        .all()
    )
    t2 = time.time()
    _log(f"[DB] Query meal_notes ({start_date} to {end_date}) completed in {t2-t1:.3f}s, found {len(meal_notes)} notes")

    notes_by_date = {note.date: note for note in meal_notes}

    # Only fetch events if requested
    events = []
    if include_events:
        events = await fetch_ical_events(start_date, end_date)

    # Build response
    days: list[DayData] = []
    current = start_date
    while current <= end_date:
        day_events = get_events_for_date(events, current) if include_events else []
        meal_note = notes_by_date.get(current)

        days.append(
            DayData(
                date=current,
                events=day_events,
                meal_note=MealNoteSchema.model_validate(meal_note) if meal_note else None,
            )
        )
        current += timedelta(days=1)

    return days


@router.get("/events", response_model=dict[str, list[CalendarEvent]])
async def get_events(
    start_date: date = Query(...),
    end_date: date = Query(...),
    include_hidden: bool = Query(False),
    user: dict = Depends(get_current_user),
):
    """Get calendar events for a date range (separate endpoint for lazy loading)."""
    t1 = time.time()
    events = await fetch_ical_events(start_date, end_date, include_hidden=include_hidden)
    t2 = time.time()
    _log(f"[CalDAV] fetch_ical_events ({start_date} to {end_date}, include_hidden={include_hidden}) completed in {t2-t1:.3f}s")

    # Group events by date
    events_by_date: dict[str, list[CalendarEvent]] = {}
    current = start_date
    while current <= end_date:
        day_events = get_events_for_date(events, current)
        if day_events:
            events_by_date[current.isoformat()] = day_events
        current += timedelta(days=1)

    return events_by_date


@router.put("/{date}/notes", response_model=MealNoteSchema)
async def update_notes(
    date: date,
    update: MealNoteUpdate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update meal notes for a specific date."""
    t1 = time.time()

    # Find or create meal note
    meal_note = db.query(MealNote).filter(MealNote.date == date).first()

    # Capture old notes BEFORE updating for item reindexing
    old_notes = meal_note.notes if meal_note else ""

    if not meal_note:
        meal_note = MealNote(date=date, notes=update.notes)
        db.add(meal_note)
    else:
        meal_note.notes = update.notes

    # Sync meal items with lines (match frontend HTML line splitting)
    old_lines = _split_note_lines(old_notes) if old_notes else []
    new_lines = _split_note_lines(update.notes)

    # Build a mapping of old line content to its itemized status
    old_items = {item.line_index: item for item in meal_note.items}
    old_line_to_itemized: dict[str, bool] = {}
    for idx, line in enumerate(old_lines):
        # Strip HTML and normalize for comparison
        line_text = re.sub(r"<[^>]*>", "", line).strip().lower()
        if idx in old_items:
            old_line_to_itemized[line_text] = old_items[idx].itemized

    # Delete all existing items - we'll recreate with correct indices
    for item in list(meal_note.items):
        db.delete(item)
    db.flush()

    # Create new items with correct indices, preserving itemized status by content match
    for i, line in enumerate(new_lines):
        line_text = re.sub(r"<[^>]*>", "", line).strip().lower()
        # Try to find matching content from old lines to preserve itemized status
        itemized = old_line_to_itemized.get(line_text, False)
        new_item = MealItem(meal_note=meal_note, line_index=i, itemized=itemized)
        db.add(new_item)

    db.commit()
    db.refresh(meal_note)

    t2 = time.time()
    _log(f"[DB] Update notes for {date} completed in {t2-t1:.3f}s")

    schema = MealNoteSchema.model_validate(meal_note)
    await broadcast_event(
        "notes.updated",
        {
            "date": str(date),
            "meal_note": schema.model_dump(mode="json"),
        },
    )
    return schema


@router.patch("/{date}/items/{line_index}", response_model=MealItemSchema)
async def toggle_item(
    date: date,
    line_index: int,
    toggle: MealItemToggle,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Toggle itemized state for a meal item."""
    t1 = time.time()

    meal_note = db.query(MealNote).filter(MealNote.date == date).first()

    if not meal_note:
        # Create meal note if it doesn't exist
        meal_note = MealNote(date=date, notes="")
        db.add(meal_note)
        db.flush()

    # Find or create item
    item = (
        db.query(MealItem)
        .filter(MealItem.meal_note_id == meal_note.id, MealItem.line_index == line_index)
        .first()
    )

    if not item:
        item = MealItem(meal_note=meal_note, line_index=line_index, itemized=toggle.itemized)
        db.add(item)
    else:
        item.itemized = toggle.itemized

    db.commit()
    db.refresh(item)

    t2 = time.time()
    _log(f"[DB] Toggle item {date}:{line_index} completed in {t2-t1:.3f}s")

    schema = MealItemSchema.model_validate(item)
    await broadcast_event(
        "item.updated",
        {
            "date": str(date),
            "line_index": schema.line_index,
            "itemized": schema.itemized,
        },
    )
    return schema
