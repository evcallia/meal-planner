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
    return name.strip().title()


@router.get("", response_model=list[StoreSchema])
async def list_stores(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    stores = db.query(Store).order_by(Store.position.asc(), Store.name.asc()).all()
    print(f"[Stores] GET /api/stores returning {len(stores)} stores")
    return stores


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
    await broadcast_event("stores.updated", {"id": str(store.id)}, source_id=request.headers.get("x-source-id"))
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
    await broadcast_event("stores.updated", {}, source_id=request.headers.get("x-source-id"))
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
    await broadcast_event("stores.updated", {"id": str(store.id)}, source_id=request.headers.get("x-source-id"))
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
        raise HTTPException(status_code=404, detail="Store not found")
    db.delete(store)
    db.commit()
    await broadcast_event("stores.updated", {"id": str(store_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
    return {"status": "deleted"}
