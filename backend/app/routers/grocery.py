from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session, joinedload

from app.auth import get_current_user
from app.database import get_db
from app.models import GrocerySection, GroceryItem, Store, ItemDefault
from app.schemas import (
    GrocerySectionSchema,
    GroceryItemSchema,
    GroceryItemCreate,
    GroceryItemUpdate,
    GroceryReplacePayload,
    GroceryReorderSections,
    GroceryReorderItems,
    GrocerySectionUpdate,
    GroceryMoveItem,
)
from app.realtime import broadcast_event

router = APIRouter(prefix="/api/grocery", tags=["grocery"])


@router.get("", response_model=list[GrocerySectionSchema])
async def list_grocery(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sections = (
        db.query(GrocerySection)
        .options(joinedload(GrocerySection.items))
        .order_by(GrocerySection.position.asc())
        .all()
    )
    # Sort items within each section: unchecked first by position, checked last by position
    for section in sections:
        section.items.sort(key=lambda item: (item.checked, item.position))
    return sections


@router.put("", response_model=list[GrocerySectionSchema])
async def replace_grocery(
    payload: GroceryReplacePayload,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # Delete all existing sections (cascades to items)
    db.query(GrocerySection).delete()
    db.flush()

    sections = []
    for i, sec in enumerate(payload.sections):
        section = GrocerySection(name=sec.name, position=i)
        db.add(section)
        db.flush()
        for j, item in enumerate(sec.items):
            # Auto-populate store from item_defaults if not provided
            store_id = item.store_id
            if store_id is None:
                default = db.query(ItemDefault).filter(
                    ItemDefault.item_name == item.name.strip().lower()
                ).first()
                if default and default.store_id:
                    store_id = default.store_id
            grocery_item = GroceryItem(
                section_id=section.id,
                name=item.name,
                quantity=item.quantity,
                checked=item.checked,
                position=j,
                store_id=store_id,
            )
            db.add(grocery_item)
        db.flush()
        sections.append(section)

    db.commit()
    # Re-query to get full data with items
    result = (
        db.query(GrocerySection)
        .options(joinedload(GrocerySection.items))
        .order_by(GrocerySection.position.asc())
        .all()
    )
    for section in result:
        section.items.sort(key=lambda item: (item.checked, item.position))
    await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
    return result


@router.patch("/sections/{section_id}", response_model=GrocerySectionSchema)
async def update_section(
    section_id: UUID,
    payload: GrocerySectionUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    section = db.query(GrocerySection).options(joinedload(GrocerySection.items)).filter(GrocerySection.id == section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    section.name = payload.name.strip()
    db.commit()
    db.refresh(section)
    section.items.sort(key=lambda item: (item.checked, item.position))
    await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
    return section


@router.delete("/sections/{section_id}", status_code=204)
async def delete_section(
    section_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    section = db.query(GrocerySection).options(joinedload(GrocerySection.items)).filter(GrocerySection.id == section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    if len(section.items) > 0:
        raise HTTPException(status_code=400, detail="Cannot delete section with items")
    db.delete(section)
    db.commit()
    await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))


@router.patch("/reorder-sections")
async def reorder_sections(
    payload: GroceryReorderSections,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    for i, section_id in enumerate(payload.section_ids):
        section = db.query(GrocerySection).filter(GrocerySection.id == section_id).first()
        if section:
            section.position = i
    db.commit()
    await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
    return {"status": "ok"}


@router.patch("/sections/{section_id}/reorder-items")
async def reorder_items(
    section_id: UUID,
    payload: GroceryReorderItems,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    section = db.query(GrocerySection).filter(GrocerySection.id == section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    for i, item_id in enumerate(payload.item_ids):
        item = db.query(GroceryItem).filter(
            GroceryItem.id == item_id,
            GroceryItem.section_id == section_id,
        ).first()
        if item:
            item.position = i
    db.commit()
    await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
    return {"status": "ok"}


@router.patch("/items/{item_id}", response_model=GroceryItemSchema)
async def update_grocery_item(
    item_id: UUID,
    payload: GroceryItemUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    item = db.query(GroceryItem).filter(GroceryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    if payload.checked is not None:
        item.checked = payload.checked
    if payload.name is not None:
        item.name = payload.name.strip()
        # If item has no store and name changed, check item_defaults for the new name
        if 'store_id' not in payload.model_fields_set and item.store_id is None:
            default = db.query(ItemDefault).filter(
                ItemDefault.item_name == item.name.strip().lower()
            ).first()
            if default and default.store_id:
                item.store_id = default.store_id
    if 'quantity' in payload.model_fields_set:
        item.quantity = payload.quantity if payload.quantity else None
    if 'store_id' in payload.model_fields_set:
        item.store_id = payload.store_id
        # Upsert item_defaults
        normalized_name = item.name.strip().lower()
        if payload.store_id is not None:
            default = db.query(ItemDefault).filter(
                ItemDefault.item_name == normalized_name
            ).first()
            if default:
                default.store_id = payload.store_id
            else:
                db.add(ItemDefault(item_name=normalized_name, store_id=payload.store_id))
        else:
            # Clearing store — also clear the default
            default = db.query(ItemDefault).filter(
                ItemDefault.item_name == normalized_name
            ).first()
            if default:
                default.store_id = None
    db.commit()
    db.refresh(item)
    await broadcast_event("grocery.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
    return item


@router.post("/items", response_model=GroceryItemSchema)
async def add_grocery_item(
    payload: GroceryItemCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    section = db.query(GrocerySection).filter(GrocerySection.id == payload.section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    # Get max position in this section
    max_pos = db.query(GroceryItem.position).filter(
        GroceryItem.section_id == payload.section_id
    ).order_by(GroceryItem.position.desc()).first()
    next_pos = (max_pos[0] + 1) if max_pos else 0

    # Auto-populate store from item_defaults if not provided
    store_id = payload.store_id
    if store_id is None:
        default = db.query(ItemDefault).filter(
            ItemDefault.item_name == payload.name.strip().lower()
        ).first()
        if default and default.store_id:
            store_id = default.store_id

    item = GroceryItem(
        section_id=payload.section_id,
        name=payload.name.strip(),
        quantity=payload.quantity,
        position=next_pos,
        store_id=store_id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    await broadcast_event("grocery.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
    return item


@router.patch("/items/{item_id}/move", response_model=GroceryItemSchema)
async def move_grocery_item(
    item_id: UUID,
    payload: GroceryMoveItem,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    item = db.query(GroceryItem).filter(GroceryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    target = db.query(GrocerySection).filter(GrocerySection.id == payload.to_section_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Target section not found")

    old_section_id = item.section_id
    item.section_id = payload.to_section_id
    item.position = payload.to_position

    # Reposition items in source section (fill the gap)
    source_items = db.query(GroceryItem).filter(
        GroceryItem.section_id == old_section_id
    ).order_by(GroceryItem.position).all()
    for i, si in enumerate(source_items):
        si.position = i

    # Reposition items in target section (make room)
    target_items = db.query(GroceryItem).filter(
        GroceryItem.section_id == payload.to_section_id
    ).order_by(GroceryItem.position).all()
    for i, ti in enumerate(target_items):
        ti.position = i

    db.commit()
    db.refresh(item)
    await broadcast_event("grocery.updated", {"id": str(item.id)}, source_id=request.headers.get("x-source-id"))
    return item


@router.delete("/items/{item_id}")
async def delete_grocery_item(
    item_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    item = db.query(GroceryItem).filter(GroceryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(item)
    db.commit()
    await broadcast_event("grocery.updated", {"id": str(item_id), "deleted": True}, source_id=request.headers.get("x-source-id"))
    return {"status": "deleted"}


@router.delete("/items", response_model=list[GrocerySectionSchema])
async def clear_grocery_items(
    request: Request,
    mode: str = Query(..., pattern="^(checked|all)$"),
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Clear checked items or all items from the grocery list."""
    if mode == "all":
        db.query(GrocerySection).delete()
    elif mode == "checked":
        db.query(GroceryItem).filter(GroceryItem.checked.is_(True)).delete()
        # Remove empty sections
        sections = db.query(GrocerySection).options(joinedload(GrocerySection.items)).all()
        for section in sections:
            if len(section.items) == 0:
                db.delete(section)

    db.commit()

    result = (
        db.query(GrocerySection)
        .options(joinedload(GrocerySection.items))
        .order_by(GrocerySection.position.asc())
        .all()
    )
    for section in result:
        section.items.sort(key=lambda item: (item.checked, item.position))
    await broadcast_event("grocery.updated", {}, source_id=request.headers.get("x-source-id"))
    return result
