from pydantic_settings import BaseSettings
from functools import lru_cache
from urllib.parse import urlparse


def _is_localhost_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    host = parsed.hostname or ""
    return host in {"localhost", "127.0.0.1", "::1"}


class Settings(BaseSettings):
    # Database
    postgres_host: str = "db"
    postgres_port: int = 5432
    postgres_db: str = "mealplanner"
    postgres_user: str = "mealplanner"
    postgres_password: str = "changeme"

    # Apple Calendar (CalDAV)
    apple_calendar_email: str = ""
    apple_calendar_app_password: str = ""
    apple_calendar_names: str = ""  # Optional: comma-separated list of calendar names to sync

    # OIDC (Authentik)
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_redirect_uri: str = "http://localhost:8000/api/auth/callback"

    # App
    secret_key: str = "change-me-in-production"
    frontend_url: str = "http://localhost:8000"
    secure_cookies: bool = False  # Set to True for HTTPS in production
    debug_timing: bool = False  # Enable timing logs for performance debugging
    allow_tunnel: bool = False  # Set to True when testing with ngrok/tunnels

    @property
    def database_url(self) -> str:
        return f"postgresql://{self.postgres_user}:{self.postgres_password}@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"

    def validate_security(self) -> None:
        """Fail fast when running in a non-local environment with insecure defaults."""
        is_local = _is_localhost_url(self.frontend_url)
        uses_oidc = bool(self.oidc_issuer)
        # Skip security validation for local dev or tunnel testing
        if is_local and not uses_oidc:
            return
        if self.allow_tunnel:
            return
        if self.secret_key == "change-me-in-production":
            raise ValueError("SECRET_KEY must be set to a secure value for non-local deployments.")
        if not self.secure_cookies:
            raise ValueError("SECURE_COOKIES must be true for non-local deployments.")

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()
