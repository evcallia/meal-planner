"""Itemized-state preservation across meal note edits (PUT /api/days/{date}/notes)."""
from fastapi.testclient import TestClient

DATE = "2026-06-15"


def put_notes(client: TestClient, notes: str) -> dict:
    resp = client.put(f"/api/days/{DATE}/notes", json={"notes": notes})
    assert resp.status_code == 200
    return resp.json()


def set_itemized(client: TestClient, line_index: int, itemized: bool = True) -> None:
    resp = client.patch(
        f"/api/days/{DATE}/items/{line_index}", json={"itemized": itemized}
    )
    assert resp.status_code == 200


def items_map(note: dict) -> dict[int, bool]:
    return {item["line_index"]: item["itemized"] for item in note["items"]}


class TestItemizedAlignment:
    def test_appending_meal_preserves_other_lines(self, authenticated_client):
        note = put_notes(authenticated_client, "Tacos\nPizza")
        assert items_map(note) == {0: False, 1: False}
        set_itemized(authenticated_client, 0)
        note = put_notes(authenticated_client, "Tacos\nPizza\nSalad")
        assert items_map(note) == {0: True, 1: False, 2: False}

    def test_editing_line_in_place_keeps_its_state(self, authenticated_client):
        note = put_notes(authenticated_client, "Tacos\nPizza")
        assert items_map(note) == {0: False, 1: False}
        set_itemized(authenticated_client, 1)
        note = put_notes(authenticated_client, "Tacos\nPizza night")
        assert items_map(note) == {0: False, 1: True}

    def test_inserting_line_above_shifts_state(self, authenticated_client):
        note = put_notes(authenticated_client, "Tacos\nPizza")
        assert items_map(note) == {0: False, 1: False}
        set_itemized(authenticated_client, 1)
        note = put_notes(authenticated_client, "Soup\nTacos\nPizza")
        assert items_map(note) == {0: False, 1: False, 2: True}

    def test_duplicate_lines_keep_individual_state(self, authenticated_client):
        note = put_notes(authenticated_client, "Tacos\nTacos")
        assert items_map(note) == {0: False, 1: False}
        set_itemized(authenticated_client, 0)
        note = put_notes(authenticated_client, "Tacos\nTacos\nPizza")
        assert items_map(note) == {0: True, 1: False, 2: False}

    def test_deleting_line_drops_state_and_shifts_rest(self, authenticated_client):
        note = put_notes(authenticated_client, "Eggs\nBacon\nToast")
        assert items_map(note) == {0: False, 1: False, 2: False}
        set_itemized(authenticated_client, 2)
        note = put_notes(authenticated_client, "Eggs\nToast")
        assert items_map(note) == {0: False, 1: True}

    def test_reordering_lines_carries_state(self, authenticated_client):
        note = put_notes(authenticated_client, "Tacos\nPizza")
        assert items_map(note) == {0: False, 1: False}
        set_itemized(authenticated_client, 0)
        note = put_notes(authenticated_client, "Pizza\nTacos")
        assert items_map(note) == {0: False, 1: True}

    def test_html_lines_align_like_frontend(self, authenticated_client):
        note = put_notes(authenticated_client, "<div>Tacos</div><div>Pizza</div>")
        assert items_map(note) == {0: False, 1: False}
        set_itemized(authenticated_client, 1)
        note = put_notes(
            authenticated_client, "<div>Tacos</div><div>Pizza</div><div>Salad</div>"
        )
        assert items_map(note) == {0: False, 1: True, 2: False}

    def test_clearing_notes_removes_all_items(self, authenticated_client):
        note = put_notes(authenticated_client, "Tacos")
        assert items_map(note) == {0: False}
        set_itemized(authenticated_client, 0)
        note = put_notes(authenticated_client, "")
        assert items_map(note) == {}
