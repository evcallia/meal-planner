import pytest
from datetime import date, datetime
from pydantic import ValidationError

from app.schemas import (
    MealNoteSchema, MealNoteUpdate, MealItemSchema, MealItemToggle,
    DayData, CalendarEvent
)


class TestSchemas:
    """Test Pydantic schemas for validation and serialization."""

    def test_meal_note_schema_valid(self):
        """Test MealNoteSchema with valid data."""
        data = {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "date": "2024-02-15",
            "notes": "<p>Breakfast: Oatmeal</p>",
            "items": [],
            "updated_at": "2024-02-15T10:30:00Z"
        }
        
        schema = MealNoteSchema(**data)
        assert str(schema.id) == "123e4567-e89b-12d3-a456-426614174000"
        assert schema.date == date(2024, 2, 15)
        assert schema.notes == "<p>Breakfast: Oatmeal</p>"
        assert schema.items == []

    def test_meal_note_schema_with_items(self):
        """Test MealNoteSchema with meal items."""
        data = {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "date": "2024-02-15",
            "notes": "<p>Breakfast: Oatmeal</p>",
            "items": [
                {"line_index": 0, "itemized": True},
                {"line_index": 1, "itemized": False}
            ],
            "updated_at": "2024-02-15T10:30:00Z"
        }
        
        schema = MealNoteSchema(**data)
        assert len(schema.items) == 2
        assert schema.items[0].line_index == 0
        assert schema.items[0].itemized is True
        assert schema.items[1].line_index == 1
        assert schema.items[1].itemized is False

    def test_meal_note_schema_invalid_uuid(self):
        """Test MealNoteSchema with invalid UUID."""
        data = {
            "id": "invalid-uuid",
            "date": "2024-02-15",
            "notes": "test",
            "items": []
        }
        
        with pytest.raises(ValidationError):
            MealNoteSchema(**data)

    def test_meal_note_schema_invalid_date(self):
        """Test MealNoteSchema with invalid date."""
        data = {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "date": "invalid-date",
            "notes": "test",
            "items": []
        }
        
        with pytest.raises(ValidationError):
            MealNoteSchema(**data)

    def test_meal_note_update_valid(self):
        """Test MealNoteUpdate schema."""
        data = {"notes": "<p>Updated notes</p>"}
        schema = MealNoteUpdate(**data)
        assert schema.notes == "<p>Updated notes</p>"

    def test_meal_note_update_empty_notes(self):
        """Test MealNoteUpdate with empty notes."""
        data = {"notes": ""}
        schema = MealNoteUpdate(**data)
        assert schema.notes == ""

    def test_meal_item_schema_valid(self):
        """Test MealItemSchema with valid data."""
        data = {"line_index": 0, "itemized": True}
        schema = MealItemSchema(**data)
        assert schema.line_index == 0
        assert schema.itemized is True

    def test_meal_item_schema_defaults(self):
        """Test MealItemSchema with required fields."""
        data = {"line_index": 0, "itemized": False}
        schema = MealItemSchema(**data)
        assert schema.line_index == 0
        assert schema.itemized is False

    def test_meal_item_schema_invalid_line_index(self):
        """Test MealItemSchema with invalid line index."""
        data = {"line_index": -1, "itemized": True}
        
        with pytest.raises(ValidationError):
            MealItemSchema(**data)

    def test_meal_item_toggle_valid(self):
        """Test MealItemToggle schema."""
        data = {"itemized": True}
        schema = MealItemToggle(**data)
        assert schema.itemized is True

    def test_meal_item_toggle_invalid(self):
        """Test MealItemToggle with invalid data."""        
        # Missing required fields
        with pytest.raises(ValidationError):
            MealItemToggle()

    def test_calendar_event_schema_valid(self):
        """Test CalendarEvent schema with valid data."""
        data = {
            "id": "event-1",
            "title": "Dinner with friends",
            "start_time": "2024-02-15T19:00:00Z",
            "all_day": False
        }
        
        schema = CalendarEvent(**data)
        assert schema.title == "Dinner with friends"
        assert schema.start_time == datetime(2024, 2, 15, 19, 0, 0).replace(tzinfo=schema.start_time.tzinfo)
        assert schema.all_day is False

    def test_calendar_event_all_day(self):
        """Test CalendarEvent with all-day event."""
        data = {
            "id": "event-2",
            "title": "Birthday",
            "start_time": "2024-02-15T00:00:00Z",
            "all_day": True
        }
        
        schema = CalendarEvent(**data)
        assert schema.title == "Birthday"
        assert schema.all_day is True

    def test_calendar_event_missing_title(self):
        """Test CalendarEvent with missing title."""
        data = {
            "id": "event-3",
            "start_time": "2024-02-15T19:00:00Z",
            "all_day": False
        }
        
        with pytest.raises(ValidationError):
            CalendarEvent(**data)

    def test_day_data_schema_complete(self):
        """Test DayData schema with complete data."""
        data = {
            "date": "2024-02-15",
            "meal_note": {
                "id": "123e4567-e89b-12d3-a456-426614174000",
                "date": "2024-02-15",
                "notes": "<p>Test</p>",
                "items": [{"line_index": 0, "itemized": True}],
                "updated_at": "2024-02-15T10:30:00Z"
            },
            "events": [
                {
                    "id": "event-4",
                    "title": "Meeting",
                    "start_time": "2024-02-15T10:00:00Z",
                    "all_day": False
                }
            ]
        }
        
        schema = DayData(**data)
        assert schema.date == date(2024, 2, 15)
        assert schema.meal_note is not None
        assert schema.meal_note.notes == "<p>Test</p>"
        assert len(schema.events) == 1
        assert schema.events[0].title == "Meeting"

    def test_day_data_schema_minimal(self):
        """Test DayData schema with minimal data."""
        data = {
            "date": "2024-02-15",
            "meal_note": None,
            "events": []
        }
        
        schema = DayData(**data)
        assert schema.date == date(2024, 2, 15)
        assert schema.meal_note is None
        assert schema.events == []

    def test_day_data_schema_invalid_date(self):
        """Test DayData schema with invalid date."""
        data = {
            "date": "not-a-date",
            "meal_note": None,
            "events": []
        }
        
        with pytest.raises(ValidationError):
            DayData(**data)

    def test_schema_json_serialization(self):
        """Test that schemas can be serialized to JSON."""
        day_data = DayData(
            date=date(2024, 2, 15),
            meal_note=None,
            events=[
                CalendarEvent(
                    id="event-5",
                    title="Test Event",
                    start_time="2024-02-15T10:00:00Z",
                    all_day=False
                )
            ]
        )
        
        # Should be able to serialize to dict
        data_dict = day_data.model_dump()
        assert data_dict["date"] == date(2024, 2, 15)
        assert data_dict["meal_note"] is None
        assert len(data_dict["events"]) == 1
        assert data_dict["events"][0]["title"] == "Test Event"

    def test_schema_from_orm_model(self):
        """Test creating schema from ORM model data."""
        # This would typically be done with actual ORM models
        # Here we simulate the structure
        meal_note_data = {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "date": date(2024, 2, 15),
            "notes": "<p>Test notes</p>",
            "items": [],
            "updated_at": datetime(2024, 2, 15, 10, 30, 0)
        }
        
        schema = MealNoteSchema(**meal_note_data)
        assert schema.date == date(2024, 2, 15)
        assert schema.notes == "<p>Test notes</p>"

    def test_nested_validation_errors(self):
        """Test validation errors in nested schemas."""
        data = {
            "date": "2024-02-15",
            "meal_note": {
                "id": "invalid-uuid",  # This should cause validation error
                "date": "2024-02-15",
                "notes": "test",
                "items": []
            },
            "events": []
        }
        
        with pytest.raises(ValidationError) as exc_info:
            DayData(**data)
        
        # Should contain information about the nested validation error
        error_details = exc_info.value.errors()
        assert any("meal_note" in str(error) for error in error_details)
