# Meal Planner

A mobile-focused Progressive Web App for meal planning that integrates with Apple Calendar via CalDAV and supports offline usage.

## Features

- Calendar view with Apple Calendar integration (via CalDAV)
- Meal notes with auto-save
- Itemization tracking (mark meals as added to your shopping list)
- Dark mode
- PWA support - install on your phone's home screen
- Offline support - works without internet, syncs when back online
- SSO authentication via OIDC (Authentik)

## Tech Stack

- **Backend**: Python (FastAPI), PostgreSQL, SQLAlchemy
- **Frontend**: React, TypeScript, Tailwind CSS, Vite
- **Auth**: OIDC via Authentik
- **Containerization**: Docker Compose

## Quick Start (Docker)

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your configuration (see [Configuration](#configuration))

3. Start the app:
   ```bash
   docker compose up --build
   ```

4. Visit http://localhost:8000

## Local Development

For faster development with hot-reload, run the backend and frontend separately.

### Prerequisites

- Python 3.11+
- Node.js 20+
- PostgreSQL (or use Docker for just the database)

### Database

Start just the PostgreSQL container:
```bash
docker compose up db
```

### Backend

```bash
cd backend

# Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run with hot-reload (from project root so .env is loaded)
cd ..
PYTHONPATH=./backend uvicorn backend.app.main:app --reload --port 8000
```

The backend will be available at http://localhost:8000

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Run with hot-reload
npm run dev
```

The frontend will be available at http://localhost:5173 (proxies API requests to backend)

### Development Auth Flow

When developing locally with the frontend on port 5173:
- Set `OIDC_REDIRECT_URI=http://localhost:8000/api/auth/callback` in `.env`
- Set `FRONTEND_URL=http://localhost:5173` in `.env`
- Configure Authentik to allow redirect to `http://localhost:8000/api/auth/callback`

## Configuration

Create a `.env` file based on the `.env.example` file

## Building and Pushing to Docker Hub

You can find docker builds here https://hub.docker.com/repository/docker/evcallia/meal-planner/tags or build from source following the below instructions. 

1. Build the image:
   ```bash
   docker build -t yourusername/meal-planner:latest .
   ```

2. Log in to Docker Hub:
   ```bash
   docker login
   ```

3. Push the image:
   ```bash
   docker push yourusername/meal-planner:latest
   ```

4. To use the pushed image, update `docker-compose.yml`:
   ```yaml
   services:
     app:
       image: yourusername/meal-planner:latest
       # Remove the 'build: .' line
   ```

## PWA Installation

### iOS
1. Open the app in Safari
2. Tap the Share button
3. Tap "Add to Home Screen"

### Android
1. Open the app in Chrome
2. Tap the menu (three dots)
3. Tap "Add to Home screen"

## License

This project is licensed under CC BY-NC 4.0 - free to use and modify for non-commercial purposes. See [LICENSE](LICENSE) for details.

**USE AT YOUR OWN RISK.**
