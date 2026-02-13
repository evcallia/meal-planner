import time
import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
import httpx

from app.auth import (
    get_current_user, get_optional_user, login, callback,
    _validate_token, _try_refresh_token, _needs_revalidation,
    TOKEN_REVALIDATION_INTERVAL,
)


class TestAuthentication:
    """Test authentication functions."""

    def test_get_current_user_authenticated(self, client: TestClient):
        """Test getting current user when authenticated."""
        # Create a mock request with user session
        class MockRequest:
            def __init__(self):
                self.session = {"user": {"sub": "123", "email": "test@example.com"}}
        
        request = MockRequest()
        
        # Should return user data
        result = pytest.importorskip("asyncio").run(get_current_user(request))
        assert result["sub"] == "123"
        assert result["email"] == "test@example.com"

    def test_get_current_user_not_authenticated(self, client: TestClient):
        """Test getting current user when not authenticated."""
        # Create a mock request without user session
        class MockRequest:
            def __init__(self):
                self.session = {}
        
        request = MockRequest()
        
        # Should raise HTTPException
        with pytest.raises(HTTPException) as exc_info:
            pytest.importorskip("asyncio").run(get_current_user(request))
        
        assert exc_info.value.status_code == 401
        assert exc_info.value.detail == "Not authenticated"

    def test_get_optional_user_authenticated(self, client: TestClient):
        """Test getting optional user when authenticated."""
        class MockRequest:
            def __init__(self):
                self.session = {"user": {"sub": "123", "email": "test@example.com"}}
        
        request = MockRequest()
        
        result = pytest.importorskip("asyncio").run(get_optional_user(request))
        assert result["sub"] == "123"
        assert result["email"] == "test@example.com"

    def test_get_optional_user_not_authenticated(self, client: TestClient):
        """Test getting optional user when not authenticated."""
        class MockRequest:
            def __init__(self):
                self.session = {}
        
        request = MockRequest()
        
        result = pytest.importorskip("asyncio").run(get_optional_user(request))
        assert result is None

    @patch("app.auth.settings")
    def test_login_oidc_not_configured(self, mock_settings, client: TestClient):
        """Test login when OIDC is not configured."""
        mock_settings.oidc_issuer = None
        
        class MockRequest:
            pass
        
        request = MockRequest()
        
        with pytest.raises(HTTPException) as exc_info:
            pytest.importorskip("asyncio").run(login(request))
        
        assert exc_info.value.status_code == 500
        assert exc_info.value.detail == "OIDC not configured"

    @patch("app.auth.oauth")
    @patch("app.auth.settings")
    def test_login_oidc_configured(self, mock_settings, mock_oauth, client: TestClient):
        """Test login when OIDC is configured."""
        mock_settings.oidc_issuer = "https://auth.example.com"
        mock_settings.oidc_redirect_uri = "http://localhost:8000/api/auth/callback"
        
        # Mock the OAuth authorize_redirect method
        mock_oauth.authentik.authorize_redirect = AsyncMock(return_value="redirect_response")
        
        class MockRequest:
            pass
        
        request = MockRequest()
        
        result = pytest.importorskip("asyncio").run(login(request))
        assert result == "redirect_response"
        mock_oauth.authentik.authorize_redirect.assert_called_once_with(
            request, "http://localhost:8000/api/auth/callback"
        )

    @patch("app.auth.settings")
    def test_callback_oidc_not_configured(self, mock_settings, client: TestClient):
        """Test callback when OIDC is not configured."""
        mock_settings.oidc_issuer = None
        
        class MockRequest:
            pass
        
        request = MockRequest()
        
        with pytest.raises(HTTPException) as exc_info:
            pytest.importorskip("asyncio").run(callback(request))
        
        assert exc_info.value.status_code == 500
        assert exc_info.value.detail == "OIDC not configured"

    @patch("app.auth.oauth")
    @patch("app.auth.settings")
    def test_callback_successful(self, mock_settings, mock_oauth, client: TestClient):
        """Test successful OIDC callback."""
        mock_settings.oidc_issuer = "https://auth.example.com"
        mock_settings.frontend_url = "http://localhost:3000"

        # Mock the OAuth token response
        mock_token = {
            "userinfo": {
                "sub": "123",
                "email": "test@example.com",
                "name": "Test User"
            },
            "access_token": "test-access-token",
            "refresh_token": "test-refresh-token",
        }
        mock_oauth.authentik.authorize_access_token = AsyncMock(return_value=mock_token)

        class MockRequest:
            def __init__(self):
                self.session = {}

        request = MockRequest()

        result = pytest.importorskip("asyncio").run(callback(request))

        # Should set user in session and redirect
        assert "user" in request.session
        assert request.session["user"]["sub"] == "123"
        assert request.session["user"]["email"] == "test@example.com"

        # Should store tokens in session
        assert request.session["access_token"] == "test-access-token"
        assert request.session["refresh_token"] == "test-refresh-token"
        assert "token_validated_at" in request.session

        # Should return redirect response
        assert hasattr(result, "status_code")  # RedirectResponse

        mock_oauth.authentik.authorize_access_token.assert_called_once_with(request)

    @patch("app.auth.oauth")
    @patch("app.auth.settings")
    def test_callback_missing_userinfo(self, mock_settings, mock_oauth, client: TestClient):
        """Test callback with missing userinfo."""
        mock_settings.oidc_issuer = "https://auth.example.com"
        
        # Mock token without userinfo
        mock_token = {}
        mock_oauth.authentik.authorize_access_token = AsyncMock(return_value=mock_token)
        
        class MockRequest:
            def __init__(self):
                self.session = {}
        
        request = MockRequest()
        
        with pytest.raises(HTTPException) as exc_info:
            pytest.importorskip("asyncio").run(callback(request))
        
        assert exc_info.value.status_code == 400
        assert "Failed to get user info" in exc_info.value.detail


