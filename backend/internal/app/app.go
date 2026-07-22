// Package app wires settings, DB, sessions, SSE and all route handlers —
// the Go counterpart of backend/app/main.py.
package app

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/config"
	"mealplanner/internal/httpx"
	"mealplanner/internal/ical"
	"mealplanner/internal/models"
	"mealplanner/internal/push"
	"mealplanner/internal/realtime"
	"mealplanner/internal/session"
)

type App struct {
	Settings    *config.Settings
	DB          *gorm.DB
	Sessions    *session.Manager
	Broadcaster *realtime.Broadcaster
	Calendar    *ical.Service
	Push        *push.Service
	oidc        *oidcClient
}

func New(settings *config.Settings, db *gorm.DB) *App {
	a := &App{
		Settings:    settings,
		DB:          db,
		Sessions:    session.NewManager(settings.SecretKey, settings.SecureCookies || settings.AllowTunnel, settings.AllowTunnel),
		Broadcaster: realtime.NewBroadcaster(),
		Calendar:    ical.NewService(settings, db),
		Push:        push.New(db, settings.VapidSubject, time.Duration(settings.PushEditWindowMinutes)*time.Minute),
	}
	if settings.OIDCIssuer != "" {
		a.oidc = newOIDCClient(settings)
	}
	// Due-reminder feed entries are created by the background loop; announce
	// them live so bells update without a refetch (actor_sub empty: no actor).
	a.Push.OnActivity = func(row *models.ActivityLog, audience map[string]bool) {
		a.emitActivity(row, audience, "")
	}
	return a
}

