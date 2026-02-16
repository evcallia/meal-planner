from authlib.integrations.starlette_client import OAuth
from fastapi import Request, HTTPException
from fastapi.responses import RedirectResponse

from app.config import get_settings

settings = get_settings()

oauth = OAuth()

# Configure OIDC provider
if settings.oidc_issuer:
    oauth.register(
        name="authentik",
        client_id=settings.oidc_client_id,
        client_secret=settings.oidc_client_secret,
        server_metadata_url=f"{settings.oidc_issuer}/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


async def get_current_user(request: Request) -> dict | None:
    """Get current user from session."""
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


async def get_optional_user(request: Request) -> dict | None:
    """Get current user if logged in, otherwise None."""
    return request.session.get("user")


async def login(request: Request):
    """Redirect to OIDC provider for login."""
    if not settings.oidc_issuer:
        raise HTTPException(status_code=500, detail="OIDC not configured")

    redirect_uri = settings.oidc_redirect_uri
    return await oauth.authentik.authorize_redirect(request, redirect_uri)


async def callback(request: Request):
    """Handle OIDC callback."""
    if not settings.oidc_issuer:
        raise HTTPException(status_code=500, detail="OIDC not configured")

    token = await oauth.authentik.authorize_access_token(request)
    user_info = token.get("userinfo")

    if not user_info:
        raise HTTPException(status_code=400, detail="Failed to get user info")

    # Store user in session
    request.session["user"] = {
        "sub": user_info.get("sub"),
        "email": user_info.get("email"),
        "name": user_info.get("name") or user_info.get("preferred_username"),
    }

    return RedirectResponse(url=settings.frontend_url)


async def logout(request: Request):
    """Clear session and logout."""
    request.session.clear()
    return {"status": "logged out"}
