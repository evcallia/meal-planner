import pytest
from datetime import date, timedelta
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from unittest.mock import patch, AsyncMock

from app.models import MealNote, MealItem, PantrySection, PantryItem, MealIdea, GrocerySection, GroceryItem, ItemDefault, Store
from app.schemas import CalendarEvent


class TestDaysAPI:
    """Test the days API endpoints."""

    def test_get_days_empty(self, authenticated_client: TestClient):
        """Test getting days when no meal notes exist."""
        response = authenticated_client.get("/api/days?start_date=2024-02-15&end_date=2024-02-17")
        
        assert response.status_code == 200
        data = response.json()
        
        assert len(data) == 3  # 3 days requested
        assert data[0]["date"] == "2024-02-15"
        assert data[1]["date"] == "2024-02-16"
        assert data[2]["date"] == "2024-02-17"
        
        # All should have no meal notes or events
        for day in data:
            assert day["meal_note"] is None
            assert day["events"] == []

    def test_get_days_with_meal_notes(self, authenticated_client: TestClient, db_session: Session):
        """Test getting days with existing meal notes."""
        # Create test meal notes
        note1 = MealNote(date=date(2024, 2, 15), notes="<p>Breakfast: Oatmeal</p>")
        note2 = MealNote(date=date(2024, 2, 16), notes="<p>Lunch: Sandwich</p>")
        db_session.add_all([note1, note2])
        db_session.commit()
        db_session.refresh(note1)
        db_session.refresh(note2)
        
        # Add meal items
        item1 = MealItem(meal_note_id=note1.id, line_index=0, itemized=True)
        item2 = MealItem(meal_note_id=note2.id, line_index=0, itemized=False)
        db_session.add_all([item1, item2])
        db_session.commit()
        
        
        response = authenticated_client.get("/api/days?start_date=2024-02-15&end_date=2024-02-17")
            
        assert response.status_code == 200
        data = response.json()
        
        assert len(data) == 3
        
        # First day should have meal note
        day1 = next(d for d in data if d["date"] == "2024-02-15")
        assert day1["meal_note"] is not None
        assert day1["meal_note"]["notes"] == "<p>Breakfast: Oatmeal</p>"
        assert len(day1["meal_note"]["items"]) == 1
        assert day1["meal_note"]["items"][0]["line_index"] == 0
        assert day1["meal_note"]["items"][0]["itemized"] is True
        
        # Second day should have meal note
        day2 = next(d for d in data if d["date"] == "2024-02-16")
        assert day2["meal_note"] is not None
        assert day2["meal_note"]["notes"] == "<p>Lunch: Sandwich</p>"
        
        # Third day should be empty
        day3 = next(d for d in data if d["date"] == "2024-02-17")
        assert day3["meal_note"] is None

    @patch("app.routers.days.fetch_ical_events")
    def test_get_days_with_events(self, mock_fetch_events, authenticated_client: TestClient):
        """Test getting days with calendar events."""
        # Mock calendar events
        mock_events = [
            CalendarEvent(
                id="event-1",
                title="Dinner with friends",
                start_time="2024-02-15T19:00:00Z",
                all_day=False
            )
        ]
        mock_fetch_events.return_value = mock_events
        
        response = authenticated_client.get("/api/days?start_date=2024-02-15&end_date=2024-02-15&include_events=true")
            
        assert response.status_code == 200
        data = response.json()
        
        assert len(data) == 1
        day = data[0]
        assert len(day["events"]) == 1
        assert day["events"][0]["title"] == "Dinner with friends"
        assert day["events"][0]["start_time"] == "2024-02-15T19:00:00Z"
        assert day["events"][0]["all_day"] is False
        
        mock_fetch_events.assert_called_once_with(date(2024, 2, 15), date(2024, 2, 15))

    def test_get_days_invalid_date_range(self, authenticated_client: TestClient):
        """Test getting days with invalid date parameters."""
        response = authenticated_client.get("/api/days?start_date=invalid&end_date=2024-02-17")
            
        assert response.status_code == 422  # Validation error

    def test_get_days_without_authentication(self, client: TestClient):
        """Test that days endpoint requires authentication."""
        response = client.get("/api/days?start_date=2024-02-15&end_date=2024-02-17")
        
        assert response.status_code == 401  # Unauthorized

    def test_update_meal_note_create_new(self, authenticated_client: TestClient, db_session: Session):
        """Test creating a new meal note via update endpoint."""
        test_date = "2024-02-15"
        test_notes = "<p>New meal notes</p>"
        
        response = authenticated_client.put(
            f"/api/days/{test_date}/notes",
            json={"notes": test_notes}
        )
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["date"] == test_date
        assert data["notes"] == test_notes
        assert len(data["items"]) == 1  # One line creates one item
        assert data["items"][0]["line_index"] == 0
        assert data["items"][0]["itemized"] is False  # Default itemized state
        
        # Verify in database
        meal_note = db_session.query(MealNote).filter_by(date=date(2024, 2, 15)).first()
        assert meal_note is not None
        assert meal_note.notes == test_notes

    def test_update_meal_note_html_lines_create_items(self, authenticated_client: TestClient):
        """Ensure HTML line breaks create matching item indices."""
        test_date = "2024-02-18"
        test_notes = "<div>Breakfast</div><div>Dinner</div>"

        response = authenticated_client.put(
            f"/api/days/{test_date}/notes",
            json={"notes": test_notes}
        )

        assert response.status_code == 200
        data = response.json()

        assert data["date"] == test_date
        assert len(data["items"]) == 2
        assert data["items"][0]["line_index"] == 0
        assert data["items"][1]["line_index"] == 1

    @patch("app.routers.days.broadcast_event", new_callable=AsyncMock)
    def test_update_meal_note_broadcasts(self, mock_broadcast, authenticated_client: TestClient):
        test_date = "2024-02-19"
        test_notes = "<div>Breakfast</div>"

        response = authenticated_client.put(
            f"/api/days/{test_date}/notes",
            json={"notes": test_notes}
        )

        assert response.status_code == 200
        mock_broadcast.assert_awaited()

    def test_update_meal_note_modify_existing(self, authenticated_client: TestClient, db_session: Session, sample_meal_note: MealNote):
        """Test modifying existing meal note."""
        new_notes = "<p>Updated meal notes</p>"
        
        response = authenticated_client.put(
            f"/api/days/{sample_meal_note.date}/notes",
            json={"notes": new_notes}
        )
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["date"] == str(sample_meal_note.date)
        assert data["notes"] == new_notes
        
        # Verify in database
        db_session.refresh(sample_meal_note)
        assert sample_meal_note.notes == new_notes

    def test_toggle_meal_item_new_item(self, authenticated_client: TestClient, db_session: Session, sample_meal_note: MealNote):
        """Test toggling itemized status for new item."""
        response = authenticated_client.patch(
            f"/api/days/{sample_meal_note.date}/items/5",
            json={"itemized": True}
        )
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["line_index"] == 5
        assert data["itemized"] is True
        
        # Verify in database
        meal_item = db_session.query(MealItem).filter_by(
            meal_note_id=sample_meal_note.id,
            line_index=5
        ).first()
        assert meal_item is not None
        assert meal_item.itemized is True

    def test_toggle_meal_item_existing_item(self, authenticated_client: TestClient, db_session: Session, sample_meal_items: list[MealItem], sample_meal_note: MealNote):
        """Test toggling itemized status for existing item."""
        existing_item = sample_meal_items[0]
        original_status = existing_item.itemized
        
        response = authenticated_client.patch(
            f"/api/days/{sample_meal_note.date}/items/{existing_item.line_index}",
            json={"itemized": not original_status}
        )
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["line_index"] == existing_item.line_index
        assert data["itemized"] is not original_status
        
        # Verify in database
        db_session.refresh(existing_item)
        assert existing_item.itemized is not original_status

    @patch("app.routers.days.broadcast_event", new_callable=AsyncMock)
    def test_toggle_meal_item_broadcasts(self, mock_broadcast, authenticated_client: TestClient, sample_meal_note: MealNote):
        response = authenticated_client.patch(
            f"/api/days/{sample_meal_note.date}/items/0",
            json={"itemized": True}
        )

        assert response.status_code == 200
        mock_broadcast.assert_awaited()

    def test_toggle_meal_item_no_meal_note(self, authenticated_client: TestClient):
        """Test toggling item when no meal note exists - should create both note and item."""
        response = authenticated_client.patch(
            "/api/days/2024-02-15/items/0",
            json={"itemized": True}
        )
            
        assert response.status_code == 200
        data = response.json()
        
        assert data["line_index"] == 0
        assert data["itemized"] is True

    def test_get_events_endpoint(self, authenticated_client: TestClient):
        """Test the dedicated events endpoint."""
        with patch("app.routers.days.fetch_ical_events") as mock_fetch:
            mock_fetch.return_value = [
                CalendarEvent(
                    id="event-2",
                    title="Test Event",
                    start_time="2024-02-15T10:00:00Z",
                    all_day=False
                )
            ]
            
            response = authenticated_client.get("/api/days/events?start_date=2024-02-15&end_date=2024-02-15")
                
        assert response.status_code == 200
        data = response.json()
        
        assert "2024-02-15" in data
        assert len(data["2024-02-15"]) == 1
        assert data["2024-02-15"][0]["title"] == "Test Event"

    def test_api_endpoints_require_authentication(self, client: TestClient, sample_meal_note: MealNote):
        """Test that all endpoints require authentication."""
        endpoints_and_methods = [
            ("GET", "/api/days?start_date=2024-02-15&end_date=2024-02-15"),
            ("PUT", f"/api/days/{sample_meal_note.date}/notes"),
            ("PATCH", f"/api/days/{sample_meal_note.date}/items/0"),
            ("GET", "/api/days/events?start_date=2024-02-15&end_date=2024-02-15"),
            ("GET", "/api/pantry"),
            ("POST", "/api/pantry/items"),
            ("PUT", "/api/pantry/items/00000000-0000-0000-0000-000000000000"),
            ("DELETE", "/api/pantry/items/00000000-0000-0000-0000-000000000000"),
            ("GET", "/api/meal-ideas"),
            ("POST", "/api/meal-ideas"),
            ("PUT", "/api/meal-ideas/00000000-0000-0000-0000-000000000000"),
            ("DELETE", "/api/meal-ideas/00000000-0000-0000-0000-000000000000"),
        ]
        
        for method, endpoint in endpoints_and_methods:
            if method == "GET":
                response = client.get(endpoint)
            elif method == "PUT":
                if endpoint.startswith("/api/pantry/items/"):
                    response = client.put(endpoint, json={"name": "test", "quantity": 1})
                elif endpoint.startswith("/api/meal-ideas/"):
                    response = client.put(endpoint, json={"title": "test"})
                else:
                    response = client.put(endpoint, json={"notes": "test"})
            elif method == "PATCH":
                response = client.patch(endpoint, json={"itemized": True})
            elif method == "POST":
                if endpoint == "/api/pantry/items":
                    response = client.post(endpoint, json={"section_id": "00000000-0000-0000-0000-000000000000", "name": "test", "quantity": 1})
                elif endpoint == "/api/meal-ideas":
                    response = client.post(endpoint, json={"title": "test"})
                else:
                    response = client.post(endpoint, json={})
            elif method == "DELETE":
                response = client.delete(endpoint)
                
            assert response.status_code == 401, f"Endpoint {method} {endpoint} should require auth"

    def test_large_date_ranges(self, authenticated_client: TestClient):
        """Test handling of large date ranges."""
        start_date = date.today()
        end_date = start_date + timedelta(days=365)  # 1 year range
        
        response = authenticated_client.get(f"/api/days?start_date={start_date}&end_date={end_date}")
            
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 366  # Including both start and end dates

    def test_update_meal_note_validation(self, authenticated_client: TestClient):
        """Test meal note update validation."""
        # Test missing notes field
        response = authenticated_client.put("/api/days/2024-02-15/notes", json={})
        assert response.status_code == 422
        
        # Test invalid date format
        response = authenticated_client.put("/api/days/invalid-date/notes", json={"notes": "test"})
        assert response.status_code == 422


