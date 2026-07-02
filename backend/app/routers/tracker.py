from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user
from app.database import get_db
from app.models import TrackerList, TrackerListPosition, TrackerTask, TrackerLog, TrackerShare, User
from app.schemas import (
    TrackerListSchema,
    TrackerListCreate,
    TrackerListRestore,
    TrackerListUpdate,
    TrackerReorderLists,
    TrackerShareCreate,
    TrackerTaskSchema,
    TrackerTaskCreate,
    TrackerTaskUpdate,
    TrackerReorderTasks,
    TrackerLogSchema,
    TrackerLogCreate,
)
from app.realtime import broadcast_to_user

router = APIRouter(prefix="/api/tracker", tags=["tracker"])


# ----- serialization helpers -----

def _full_name(db: Session, sub: str | None) -> str | None:
    if not sub:
        return None
    u = db.query(User).filter(User.sub == sub).first()
    return (u.name if u else None) or (u.email if u else None)


def _first_name(db: Session, sub: str | None) -> str | None:
    name = _full_name(db, sub)
    return name.split()[0] if name else None


def _naive_utc(dt: datetime | None) -> datetime | None:
    """Coerce to naive UTC. The DB columns are naive (the app's invariant), and the
    client sends tz-aware ISO strings (`...Z`); mixing the two breaks datetime sorts
    in `_task_dict` and JSON encoding in the SSE path. Normalize on the way in."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _log_dict(db: Session, log: TrackerLog) -> dict:
    return {
        "id": str(log.id),
        "task_id": str(log.task_id),
        # ISO string, not a raw datetime — this dict is also embedded in SSE payloads
        # (via recent_logs) which are encoded with json.dumps, not Pydantic.
        "done_at": log.done_at.isoformat() if log.done_at else None,
        "kind": log.kind or "done",
        "note": log.note,
        "created_by_sub": log.created_by_sub,
        "created_by_name": _first_name(db, log.created_by_sub),
    }


def _task_dict(db: Session, task: TrackerTask) -> dict:
    # Query logs explicitly rather than relying on the relationship's load state —
    # right after create/refresh the `logs` collection may not be populated.
    logs = db.query(TrackerLog).filter(TrackerLog.task_id == task.id).all()
    done_logs = [l for l in logs if (l.kind or "done") != "skip"]
    done_times = sorted(l.done_at for l in done_logs)
    total = len(done_times)
    last_done = done_times[-1] if done_times else None
    # Recency baseline resets on a skip too, so it tracks the latest event of any kind.
    last_event = max((l.done_at for l in logs), default=None)
    latest_done = max(done_logs, key=lambda l: l.done_at) if done_logs else None
    # Embed the most recent few entries so the client can show history offline
    # without a separate /logs fetch (full history still loads on demand).
    recent = sorted(logs, key=lambda l: l.done_at, reverse=True)[:5]
    avg = None
    if total >= 2:
        deltas = [
            (done_times[i] - done_times[i - 1]).total_seconds() / 86400
            for i in range(1, total)
        ]
        avg = round(sum(deltas) / len(deltas), 1)
    return {
        "id": str(task.id),
        "list_id": str(task.list_id),
        "name": task.name,
        "target_interval_days": task.target_interval_days,
        "notes": task.notes,
        "position": task.position,
        "archived": task.archived,
        "season_start_month": task.season_start_month,
        "season_end_month": task.season_end_month,
        "season_start_day": task.season_start_day,
        "season_end_day": task.season_end_day,
        "snooze_until": task.snooze_until.isoformat() if task.snooze_until else None,
        "last_done_at": last_done.isoformat() if last_done else None,
        "last_event_at": last_event.isoformat() if last_event else None,
        "last_done_by": _first_name(db, latest_done.created_by_sub) if latest_done else None,
        "last_note": latest_done.note if latest_done else None,
        "total_count": total,
        "avg_interval_days": avg,
        "recent_logs": [_log_dict(db, l) for l in recent],
    }


def _user_position(db: Session, list_id, sub: str, fallback: int) -> int:
    """A user's personal position for a list, falling back to the list's own
    position when they haven't reordered yet."""
    row = (
        db.query(TrackerListPosition)
        .filter(TrackerListPosition.sub == sub, TrackerListPosition.list_id == list_id)
        .first()
    )
    return row.position if row else fallback


