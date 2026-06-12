"""Tests for remembering a grocery item's last section in item_defaults."""

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import GrocerySection, GroceryItem, ItemDefault, Store


def _create_section(db_session: Session, name: str, position: int = 0) -> GrocerySection:
    section = GrocerySection(name=name, position=position)
    db_session.add(section)
    db_session.commit()
    db_session.refresh(section)
    return section


@patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
class TestSectionDefaultOnAdd:
    def test_add_item_creates_section_default(
        self, mock_broadcast, authenticated_client: TestClient, db_session: Session
    ):
        """POST /api/grocery/items records the section name in item_defaults."""
        section = _create_section(db_session, "Produce")

        resp = authenticated_client.post(
            "/api/grocery/items",
            json={"section_id": str(section.id), "name": "Avocado"},
        )
        assert resp.status_code == 200

        row = db_session.query(ItemDefault).filter_by(item_name="avocado").first()
        assert row is not None
        assert row.section_name == "Produce"

        # Visible via GET even though store_id is null
        get_resp = authenticated_client.get("/api/grocery/item-defaults")
        assert get_resp.status_code == 200
        defaults = {d["item_name"]: d for d in get_resp.json()}
        assert defaults["avocado"]["section_name"] == "Produce"
        assert defaults["avocado"]["store_id"] is None

    def test_add_item_updates_existing_default(
        self, mock_broadcast, authenticated_client: TestClient, db_session: Session
    ):
        """Adding an item whose default already exists updates the section name."""
        section = _create_section(db_session, "Dairy")
        db_session.add(ItemDefault(item_name="butter", section_name="Produce"))
        db_session.commit()

        resp = authenticated_client.post(
            "/api/grocery/items",
            json={"section_id": str(section.id), "name": "Butter"},
        )
        assert resp.status_code == 200

        db_session.expire_all()
        row = db_session.query(ItemDefault).filter_by(item_name="butter").first()
        assert row.section_name == "Dairy"

    def test_add_item_preserves_store_default(
        self, mock_broadcast, authenticated_client: TestClient, db_session: Session
    ):
        """Recording a section default must not clobber an existing store default."""
        store = Store(name="Kroger")
        db_session.add(store)
        db_session.flush()
        db_session.add(ItemDefault(item_name="milk", store_id=store.id))
        section = _create_section(db_session, "Dairy")
        db_session.commit()

        resp = authenticated_client.post(
            "/api/grocery/items",
            json={"section_id": str(section.id), "name": "Milk"},
        )
        assert resp.status_code == 200

        db_session.expire_all()
        row = db_session.query(ItemDefault).filter_by(item_name="milk").first()
        assert row.section_name == "Dairy"
        assert str(row.store_id) == str(store.id)


@patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
class TestSectionDefaultOnMove:
    def test_move_updates_section_default(
        self, mock_broadcast, authenticated_client: TestClient, db_session: Session
    ):
        """Moving an item to another section updates the remembered section name."""
        source = _create_section(db_session, "Produce", position=0)
        target = _create_section(db_session, "Frozen", position=1)
        item = GroceryItem(section_id=source.id, name="Peas", position=0)
        db_session.add(item)
        db_session.commit()
        db_session.refresh(item)

        resp = authenticated_client.patch(
            f"/api/grocery/items/{item.id}/move",
            json={"to_section_id": str(target.id), "to_position": 0},
        )
        assert resp.status_code == 200

        row = db_session.query(ItemDefault).filter_by(item_name="peas").first()
        assert row is not None
        assert row.section_name == "Frozen"

    def test_move_within_same_section_does_not_write_default(
        self, mock_broadcast, authenticated_client: TestClient, db_session: Session
    ):
        """Reordering within the same section is not a section change."""
        section = _create_section(db_session, "Produce")
        item = GroceryItem(section_id=section.id, name="Kale", position=0)
        other = GroceryItem(section_id=section.id, name="Chard", position=1)
        db_session.add_all([item, other])
        db_session.commit()
        db_session.refresh(item)

        resp = authenticated_client.patch(
            f"/api/grocery/items/{item.id}/move",
            json={"to_section_id": str(section.id), "to_position": 1},
        )
        assert resp.status_code == 200

        assert db_session.query(ItemDefault).filter_by(item_name="kale").first() is None


@patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
class TestSectionDefaultOnMerge:
    def test_merge_writes_section_defaults(
        self, mock_broadcast, authenticated_client: TestClient, db_session: Session
    ):
        """Bulk import via PUT /api/grocery records section defaults for all items."""
        resp = authenticated_client.put(
            "/api/grocery",
            json={
                "sections": [
                    {
                        "name": "Bakery",
                        "items": [
                            {"name": "Bagels"},
                            {"name": "Sourdough"},
                        ],
                    },
                    {
                        "name": "Deli",
                        "items": [
                            {"name": "Turkey"},
                        ],
                    },
                ]
            },
        )
        assert resp.status_code == 200

        rows = {d.item_name: d for d in db_session.query(ItemDefault).all()}
        assert rows["bagels"].section_name == "Bakery"
        assert rows["sourdough"].section_name == "Bakery"
        assert rows["turkey"].section_name == "Deli"


class TestItemDefaultsGetAndPut:
    def test_get_returns_section_only_defaults(
        self, authenticated_client: TestClient, db_session: Session
    ):
        """GET includes rows that have only a section_name (store_id null)."""
        db_session.add(ItemDefault(item_name="cereal", section_name="Breakfast"))
        # Row with neither store nor section should be excluded
        db_session.add(ItemDefault(item_name="mystery"))
        db_session.commit()

        resp = authenticated_client.get("/api/grocery/item-defaults")
        assert resp.status_code == 200
        names = {d["item_name"] for d in resp.json()}
        assert "cereal" in names
        assert "mystery" not in names

    def test_put_section_name_preserves_store_id(
        self, authenticated_client: TestClient, db_session: Session
    ):
        """PUT with only section_name doesn't clobber an existing store_id."""
        store = Store(name="Costco")
        db_session.add(store)
        db_session.flush()
        db_session.add(ItemDefault(item_name="eggs", store_id=store.id))
        db_session.commit()

        resp = authenticated_client.put(
            "/api/grocery/item-defaults/eggs",
            json={"section_name": "Dairy"},
        )
        assert resp.status_code == 204

        db_session.expire_all()
        row = db_session.query(ItemDefault).filter_by(item_name="eggs").first()
        assert row.section_name == "Dairy"
        assert str(row.store_id) == str(store.id)

    def test_put_store_id_preserves_section_name(
        self, authenticated_client: TestClient, db_session: Session
    ):
        """PUT with only store_id doesn't clobber an existing section_name."""
        store = Store(name="Aldi")
        db_session.add(store)
        db_session.flush()
        db_session.add(ItemDefault(item_name="rice", section_name="Pantry"))
        db_session.commit()

        resp = authenticated_client.put(
            "/api/grocery/item-defaults/rice",
            json={"store_id": str(store.id)},
        )
        assert resp.status_code == 204

        db_session.expire_all()
        row = db_session.query(ItemDefault).filter_by(item_name="rice").first()
        assert row.section_name == "Pantry"
        assert str(row.store_id) == str(store.id)

    def test_put_creates_row_with_section_name(
        self, authenticated_client: TestClient, db_session: Session
    ):
        """PUT creates a new row when only section_name is given."""
        resp = authenticated_client.put(
            "/api/grocery/item-defaults/Flour",
            json={"section_name": "Baking"},
        )
        assert resp.status_code == 204

        row = db_session.query(ItemDefault).filter_by(item_name="flour").first()
        assert row is not None
        assert row.section_name == "Baking"
        assert row.store_id is None


@patch("app.routers.grocery.broadcast_event", new_callable=AsyncMock)
class TestStoreDefaultRegression:
    @patch("app.routers.stores.broadcast_event", new_callable=AsyncMock)
    def test_patch_store_id_still_upserts_store_default(
        self,
        mock_stores_broadcast,
        mock_grocery_broadcast,
        authenticated_client: TestClient,
        db_session: Session,
    ):
        """Existing store-default behavior on PATCH /items/{id} is unchanged."""
        store_resp = authenticated_client.post("/api/stores", json={"name": "Wegmans"})
        store_id = store_resp.json()["id"]

        section = _create_section(db_session, "Snacks")
        item = GroceryItem(section_id=section.id, name="Pretzels", position=0)
        db_session.add(item)
        db_session.commit()
        db_session.refresh(item)

        patch_resp = authenticated_client.patch(
            f"/api/grocery/items/{item.id}", json={"store_id": store_id}
        )
        assert patch_resp.status_code == 200

        row = db_session.query(ItemDefault).filter_by(item_name="pretzels").first()
        assert row is not None
        assert str(row.store_id) == store_id
