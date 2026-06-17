from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import User
from app.schemas import TrackerDirectoryUser

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=list[TrackerDirectoryUser])
async def list_users(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """Directory of other users who have signed in — used to pick someone to
    share a list with. Excludes the current user."""
    sub = user.get("sub")
    rows = db.query(User).filter(User.sub != sub).order_by(User.name.asc()).all()
    return [TrackerDirectoryUser(sub=r.sub, email=r.email, name=r.name) for r in rows]
