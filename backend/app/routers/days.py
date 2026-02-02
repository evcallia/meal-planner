from datetime import date, timedelta
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import MealNote, MealItem
from app.schemas import DayData, MealNoteSchema, MealNoteUpdate, MealItemToggle, MealItemSchema
from app.ical_service import fetch_ical_events, get_events_for_date
from app.auth import get_current_user

router = APIRouter(prefix="/api/days", tags=["days"])


@router.get("", response_model=list[DayData])
async def get_days(
    start_date: date = Query(...),
    end_date: date = Query(...),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Get days with events and meal notes for a date range."""
    # Fetch iCal events
    events = await fetch_ical_events(start_date, end_date)

    # Fetch meal notes for date range
    meal_notes = (
        db.query(MealNote)
        .filter(MealNote.date >= start_date, MealNote.date <= end_date)
        .all()
    )
    notes_by_date = {note.date: note for note in meal_notes}

    # Build response
    days: list[DayData] = []
    current = start_date
    while current <= end_date:
        day_events = get_events_for_date(events, current)
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


@router.put("/{date}/notes", response_model=MealNoteSchema)
async def update_notes(
    date: date,
    update: MealNoteUpdate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Update meal notes for a specific date."""
    # Find or create meal note
    meal_note = db.query(MealNote).filter(MealNote.date == date).first()

    if not meal_note:
        meal_note = MealNote(date=date, notes=update.notes)
        db.add(meal_note)
    else:
        meal_note.notes = update.notes

    # Sync meal items with lines
    lines = [l for l in update.notes.split("\n") if l.strip()]
    existing_items = {item.line_index: item for item in meal_note.items}

    # Remove items for lines that no longer exist
    for item in list(meal_note.items):
        if item.line_index >= len(lines):
            db.delete(item)

    # Ensure items exist for all lines (preserve itemized state)
    for i, line in enumerate(lines):
        if i not in existing_items:
            new_item = MealItem(meal_note=meal_note, line_index=i, itemized=False)
            db.add(new_item)

    db.commit()
    db.refresh(meal_note)

    return MealNoteSchema.model_validate(meal_note)


@router.patch("/{date}/items/{line_index}", response_model=MealItemSchema)
async def toggle_item(
    date: date,
    line_index: int,
    toggle: MealItemToggle,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Toggle itemized state for a meal item."""
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

    return MealItemSchema.model_validate(item)
