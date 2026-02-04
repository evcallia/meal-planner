import pytest
from datetime import date, datetime
import uuid
from sqlalchemy.orm import Session

from app.models import MealNote, MealItem


class TestMealNote:
    """Test the MealNote model."""

    def test_create_meal_note(self, db_session: Session):
        """Test creating a meal note."""
        test_date = date(2024, 2, 15)
        notes = "<p>Breakfast: Eggs</p>"
        
        meal_note = MealNote(date=test_date, notes=notes)
        db_session.add(meal_note)
        db_session.commit()
        db_session.refresh(meal_note)
        
        assert meal_note.id is not None
        assert isinstance(meal_note.id, uuid.UUID)
        assert meal_note.date == test_date
        assert meal_note.notes == notes
        assert meal_note.created_at is not None
        assert meal_note.updated_at is not None
        assert isinstance(meal_note.created_at, datetime)
        assert isinstance(meal_note.updated_at, datetime)

    def test_meal_note_defaults(self, db_session: Session):
        """Test meal note default values."""
        meal_note = MealNote(date=date(2024, 2, 15))
        db_session.add(meal_note)
        db_session.commit()
        db_session.refresh(meal_note)
        
        assert meal_note.notes == ""
        assert meal_note.created_at is not None
        assert meal_note.updated_at is not None

    def test_meal_note_unique_date(self, db_session: Session):
        """Test that meal notes have unique dates."""
        test_date = date(2024, 2, 15)
        
        # Create first meal note
        meal_note1 = MealNote(date=test_date, notes="First note")
        db_session.add(meal_note1)
        db_session.commit()
        
        # Try to create second meal note with same date
        meal_note2 = MealNote(date=test_date, notes="Second note")
        db_session.add(meal_note2)
        
        with pytest.raises(Exception):  # Should raise integrity error
            db_session.commit()

    def test_meal_note_relationships(self, db_session: Session):
        """Test meal note to meal items relationship."""
        meal_note = MealNote(date=date(2024, 2, 15), notes="Test notes")
        db_session.add(meal_note)
        db_session.commit()
        db_session.refresh(meal_note)
        
        # Initially no items
        assert len(meal_note.items) == 0
        
        # Add meal items
        item1 = MealItem(meal_note_id=meal_note.id, line_index=0, itemized=True)
        item2 = MealItem(meal_note_id=meal_note.id, line_index=1, itemized=False)
        db_session.add_all([item1, item2])
        db_session.commit()
        
        # Refresh and check relationship
        db_session.refresh(meal_note)
        assert len(meal_note.items) == 2
        assert meal_note.items[0].line_index in [0, 1]
        assert meal_note.items[1].line_index in [0, 1]

    def test_meal_note_cascade_delete(self, db_session: Session):
        """Test that deleting meal note cascades to items."""
        meal_note = MealNote(date=date(2024, 2, 15), notes="Test notes")
        db_session.add(meal_note)
        db_session.commit()
        db_session.refresh(meal_note)
        
        # Add meal items
        item1 = MealItem(meal_note_id=meal_note.id, line_index=0, itemized=True)
        item2 = MealItem(meal_note_id=meal_note.id, line_index=1, itemized=False)
        db_session.add_all([item1, item2])
        db_session.commit()
        
        # Verify items exist
        items_count = db_session.query(MealItem).filter_by(meal_note_id=meal_note.id).count()
        assert items_count == 2
        
        # Delete meal note
        db_session.delete(meal_note)
        db_session.commit()
        
        # Verify items are also deleted (cascade)
        items_count = db_session.query(MealItem).filter_by(meal_note_id=meal_note.id).count()
        assert items_count == 0