class TestAuthenticationIntegration:
    """Integration tests for authentication endpoints."""

    def test_auth_routes_exist(self, client: TestClient):
        """Test that authentication routes exist."""
        # Test login route exists (even if OIDC not configured)
        response = client.get("/api/auth/login")
        # Should return 500 if OIDC not configured, not 404
        assert response.status_code in [500, 302]  # 302 for redirect, 500 for not configured
        
        # Test callback route exists
        response = client.get("/api/auth/callback")
        assert response.status_code in [500, 400]  # Not 404

    def test_logout_endpoint(self, authenticated_client: TestClient):
        """Test logout functionality."""
        # Test logout with authenticated client
        response = authenticated_client.post("/api/auth/logout")
        assert response.status_code == 200
        
        data = response.json()
        assert data["status"] == "logged out"
        
        # After logout, should not be able to access protected endpoints
        # Note: this may still work due to dependency override in test fixture

    def test_protected_endpoint_without_auth(self, client: TestClient):
        """Test that protected endpoints require authentication."""
        # Try to access days endpoint without authentication
        response = client.get("/api/days?start_date=2024-02-15&end_date=2024-02-15")
        assert response.status_code == 401

    def test_protected_endpoint_with_auth(self, authenticated_client: TestClient):
        """Test that protected endpoints work with authentication."""
        response = authenticated_client.get("/api/days?start_date=2024-02-15&end_date=2024-02-15")
        assert response.status_code == 200

    def test_me_endpoint_unauthenticated(self, client: TestClient):
        """Test /me returns 401 when not authenticated."""
        response = client.get("/api/auth/me")
        assert response.status_code == 401


