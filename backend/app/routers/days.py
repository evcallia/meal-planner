from datetime import date, timedelta
import time
import re
import difflib
from fastapi import APIRouter, Depends, Query, Request
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
    normalized = re.sub(r"</p>\s*<p[^>]*>", "\n", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"<p[^>]*>", "\n", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"</p>", "", normalized, flags=re.IGNORECASE)
    lines = normalized.split("\n")
    filtered: list[str] = []
    for line in lines:
        text_content = re.sub(r"<[^>]*>", "", line).strip()
        if text_content:
            filtered.append(line)
    return filtered


def _normalize_line(line: str) -> str:
    return re.sub(r"<[^>]*>", "", line).strip().lower()


# Minimum text similarity for an edited line to keep its itemized state.
# A typo fix ("tacs" -> "tacos", 0.89) keeps the checkbox; a meal swap
# ("tacos" -> "tandoori", 0.46) resets it.
ITEMIZED_CARRY_SIMILARITY = 0.6


def _carry_itemized_state(
    old_lines: list[str], new_lines: list[str], old_itemized: dict[int, bool]
) -> list[bool]:
    """Map itemized state from old line positions to new line positions.

    Sequence alignment handles unchanged lines, insertions, deletions, and
    in-place edits (positional pairing inside `replace` blocks, kept only when
    the edited text is similar enough to the original). A second
    content-matching pass over the leftovers handles moved/reordered lines.
    In-place edits are paired positionally within `replace` blocks; simultaneously editing and reordering two adjacent lines may swap their states.
    """
    old_norm = [_normalize_line(line) for line in old_lines]
    new_norm = [_normalize_line(line) for line in new_lines]
    result = [False] * len(new_norm)
    matched_old: set[int] = set()
    matched_new: set[int] = set()

    matcher = difflib.SequenceMatcher(a=old_norm, b=new_norm, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                result[j1 + k] = old_itemized.get(i1 + k, False)
                matched_old.add(i1 + k)
                matched_new.add(j1 + k)
        elif tag == "replace":
            for k in range(min(i2 - i1, j2 - j1)):
                similarity = difflib.SequenceMatcher(
                    a=old_norm[i1 + k], b=new_norm[j1 + k], autojunk=False
                ).ratio()
                if similarity < ITEMIZED_CARRY_SIMILARITY:
                    # The line was rewritten into something else, not edited —
                    # leave both sides for the content-match pass / reset
                    continue
                result[j1 + k] = old_itemized.get(i1 + k, False)
                matched_old.add(i1 + k)
                matched_new.add(j1 + k)

    remaining_old: dict[str, list[int]] = {}
    for i, text in enumerate(old_norm):
        if i not in matched_old:
            remaining_old.setdefault(text, []).append(i)
    for j, text in enumerate(new_norm):
        if j in matched_new:
            continue
        candidates = remaining_old.get(text)
        if candidates:
            result[j] = old_itemized.get(candidates.pop(0), False)

    return result


@router.get("", response_model=list[DayData])
async def get_days(
    start_date: date = Query(...),
    end_date: date = Query(...),
    include_events: bool = Query(default=False),
    include_holidays: bool = Query(default=True),
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
        events = await fetch_ical_events(start_date, end_date, include_holidays=include_holidays)

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
    include_holidays: bool = Query(True),
    user: dict = Depends(get_current_user),
):
    """Get calendar events for a date range (separate endpoint for lazy loading)."""
    t1 = time.time()
    events = await fetch_ical_events(start_date, end_date, include_hidden=include_hidden, include_holidays=include_holidays)
    t2 = time.time()
    _log(f"[CalDAV] fetch_ical_events ({start_date} to {end_date}, include_hidden={include_hidden}, include_holidays={include_holidays}) completed in {t2-t1:.3f}s")

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
    request: Request,
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
    new_lines = _split_note_lines(update.notes) if update.notes else []

    old_itemized = {item.line_index: item.itemized for item in meal_note.items}
    itemized_by_index = _carry_itemized_state(old_lines, new_lines, old_itemized)

    # Delete all existing items - we'll recreate with correct indices
    for item in list(meal_note.items):
        db.delete(item)
    db.flush()

    for i in range(len(new_lines)):
        db.add(MealItem(meal_note=meal_note, line_index=i, itemized=itemized_by_index[i]))

    db.commit()
    db.refresh(meal_note)

    t2 = time.time()
    _log(f"[DB] Update notes for {date} completed in {t2-t1:.3f}s")

    schema = MealNoteSchema.model_validate(meal_note)
    source_id = request.headers.get("x-source-id")
    await broadcast_event(
        "notes.updated",
        {
            "date": str(date),
            "meal_note": schema.model_dump(mode="json"),
        },
        source_id=source_id,
    )
    return schema


@router.patch("/{date}/items/{line_index}", response_model=MealItemSchema)
async def toggle_item(
    date: date,
    line_index: int,
    toggle: MealItemToggle,
    request: Request,
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
    source_id = request.headers.get("x-source-id")
    await broadcast_event(
        "item.updated",
        {
            "date": str(date),
            "line_index": schema.line_index,
            "itemized": schema.itemized,
        },
        source_id=source_id,
    )
    return schema
