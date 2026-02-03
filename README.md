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
- Optional frontend performance logging (console-gated)

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

### Frontend Performance Logging

Frontend request/render timing logs are disabled by default. Enable them from the browser console:

```js
mealPlannerPerf.enable()
// mealPlannerPerf.disable()
// mealPlannerPerf.isEnabled()
```

When enabled, the console will log:
- API request duration and JSON parse time.
- Calendar days/events render timing (measured to next paint).

### Development Auth Flow

When developing locally with the frontend on port 5173:
- Set `OIDC_REDIRECT_URI=http://localhost:8000/api/auth/callback` in `.env`
- Set `FRONTEND_URL=http://localhost:5173` in `.env`
- Configure Authentik to allow redirect to `http://localhost:8000/api/auth/callback`

## Testing

This project includes comprehensive test suites for both frontend and backend components to prevent regressions and ensure code quality.

### Quick Test Run

To run all tests with a single command:

```bash
./run-tests.sh
```

**Available options:**
```bash
./run-tests.sh --help              # Show all options
./run-tests.sh --skip-deps         # Skip dependency installation
./run-tests.sh --frontend-only     # Run only frontend tests
./run-tests.sh --backend-only      # Run only backend tests  
./run-tests.sh --integration       # Include integration tests
```

### Frontend Tests

The frontend uses **Vitest** with **React Testing Library** for comprehensive component and utility testing.

```bash
cd frontend

# Run tests in watch mode (development)
npm test

# Run all tests once
npm run test:run

# Run tests with coverage report
npm run test:coverage

# Run tests with UI interface
npm run test:ui
```

**Test Coverage:**
- ✅ **Components**: Settings modal, meal items, rich text editor, day cards
- ✅ **Hooks**: Settings management, dark mode, online status detection
- ✅ **Utilities**: Auto-linking URLs, HTML processing
- ✅ **User Interactions**: Click handlers, form inputs, keyboard navigation
- ✅ **Edge Cases**: Error handling, malformed data, XSS prevention

**Coverage Reports:**
- Terminal: Displayed after `npm run test:coverage`
- HTML: `frontend/coverage/index.html`

### Backend Tests

The backend uses **pytest** with **FastAPI TestClient** for API and service testing.

```bash
cd backend

# Install test dependencies
pip install -r requirements.txt

# Run all tests
python -m pytest

# Run with verbose output
python -m pytest -v

# Run with coverage
python -m pytest --cov=app --cov-report=html --cov-report=term-missing

# Run specific test categories
python -m pytest -m unit          # Unit tests only
python -m pytest -m integration   # Integration tests only
python -m pytest -k "test_auth"   # Tests matching pattern
```

**Test Coverage:**
- ✅ **API Endpoints**: Days, meal notes, authentication, calendar events
- ✅ **Database Models**: MealNote, MealItem relationships and constraints
- ✅ **Authentication**: OIDC flow, session management, protected routes
- ✅ **External Services**: Calendar integration, iCal parsing
- ✅ **Data Validation**: Pydantic schemas, request/response validation
- ✅ **Error Handling**: Invalid data, network failures, edge cases

**Coverage Reports:**
- Terminal: Displayed after pytest with `--cov-report=term-missing`
- HTML: `backend/htmlcov/index.html`

### Test Categories

**1. Unit Tests**
- Individual functions and components
- Mock external dependencies
- Fast execution (< 1s per test)

**2. Integration Tests**
- API endpoints with database
- Component interactions
- Authentication flows

**3. Edge Case Tests**
- Malformed data handling
- Network failures
- Large data sets
- XSS and security scenarios

### Continuous Integration

Tests are designed for CI environments:

```yaml
# Example GitHub Actions workflow
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: ./run-tests.sh --skip-deps
```

### Test Development Guidelines

**Frontend:**
```tsx
// Use React Testing Library patterns
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

it('handles user interaction', async () => {
  const user = userEvent.setup()
  render(<MyComponent />)
  
  await user.click(screen.getByRole('button'))
  expect(screen.getByText('Expected result')).toBeInTheDocument()
})
```

**Backend:**
```python
# Use pytest fixtures and FastAPI TestClient
def test_api_endpoint(client: TestClient, mock_user):
    with patch("app.auth.get_current_user", return_value=mock_user):
        response = client.get("/api/endpoint")
        assert response.status_code == 200
```

**Coverage Requirements:**
- **Statements**: >90%
- **Branches**: >85% 
- **Functions**: >90%
- **Critical paths**: 100%

For detailed testing documentation, see [TESTING.md](frontend/TESTING.md).

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
