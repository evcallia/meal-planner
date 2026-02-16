from fastapi import APIRouter, Request, Depends
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


@router.get("/me", response_model=UserInfo | None)
async def get_me(user: dict | None = Depends(get_optional_user)):
    """Get current user info."""
    if user:
        return UserInfo(**user)
    return None
