from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import MealIdea
from app.schemas import MealIdeaSchema, MealIdeaCreate, MealIdeaUpdate
from app.realtime import broadcast_event

router = APIRouter(prefix="/api/meal-ideas", tags=["meal-ideas"])


@router.get("", response_model=list[MealIdeaSchema])
async def list_meal_ideas(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ideas = db.query(MealIdea).order_by(MealIdea.updated_at.desc()).all()
    return ideas


@router.post("", response_model=MealIdeaSchema)
async def create_meal_idea(
    payload: MealIdeaCreate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    idea = MealIdea(title=title)
    db.add(idea)
    db.commit()
    db.refresh(idea)
    await broadcast_event("meal-ideas.updated", {"id": str(idea.id)})
    return idea


@router.put("/{idea_id}", response_model=MealIdeaSchema)
async def update_meal_idea(
    idea_id: UUID,
    payload: MealIdeaUpdate,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    idea = db.query(MealIdea).filter(MealIdea.id == idea_id).first()
    if not idea:
        raise HTTPException(status_code=404, detail="Idea not found")
    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title is required")
        idea.title = title
    db.commit()
    db.refresh(idea)
    await broadcast_event("meal-ideas.updated", {"id": str(idea.id)})
    return idea


@router.delete("/{idea_id}")
async def delete_meal_idea(
    idea_id: UUID,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    idea = db.query(MealIdea).filter(MealIdea.id == idea_id).first()
    if not idea:
        raise HTTPException(status_code=404, detail="Idea not found")
    db.delete(idea)
    db.commit()
    await broadcast_event("meal-ideas.updated", {"id": str(idea.id), "deleted": True})
    return {"status": "deleted"}
