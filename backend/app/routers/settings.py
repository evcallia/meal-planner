from datetime import datetime

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.models import UserSettings
from app.schemas import UserSettingsResponse, UserSettingsUpdate
from app.realtime import broadcast_to_user

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=UserSettingsResponse)
async def get_settings(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    row = db.query(UserSettings).filter(UserSettings.sub == sub).first()
    if not row:
        return UserSettingsResponse(settings={}, updated_at=None)
    return UserSettingsResponse(settings=row.settings, updated_at=row.updated_at)


@router.put("", response_model=UserSettingsResponse)
async def put_settings(
    payload: UserSettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    sub = user.get("sub")
    row = db.query(UserSettings).filter(UserSettings.sub == sub).first()
    if row:
        row.settings = payload.settings
        row.updated_at = payload.updated_at
    else:
        row = UserSettings(sub=sub, settings=payload.settings, updated_at=payload.updated_at)
        db.add(row)
    db.commit()
    db.refresh(row)

    await broadcast_to_user(
        sub,
        "settings.updated",
        {"settings": row.settings, "updated_at": row.updated_at.isoformat()},
        source_id=request.headers.get("x-source-id"),
    )

    return UserSettingsResponse(settings=row.settings, updated_at=row.updated_at)
