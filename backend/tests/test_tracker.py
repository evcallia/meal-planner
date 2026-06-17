"""Tests for the Lists / tracker feature: privacy, sharing, tasks, and stats."""
from datetime import datetime, timedelta

from app.main import app
from app.auth import get_current_user

USER_A = {"sub": "user-a", "email": "alice@example.com", "name": "Alice"}
USER_B = {"sub": "user-b", "email": "bob@example.com", "name": "Bob"}


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user


def test_lists_are_private_by_default(client):
    _as(USER_A)
    res = client.post("/api/tracker/lists", json={"name": "Chores"})
    assert res.status_code == 201
    body = res.json()
    assert body["is_owner"] is True
    assert body["shared_with"] == []

    # Bob cannot see Alice's private list
    _as(USER_B)
    assert client.get("/api/tracker").json() == []
    app.dependency_overrides.pop(get_current_user, None)


def test_share_grants_access_with_non_owner_perspective(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "House"}).json()["id"]

    res = client.post(f"/api/tracker/lists/{list_id}/shares", json={"sub": "user-b"})
    assert res.status_code == 200
    assert any(u["sub"] == "user-b" for u in res.json()["shared_with"])

    _as(USER_B)
    lists = client.get("/api/tracker").json()
    assert len(lists) == 1
    assert lists[0]["id"] == list_id
    assert lists[0]["is_owner"] is False

    # Non-owner cannot delete the list or manage shares
    assert client.delete(f"/api/tracker/lists/{list_id}").status_code == 403
    assert client.post(f"/api/tracker/lists/{list_id}/shares", json={"sub": "user-c"}).status_code == 403

    # ...but can collaborate on tasks
    assert client.post("/api/tracker/tasks", json={"list_id": list_id, "name": "Vacuum"}).status_code == 201
    app.dependency_overrides.pop(get_current_user, None)


def test_unshare_revokes_access(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "House"}).json()["id"]
    client.post(f"/api/tracker/lists/{list_id}/shares", json={"sub": "user-b"})

    _as(USER_B)
    assert len(client.get("/api/tracker").json()) == 1

    _as(USER_A)
    assert client.delete(f"/api/tracker/lists/{list_id}/shares/user-b").status_code == 200

    _as(USER_B)
    assert client.get("/api/tracker").json() == []
    app.dependency_overrides.pop(get_current_user, None)


def test_no_access_to_foreign_list_is_403(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "Secret"}).json()["id"]
    _as(USER_B)
    assert client.post("/api/tracker/tasks", json={"list_id": list_id, "name": "x"}).status_code == 403
    app.dependency_overrides.pop(get_current_user, None)


def test_tasks_logs_and_recency_stats(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "Plants"}).json()["id"]
    task = client.post("/api/tracker/tasks", json={
        "list_id": list_id, "name": "Water", "target_interval_days": 7,
    }).json()
    tid = task["id"]
    assert task["total_count"] == 0
    assert task["last_done_at"] is None

    d1 = (datetime.utcnow() - timedelta(days=4)).isoformat()
    d2 = datetime.utcnow().isoformat()
    client.post(f"/api/tracker/tasks/{tid}/logs", json={"done_at": d1})
    assert client.post(f"/api/tracker/tasks/{tid}/logs", json={"done_at": d2}).status_code == 201

    t = client.get("/api/tracker").json()[0]["tasks"][0]
    assert t["total_count"] == 2
    assert t["last_done_at"] is not None
    assert t["avg_interval_days"] is not None and 3 <= t["avg_interval_days"] <= 5

    logs = client.get(f"/api/tracker/tasks/{tid}/logs").json()
    assert len(logs) == 2
    assert client.delete(f"/api/tracker/logs/{logs[0]['id']}").status_code == 204
    t = client.get("/api/tracker").json()[0]["tasks"][0]
    assert t["total_count"] == 1
    app.dependency_overrides.pop(get_current_user, None)


def test_share_by_unknown_email_is_404(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "Y"}).json()["id"]
    res = client.post(f"/api/tracker/lists/{list_id}/shares", json={"email": "ghost@example.com"})
    assert res.status_code == 404
    app.dependency_overrides.pop(get_current_user, None)


def test_seasonal_fields_roundtrip(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "Yard"}).json()["id"]
    task = client.post("/api/tracker/tasks", json={
        "list_id": list_id, "name": "Mow lawn", "target_interval_days": 7,
        "season_start_month": 4, "season_end_month": 10,
    }).json()
    assert task["season_start_month"] == 4
    assert task["season_end_month"] == 10

    # Clearing the season back to all-year
    updated = client.patch(f"/api/tracker/tasks/{task['id']}", json={
        "season_start_month": None, "season_end_month": None,
    }).json()
    assert updated["season_start_month"] is None
    assert updated["season_end_month"] is None

    # Out-of-range months are rejected
    assert client.post("/api/tracker/tasks", json={
        "list_id": list_id, "name": "Bad", "season_start_month": 13,
    }).status_code == 422
    app.dependency_overrides.pop(get_current_user, None)


def test_skip_logs_a_deletable_skip_entry(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "Skips"}).json()["id"]
    tid = client.post("/api/tracker/tasks", json={"list_id": list_id, "name": "t", "target_interval_days": 7}).json()["id"]

    r = client.post(f"/api/tracker/tasks/{tid}/skip")
    assert r.status_code == 200
    body = r.json()
    assert body["total_count"] == 0          # a skip is not a completion
    assert body["last_event_at"] is not None  # ...but it resets recency

    logs = client.get(f"/api/tracker/tasks/{tid}/logs").json()
    assert len(logs) == 1 and logs[0]["kind"] == "skip"

    # Undo a skip = delete the skip log
    assert client.delete(f"/api/tracker/logs/{logs[0]['id']}").status_code == 204
    t = client.get("/api/tracker").json()[0]["tasks"][0]
    assert t["last_event_at"] is None
    assert t["total_count"] == 0
    app.dependency_overrides.pop(get_current_user, None)


