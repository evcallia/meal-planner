import time

import httpx
from authlib.integrations.starlette_client import OAuth
from fastapi import Request, HTTPException
from fastapi.responses import RedirectResponse

from app.config import get_settings

settings = get_settings()

oauth = OAuth()

# How often (in seconds) to re-validate the access token against the OIDC provider.
# Between checks, the cached session user is trusted.
TOKEN_REVALIDATION_INTERVAL = 60 #* 60  # 1 hour

# Configure OIDC provider
if settings.oidc_issuer:
    oauth.register(
        name="authentik",
        client_id=settings.oidc_client_id,
        client_secret=settings.oidc_client_secret,
        server_metadata_url=f"{settings.oidc_issuer}/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile offline_access"},
    )


async def _validate_token(request: Request) -> bool:
    """Validate the stored access token against the OIDC userinfo endpoint.

    Returns True if the token is still valid, False if revoked/expired.
    On network errors, returns True (fail-open) to avoid locking out users
    when Authentik is temporarily unreachable.
    """
    access_token = request.session.get("access_token")
    if not access_token or not settings.oidc_issuer:
        return True  # No token to validate or OIDC not configured

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{settings.oidc_issuer}/application/o/userinfo/",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if resp.status_code == 200:
                request.session["token_validated_at"] = int(time.time())
                return True
            if resp.status_code in (401, 403):
                # Token revoked or expired — try refresh token
                return await _try_refresh_token(request)
            # Other errors: fail-open
            return True
    except httpx.HTTPError:
        # Network error reaching Authentik: fail-open
        return True


async def _try_refresh_token(request: Request) -> bool:
    """Attempt to use the refresh token to get a new access token.

    Returns True if refresh succeeded, False if it failed (user must re-login).
    """
    refresh_token = request.session.get("refresh_token")
    if not refresh_token or not settings.oidc_issuer:
        return False

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{settings.oidc_issuer}/application/o/token/",
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": settings.oidc_client_id,
                    "client_secret": settings.oidc_client_secret,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                request.session["access_token"] = data.get("access_token", "")
                if data.get("refresh_token"):
                    request.session["refresh_token"] = data["refresh_token"]
                request.session["token_validated_at"] = int(time.time())
                return True
            return False
    except httpx.HTTPError:
        # Network error: fail-open (keep existing session)
        return True


async def _needs_revalidation(request: Request) -> bool:
    """Check whether the stored token should be re-validated."""
    validated_at = request.session.get("token_validated_at")
    if validated_at is None:
        # Legacy session without token — don't revalidate (no token to check)
        return False
    return (int(time.time()) - validated_at) >= TOKEN_REVALIDATION_INTERVAL


async def get_current_user(request: Request) -> dict | None:
    """Get current user from session, revalidating token periodically."""
    user = request.session.get("user")
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if await _needs_revalidation(request):
        if not await _validate_token(request):
            request.session.clear()
            raise HTTPException(status_code=401, detail="Session expired")

    return user


async def get_optional_user(request: Request) -> dict | None:
    """Get current user if logged in, otherwise None.

    Also validates the token periodically — if validation fails,
    clears the session and returns None (as if not logged in).
    """
    user = request.session.get("user")
    if not user:
        return None

    if await _needs_revalidation(request):
        if not await _validate_token(request):
            request.session.clear()
            return None

    return user


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

    # Store user info and tokens in session
    request.session["user"] = {
        "sub": user_info.get("sub"),
        "email": user_info.get("email"),
        "name": user_info.get("name") or user_info.get("preferred_username"),
    }
    request.session["access_token"] = token.get("access_token")
    request.session["refresh_token"] = token.get("refresh_token")
    request.session["token_validated_at"] = int(time.time())

    return RedirectResponse(url=settings.frontend_url)


async def logout(request: Request):
    """Clear session and logout."""
    request.session.clear()
    return {"status": "logged out"}