class TestMealItem:
    """Test the MealItem model."""

    def test_create_meal_item(self, db_session: Session, sample_meal_note: MealNote):
        """Test creating a meal item."""
        line_index = 0
        itemized = True
        
        meal_item = MealItem(
            meal_note_id=sample_meal_note.id,
            line_index=line_index,
            itemized=itemized
        )
        db_session.add(meal_item)
        db_session.commit()
        db_session.refresh(meal_item)
        
        assert meal_item.id is not None
        assert isinstance(meal_item.id, uuid.UUID)
        assert meal_item.meal_note_id == sample_meal_note.id
        assert meal_item.line_index == line_index
        assert meal_item.itemized == itemized
        assert meal_item.created_at is not None
        assert isinstance(meal_item.created_at, datetime)

    def test_meal_item_defaults(self, db_session: Session, sample_meal_note: MealNote):
        """Test meal item default values."""
        meal_item = MealItem(meal_note_id=sample_meal_note.id, line_index=0)
        db_session.add(meal_item)
        db_session.commit()
        db_session.refresh(meal_item)
        
        assert meal_item.itemized is False  # Default value
        assert meal_item.created_at is not None

    def test_meal_item_relationship(self, db_session: Session, sample_meal_note: MealNote):
        """Test meal item to meal note relationship."""
        meal_item = MealItem(
            meal_note_id=sample_meal_note.id,
            line_index=0,
            itemized=True
        )
        db_session.add(meal_item)
        db_session.commit()
        db_session.refresh(meal_item)
        
        # Test back reference
        assert meal_item.meal_note is not None
        assert meal_item.meal_note.id == sample_meal_note.id
        assert meal_item.meal_note.date == sample_meal_note.date

    def test_meal_item_multiple_per_note(self, db_session: Session, sample_meal_note: MealNote):
        """Test multiple meal items per note."""
        items = [
            MealItem(meal_note_id=sample_meal_note.id, line_index=0, itemized=True),
            MealItem(meal_note_id=sample_meal_note.id, line_index=1, itemized=False),
            MealItem(meal_note_id=sample_meal_note.id, line_index=2, itemized=True),
        ]
        
        db_session.add_all(items)
        db_session.commit()
        
        # Query all items for this note
        saved_items = (
            db_session.query(MealItem)
            .filter_by(meal_note_id=sample_meal_note.id)
            .order_by(MealItem.line_index)
            .all()
        )
        
        assert len(saved_items) == 3
        assert saved_items[0].line_index == 0
        assert saved_items[0].itemized is True
        assert saved_items[1].line_index == 1
        assert saved_items[1].itemized is False
        assert saved_items[2].line_index == 2
        assert saved_items[2].itemized is True

    def test_meal_item_foreign_key_constraint(self, db_session: Session):
        """Test that meal items require valid meal note ID."""
        # Try to create meal item with non-existent meal note ID
        fake_id = uuid.uuid4()
        meal_item = MealItem(meal_note_id=fake_id, line_index=0)
        db_session.add(meal_item)

        with pytest.raises(Exception):  # Should raise foreign key constraint error
            db_session.commit()


