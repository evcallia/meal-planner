"""Tests for cleanup_old_data() in app.main."""
from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest

from app import main as main_module
from app.main import cleanup_old_data
from app.models import CachedCalendarEvent, MealNote


def test_cleanup_uses_retention_setting_for_meal_notes(db_session, monkeypatch):
    monkeypatch.setattr(main_module.settings, "meal_history_retention_days", 100)
    old_note = MealNote(date=date.today() - timedelta(days=101), notes="too old")
    kept_note = MealNote(date=date.today() - timedelta(days=99), notes="kept")
    db_session.add_all([old_note, kept_note])
    db_session.commit()

    with patch("app.main.SessionLocal", return_value=db_session):
        cleanup_old_data()

    # After cleanup, query through same session
    db_session.expire_all()
    remaining = {n.notes for n in db_session.query(MealNote).all()}
    assert remaining == {"kept"}


def test_cleanup_keeps_30_day_cutoff_for_cached_events(db_session, monkeypatch):
    monkeypatch.setattr(main_module.settings, "meal_history_retention_days", 365)
    old_event_date = date.today() - timedelta(days=31)
    kept_event_date = date.today() - timedelta(days=29)
    for event_date, title in [(old_event_date, "old"), (kept_event_date, "kept")]:
        db_session.add(CachedCalendarEvent(
            event_date=event_date,
            event_uid=f"uid-{title}",
            calendar_name="Personal",
            title=title,
            start_time=datetime.combine(event_date, datetime.min.time()),
            end_time=datetime.combine(event_date, datetime.max.time()),
            all_day=True,
        ))
    db_session.commit()

    with patch("app.main.SessionLocal", return_value=db_session):
        cleanup_old_data()

    db_session.expire_all()
    remaining = {e.title for e in db_session.query(CachedCalendarEvent).all()}
    assert remaining == {"kept"}
