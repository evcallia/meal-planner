from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import Store
from app.schemas import StoreSchema, StoreCreate, StoreUpdate, StoreReorder
from app.realtime import broadcast_event

router = APIRouter(prefix="/api/stores", tags=["stores"])


def to_title_case(name: str) -> str:
    # Python's str.title() capitalizes after any non-alpha char (e.g. "joe's" → "Joe'S").
    # Only capitalize after whitespace/start of string to preserve apostrophes.
    import re  # noqa: PLC0415
    return re.sub(r"(^|\s)(\S)", lambda m: m.group(1) + m.group(2).upper(), name.strip())


@router.get("", response_model=list[StoreSchema])
async def list_stores(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    return db.query(Store).order_by(Store.position.asc(), Store.name.asc()).all()


@router.post("", response_model=StoreSchema)
async def create_store(
    payload: StoreCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    name = to_title_case(payload.name)
    existing = db.query(Store).filter(Store.name.ilike(name)).first()
    if existing:
        return existing

    max_pos = db.query(Store.position).order_by(Store.position.desc()).first()
    next_pos = payload.position if payload.position is not None else ((max_pos[0] + 1) if max_pos else 0)

    store = Store(name=name, position=next_pos)
    db.add(store)
    db.commit()
    db.refresh(store)
    await broadcast_event("stores.updated", {
        "action": "added",
        "store": StoreSchema.model_validate(store).model_dump(mode="json"),
    }, source_id=request.headers.get("x-source-id"))
    return store


@router.patch("/reorder", response_model=dict)
async def reorder_stores(
    payload: StoreReorder,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    for i, store_id in enumerate(payload.store_ids):
        db.query(Store).filter(Store.id == store_id).update({"position": i})
    db.commit()
    stores = db.query(Store).order_by(Store.position.asc()).all()
    await broadcast_event("stores.updated", {
        "action": "reordered",
        "stores": [{"id": str(s.id), "position": s.position} for s in stores],
    }, source_id=request.headers.get("x-source-id"))
    return {"status": "ok"}


@router.patch("/{store_id}", response_model=StoreSchema)
async def update_store(
    store_id: UUID,
    payload: StoreUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        raise HTTPException(status_code=404, detail="Store not found")

    if payload.name is not None:
        name = to_title_case(payload.name)
        existing = db.query(Store).filter(Store.name.ilike(name), Store.id != store_id).first()
        if existing:
            raise HTTPException(status_code=409, detail="Store name already exists")
        store.name = name
    if payload.position is not None:
        store.position = payload.position

    db.commit()
    db.refresh(store)
    await broadcast_event("stores.updated", {
        "action": "updated",
        "store": StoreSchema.model_validate(store).model_dump(mode="json"),
    }, source_id=request.headers.get("x-source-id"))
    return store


@router.delete("/{store_id}")
async def delete_store(
    store_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    store = db.query(Store).filter(Store.id == store_id).first()
    if not store:
        return {"status": "ok"}  # Idempotent — already deleted
    db.delete(store)
    db.commit()
    await broadcast_event("stores.updated", {
        "action": "deleted",
        "storeId": str(store_id),
    }, source_id=request.headers.get("x-source-id"))
    return {"status": "deleted"}