class TestPantryAPI:
    def test_list_pantry_empty(self, authenticated_client: TestClient):
        response = authenticated_client.get("/api/pantry")
        assert response.status_code == 200
        assert response.json() == []

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_create_update_delete_pantry_item(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        # Create a section first
        section = PantrySection(name="General", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)
        section_id = str(section.id)

        create_response = authenticated_client.post("/api/pantry/items", json={"section_id": section_id, "name": "Meatballs", "quantity": 2})
        assert create_response.status_code == 200
        created = create_response.json()
        assert created["name"] == "Meatballs"
        assert created["quantity"] == 2
        assert created["section_id"] == section_id
        mock_broadcast.assert_awaited()

        item_id = created["id"]
        update_response = authenticated_client.put(f"/api/pantry/items/{item_id}", json={"quantity": 3})
        assert update_response.status_code == 200
        updated = update_response.json()
        assert updated["quantity"] == 3
        mock_broadcast.assert_awaited()

        delete_response = authenticated_client.delete(f"/api/pantry/items/{item_id}")
        assert delete_response.status_code == 200
        mock_broadcast.assert_awaited()

        from uuid import UUID
        remaining = db_session.query(PantryItem).filter(PantryItem.id == UUID(item_id)).first()
        assert remaining is None

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_create_pantry_item_empty_name(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test creating pantry item with empty name fails."""
        section = PantrySection(name="General", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        response = authenticated_client.post("/api/pantry/items", json={"section_id": str(section.id), "name": "  ", "quantity": 1})
        assert response.status_code == 400
        assert "Name is required" in response.json()["detail"]

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_update_pantry_item_not_found(self, mock_broadcast, authenticated_client: TestClient):
        """Test updating non-existent pantry item fails."""
        response = authenticated_client.put(
            "/api/pantry/items/00000000-0000-0000-0000-000000000001",
            json={"quantity": 5}
        )
        assert response.status_code == 404
        assert "Item not found" in response.json()["detail"]

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_update_pantry_item_empty_name(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test updating pantry item with empty name fails."""
        section = PantrySection(name="General", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        create_response = authenticated_client.post("/api/pantry/items", json={"section_id": str(section.id), "name": "Test Item", "quantity": 1})
        item_id = create_response.json()["id"]

        response = authenticated_client.put(f"/api/pantry/items/{item_id}", json={"name": "  "})
        assert response.status_code == 400
        assert "Name is required" in response.json()["detail"]

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_update_pantry_item_with_name(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test updating pantry item name."""
        section = PantrySection(name="General", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        create_response = authenticated_client.post("/api/pantry/items", json={"section_id": str(section.id), "name": "Old Name", "quantity": 1})
        item_id = create_response.json()["id"]

        response = authenticated_client.put(f"/api/pantry/items/{item_id}", json={"name": "New Name"})
        assert response.status_code == 200
        assert response.json()["name"] == "New Name"

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_delete_pantry_item_not_found(self, mock_broadcast, authenticated_client: TestClient):
        """Test deleting non-existent pantry item fails."""
        response = authenticated_client.delete("/api/pantry/items/00000000-0000-0000-0000-000000000001")
        assert response.status_code == 404
        assert "Item not found" in response.json()["detail"]

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_replace_pantry(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test replacing the entire pantry via PUT."""
        # Create initial data
        section = PantrySection(name="Old", position=0)
        db_session.add(section)
        db_session.commit()

        payload = {
            "sections": [
                {"name": "Fridge", "items": [{"name": "Milk", "quantity": 1}, {"name": "Eggs", "quantity": 12}]},
                {"name": "Freezer", "items": [{"name": "Ice cream", "quantity": 2}]},
            ]
        }
        response = authenticated_client.put("/api/pantry", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2
        assert data[0]["name"] == "Fridge"
        assert len(data[0]["items"]) == 2
        assert data[1]["name"] == "Freezer"
        assert len(data[1]["items"]) == 1
        mock_broadcast.assert_awaited()

        # Old section should be gone
        assert db_session.query(PantrySection).filter(PantrySection.name == "Old").first() is None

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_rename_section(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test renaming a pantry section."""
        section = PantrySection(name="General", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        response = authenticated_client.patch(f"/api/pantry/sections/{section.id}", json={"name": "Fridge"})
        assert response.status_code == 200
        assert response.json()["name"] == "Fridge"
        mock_broadcast.assert_awaited()

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_rename_section_not_found(self, mock_broadcast, authenticated_client: TestClient):
        """Test renaming non-existent section fails."""
        response = authenticated_client.patch(
            "/api/pantry/sections/00000000-0000-0000-0000-000000000001",
            json={"name": "Nope"}
        )
        assert response.status_code == 404

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_reorder_sections(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test reordering pantry sections."""
        s1 = PantrySection(name="A", position=0)
        s2 = PantrySection(name="B", position=1)
        db_session.add_all([s1, s2])
        db_session.commit()
        db_session.refresh(s1)
        db_session.refresh(s2)

        response = authenticated_client.patch("/api/pantry/reorder-sections", json={"section_ids": [str(s2.id), str(s1.id)]})
        assert response.status_code == 200
        mock_broadcast.assert_awaited()

        db_session.refresh(s1)
        db_session.refresh(s2)
        assert s2.position == 0
        assert s1.position == 1

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_reorder_items(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test reordering items within a section."""
        section = PantrySection(name="General", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        i1 = PantryItem(section_id=section.id, name="A", quantity=1, position=0)
        i2 = PantryItem(section_id=section.id, name="B", quantity=1, position=1)
        db_session.add_all([i1, i2])
        db_session.commit()
        db_session.refresh(i1)
        db_session.refresh(i2)

        response = authenticated_client.patch(
            f"/api/pantry/sections/{section.id}/reorder-items",
            json={"item_ids": [str(i2.id), str(i1.id)]}
        )
        assert response.status_code == 200
        mock_broadcast.assert_awaited()

        db_session.refresh(i1)
        db_session.refresh(i2)
        assert i2.position == 0
        assert i1.position == 1

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_reorder_items_section_not_found(self, mock_broadcast, authenticated_client: TestClient):
        """Test reordering items in non-existent section fails."""
        response = authenticated_client.patch(
            "/api/pantry/sections/00000000-0000-0000-0000-000000000001/reorder-items",
            json={"item_ids": []}
        )
        assert response.status_code == 404

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_create_pantry_item_section_not_found(self, mock_broadcast, authenticated_client: TestClient):
        """Test creating item in non-existent section fails."""
        response = authenticated_client.post("/api/pantry/items", json={
            "section_id": "00000000-0000-0000-0000-000000000001",
            "name": "Test",
            "quantity": 1
        })
        assert response.status_code == 404

    @patch("app.routers.pantry.broadcast_event", new_callable=AsyncMock)
    def test_clear_pantry(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test clearing all pantry items."""
        section = PantrySection(name="General", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)
        item = PantryItem(section_id=section.id, name="Milk", quantity=1, position=0)
        db_session.add(item)
        db_session.commit()

        response = authenticated_client.delete("/api/pantry/items?mode=all")
        assert response.status_code == 200
        assert response.json() == []
        mock_broadcast.assert_awaited()

        assert db_session.query(PantrySection).count() == 0


class TestMealIdeasAPI:
    def test_list_meal_ideas_empty(self, authenticated_client: TestClient):
        response = authenticated_client.get("/api/meal-ideas")
        assert response.status_code == 200
        assert response.json() == []

    @patch("app.routers.meal_ideas.broadcast_event", new_callable=AsyncMock)
    def test_create_update_delete_meal_idea(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        create_response = authenticated_client.post("/api/meal-ideas", json={"title": "Salmon Bites"})
        assert create_response.status_code == 200
        created = create_response.json()
        assert created["title"] == "Salmon Bites"
        mock_broadcast.assert_awaited()

        idea_id = created["id"]
        update_response = authenticated_client.put(f"/api/meal-ideas/{idea_id}", json={"title": "Updated"})
        assert update_response.status_code == 200
        updated = update_response.json()
        assert updated["title"] == "Updated"
        mock_broadcast.assert_awaited()

        delete_response = authenticated_client.delete(f"/api/meal-ideas/{idea_id}")
        assert delete_response.status_code == 200
        mock_broadcast.assert_awaited()

        from uuid import UUID
        remaining = db_session.query(MealIdea).filter(MealIdea.id == UUID(idea_id)).first()
        assert remaining is None

    @patch("app.routers.meal_ideas.broadcast_event", new_callable=AsyncMock)
    def test_create_meal_idea_empty_title(self, mock_broadcast, authenticated_client: TestClient):
        """Test creating meal idea with empty title fails."""
        response = authenticated_client.post("/api/meal-ideas", json={"title": "  "})
        assert response.status_code == 400
        assert "Title is required" in response.json()["detail"]

    @patch("app.routers.meal_ideas.broadcast_event", new_callable=AsyncMock)
    def test_update_meal_idea_not_found(self, mock_broadcast, authenticated_client: TestClient):
        """Test updating non-existent meal idea fails."""
        response = authenticated_client.put(
            "/api/meal-ideas/00000000-0000-0000-0000-000000000001",
            json={"title": "New Title"}
        )
        assert response.status_code == 404
        assert "Idea not found" in response.json()["detail"]

    @patch("app.routers.meal_ideas.broadcast_event", new_callable=AsyncMock)
    def test_update_meal_idea_empty_title(self, mock_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test updating meal idea with empty title fails."""
        # Create idea first
        create_response = authenticated_client.post("/api/meal-ideas", json={"title": "Test Idea"})
        idea_id = create_response.json()["id"]

        # Try to update with empty title
        response = authenticated_client.put(f"/api/meal-ideas/{idea_id}", json={"title": "  "})
        assert response.status_code == 400
        assert "Title is required" in response.json()["detail"]

    @patch("app.routers.meal_ideas.broadcast_event", new_callable=AsyncMock)
    def test_delete_meal_idea_not_found(self, mock_broadcast, authenticated_client: TestClient):
        """Test deleting non-existent meal idea fails."""
        response = authenticated_client.delete("/api/meal-ideas/00000000-0000-0000-0000-000000000001")
        assert response.status_code == 404
        assert "Idea not found" in response.json()["detail"]


class TestStoresAPI:
    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_create_and_list_stores(self, mock_broadcast, authenticated_client: TestClient):
        """Test creating a store applies title case and list returns it at position 0."""
        response = authenticated_client.post("/api/stores", json={"name": "trader joes"})
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Trader Joes"
        assert data["position"] == 0

        list_response = authenticated_client.get("/api/stores")
        assert list_response.status_code == 200
        stores = list_response.json()
        assert len(stores) == 1
        assert stores[0]["name"] == "Trader Joes"
        mock_broadcast.assert_awaited()

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_create_duplicate_store_returns_existing(self, mock_broadcast, authenticated_client: TestClient):
        """Test creating a store with a duplicate name (case-insensitive) returns existing store."""
        first_response = authenticated_client.post("/api/stores", json={"name": "Whole Foods"})
        assert first_response.status_code == 200
        first_id = first_response.json()["id"]

        second_response = authenticated_client.post("/api/stores", json={"name": "whole foods"})
        assert second_response.status_code == 200
        assert second_response.json()["id"] == first_id

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_rename_store(self, mock_broadcast, authenticated_client: TestClient):
        """Test renaming a store updates its name."""
        create_response = authenticated_client.post("/api/stores", json={"name": "Costco"})
        store_id = create_response.json()["id"]

        rename_response = authenticated_client.patch(f"/api/stores/{store_id}", json={"name": "costco wholesale"})
        assert rename_response.status_code == 200
        assert rename_response.json()["name"] == "Costco Wholesale"

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_delete_store_nullifies_grocery_items(self, mock_grocery_broadcast, mock_stores_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test deleting a store sets store_id to None on associated grocery items."""
        # Create store via API
        create_response = authenticated_client.post("/api/stores", json={"name": "Target"})
        assert create_response.status_code == 200
        store_id = create_response.json()["id"]

        # Create section and item directly in db
        from uuid import UUID
        section = GrocerySection(name="General", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        item = GroceryItem(section_id=section.id, name="Milk", position=0, store_id=UUID(store_id))
        db_session.add(item)
        db_session.commit()
        db_session.refresh(item)
        assert str(item.store_id) == store_id

        # Delete store
        delete_response = authenticated_client.delete(f"/api/stores/{store_id}")
        assert delete_response.status_code == 200

        # Verify item's store_id is now None
        db_session.refresh(item)
        assert item.store_id is None

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_reorder_stores(self, mock_broadcast, authenticated_client: TestClient):
        """Test reordering stores updates their positions."""
        a_response = authenticated_client.post("/api/stores", json={"name": "Store A"})
        b_response = authenticated_client.post("/api/stores", json={"name": "Store B"})
        a_id = a_response.json()["id"]
        b_id = b_response.json()["id"]

        reorder_response = authenticated_client.patch("/api/stores/reorder", json={"store_ids": [b_id, a_id]})
        assert reorder_response.status_code == 200

        list_response = authenticated_client.get("/api/stores")
        stores = list_response.json()
        assert stores[0]["id"] == b_id
        assert stores[1]["id"] == a_id


class TestGroceryStoreDefaults:
    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_assign_store_creates_default(self, mock_grocery_broadcast, mock_stores_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test that assigning a store to an item via PATCH creates an ItemDefault row."""
        from uuid import UUID
        # Create store via API
        store_resp = authenticated_client.post("/api/stores", json={"name": "Safeway"})
        store_id = store_resp.json()["id"]

        # Create section and item directly in db
        section = GrocerySection(name="Produce", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        item = GroceryItem(section_id=section.id, name="Apples", position=0)
        db_session.add(item)
        db_session.commit()
        db_session.refresh(item)
        item_id = str(item.id)

        # Assign store to item
        patch_resp = authenticated_client.patch(f"/api/grocery/items/{item_id}", json={"store_id": store_id})
        assert patch_resp.status_code == 200
        assert patch_resp.json()["store_id"] == store_id

        # Verify ItemDefault row exists
        default = db_session.query(ItemDefault).filter(ItemDefault.item_name == "apples").first()
        assert default is not None
        assert str(default.store_id) == store_id

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_add_item_auto_populates_store(self, mock_grocery_broadcast, mock_stores_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test that adding an item with a known default auto-populates the store."""
        from uuid import UUID
        # Create store via API
        store_resp = authenticated_client.post("/api/stores", json={"name": "Kroger"})
        store_id = store_resp.json()["id"]

        # Create section directly in db
        section = GrocerySection(name="Dairy", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)
        section_id = str(section.id)

        # Add item and assign store (creates default)
        add_resp = authenticated_client.post("/api/grocery/items", json={"section_id": section_id, "name": "Butter"})
        assert add_resp.status_code == 200
        item_id = add_resp.json()["id"]

        patch_resp = authenticated_client.patch(f"/api/grocery/items/{item_id}", json={"store_id": store_id})
        assert patch_resp.status_code == 200

        # Delete the item
        del_resp = authenticated_client.delete(f"/api/grocery/items/{item_id}")
        assert del_resp.status_code == 200

        # Re-add same item name — should auto-populate store
        readd_resp = authenticated_client.post("/api/grocery/items", json={"section_id": section_id, "name": "Butter"})
        assert readd_resp.status_code == 200
        assert readd_resp.json()["store_id"] == store_id

    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    @patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
    def test_clear_store_clears_default(self, mock_grocery_broadcast, mock_stores_broadcast, authenticated_client: TestClient, db_session: Session):
        """Test that clearing store_id via PATCH also clears the ItemDefault."""
        from uuid import UUID
        # Create store via API
        store_resp = authenticated_client.post("/api/stores", json={"name": "Aldi"})
        store_id = store_resp.json()["id"]

        # Create section and item directly in db
        section = GrocerySection(name="Snacks", position=0)
        db_session.add(section)
        db_session.commit()
        db_session.refresh(section)

        item = GroceryItem(section_id=section.id, name="Chips", position=0)
        db_session.add(item)
        db_session.commit()
        db_session.refresh(item)
        item_id = str(item.id)

        # Assign store (creates default)
        patch_resp = authenticated_client.patch(f"/api/grocery/items/{item_id}", json={"store_id": store_id})
        assert patch_resp.status_code == 200

        # Verify default was created
        default = db_session.query(ItemDefault).filter(ItemDefault.item_name == "chips").first()
        assert default is not None
        assert str(default.store_id) == store_id

        # Clear store_id
        clear_resp = authenticated_client.patch(f"/api/grocery/items/{item_id}", json={"store_id": None})
        assert clear_resp.status_code == 200
        assert clear_resp.json()["store_id"] is None

        # Verify ItemDefault.store_id is now None
        db_session.refresh(default)
        assert default.store_id is None
