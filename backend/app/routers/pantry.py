from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user
from app.routers.stores import to_title_case
from app.database import get_db
from app.models import PantrySection, PantryItem
from app.schemas import (
    PantrySectionSchema,
    PantryItemSchema,
    PantryItemCreate,
    PantryItemUpdate,
    PantryReplacePayload,
    PantryReorderSections,
    PantryReorderItems,
    PantrySectionUpdate,
    PantryMoveItem,
)
from app.realtime import broadcast_event

router = APIRouter(prefix="/api/pantry", tags=["pantry"])


@router.get("", response_model=list[PantrySectionSchema])
async def list_pantry(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sections = (
        db.query(PantrySection)
        .options(joinedload(PantrySection.items))
        .order_by(PantrySection.position.asc())
        .all()
    )
    for section in sections:
        section.items.sort(key=lambda item: item.position)
    return sections


@router.put("", response_model=list[PantrySectionSchema])
async def replace_pantry(
    payload: PantryReplacePayload,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # Delete all existing sections (cascades to items)
    db.query(PantrySection).delete()
    db.flush()

    for i, sec in enumerate(payload.sections):
        section = PantrySection(name=to_title_case(sec.name), position=i)
        db.add(section)
        db.flush()
        for j, item in enumerate(sec.items):
            pantry_item = PantryItem(
                section_id=section.id,
                name=item.name,
                quantity=item.quantity,
                position=j,
            )
            db.add(pantry_item)
        db.flush()

    db.commit()
    result = (
        db.query(PantrySection)
        .options(joinedload(PantrySection.items))
        .order_by(PantrySection.position.asc())
        .all()
    )
    for section in result:
        section.items.sort(key=lambda item: item.position)
    await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
    return result


@router.patch("/sections/{section_id}", response_model=PantrySectionSchema)
async def update_section(
    section_id: UUID,
    payload: PantrySectionUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    section = db.query(PantrySection).options(joinedload(PantrySection.items)).filter(PantrySection.id == section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    section.name = to_title_case(payload.name)
    db.commit()
    db.refresh(section)
    section.items.sort(key=lambda item: item.position)
    await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
    return section


@router.patch("/reorder-sections")
async def reorder_sections(
    payload: PantryReorderSections,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    for i, section_id in enumerate(payload.section_ids):
        section = db.query(PantrySection).filter(PantrySection.id == section_id).first()
        if section:
            section.position = i
    db.commit()
    await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
    return {"status": "ok"}


@router.patch("/sections/{section_id}/reorder-items")
async def reorder_items(
    section_id: UUID,
    payload: PantryReorderItems,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    section = db.query(PantrySection).filter(PantrySection.id == section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    for i, item_id in enumerate(payload.item_ids):
        item = db.query(PantryItem).filter(
            PantryItem.id == item_id,
            PantryItem.section_id == section_id,
        ).first()
        if item:
            item.position = i
    db.commit()
    await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
    return {"status": "ok"}


@router.post("/items", response_model=PantryItemSchema)
async def add_pantry_item(
    payload: PantryItemCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    section = db.query(PantrySection).filter(PantrySection.id == payload.section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    # Get max position in this section
    max_pos = db.query(PantryItem.position).filter(
        PantryItem.section_id == payload.section_id
    ).order_by(PantryItem.position.desc()).first()
    next_pos = (max_pos[0] + 1) if max_pos else 0

    item = PantryItem(
        section_id=payload.section_id,
        name=name,
        quantity=payload.quantity,
        position=next_pos,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    await broadcast_event("pantry.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
    return item


@router.put("/items/{item_id}", response_model=PantryItemSchema)
async def update_pantry_item(
    item_id: UUID,
    payload: PantryItemUpdate,
    request: Request,
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
    await broadcast_event("pantry.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
    return item


@router.patch("/items/{item_id}/move", response_model=PantryItemSchema)
async def move_pantry_item(
    item_id: UUID,
    payload: PantryMoveItem,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    item = db.query(PantryItem).filter(PantryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    target = db.query(PantrySection).filter(PantrySection.id == payload.to_section_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Target section not found")

    old_section_id = item.section_id
    item.section_id = payload.to_section_id
    item.position = payload.to_position

    # Reposition items in source section (fill the gap)
    source_items = db.query(PantryItem).filter(
        PantryItem.section_id == old_section_id
    ).order_by(PantryItem.position).all()
    for i, si in enumerate(source_items):
        si.position = i

    # Reposition items in target section (make room)
    target_items = db.query(PantryItem).filter(
        PantryItem.section_id == payload.to_section_id
    ).order_by(PantryItem.position).all()
    for i, ti in enumerate(target_items):
        ti.position = i

    db.commit()
    db.refresh(item)
    await broadcast_event("pantry.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
    return item


@router.post("/sections", response_model=PantrySectionSchema)
async def create_pantry_section(
    payload: PantrySectionUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    name = to_title_case(payload.name)
    existing = db.query(PantrySection).filter(PantrySection.name == name).first()
    if existing:
        return existing
    max_pos = db.query(PantrySection.position).order_by(PantrySection.position.desc()).first()
    next_pos = (max_pos[0] + 1) if max_pos else 0
    section = PantrySection(name=name, position=next_pos)
    db.add(section)
    db.commit()
    db.refresh(section)
    await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
    return section


@router.delete("/sections/{section_id}")
async def delete_pantry_section(
    section_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    section = db.query(PantrySection).filter(PantrySection.id == section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    db.delete(section)
    db.commit()
    await broadcast_event("pantry.updated", {"id": str(section_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
    return {"status": "deleted"}


@router.delete("/items/{item_id}")
async def delete_pantry_item(
    item_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    item = db.query(PantryItem).filter(PantryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(item)
    db.commit()
    await broadcast_event("pantry.updated", {"id": str(item_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
    return {"status": "deleted"}


@router.delete("/items", response_model=list[PantrySectionSchema])
async def clear_pantry_items(
    request: Request,
    mode: str = Query(..., pattern="^(all)$"),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Clear all items from the pantry."""
    if mode == "all":
        db.query(PantrySection).delete()

    db.commit()

    result = (
        db.query(PantrySection)
        .options(joinedload(PantrySection.items))
        .order_by(PantrySection.position.asc())
        .all()
    )
    for section in result:
        section.items.sort(key=lambda item: item.position)
    await broadcast_event("pantry.updated", {}, source_id=request.headers.get("x-source-id"))
    return result
