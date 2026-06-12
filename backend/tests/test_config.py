"""Tests for configuration module."""
import pytest
from app.config import Settings, _is_localhost_url


class TestIsLocalhostUrl:
    """Test the _is_localhost_url helper function."""

    def test_localhost(self):
        """Test localhost is detected."""
        assert _is_localhost_url("http://localhost:8000") is True
        assert _is_localhost_url("https://localhost:443") is True
        assert _is_localhost_url("http://localhost") is True

    def test_127_0_0_1(self):
        """Test 127.0.0.1 is detected."""
        assert _is_localhost_url("http://127.0.0.1:8000") is True
        assert _is_localhost_url("https://127.0.0.1") is True

    def test_ipv6_localhost(self):
        """Test IPv6 localhost is detected."""
        assert _is_localhost_url("http://[::1]:8000") is True

    def test_non_localhost(self):
        """Test non-localhost URLs are not detected."""
        assert _is_localhost_url("http://example.com") is False
        assert _is_localhost_url("https://myapp.com:8000") is False
        assert _is_localhost_url("http://192.168.1.1:8000") is False

    def test_invalid_url(self):
        """Test invalid URLs return False."""
        assert _is_localhost_url("") is False
        assert _is_localhost_url("not-a-url") is False
        # Test URL that causes urlparse to fail
        assert _is_localhost_url("://invalid") is False


class TestSettings:
    """Test Settings class."""

    def test_database_url_property(self):
        """Test database URL is correctly constructed."""
        settings = Settings(
            postgres_host="myhost",
            postgres_port=5432,
            postgres_db="mydb",
            postgres_user="myuser",
            postgres_password="mypass",
        )
        expected = "postgresql://myuser:mypass@myhost:5432/mydb"
        assert settings.database_url == expected

    def test_validate_security_local_no_oidc(self):
        """Test validation passes for local dev without OIDC."""
        settings = Settings(
            frontend_url="http://localhost:8000",
            oidc_issuer="",
            secret_key="change-me-in-production",
            secure_cookies=False,
        )
        # Should not raise
        settings.validate_security()

    def test_validate_security_with_tunnel(self):
        """Test validation passes when allow_tunnel is True."""
        settings = Settings(
            frontend_url="https://myapp.example.com",
            oidc_issuer="https://auth.example.com",
            secret_key="change-me-in-production",
            secure_cookies=False,
            allow_tunnel=True,
        )
        # Should not raise
        settings.validate_security()

    def test_validate_security_insecure_secret_key(self):
        """Test validation fails with default secret key on non-local."""
        settings = Settings(
            frontend_url="https://myapp.example.com",
            oidc_issuer="https://auth.example.com",
            secret_key="change-me-in-production",
            secure_cookies=True,
        )
        with pytest.raises(ValueError, match="SECRET_KEY must be set"):
            settings.validate_security()

    def test_validate_security_insecure_cookies(self):
        """Test validation fails with insecure cookies on non-local."""
        settings = Settings(
            frontend_url="https://myapp.example.com",
            oidc_issuer="https://auth.example.com",
            secret_key="proper-secure-key-here",
            secure_cookies=False,
        )
        with pytest.raises(ValueError, match="SECURE_COOKIES must be true"):
            settings.validate_security()

    def test_validate_security_all_secure(self):
        """Test validation passes with secure settings."""
        settings = Settings(
            frontend_url="https://myapp.example.com",
            oidc_issuer="https://auth.example.com",
            secret_key="proper-secure-key-here",
            secure_cookies=True,
            postgres_password="a-real-password",
        )
        # Should not raise
        settings.validate_security()

    def test_validate_security_non_local_requires_oidc(self):
        """Non-local deploys without OIDC must fail (dev-login would be exposed)."""
        settings = Settings(
            frontend_url="https://myapp.example.com",
            oidc_issuer="",
            secret_key="proper-secure-key-here",
            secure_cookies=True,
            postgres_password="a-real-password",
        )
        with pytest.raises(ValueError, match="OIDC_ISSUER must be configured"):
            settings.validate_security()

    def test_validate_security_tunnel_allows_no_oidc(self):
        """Tunnel testing mode still permits dev-login (no OIDC) deployments."""
        settings = Settings(
            frontend_url="https://abc123.ngrok.io",
            oidc_issuer="",
            secret_key="change-me-in-production",
            secure_cookies=False,
            allow_tunnel=True,
        )
        # Should not raise
        settings.validate_security()

    def test_validate_security_default_db_password(self):
        """Non-local deploys with the default postgres password must fail."""
        settings = Settings(
            frontend_url="https://myapp.example.com",
            oidc_issuer="https://auth.example.com",
            secret_key="proper-secure-key-here",
            secure_cookies=True,
            postgres_password="changeme",
        )
        with pytest.raises(ValueError, match="POSTGRES_PASSWORD must be set"):
            settings.validate_security()

    def test_apple_calendar_names_default(self):
        """Test apple_calendar_names defaults to empty string."""
        settings = Settings()
        assert settings.apple_calendar_names == ""

    def test_debug_timing_default(self):
        """Test debug_timing defaults to False."""
        settings = Settings()
        assert settings.debug_timing is False

    def test_allow_tunnel_default(self):
        """Test allow_tunnel defaults to False."""
        settings = Settings()
        assert settings.allow_tunnel is False


class TestMealHistoryRetention:
    """Test meal_history_retention_days setting."""

    def test_meal_history_retention_defaults_to_one_year(self):
        settings = Settings()
        assert settings.meal_history_retention_days == 365

    def test_meal_history_retention_env_override(self, monkeypatch):
        monkeypatch.setenv("MEAL_HISTORY_RETENTION_DAYS", "30")
        settings = Settings()
        assert settings.meal_history_retention_days == 30


class TestGetSettings:
    """Test the get_settings function."""

    def test_get_settings_returns_settings(self):
        """Test get_settings returns a Settings instance."""
        from app.config import get_settings
        settings = get_settings()
        assert isinstance(settings, Settings)
