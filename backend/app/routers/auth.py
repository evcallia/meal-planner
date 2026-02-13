from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import RedirectResponse

from app.auth import login, callback, logout, get_current_user, get_optional_user
from app.schemas import UserInfo

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/login")
async def auth_login(request: Request):
    """Redirect to OIDC provider for login."""
    return await login(request)


@router.get("/callback")
async def auth_callback(request: Request):
    """Handle OIDC callback."""
    return await callback(request)


@router.post("/logout")
async def auth_logout(request: Request):
    """Logout and clear session."""
    return await logout(request)


@router.get("/me")
async def get_me(request: Request):
    """Get current user info, or 401 if not authenticated."""
    user = await get_optional_user(request)
    if user:
        return UserInfo(**user)
    raise HTTPException(status_code=401, detail="Not authenticated")
