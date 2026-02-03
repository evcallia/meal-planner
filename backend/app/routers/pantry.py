from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import PantryItem
from app.schemas import PantryItemSchema, PantryItemCreate, PantryItemUpdate
from app.realtime import broadcast_event

router = APIRouter(prefix="/api/pantry", tags=["pantry"])


@router.get("", response_model=list[PantryItemSchema])
async def list_pantry_items(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    items = db.query(PantryItem).order_by(PantryItem.name.asc()).all()
    return items


@router.post("", response_model=PantryItemSchema)
async def create_pantry_item(
    payload: PantryItemCreate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    item = PantryItem(name=name, quantity=payload.quantity)
    db.add(item)
    db.commit()
    db.refresh(item)
    await broadcast_event("pantry.updated", {"id": str(item.id)})
    return item


@router.put("/{item_id}", response_model=PantryItemSchema)
async def update_pantry_item(
    item_id: UUID,
    payload: PantryItemUpdate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    item = db.query(PantryItem).filter(PantryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name is required")
        item.name = name
    if payload.quantity is not None:
        item.quantity = payload.quantity
    db.commit()
    db.refresh(item)
    await broadcast_event("pantry.updated", {"id": str(item.id)})
    return item


@router.delete("/{item_id}")
async def delete_pantry_item(
    item_id: UUID,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    item = db.query(PantryItem).filter(PantryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(item)
    db.commit()
    await broadcast_event("pantry.updated", {"id": str(item.id), "deleted": True})
    return {"status": "deleted"}