class TestCachedCalendarEvent:
    """Test the CachedCalendarEvent model."""

    def test_create_cached_event(self, db_session: Session):
        """Test creating a cached calendar event."""
        from app.models import CachedCalendarEvent

        event = CachedCalendarEvent(
            event_date=date(2024, 2, 15),
            title="Test Event",
            start_time=datetime(2024, 2, 15, 10, 0, 0),
            end_time=datetime(2024, 2, 15, 11, 0, 0),
            all_day=False
        )
        db_session.add(event)
        db_session.commit()
        db_session.refresh(event)

        assert event.id is not None
        assert isinstance(event.id, uuid.UUID)
        assert event.event_date == date(2024, 2, 15)
        assert event.title == "Test Event"
        assert event.start_time == datetime(2024, 2, 15, 10, 0, 0)
        assert event.end_time == datetime(2024, 2, 15, 11, 0, 0)
        assert event.all_day is False
        assert event.created_at is not None

    def test_cached_event_all_day(self, db_session: Session):
        """Test creating an all-day cached event."""
        from app.models import CachedCalendarEvent

        event = CachedCalendarEvent(
            event_date=date(2024, 2, 15),
            title="All Day Event",
            start_time=datetime(2024, 2, 15, 0, 0, 0),
            end_time=None,
            all_day=True
        )
        db_session.add(event)
        db_session.commit()
        db_session.refresh(event)

        assert event.all_day is True
        assert event.end_time is None

    def test_cached_events_multiple_per_day(self, db_session: Session):
        """Test multiple cached events for the same day."""
        from app.models import CachedCalendarEvent

        events = [
            CachedCalendarEvent(
                event_date=date(2024, 2, 15),
                title="Event 1",
                start_time=datetime(2024, 2, 15, 9, 0, 0),
                all_day=False
            ),
            CachedCalendarEvent(
                event_date=date(2024, 2, 15),
                title="Event 2",
                start_time=datetime(2024, 2, 15, 14, 0, 0),
                all_day=False
            ),
            CachedCalendarEvent(
                event_date=date(2024, 2, 15),
                title="Event 3",
                start_time=datetime(2024, 2, 15, 18, 0, 0),
                all_day=False
            ),
        ]

        db_session.add_all(events)
        db_session.commit()

        # Query events for this date
        saved_events = (
            db_session.query(CachedCalendarEvent)
            .filter_by(event_date=date(2024, 2, 15))
            .order_by(CachedCalendarEvent.start_time)
            .all()
        )

        assert len(saved_events) == 3
        assert saved_events[0].title == "Event 1"
        assert saved_events[1].title == "Event 2"
        assert saved_events[2].title == "Event 3"

    def test_cached_event_date_index(self, db_session: Session):
        """Test that event_date is indexed for efficient querying."""
        from app.models import CachedCalendarEvent

        # Add events on different dates
        for i in range(10):
            event = CachedCalendarEvent(
                event_date=date(2024, 2, i + 1),
                title=f"Event {i}",
                start_time=datetime(2024, 2, i + 1, 10, 0, 0),
                all_day=False
            )
            db_session.add(event)
        db_session.commit()

        # Query specific date (would use index)
        results = (
            db_session.query(CachedCalendarEvent)
            .filter_by(event_date=date(2024, 2, 5))
            .all()
        )

        assert len(results) == 1
        assert results[0].title == "Event 4"


class TestCalendarCacheMetadata:
    """Test the CalendarCacheMetadata model."""

    def test_create_metadata(self, db_session: Session):
        """Test creating cache metadata."""
        from app.models import CalendarCacheMetadata

        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime(2024, 2, 15, 12, 0, 0),
            cache_start=date(2024, 1, 15),
            cache_end=date(2024, 4, 15)
        )
        db_session.add(metadata)
        db_session.commit()
        db_session.refresh(metadata)

        assert metadata.id == 1
        assert metadata.last_refresh == datetime(2024, 2, 15, 12, 0, 0)
        assert metadata.cache_start == date(2024, 1, 15)
        assert metadata.cache_end == date(2024, 4, 15)

    def test_metadata_nullable_fields(self, db_session: Session):
        """Test metadata with null fields."""
        from app.models import CalendarCacheMetadata

        metadata = CalendarCacheMetadata(id=1)
        db_session.add(metadata)
        db_session.commit()
        db_session.refresh(metadata)

        assert metadata.last_refresh is None
        assert metadata.cache_start is None
        assert metadata.cache_end is None

    def test_metadata_update(self, db_session: Session):
        """Test updating cache metadata."""
        from app.models import CalendarCacheMetadata

        # Create initial metadata
        metadata = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime(2024, 2, 15, 12, 0, 0),
            cache_start=date(2024, 1, 15),
            cache_end=date(2024, 4, 15)
        )
        db_session.add(metadata)
        db_session.commit()

        # Update metadata
        metadata.last_refresh = datetime(2024, 2, 16, 12, 0, 0)
        metadata.cache_start = date(2024, 1, 16)
        metadata.cache_end = date(2024, 4, 16)
        db_session.commit()
        db_session.refresh(metadata)

        assert metadata.last_refresh == datetime(2024, 2, 16, 12, 0, 0)
        assert metadata.cache_start == date(2024, 1, 16)
        assert metadata.cache_end == date(2024, 4, 16)

    def test_metadata_singleton(self, db_session: Session):
        """Test that only one metadata record exists (singleton pattern)."""
        from app.models import CalendarCacheMetadata

        # Create first metadata
        metadata1 = CalendarCacheMetadata(
            id=1,
            last_refresh=datetime.utcnow()
        )
        db_session.add(metadata1)
        db_session.commit()

        # Query should return single record
        all_metadata = db_session.query(CalendarCacheMetadata).all()
        assert len(all_metadata) == 1