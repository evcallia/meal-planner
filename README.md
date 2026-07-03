# Meal Planner

A mobile-focused Progressive Web App for meal planning that integrates with Apple Calendar via CalDAV and supports offline usage.

## Features

- Calendar view with Apple Calendar integration (via CalDAV)
- Meal notes with auto-save
- Itemization tracking (mark meals as added to your shopping list)
- Drag and drop meals between days (with touch support on mobile)
- Pantry management - track ingredients you have on hand
- Future meal ideas - save meal ideas to schedule later
- Dark mode
- PWA support - install on your phone's home screen
- Offline support - works without internet, syncs when back online
  - Background caching of 1 week past and 3 weeks future for seamless offline access
  - Queued changes sync automatically when back online
- SSO authentication via OIDC (Authentik)
- Optional frontend performance logging (console-gated)

## Tech Stack

- **Backend**: Go, PostgreSQL, GORM
- **Frontend**: React, TypeScript, Tailwind CSS, Vite
- **Auth**: OIDC via Authentik
- **Containerization**: Docker Compose

## Quick Start (Docker)

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your configuration (see [Configuration](#configuration))

3. Start the app (pulls the published image):
   ```bash
   docker compose up -d
   ```
   Or build from source:
   ```bash
   docker compose -f docker-compose-dev.yml up -d --build
   ```

4. Visit http://localhost:8000

## Local Development

For faster development with hot-reload, run the backend and frontend separately.

### Prerequisites

- Go 1.26+
- Node.js 20+
- PostgreSQL (or use Docker for just the database)

### Database

Start just the PostgreSQL container:
```bash
docker compose up db
```

### Backend

```bash
# Run from the project root so .env is loaded
go run ./backend/cmd/server
```

No local PostgreSQL? Run a throwaway embedded one:
```bash
cd backend && go run ./cmd/devpg -port 5433
# then: POSTGRES_HOST=localhost POSTGRES_PORT=5433 POSTGRES_USER=dev \
#       POSTGRES_PASSWORD=dev go run ./backend/cmd/server
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

### Testing with ngrok/tunnels

To test on mobile devices or share your local dev server via ngrok:

**Frontend:**
```bash
ALLOW_TUNNEL=true npm run dev
```

**Backend:**
```bash
ALLOW_TUNNEL=true FRONTEND_URL=https://your-ngrok-url.ngrok-free.dev \
  OIDC_REDIRECT_URI=https://your-ngrok-url.ngrok-free.dev/api/auth/callback \
  go run ./backend/cmd/server
```

You can also setup the .env with necessary values and run
```bash
docker compose up -d --build # --build forces a fresh build
ngrok http 8000. # serves the app over the ngrok tunnel which works with SSO
```

**Important:** You also need to add the ngrok callback URL to your OIDC provider's allowed redirect URIs.

The `ALLOW_TUNNEL=true` flag:
- **Frontend**: Allows Vite to accept requests from `.ngrok-free.dev` and `.ngrok.io` domains
- **Backend**: Relaxes security validation and configures session cookies for cross-site use (ngrok uses HTTPS)

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

The backend uses Go's standard **testing** package with an in-memory SQLite HTTP test harness, plus an embedded-Postgres integration test that exercises the production database dialect.

```bash
cd backend

# Run all tests
go test ./...

# Verbose output
go test -v ./...

# With coverage
go test -coverprofile=coverage.out ./... && go tool cover -html=coverage.out

# Tests matching a pattern
go test -run Tracker ./...

# Skip the (slower) embedded-Postgres integration test
go test -short ./...
```

**Test Coverage:**
- ✅ **API Endpoints**: Days, meal notes, grocery, pantry, tracker, authentication, calendar events
- ✅ **Database Models**: relationships, cascade deletes, migrations
- ✅ **Authentication**: OIDC flow, session signing/expiry, protected routes
- ✅ **External Services**: Calendar integration, iCal/CalDAV parsing
- ✅ **Realtime**: SSE broadcasting, per-user filtering
- ✅ **Error Handling**: validation, malformed data, offline/concurrency edge cases

**Coverage Reports:**
- Terminal: `go tool cover -func=coverage.out`
- HTML: `go tool cover -html=coverage.out`

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
```go
// Use the shared harness (backend/internal/app/harness_test.go):
// in-memory SQLite + signed-cookie auth + SSE collector
func TestAPIEndpoint(t *testing.T) {
    ta := newTestApp(t)
    resp := ta.GET("/api/endpoint")
    if resp.Status != 200 {
        t.Fatalf("status = %d", resp.Status)
    }
}
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

You can find docker builds here https://hub.docker.com/repository/docker/evcallia/meal-planner/tags.

**Automated (preferred):** pushing a version tag builds and pushes the multiarch image via GitHub Actions (`.github/workflows/release.yml`), tagged with the git tag plus `latest`:
```bash
git tag v2.0.0
git push origin v2.0.0
```
Requires a `dockerhub` environment (Settings → Environments) holding the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets (use a Docker Hub access token, not your password), with deployment tags restricted to `v*`.

**Manual (fallback):** 

1. Log in to Docker Hub:
   ```bash
   docker login
   ```

2. Build and push the image (multiarch):
   ```bash
   docker buildx create --name multiarch --driver docker-container --bootstrap
   docker buildx build --builder multiarch --platform linux/amd64,linux/arm64 -t evcallia/meal-planner:{TAG} --push .
   ```

3. `docker-compose.yml` already runs the published image (`evcallia/meal-planner:${APP_VERSION:-v2.0.0}`) — bump the default tag (or set `APP_VERSION`) after pushing. `docker-compose-dev.yml` always builds fresh from source instead.

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
