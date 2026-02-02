from pydantic_settings import BaseSettings
from functools import lru_cache


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
    apple_calendar_name: str = ""  # Optional: filter to specific calendar by name

    # OIDC (Authentik)
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_redirect_uri: str = "http://localhost:8000/api/auth/callback"

    # App
    secret_key: str = "change-me-in-production"
    frontend_url: str = "http://localhost:8000"
    secure_cookies: bool = False  # Set to True for HTTPS in production

    @property
    def database_url(self) -> str:
        return f"postgresql://{self.postgres_user}:{self.postgres_password}@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"

    class Config:
        env_file = ".env"
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()
