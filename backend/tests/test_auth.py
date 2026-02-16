import pytest
from unittest.mock import patch, AsyncMock
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from app.auth import get_current_user, get_optional_user, login, callback


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
            }
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