def _list_dict(db: Session, lst: TrackerList, current_sub: str) -> dict:
    shared_with = []
    for share in lst.shares:
        if share.left_at is not None:
            continue  # member has left — not an active share
        u = db.query(User).filter(User.sub == share.sub).first()
        shared_with.append({
            "sub": share.sub,
            "email": u.email if u else None,
            "name": u.name if u else None,
        })
    tasks = sorted(lst.tasks, key=lambda t: t.position)
    return {
        "id": str(lst.id),
        "name": lst.name,
        "icon": lst.icon,
        "color": lst.color,
        "position": _user_position(db, lst.id, current_sub, lst.position),
        "owner_sub": lst.owner_sub,
        "owner_name": _full_name(db, lst.owner_sub),
        "is_owner": lst.owner_sub == current_sub,
        "shared_with": shared_with,
        "tasks": [_task_dict(db, t) for t in tasks],
    }


# ----- access control & broadcasting -----

_FULL_LIST = (
    joinedload(TrackerList.tasks).joinedload(TrackerTask.logs),
    joinedload(TrackerList.shares),
)


def _audience(lst: TrackerList) -> set[str]:
    """Subs that can see this list: owner + everyone with an active share."""
    return {lst.owner_sub} | {share.sub for share in lst.shares if share.left_at is None}


async def _broadcast(
    lst: TrackerList,
    action: str,
    extra: dict,
    source_id: str | None,
    extra_subs: tuple[str, ...] = (),
) -> None:
    """Broadcast a payload that is identical for every recipient (task events,
    deletes, reorders — nothing recipient-specific)."""
    payload = {"action": action, **extra}
    for sub in _audience(lst) | set(extra_subs):
        await broadcast_to_user(sub, "tracker.updated", payload, source_id=source_id)


async def _broadcast_list(
    db: Session,
    lst: TrackerList,
    action: str,
    source_id: str | None,
    extra_subs: tuple[str, ...] = (),
) -> None:
    """Broadcast a full-list payload, recomputing `is_owner` per recipient so a
    shared user never receives the owner's perspective."""
    for sub in _audience(lst) | set(extra_subs):
        await broadcast_to_user(
            sub, "tracker.updated",
            {"action": action, "list": _list_dict(db, lst, sub)},
            source_id=source_id,
        )


def _get_list(db: Session, list_id: UUID, sub: str, owner_only: bool = False) -> TrackerList:
    lst = (
        db.query(TrackerList)
        .options(*_FULL_LIST)
        .filter(TrackerList.id == list_id)
        .first()
    )
    if not lst:
        raise HTTPException(status_code=404, detail="List not found")
    if lst.owner_sub != sub and not any(s.sub == sub and s.left_at is None for s in lst.shares):
        raise HTTPException(status_code=403, detail="No access to this list")
    if owner_only and lst.owner_sub != sub:
        raise HTTPException(status_code=403, detail="Only the owner can do this")
    return lst


def _get_task(db: Session, task_id: UUID, sub: str) -> TrackerTask:
    task = (
        db.query(TrackerTask)
        .options(joinedload(TrackerTask.logs))
        .filter(TrackerTask.id == task_id)
        .first()
    )
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    # Authorize via parent list
    _get_list(db, task.list_id, sub)
    return task


# ----- list endpoints -----

