import pytest
import asyncio
from datetime import date, datetime
from typing import AsyncGenerator, Generator
from contextlib import asynccontextmanager
import httpx
from sqlalchemy import create_engine, StaticPool, event
from sqlalchemy.orm import sessionmaker, Session
from fastapi.testclient import TestClient
from unittest.mock import patch

from app.database import Base, get_db
from app.main import app
from app.models import MealNote, MealItem, CachedCalendarEvent, CalendarCacheMetadata
from app.config import Settings


# Test database URL - use SQLite in memory for fast tests
SQLALCHEMY_DATABASE_URL = "sqlite:///:memory:"

# Create test engine with connection pooling disabled for SQLite
engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={
        "check_same_thread": False,
        # Enable foreign key constraints in SQLite
    },
    poolclass=StaticPool,
)

# Enable foreign key constraints for SQLite
@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()

TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


# Test settings that prevent database connection issues
test_settings = Settings(
    database_url="sqlite:///:memory:",
    secret_key="test-secret-key-for-testing-only",
    apple_calendar_email="",
    apple_calendar_app_password="",
    apple_calendar_name="",
    debug_timing=False,
    oidc_client_id="",
    oidc_client_secret="",
    oidc_issuer="",
    environment="test"
)

TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def override_get_db() -> Generator[Session, None, None]:
    """Override database dependency for testing."""
    try:
        db = TestingSessionLocal()
        yield db
    finally:
        db.close()


# Override settings for testing
def override_settings():
    return Settings(
        postgres_host="test",
        postgres_port=5432,
        postgres_db="test",
        postgres_user="test",
        postgres_password="test",
        secret_key="test-secret-key",
        debug_timing=False,
        frontend_url="http://localhost:3000",
        secure_cookies=False,
    )


@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    policy = asyncio.get_event_loop_policy()
    loop = policy.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="function")
def db_session() -> Generator[Session, None, None]:
    """Create a fresh database session for each test."""
    # Create all tables
    Base.metadata.create_all(bind=engine)
    
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()
        # Drop all tables after each test
        Base.metadata.drop_all(bind=engine)


@pytest.fixture(scope="function")
def client(db_session: Session) -> Generator[TestClient, None, None]:
    """Create a test client with database dependency override."""
    
    def override_get_db_for_testing():
        yield db_session
    
    # Mock lifespan to prevent database connections during startup
    @asynccontextmanager
    async def mock_lifespan(app):
        # Skip startup database operations
        yield
        # Skip shutdown operations
    
    # Override the database dependency
    app.dependency_overrides[get_db] = override_get_db_for_testing
    
    # Patch the settings to prevent production database connections
    with patch("app.config.get_settings", return_value=test_settings), \
         patch("app.main.engine", engine), \
         patch("app.database.engine", engine), \
         patch("app.main.lifespan", mock_lifespan), \
         patch("app.main.SessionLocal", TestingSessionLocal):
        
        with TestClient(app) as test_client:
            yield test_client
    
    app.dependency_overrides.clear()


@pytest.fixture
async def async_client(db_session: Session) -> AsyncGenerator[httpx.AsyncClient, None]:
    """Create an async test client."""
    
    def override_get_db_for_testing():
        yield db_session
    
    app.dependency_overrides[get_db] = override_get_db_for_testing
    
    async with httpx.AsyncClient(app=app, base_url="http://test") as ac:
        yield ac
    
    app.dependency_overrides.clear()


@pytest.fixture
def sample_meal_note(db_session: Session) -> MealNote:
    """Create a sample meal note for testing."""
    meal_note = MealNote(
        date=date(2024, 2, 15),
        notes="<p>Breakfast: Oatmeal</p><p>Lunch: Sandwich</p>",
    )
    db_session.add(meal_note)
    db_session.commit()
    db_session.refresh(meal_note)
    return meal_note


@pytest.fixture  
def sample_meal_items(db_session: Session, sample_meal_note: MealNote) -> list[MealItem]:
    """Create sample meal items for testing."""
    items = [
        MealItem(meal_note_id=sample_meal_note.id, line_index=0, itemized=True),
        MealItem(meal_note_id=sample_meal_note.id, line_index=1, itemized=False),
    ]
    db_session.add_all(items)
    db_session.commit()
    for item in items:
        db_session.refresh(item)
    return items


@pytest.fixture
def mock_user():
    """Mock user data for authentication."""
    return {
        "sub": "test-user-123",
        "email": "test@example.com",
        "name": "Test User",
    }


@pytest.fixture
def authenticated_client(client: TestClient, mock_user):
    """Create a test client with authentication mocked."""
    from app.main import app
    from app.auth import get_current_user

    # Override the auth dependency
    app.dependency_overrides[get_current_user] = lambda: mock_user

    yield client

    # Clean up the dependency override
    if get_current_user in app.dependency_overrides:
        del app.dependency_overrides[get_current_user]


@pytest.fixture
def sample_cache_metadata(db_session: Session) -> CalendarCacheMetadata:
    """Create sample calendar cache metadata for testing."""
    from datetime import timedelta
    today = date.today()

    metadata = CalendarCacheMetadata(
        id=1,
        last_refresh=datetime.utcnow(),
        cache_start=today - timedelta(weeks=4),
        cache_end=today + timedelta(weeks=8)
    )
    db_session.add(metadata)
    db_session.commit()
    db_session.refresh(metadata)
    return metadata


@pytest.fixture
def sample_cached_events(db_session: Session, sample_cache_metadata: CalendarCacheMetadata) -> list[CachedCalendarEvent]:
    """Create sample cached calendar events for testing."""
    today = date.today()

    events = [
        CachedCalendarEvent(
            event_date=today,
            title="Morning Meeting",
            start_time=datetime.combine(today, datetime.min.time().replace(hour=9)),
            end_time=datetime.combine(today, datetime.min.time().replace(hour=10)),
            all_day=False
        ),
        CachedCalendarEvent(
            event_date=today,
            title="Lunch",
            start_time=datetime.combine(today, datetime.min.time().replace(hour=12)),
            end_time=datetime.combine(today, datetime.min.time().replace(hour=13)),
            all_day=False
        ),
        CachedCalendarEvent(
            event_date=today + timedelta(days=1),
            title="All Day Event",
            start_time=datetime.combine(today + timedelta(days=1), datetime.min.time()),
            all_day=True
        ),
    ]
    db_session.add_all(events)
    db_session.commit()
    for event in events:
        db_session.refresh(event)
    return events