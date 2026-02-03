from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path
import time

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from sqlalchemy import delete

from app.config import get_settings
from app.database import engine, Base, SessionLocal
from app.models import MealNote
from app.routers import days, auth, pantry, meal_ideas, realtime

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


def cleanup_old_notes():
    """Delete meal notes older than 30 days."""
    db = SessionLocal()
    try:
        cutoff = date.today() - timedelta(days=30)
        db.execute(delete(MealNote).where(MealNote.date < cutoff))
        db.commit()
        print(f"Cleaned up meal notes older than {cutoff}")
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: create tables and cleanup old data
    Base.metadata.create_all(bind=engine)
    cleanup_old_notes()
    yield
    # Shutdown


app = FastAPI(title="Meal Planner", lifespan=lifespan)

# Timing middleware (must be added first to wrap all other middleware)
app.add_middleware(TimingMiddleware)

# Session middleware for auth
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    same_site="lax",
    https_only=settings.secure_cookies,
    session_cookie="meal_planner_session",
)

# API routes
app.include_router(days.router)
app.include_router(auth.router)
app.include_router(pantry.router)
app.include_router(meal_ideas.router)
app.include_router(realtime.router)


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