@router.get("", response_model=list[TrackerListSchema])
async def list_lists(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    owned = db.query(TrackerList).options(*_FULL_LIST).filter(TrackerList.owner_sub == sub)
    shared_ids = [s.list_id for s in db.query(TrackerShare).filter(
        TrackerShare.sub == sub, TrackerShare.left_at.is_(None)).all()]
    shared = (
        db.query(TrackerList).options(*_FULL_LIST).filter(TrackerList.id.in_(shared_ids)).all()
        if shared_ids else []
    )
    user_pos = {
        r.list_id: r.position
        for r in db.query(TrackerListPosition).filter(TrackerListPosition.sub == sub).all()
    }
    lists = sorted(
        [*owned.all(), *shared],
        key=lambda l: (user_pos.get(l.id, l.position), l.position),
    )
    return [_list_dict(db, l, sub) for l in lists]


@router.post("/lists", response_model=TrackerListSchema, status_code=201)
async def create_list(
    payload: TrackerListCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    max_pos = db.query(func.count(TrackerList.id)).filter(TrackerList.owner_sub == sub).scalar() or 0
    lst = TrackerList(
        owner_sub=sub,
        name=payload.name.strip(),
        icon=payload.icon,
        color=payload.color,
        position=max_pos,
    )
    db.add(lst)
    db.commit()
    db.refresh(lst)
    data = _list_dict(db, lst, sub)
    await _broadcast_list(db, lst, "list-added", request.headers.get("x-source-id"))
    return data


@router.post("/lists/restore", response_model=TrackerListSchema, status_code=201)
async def restore_list(
    payload: TrackerListRestore,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Recreate a previously-deleted list (with tasks, logs and shares) in a single
    transaction and emit one full-list event, so undo restores it without the
    append-then-rebuild flicker that granular re-creation produces."""
    sub = user.get("sub")
    count = db.query(func.count(TrackerList.id)).filter(TrackerList.owner_sub == sub).scalar() or 0
    position = payload.position if payload.position is not None else count
    lst = TrackerList(
        owner_sub=sub,
        name=payload.name.strip(),
        icon=payload.icon,
        color=payload.color,
        position=position,
    )
    db.add(lst)
    db.flush()  # assign lst.id for the rows below
    # Pin the owner's personal position so their other devices place it correctly.
    db.add(TrackerListPosition(sub=sub, list_id=lst.id, position=position))
    for share_sub in payload.share_subs:
        if share_sub and share_sub != sub:
            db.add(TrackerShare(list_id=lst.id, sub=share_sub))
    for t in payload.tasks:
        task = TrackerTask(
            list_id=lst.id,
            name=t.name.strip(),
            target_interval_days=t.target_interval_days,
            notes=t.notes,
            position=t.position,
            season_start_month=t.season_start_month,
            season_end_month=t.season_end_month,
            season_start_day=t.season_start_day,
            season_end_day=t.season_end_day,
        )
        db.add(task)
        db.flush()  # assign task.id for its logs
        for lg in t.logs:
            db.add(TrackerLog(
                task_id=task.id,
                done_at=_naive_utc(lg.done_at) or datetime.utcnow(),
                kind="skip" if lg.kind == "skip" else "done",
                note=lg.note,
                created_by_sub=lg.created_by_sub or sub,
            ))
    db.commit()
    db.refresh(lst)
    data = _list_dict(db, lst, sub)
    await _broadcast_list(db, lst, "list-added", request.headers.get("x-source-id"))
    return data


@router.patch("/lists/{list_id}", response_model=TrackerListSchema)
async def update_list(
    list_id: UUID,
    payload: TrackerListUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    lst = _get_list(db, list_id, sub)
    if payload.name is not None:
        lst.name = payload.name.strip()
    if "icon" in payload.model_fields_set:
        lst.icon = payload.icon
    if "color" in payload.model_fields_set:
        lst.color = payload.color
    db.commit()
    db.refresh(lst)
    data = _list_dict(db, lst, sub)
    await _broadcast_list(db, lst, "list-updated", request.headers.get("x-source-id"))
    return data


@router.delete("/lists/{list_id}", status_code=204)
async def delete_list(
    list_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    lst = (
        db.query(TrackerList).options(joinedload(TrackerList.shares))
        .filter(TrackerList.id == list_id).first()
    )
    if not lst:
        return  # idempotent
    if lst.owner_sub != sub:
        raise HTTPException(status_code=403, detail="Only the owner can delete this list")
    audience = _audience(lst)
    db.delete(lst)
    db.commit()
    payload = {"action": "list-deleted", "listId": str(list_id)}
    for member in audience:
        await broadcast_to_user(member, "tracker.updated", payload, source_id=request.headers.get("x-source-id"))


@router.patch("/reorder-lists")
async def reorder_lists(
    payload: TrackerReorderLists,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    # List order is per-user: write this user's positions only, so reordering
    # never reshuffles a shared list for the other members.
    applied: list[tuple[str, int]] = []
    for i, list_id in enumerate(payload.list_ids):
        lst = db.query(TrackerList).filter(TrackerList.id == list_id).first()
        # Only reposition lists this user can access.
        if lst and (lst.owner_sub == sub or db.query(TrackerShare).filter(
            TrackerShare.list_id == lst.id, TrackerShare.sub == sub).first()):
            row = db.query(TrackerListPosition).filter(
                TrackerListPosition.sub == sub, TrackerListPosition.list_id == lst.id).first()
            if row:
                row.position = i
            else:
                db.add(TrackerListPosition(sub=sub, list_id=lst.id, position=i))
            applied.append((str(lst.id), i))
    db.commit()
    # Only this user's other sessions need to learn about the new order.
    source = request.headers.get("x-source-id")
    for list_id, position in applied:
        await broadcast_to_user(sub, "tracker.updated",
                                {"action": "list-reordered", "listId": list_id, "position": position},
                                source_id=source)
    return {"status": "ok"}


# ----- sharing -----

@router.post("/lists/{list_id}/shares", response_model=TrackerListSchema)
async def add_share(
    list_id: UUID,
    payload: TrackerShareCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    lst = _get_list(db, list_id, sub, owner_only=True)

    target_sub = payload.sub
    if not target_sub and payload.email:
        u = db.query(User).filter(func.lower(User.email) == payload.email.strip().lower()).first()
        if not u:
            raise HTTPException(status_code=404, detail="No user with that email has signed in yet")
        target_sub = u.sub
    if not target_sub:
        raise HTTPException(status_code=400, detail="Provide an email or sub to share with")
    if target_sub == lst.owner_sub:
        raise HTTPException(status_code=400, detail="You already own this list")

    existing = db.query(TrackerShare).filter(
        TrackerShare.list_id == list_id, TrackerShare.sub == target_sub
    ).first()
    if not existing:
        db.add(TrackerShare(list_id=list_id, sub=target_sub))
        db.commit()
        db.refresh(lst)
    elif existing.left_at is not None:
        existing.left_at = None  # re-activate a share the member had left
        db.commit()
        db.refresh(lst)

    data = _list_dict(db, lst, sub)
    # Owner + all members (including the newly added one) learn about the share,
    # each with their own is_owner perspective.
    await _broadcast_list(db, lst, "list-shared", request.headers.get("x-source-id"),
                          extra_subs=(target_sub,))
    return data


@router.delete("/lists/{list_id}/shares/{share_sub}", response_model=TrackerListSchema)
async def remove_share(
    list_id: UUID,
    share_sub: str,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    lst = _get_list(db, list_id, sub, owner_only=True)
    audience_before = _audience(lst)
    share = db.query(TrackerShare).filter(
        TrackerShare.list_id == list_id, TrackerShare.sub == share_sub
    ).first()
    if share:
        db.delete(share)
        db.commit()
        db.refresh(lst)
    data = _list_dict(db, lst, sub)
    source = request.headers.get("x-source-id")
    # Tell remaining members the share set changed.
    await _broadcast_list(db, lst, "list-updated", source)
    # Tell the removed user to drop the list.
    if share_sub in audience_before:
        await broadcast_to_user(share_sub, "tracker.updated",
                                {"action": "list-deleted", "listId": str(list_id)}, source_id=source)
    return data


@router.post("/lists/{list_id}/leave", status_code=204)
async def leave_list(
    list_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """A shared (non-owner) member removes their own access. The list itself is
    untouched for the owner, who can re-share later."""
    sub = user.get("sub")
    lst = (
        db.query(TrackerList).options(joinedload(TrackerList.shares))
        .filter(TrackerList.id == list_id).first()
    )
    if not lst:
        return  # idempotent
    if lst.owner_sub == sub:
        raise HTTPException(status_code=400, detail="The owner can't leave their own list")
    share = db.query(TrackerShare).filter(
        TrackerShare.list_id == list_id, TrackerShare.sub == sub
    ).first()
    if not share or share.left_at is not None:
        return  # not an active member — idempotent
    # Soft-delete so the member can undo (rejoin) without the owner re-sharing.
    share.left_at = datetime.utcnow()
    db.commit()
    db.refresh(lst)
    source = request.headers.get("x-source-id")
    # Remaining members (incl. owner) see the updated share set.
    await _broadcast_list(db, lst, "list-updated", source)
    # The leaver's own other sessions drop the list.
    await broadcast_to_user(sub, "tracker.updated",
                            {"action": "list-deleted", "listId": str(list_id)}, source_id=source)


@router.post("/lists/{list_id}/rejoin", response_model=TrackerListSchema)
async def rejoin_list(
    list_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Undo a leave: re-activate the caller's own (left) share. Only a former member
    — someone who still has a share row — can rejoin; this never grants access to a
    list the user was never shared into."""
    sub = user.get("sub")
    lst = (
        db.query(TrackerList).options(joinedload(TrackerList.shares))
        .filter(TrackerList.id == list_id).first()
    )
    if not lst:
        raise HTTPException(status_code=404, detail="List not found")
    share = db.query(TrackerShare).filter(
        TrackerShare.list_id == list_id, TrackerShare.sub == sub
    ).first()
    if not share:
        raise HTTPException(status_code=403, detail="You were not a member of this list")
    if share.left_at is not None:
        share.left_at = None
        db.commit()
        db.refresh(lst)
    data = _list_dict(db, lst, sub)
    source = request.headers.get("x-source-id")
    await _broadcast_list(db, lst, "list-shared", source, extra_subs=(sub,))
    return data


# ----- task endpoints -----

@router.post("/tasks", response_model=TrackerTaskSchema, status_code=201)
async def create_task(
    payload: TrackerTaskCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    lst = _get_list(db, payload.list_id, sub)
    max_pos = db.query(TrackerTask.position).filter(
        TrackerTask.list_id == payload.list_id
    ).order_by(TrackerTask.position.desc()).first()
    next_pos = (max_pos[0] + 1) if max_pos else 0
    task = TrackerTask(
        list_id=payload.list_id,
        name=payload.name.strip(),
        target_interval_days=payload.target_interval_days,
        notes=payload.notes,
        position=next_pos,
        season_start_month=payload.season_start_month,
        season_end_month=payload.season_end_month,
        season_start_day=payload.season_start_day,
        season_end_day=payload.season_end_day,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    data = _task_dict(db, task)
    await _broadcast(lst, "task-added", {"listId": str(lst.id), "task": data},
                     request.headers.get("x-source-id"))
    return data


@router.patch("/tasks/{task_id}", response_model=TrackerTaskSchema)
async def update_task(
    task_id: UUID,
    payload: TrackerTaskUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    task = _get_task(db, task_id, sub)
    if payload.name is not None:
        task.name = payload.name.strip()
    if "target_interval_days" in payload.model_fields_set:
        task.target_interval_days = payload.target_interval_days
    if "notes" in payload.model_fields_set:
        task.notes = payload.notes
    if payload.archived is not None:
        task.archived = payload.archived
    if "season_start_month" in payload.model_fields_set:
        task.season_start_month = payload.season_start_month
    if "season_end_month" in payload.model_fields_set:
        task.season_end_month = payload.season_end_month
    if "season_start_day" in payload.model_fields_set:
        task.season_start_day = payload.season_start_day
    if "season_end_day" in payload.model_fields_set:
        task.season_end_day = payload.season_end_day
    if "snooze_until" in payload.model_fields_set:
        task.snooze_until = payload.snooze_until
    db.commit()
    db.refresh(task)
    lst = _get_list(db, task.list_id, sub)
    data = _task_dict(db, task)
    await _broadcast(lst, "task-updated", {"listId": str(lst.id), "task": data},
                     request.headers.get("x-source-id"))
    return data


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(
    task_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    task = db.query(TrackerTask).filter(TrackerTask.id == task_id).first()
    if not task:
        return  # idempotent
    list_id = task.list_id
    lst = _get_list(db, list_id, sub)
    db.delete(task)
    db.commit()
    db.refresh(lst)
    await _broadcast(lst, "task-deleted", {"listId": str(list_id), "taskId": str(task_id)},
                     request.headers.get("x-source-id"))


@router.patch("/lists/{list_id}/reorder-tasks")
async def reorder_tasks(
    list_id: UUID,
    payload: TrackerReorderTasks,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    lst = _get_list(db, list_id, sub)
    for i, task_id in enumerate(payload.task_ids):
        task = db.query(TrackerTask).filter(
            TrackerTask.id == task_id, TrackerTask.list_id == list_id
        ).first()
        if task:
            task.position = i
    db.commit()
    tasks = db.query(TrackerTask).filter(
        TrackerTask.list_id == list_id
    ).order_by(TrackerTask.position.asc()).all()
    await _broadcast(lst, "tasks-reordered", {
        "listId": str(list_id),
        "tasks": [{"id": str(t.id), "position": t.position} for t in tasks],
    }, request.headers.get("x-source-id"))
    return {"status": "ok"}


# ----- completion logs -----

@router.get("/tasks/{task_id}/logs", response_model=list[TrackerLogSchema])
async def list_logs(
    task_id: UUID,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    task = _get_task(db, task_id, sub)
    logs = (
        db.query(TrackerLog)
        .filter(TrackerLog.task_id == task.id)
        .order_by(TrackerLog.done_at.desc())
        .all()
    )
    return [_log_dict(db, l) for l in logs]


@router.post("/tasks/{task_id}/logs", response_model=TrackerLogSchema, status_code=201)
async def add_log(
    task_id: UUID,
    payload: TrackerLogCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    task = _get_task(db, task_id, sub)
    # Completions may be attributed to a collaborator; default to the current user.
    attributed = payload.created_by_sub or sub
    log = TrackerLog(
        task_id=task_id,
        done_at=_naive_utc(payload.done_at) or datetime.utcnow(),
        kind="skip" if payload.kind == "skip" else "done",
        note=payload.note,
        created_by_sub=attributed,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    db.refresh(task)
    lst = _get_list(db, task.list_id, sub)
    await _broadcast(lst, "task-logged", {"listId": str(lst.id), "task": _task_dict(db, task)},
                     request.headers.get("x-source-id"))
    return _log_dict(db, log)


@router.post("/tasks/{task_id}/skip", response_model=TrackerTaskSchema)
async def skip_task(
    task_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Skip this cycle — logs a skip entry (visible in history) that resets
    recency without counting as a completion."""
    sub = user.get("sub")
    task = _get_task(db, task_id, sub)
    db.add(TrackerLog(task_id=task_id, done_at=datetime.utcnow(), kind="skip", created_by_sub=sub))
    db.commit()
    db.refresh(task)
    lst = _get_list(db, task.list_id, sub)
    data = _task_dict(db, task)
    await _broadcast(lst, "task-updated", {"listId": str(lst.id), "task": data},
                     request.headers.get("x-source-id"))
    return data


@router.delete("/logs/{log_id}", status_code=204)
async def delete_log(
    log_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    log = db.query(TrackerLog).filter(TrackerLog.id == log_id).first()
    if not log:
        return  # idempotent
    task = _get_task(db, log.task_id, sub)
    db.delete(log)
    db.commit()
    db.refresh(task)
    lst = _get_list(db, task.list_id, sub)
    await _broadcast(lst, "task-logged", {"listId": str(lst.id), "task": _task_dict(db, task)},
                     request.headers.get("x-source-id"))