// Handler builds the full route table.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()

	// Health
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, 200, map[string]string{"status": "ok"})
	})

	// Auth
	mux.HandleFunc("GET /api/auth/login", a.handleLogin)
	mux.HandleFunc("GET /api/auth/callback", a.handleCallback)
	mux.HandleFunc("POST /api/auth/logout", a.handleLogout)
	mux.HandleFunc("GET /api/auth/me", a.handleMe)
	if a.Settings.OIDCIssuer == "" {
		mux.HandleFunc("GET /api/auth/dev-login", a.handleDevLogin)
	}

	// Authenticated API routes. auth() wraps a handler with the session check.
	auth := a.requireUser

	// Realtime (SSE)
	mux.HandleFunc("GET /api/stream", auth(a.handleStream))

	// Days / meal notes
	mux.HandleFunc("GET /api/days", auth(a.handleGetDays))
	mux.HandleFunc("GET /api/days/events", auth(a.handleGetEvents))
	mux.HandleFunc("PUT /api/days/{date}/notes", auth(a.handleUpdateNotes))
	mux.HandleFunc("PATCH /api/days/{date}/items/{lineIndex}", auth(a.handleToggleItem))

	// Calendar
	mux.HandleFunc("GET /api/calendar/cache-status", auth(a.handleCacheStatus))
	mux.HandleFunc("POST /api/calendar/refresh", auth(a.handleCalendarRefresh))
	mux.HandleFunc("GET /api/calendar/list", auth(a.handleCalendarList))
	mux.HandleFunc("GET /api/calendar/hidden", auth(a.handleListHidden))
	mux.HandleFunc("POST /api/calendar/hidden", auth(a.handleHideEvent))
	mux.HandleFunc("DELETE /api/calendar/hidden/{hiddenId}", auth(a.handleUnhideEvent))

	// Grocery
	mux.HandleFunc("GET /api/grocery", auth(a.handleListGrocery))
	mux.HandleFunc("PUT /api/grocery", auth(a.handleReplaceGrocery))
	mux.HandleFunc("GET /api/grocery/item-defaults", auth(a.handleListItemDefaults))
	mux.HandleFunc("PUT /api/grocery/item-defaults/{itemName}", auth(a.handleUpsertItemDefault))
	mux.HandleFunc("DELETE /api/grocery/item-defaults/{itemName}", auth(a.handleDeleteItemDefault))
	mux.HandleFunc("POST /api/grocery/sections", auth(a.handleCreateGrocerySection))
	mux.HandleFunc("PATCH /api/grocery/sections/{sectionId}", auth(a.handleUpdateGrocerySection))
	mux.HandleFunc("DELETE /api/grocery/sections/{sectionId}", auth(a.handleDeleteGrocerySection))
	mux.HandleFunc("PATCH /api/grocery/reorder-sections", auth(a.handleReorderGrocerySections))
	mux.HandleFunc("PATCH /api/grocery/sections/{sectionId}/reorder-items", auth(a.handleReorderGroceryItems))
	mux.HandleFunc("POST /api/grocery/items", auth(a.handleAddGroceryItem))
	mux.HandleFunc("PATCH /api/grocery/items/{itemId}", auth(a.handleUpdateGroceryItem))
	mux.HandleFunc("PATCH /api/grocery/items/{itemId}/move", auth(a.handleMoveGroceryItem))
	mux.HandleFunc("DELETE /api/grocery/items/{itemId}", auth(a.handleDeleteGroceryItem))
	mux.HandleFunc("DELETE /api/grocery/items", auth(a.handleClearGroceryItems))

	// Pantry
	mux.HandleFunc("GET /api/pantry", auth(a.handleListPantry))
	mux.HandleFunc("PUT /api/pantry", auth(a.handleReplacePantry))
	mux.HandleFunc("PATCH /api/pantry/sections/{sectionId}", auth(a.handleUpdatePantrySection))
	mux.HandleFunc("PATCH /api/pantry/reorder-sections", auth(a.handleReorderPantrySections))
	mux.HandleFunc("PATCH /api/pantry/sections/{sectionId}/reorder-items", auth(a.handleReorderPantryItems))
	mux.HandleFunc("POST /api/pantry/items", auth(a.handleAddPantryItem))
	mux.HandleFunc("PUT /api/pantry/items/{itemId}", auth(a.handleUpdatePantryItem))
	mux.HandleFunc("PATCH /api/pantry/items/{itemId}/move", auth(a.handleMovePantryItem))
	mux.HandleFunc("POST /api/pantry/sections", auth(a.handleCreatePantrySection))
	mux.HandleFunc("DELETE /api/pantry/sections/{sectionId}", auth(a.handleDeletePantrySection))
	mux.HandleFunc("DELETE /api/pantry/items/{itemId}", auth(a.handleDeletePantryItem))
	mux.HandleFunc("DELETE /api/pantry/items", auth(a.handleClearPantryItems))

	// Meal ideas
	mux.HandleFunc("GET /api/meal-ideas", auth(a.handleListMealIdeas))
	mux.HandleFunc("POST /api/meal-ideas", auth(a.handleCreateMealIdea))
	mux.HandleFunc("PUT /api/meal-ideas/{ideaId}", auth(a.handleUpdateMealIdea))
	mux.HandleFunc("DELETE /api/meal-ideas/{ideaId}", auth(a.handleDeleteMealIdea))

	// Stores
	mux.HandleFunc("GET /api/stores", auth(a.handleListStores))
	mux.HandleFunc("POST /api/stores", auth(a.handleCreateStore))
	mux.HandleFunc("PATCH /api/stores/reorder", auth(a.handleReorderStores))
	mux.HandleFunc("PATCH /api/stores/{storeId}", auth(a.handleUpdateStore))
	mux.HandleFunc("DELETE /api/stores/{storeId}", auth(a.handleDeleteStore))

	// Settings
	mux.HandleFunc("GET /api/settings", auth(a.handleGetSettings))
	mux.HandleFunc("PUT /api/settings", auth(a.handlePutSettings))

	// Users directory
	mux.HandleFunc("GET /api/users", auth(a.handleListUsers))

	// Push notifications
	mux.HandleFunc("GET /api/push/public-key", auth(a.handleGetPushPublicKey))
	mux.HandleFunc("POST /api/push/subscriptions", auth(a.handleSavePushSubscription))
	mux.HandleFunc("DELETE /api/push/subscriptions", auth(a.handleDeletePushSubscription))
	mux.HandleFunc("POST /api/push/test", auth(a.handleTestPush))

	// Activity feed
	mux.HandleFunc("GET /api/activity", auth(a.handleGetActivity))
	mux.HandleFunc("POST /api/activity/seen", auth(a.handleMarkActivitySeen))

	// Tracker
	mux.HandleFunc("GET /api/tracker", auth(a.handleTrackerListLists))
	mux.HandleFunc("POST /api/tracker/lists", auth(a.handleTrackerCreateList))
	mux.HandleFunc("POST /api/tracker/lists/restore", auth(a.handleTrackerRestoreList))
	mux.HandleFunc("PATCH /api/tracker/lists/{listId}", auth(a.handleTrackerUpdateList))
	mux.HandleFunc("DELETE /api/tracker/lists/{listId}", auth(a.handleTrackerDeleteList))
	mux.HandleFunc("PATCH /api/tracker/reorder-lists", auth(a.handleTrackerReorderLists))
	mux.HandleFunc("POST /api/tracker/lists/{listId}/shares", auth(a.handleTrackerAddShare))
	mux.HandleFunc("DELETE /api/tracker/lists/{listId}/shares/{shareSub}", auth(a.handleTrackerRemoveShare))
	mux.HandleFunc("POST /api/tracker/lists/{listId}/leave", auth(a.handleTrackerLeaveList))
	mux.HandleFunc("POST /api/tracker/lists/{listId}/rejoin", auth(a.handleTrackerRejoinList))
	mux.HandleFunc("PATCH /api/tracker/lists/{listId}/reorder-tasks", auth(a.handleTrackerReorderTasks))
	mux.HandleFunc("POST /api/tracker/tasks", auth(a.handleTrackerCreateTask))
	mux.HandleFunc("PATCH /api/tracker/tasks/{taskId}", auth(a.handleTrackerUpdateTask))
	mux.HandleFunc("DELETE /api/tracker/tasks/{taskId}", auth(a.handleTrackerDeleteTask))
	mux.HandleFunc("GET /api/tracker/tasks/{taskId}/logs", auth(a.handleTrackerListLogs))
	mux.HandleFunc("POST /api/tracker/tasks/{taskId}/logs", auth(a.handleTrackerAddLog))
	mux.HandleFunc("POST /api/tracker/tasks/{taskId}/skip", auth(a.handleTrackerSkipTask))
	mux.HandleFunc("DELETE /api/tracker/logs/{logId}", auth(a.handleTrackerDeleteLog))

	// Unknown /api paths → 404 JSON (before the SPA catch-all).
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		httpx.Detail(w, http.StatusNotFound, "Not Found")
	})

	// Static SPA
	mux.HandleFunc("/", a.serveSPA)

	return a.timing(a.securityHeaders(mux))
}