class TestTokenValidation:
    """Test OIDC token revalidation logic."""

    def test_needs_revalidation_no_timestamp(self):
        """Legacy sessions without token_validated_at don't trigger revalidation."""
        class MockRequest:
            def __init__(self):
                self.session = {"user": {"sub": "123"}}

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_needs_revalidation(request))
        assert result is False

    def test_needs_revalidation_recent(self):
        """Recent validation timestamp doesn't trigger revalidation."""
        class MockRequest:
            def __init__(self):
                self.session = {
                    "user": {"sub": "123"},
                    "token_validated_at": int(time.time()),
                }

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_needs_revalidation(request))
        assert result is False

    def test_needs_revalidation_stale(self):
        """Old validation timestamp triggers revalidation."""
        class MockRequest:
            def __init__(self):
                self.session = {
                    "user": {"sub": "123"},
                    "token_validated_at": int(time.time()) - TOKEN_REVALIDATION_INTERVAL - 1,
                }

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_needs_revalidation(request))
        assert result is True

    @patch("app.auth.settings")
    def test_validate_token_no_access_token(self, mock_settings):
        """Validation passes when there's no access token (legacy session)."""
        mock_settings.oidc_issuer = "https://auth.example.com"

        class MockRequest:
            def __init__(self):
                self.session = {"user": {"sub": "123"}}

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_validate_token(request))
        assert result is True

    @patch("app.auth.settings")
    def test_validate_token_no_oidc(self, mock_settings):
        """Validation passes when OIDC is not configured."""
        mock_settings.oidc_issuer = ""

        class MockRequest:
            def __init__(self):
                self.session = {"access_token": "some-token"}

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_validate_token(request))
        assert result is True

    @patch("app.auth.httpx.AsyncClient")
    @patch("app.auth.settings")
    def test_validate_token_success(self, mock_settings, mock_client_cls):
        """Token validation succeeds with 200 response from userinfo."""
        mock_settings.oidc_issuer = "https://auth.example.com"

        mock_response = MagicMock()
        mock_response.status_code = 200

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client_cls.return_value = mock_client

        class MockRequest:
            def __init__(self):
                self.session = {
                    "access_token": "valid-token",
                    "token_validated_at": int(time.time()) - 7200,
                }

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_validate_token(request))
        assert result is True
        # Should update the validated_at timestamp
        assert request.session["token_validated_at"] > int(time.time()) - 5

    @patch("app.auth._try_refresh_token", new_callable=AsyncMock)
    @patch("app.auth.httpx.AsyncClient")
    @patch("app.auth.settings")
    def test_validate_token_expired_tries_refresh(self, mock_settings, mock_client_cls, mock_refresh):
        """Token validation with 401 tries refresh token."""
        mock_settings.oidc_issuer = "https://auth.example.com"

        mock_response = MagicMock()
        mock_response.status_code = 401

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client_cls.return_value = mock_client

        mock_refresh.return_value = False

        class MockRequest:
            def __init__(self):
                self.session = {"access_token": "expired-token"}

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_validate_token(request))
        assert result is False
        mock_refresh.assert_called_once()

    @patch("app.auth.httpx.AsyncClient")
    @patch("app.auth.settings")
    def test_validate_token_network_error_fails_open(self, mock_settings, mock_client_cls):
        """Network errors during validation fail-open (allow access)."""
        mock_settings.oidc_issuer = "https://auth.example.com"

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client_cls.return_value = mock_client

        class MockRequest:
            def __init__(self):
                self.session = {"access_token": "some-token"}

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_validate_token(request))
        assert result is True

    @patch("app.auth.httpx.AsyncClient")
    @patch("app.auth.settings")
    def test_refresh_token_success(self, mock_settings, mock_client_cls):
        """Refresh token succeeds and updates session."""
        mock_settings.oidc_issuer = "https://auth.example.com"
        mock_settings.oidc_client_id = "test-client"
        mock_settings.oidc_client_secret = "test-secret"

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "access_token": "new-access-token",
            "refresh_token": "new-refresh-token",
        }

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client_cls.return_value = mock_client

        class MockRequest:
            def __init__(self):
                self.session = {
                    "refresh_token": "old-refresh-token",
                }

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_try_refresh_token(request))
        assert result is True
        assert request.session["access_token"] == "new-access-token"
        assert request.session["refresh_token"] == "new-refresh-token"

    @patch("app.auth.httpx.AsyncClient")
    @patch("app.auth.settings")
    def test_refresh_token_revoked(self, mock_settings, mock_client_cls):
        """Refresh token fails when revoked."""
        mock_settings.oidc_issuer = "https://auth.example.com"
        mock_settings.oidc_client_id = "test-client"
        mock_settings.oidc_client_secret = "test-secret"

        mock_response = MagicMock()
        mock_response.status_code = 400

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client_cls.return_value = mock_client

        class MockRequest:
            def __init__(self):
                self.session = {"refresh_token": "revoked-token"}

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(_try_refresh_token(request))
        assert result is False

    @patch("app.auth._validate_token", new_callable=AsyncMock)
    @patch("app.auth._needs_revalidation", new_callable=AsyncMock)
    def test_get_current_user_revalidation_clears_session(self, mock_needs, mock_validate, client):
        """get_current_user clears session and raises 401 when revalidation fails."""
        mock_needs.return_value = True
        mock_validate.return_value = False

        class MockRequest:
            def __init__(self):
                self.session = {
                    "user": {"sub": "123", "email": "test@example.com"},
                    "access_token": "expired",
                    "token_validated_at": 0,
                }

        request = MockRequest()

        with pytest.raises(HTTPException) as exc_info:
            pytest.importorskip("asyncio").run(get_current_user(request))

        assert exc_info.value.status_code == 401
        assert exc_info.value.detail == "Session expired"
        assert request.session == {}  # Session cleared

    @patch("app.auth._validate_token", new_callable=AsyncMock)
    @patch("app.auth._needs_revalidation", new_callable=AsyncMock)
    def test_get_optional_user_revalidation_clears_session(self, mock_needs, mock_validate, client):
        """get_optional_user clears session and returns None when revalidation fails."""
        mock_needs.return_value = True
        mock_validate.return_value = False

        class MockRequest:
            def __init__(self):
                self.session = {
                    "user": {"sub": "123", "email": "test@example.com"},
                    "access_token": "expired",
                    "token_validated_at": 0,
                }

        request = MockRequest()
        result = pytest.importorskip("asyncio").run(get_optional_user(request))

        assert result is None
        assert request.session == {}  # Session cleared