from contextlib import asynccontextmanager
from datetime import date, timedelta
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy import delete

from app.config import get_settings
from app.database import engine, Base, SessionLocal
from app.models import MealNote
from app.routers import days, auth

settings = get_settings()

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