def test_completion_can_be_attributed_to_another_user(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "Who"}).json()["id"]
    tid = client.post("/api/tracker/tasks", json={"list_id": list_id, "name": "t"}).json()["id"]

    log = client.post(f"/api/tracker/tasks/{tid}/logs", json={"created_by_sub": "user-b"}).json()
    assert log["created_by_sub"] == "user-b"
    logs = client.get(f"/api/tracker/tasks/{tid}/logs").json()
    assert logs[0]["created_by_sub"] == "user-b"
    app.dependency_overrides.pop(get_current_user, None)


def test_season_day_range_roundtrip(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "Yard"}).json()["id"]
    task = client.post("/api/tracker/tasks", json={
        "list_id": list_id, "name": "Mow",
        "season_start_month": 3, "season_start_day": 15,
        "season_end_month": 10, "season_end_day": 31,
    }).json()
    assert task["season_start_day"] == 15
    assert task["season_end_day"] == 31
    assert client.post("/api/tracker/tasks", json={
        "list_id": list_id, "name": "Bad", "season_start_day": 40,
    }).status_code == 422
    app.dependency_overrides.pop(get_current_user, None)


def test_list_order_is_per_user(client):
    # Alice owns two lists and shares both with Bob.
    _as(USER_A)
    l1 = client.post("/api/tracker/lists", json={"name": "One"}).json()["id"]
    l2 = client.post("/api/tracker/lists", json={"name": "Two"}).json()["id"]
    client.post(f"/api/tracker/lists/{l1}/shares", json={"sub": "user-b"})
    client.post(f"/api/tracker/lists/{l2}/shares", json={"sub": "user-b"})

    # Alice reorders to [Two, One].
    assert client.patch("/api/tracker/reorder-lists", json={"list_ids": [l2, l1]}).status_code == 200
    assert [l["id"] for l in client.get("/api/tracker").json()] == [l2, l1]

    # Bob's order is unaffected by Alice's reorder.
    _as(USER_B)
    assert [l["id"] for l in client.get("/api/tracker").json()] == [l1, l2]

    # Bob reorders for himself; Alice's order stays put.
    assert client.patch("/api/tracker/reorder-lists", json={"list_ids": [l2, l1]}).status_code == 200
    assert [l["id"] for l in client.get("/api/tracker").json()] == [l2, l1]

    _as(USER_A)
    assert [l["id"] for l in client.get("/api/tracker").json()] == [l2, l1]
    app.dependency_overrides.pop(get_current_user, None)


def test_restore_list_rebuilds_tasks_logs_shares_and_position(client):
    _as(USER_A)
    # Mirror the undo flow: A, B, C exist; B is deleted, then restored into its slot.
    client.post("/api/tracker/lists", json={"name": "A"})
    bid = client.post("/api/tracker/lists", json={"name": "B"}).json()["id"]
    client.post("/api/tracker/lists", json={"name": "C"})
    assert client.delete(f"/api/tracker/lists/{bid}").status_code == 204

    d1 = (datetime.utcnow() - timedelta(days=5)).isoformat()
    d2 = datetime.utcnow().isoformat()
    restored = client.post("/api/tracker/lists/restore", json={
        "name": "B",
        "color": "rose",
        "position": 1,  # original slot, now vacated
        "share_subs": ["user-b"],
        "tasks": [{
            "name": "Water",
            "target_interval_days": 7,
            "position": 0,
            "logs": [
                {"done_at": d1, "kind": "done"},
                {"done_at": d2, "kind": "done"},
                {"done_at": d2, "kind": "skip"},
            ],
        }],
    })
    assert restored.status_code == 201
    body = restored.json()
    assert body["name"] == "B"
    assert body["position"] == 1
    assert body["is_owner"] is True
    assert any(u["sub"] == "user-b" for u in body["shared_with"])
    assert len(body["tasks"]) == 1
    task = body["tasks"][0]
    assert task["total_count"] == 2  # skip doesn't count as a completion
    assert task["avg_interval_days"] is not None

    # Restored list reappears in its original slot for the owner, not at the end.
    assert [l["name"] for l in client.get("/api/tracker").json()] == ["A", "B", "C"]

    # Logs (incl. the skip) were recreated.
    logs = client.get(f"/api/tracker/tasks/{task['id']}/logs").json()
    assert len(logs) == 3
    assert sum(1 for l in logs if l["kind"] == "skip") == 1

    # The collaborator can see the restored list.
    _as(USER_B)
    assert any(l["id"] == body["id"] for l in client.get("/api/tracker").json())
    app.dependency_overrides.pop(get_current_user, None)


def test_delete_task_is_idempotent(client):
    _as(USER_A)
    list_id = client.post("/api/tracker/lists", json={"name": "Z"}).json()["id"]
    tid = client.post("/api/tracker/tasks", json={"list_id": list_id, "name": "t"}).json()["id"]
    assert client.delete(f"/api/tracker/tasks/{tid}").status_code == 204
    assert client.delete(f"/api/tracker/tasks/{tid}").status_code == 204
    app.dependency_overrides.pop(get_current_user, None)