// maxBodyBytes caps request bodies (largest legitimate payload — a full
// grocery/tracker restore — is well under 1 MB).
const maxBodyBytes = 1 << 20

// requireUser mirrors Depends(get_current_user).
func (a *App) requireUser(next func(http.ResponseWriter, *http.Request, *session.UserInfo)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := session.UserFrom(a.Sessions.Get(r))
		if user == nil {
			httpx.Detail(w, http.StatusUnauthorized, "Not authenticated")
			return
		}
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		}
		// Sliding session window: an active user never hits the 14-day
		// hard expiry (Starlette re-signs on every response).
		a.Sessions.Touch(w, r)
		next(w, r, user)
	}
}

// timing mirrors TimingMiddleware (debug_timing only).
func (a *App) timing(next http.Handler) http.Handler {
	if !a.Settings.DebugTiming {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("[API] %s %s completed in %.3fs", r.Method, r.URL.Path, time.Since(start).Seconds())
	})
}

// securityHeaders mirrors SecurityHeadersMiddleware (HTML responses only).
func (a *App) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api") {
			h := w.Header()
			h.Set("Content-Security-Policy",
				"default-src 'self'; "+
					"script-src 'self'; "+
					"style-src 'self' 'unsafe-inline'; "+
					"img-src 'self' data:; "+
					"font-src 'self'; "+
					"connect-src 'self'; "+
					"frame-ancestors 'none'; "+
					"base-uri 'self'; "+
					"form-action 'self'")
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		}
		next.ServeHTTP(w, r)
	})
}

var noCacheFiles = map[string]bool{
	"sw.js": true, "push-sw.js": true, "index.html": true, "version.json": true, "manifest.webmanifest": true,
}

// serveSPA mirrors the FastAPI static-file catch-all: exact file if present
// (with no-cache headers for the SW/version files), index.html otherwise.
// Divergences from Python are deliberate: missing /assets/* files 404 (a
// stale hashed chunk must not receive index.html with a 200), and non-GET
// methods 405 (the Python catch-all was @app.get).
func (a *App) serveSPA(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		httpx.Detail(w, http.StatusMethodNotAllowed, "Method Not Allowed")
		return
	}
	staticDir, err := filepath.Abs(a.Settings.StaticDir)
	if err != nil || !dirExists(staticDir) {
		http.NotFound(w, r)
		return
	}
	if real, rerr := filepath.EvalSymlinks(staticDir); rerr == nil {
		staticDir = real
	}
	serveIndex := func() {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		a.serveStaticFile(w, r, filepath.Join(staticDir, "index.html"))
	}
	rel := strings.TrimPrefix(r.URL.Path, "/")
	full := filepath.Join(staticDir, filepath.FromSlash(rel))
	resolved, err := filepath.Abs(full)
	inRoot := err == nil && (strings.HasPrefix(resolved, staticDir+string(filepath.Separator)) || resolved == staticDir)
	if inRoot {
		// Symlink guard (Python's Path.resolve() semantics): the real path
		// must also live under the static root.
		if real, rerr := filepath.EvalSymlinks(resolved); rerr == nil {
			inRoot = strings.HasPrefix(real, staticDir+string(filepath.Separator)) || real == staticDir
			resolved = real
		}
	}
	if !inRoot {
		serveIndex()
		return
	}
	if info, err := os.Stat(resolved); err == nil && !info.IsDir() {
		if noCacheFiles[filepath.Base(resolved)] {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		}
		a.serveStaticFile(w, r, resolved)
		return
	}
	// Hashed asset chunks must 404 when missing, never fall back to HTML.
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		httpx.Detail(w, http.StatusNotFound, "Not Found")
		return
	}
	serveIndex()
}

// serveStaticFile serves a file without http.ServeFile's index.html→"./"
// redirect (a direct GET /index.html must return 200 like Python).
func (a *App) serveStaticFile(w http.ResponseWriter, r *http.Request, path string) {
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
