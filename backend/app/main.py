from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
import time
import signal
import threading
import asyncio

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import delete, text, inspect

from app.config import get_settings

# Clear the settings cache on import to ensure fresh settings are loaded
get_settings.cache_clear()
from app.database import engine, Base, SessionLocal
from app.models import MealNote, CachedCalendarEvent
from app.routers import days, auth, pantry, meal_ideas, realtime, calendar
from app.ical_service import initialize_cache, shutdown_cache
from app.realtime import broadcaster, shutdown_event

settings = get_settings()
settings.validate_security()


class TimingMiddleware(BaseHTTPMiddleware):
    """Middleware to log API request timing when debug_timing is enabled."""

    async def dispatch(self, request: Request, call_next):
        if not settings.debug_timing or not request.url.path.startswith("/api"):
            return await call_next(request)

        start_time = time.time()
        response = await call_next(request)
        duration = time.time() - start_time

        print(f"[API] {request.method} {request.url.path} completed in {duration:.3f}s")
        return response

# Path to static files (built React app)
STATIC_DIR = Path(__file__).parent.parent / "static"


def cleanup_old_data():
    """Delete meal notes and cached calendar events older than 30 days."""
    db = SessionLocal()
    try:
        cutoff = date.today() - timedelta(days=30)

        # Clean up old meal notes
        notes_deleted = db.execute(delete(MealNote).where(MealNote.date < cutoff))

        # Clean up old cached calendar events
        events_deleted = db.execute(delete(CachedCalendarEvent).where(CachedCalendarEvent.event_date < cutoff))

        db.commit()
        print(f"Cleaned up data older than {cutoff}: {notes_deleted.rowcount} meal notes, {events_deleted.rowcount} cached events")
    finally:
        db.close()


def run_migrations():
    """Run database migrations for schema changes."""
    inspector = inspect(engine)

    # Check if calendar_name column exists in cached_calendar_events
    columns = [col["name"] for col in inspector.get_columns("cached_calendar_events")]
    if "calendar_name" not in columns:
        print("Adding calendar_name column to cached_calendar_events...")
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE cached_calendar_events ADD COLUMN calendar_name TEXT DEFAULT ''"))
            conn.commit()
        print("Migration complete: added calendar_name column")

    if "event_uid" not in columns:
        print("Adding event_uid column to cached_calendar_events...")
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE cached_calendar_events ADD COLUMN event_uid TEXT DEFAULT ''"))
            conn.commit()
        print("Migration complete: added event_uid column")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: create tables, run migrations, and cleanup old data
    Base.metadata.create_all(bind=engine)
    run_migrations()
    cleanup_old_data()

    if threading.current_thread() is threading.main_thread():
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous = signal.getsignal(sig)

            def _handler(signum, frame, prev=previous):
                loop.call_soon_threadsafe(shutdown_event.set)
                if callable(prev):
                    prev(signum, frame)

            try:
                signal.signal(sig, _handler)
            except ValueError:
                # Test runners may execute lifespan in a non-main thread.
                pass

    # Initialize calendar cache in background (don't block startup)
    asyncio.create_task(initialize_cache())

    yield

    # Shutdown: stop background cache refresh
    broadcaster.close()
    await shutdown_cache()


app = FastAPI(title="Meal Planner", lifespan=lifespan)

# Timing middleware (must be added first to wrap all other middleware)
app.add_middleware(TimingMiddleware)

# Session middleware for auth
# When using tunnels (ngrok), use same_site="none" to allow cross-site cookies
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    same_site="none" if settings.allow_tunnel else "lax",
    https_only=settings.secure_cookies or settings.allow_tunnel,  # ngrok uses HTTPS
    session_cookie="meal_planner_session",
)

# API routes
app.include_router(days.router)
app.include_router(auth.router)
app.include_router(pantry.router)
app.include_router(meal_ideas.router)
app.include_router(realtime.router)
app.include_router(calendar.router)


# Health check
@app.get("/api/health")
async def health():
    return {"status": "ok"}


# Serve React static files
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve React SPA for all non-API routes."""
        # Try to serve the exact file
        file_path = STATIC_DIR / full_path
        if file_path.is_file():
            return FileResponse(file_path)
        # Otherwise serve index.html (SPA routing)
        return FileResponse(STATIC_DIR / "index.html")
