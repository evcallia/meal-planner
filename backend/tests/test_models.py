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