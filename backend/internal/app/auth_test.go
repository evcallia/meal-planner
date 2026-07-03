package app

// Port of backend/tests/test_auth.py.
//
// The Python file unit-tested the FastAPI dependencies (get_current_user,
// get_optional_user) and route functions with mocked requests. In Go the same
// behavior is exercised at the HTTP level through the real handler stack:
//   - get_current_user      -> requireUser on any protected endpoint
//   - get_optional_user     -> GET /api/auth/me (null when logged out)
//   - login/callback (OIDC not configured) -> 500 "OIDC not configured"
//
// Skipped (require a live/mocked OIDC provider; Python mocked the authlib
// client object, which has no Go equivalent without a full provider stub):
//   - test_login_oidc_configured (redirect to authorize URL) — partially
//     covered by TestLoginOIDCConfiguredDiscoveryFails, which proves the
//     configured branch is taken.
//   - test_callback_successful
//   - test_callback_missing_userinfo

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"mealplanner/internal/config"
	"mealplanner/internal/db"
	"mealplanner/internal/ical"
	"mealplanner/internal/models"
)

// newTestAppWith builds a testApp with mutated settings (e.g. OIDC configured)
// without touching the shared harness.
func newTestAppWith(t *testing.T, mutate func(*config.Settings)) *testApp {
	t.Helper()
	gdb, err := db.OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	settings := testSettings()
	mutate(settings)
	a := New(settings, gdb)
	a.Calendar.FetchCalDAVEvents = func(start, end time.Time) []ical.EventWithSource { return nil }
	a.Calendar.FetchHolidaysRaw = func() ([]byte, error) { return nil, errors.New("no network in tests") }
	a.Calendar.ListCalendarsFn = func() ([]ical.Calendar, error) { return nil, nil }
	ta := &testApp{t: t, App: a, h: a.Handler()}
	ta.Cookie = ta.LoginAs(TestSub, TestEmail, TestName)
	return ta
}

// ---- TestAuthentication (dependency behavior, via HTTP) ----

// test_get_current_user_authenticated / test_get_optional_user_authenticated
func TestMeAuthenticated(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/auth/me")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	obj := resp.Obj()
	if obj["sub"] != TestSub {
		t.Fatalf("sub = %v, want %q", obj["sub"], TestSub)
	}
	if obj["email"] != TestEmail {
		t.Fatalf("email = %v, want %q", obj["email"], TestEmail)
	}
	if obj["name"] != TestName {
		t.Fatalf("name = %v, want %q", obj["name"], TestName)
	}
}

// test_get_optional_user_not_authenticated: /api/auth/me returns JSON null.
func TestMeUnauthenticated(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/auth/me", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.JSON() != nil {
		t.Fatalf("body = %s, want JSON null", resp.Body)
	}
}

// test_get_current_user_not_authenticated + test_protected_endpoint_without_auth
func TestProtectedEndpointWithoutAuth(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/days?start_date=2024-02-15&end_date=2024-02-15", nil)
	if resp.Status != 401 {
		t.Fatalf("status = %d, want 401: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Not authenticated" {
		t.Fatalf("detail = %q, want %q", detail, "Not authenticated")
	}
}

// test_protected_endpoint_with_auth
func TestProtectedEndpointWithAuth(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/days?start_date=2024-02-15&end_date=2024-02-15")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
}

// test_login_oidc_not_configured
func TestLoginOIDCNotConfigured(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/auth/login", nil)
	if resp.Status != 500 {
		t.Fatalf("status = %d, want 500: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "OIDC not configured" {
		t.Fatalf("detail = %q, want %q", detail, "OIDC not configured")
	}
}

// test_login_oidc_configured (partial): with an issuer set, login takes the
// configured branch — here discovery fails (unreachable issuer) instead of
// redirecting, proving the "not configured" 500 is not returned.
func TestLoginOIDCConfiguredDiscoveryFails(t *testing.T) {
	ta := newTestAppWith(t, func(s *config.Settings) {
		s.OIDCIssuer = "http://127.0.0.1:1" // unreachable, fails fast
		s.OIDCClientID = "client"
		s.OIDCClientSecret = "secret"
	})
	resp := ta.Anon("GET", "/api/auth/login", nil)
	if resp.Status != 500 {
		t.Fatalf("status = %d, want 500: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "OIDC discovery failed" {
		t.Fatalf("detail = %q, want %q", detail, "OIDC discovery failed")
	}
}

// test_callback_oidc_not_configured
func TestCallbackOIDCNotConfigured(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/auth/callback", nil)
	if resp.Status != 500 {
		t.Fatalf("status = %d, want 500: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "OIDC not configured" {
		t.Fatalf("detail = %q, want %q", detail, "OIDC not configured")
	}
}

// ---- TestAuthenticationIntegration ----

// test_auth_routes_exist: the routes respond (not 404) even without OIDC.
func TestAuthRoutesExist(t *testing.T) {
	ta := newTestApp(t)
	if resp := ta.Anon("GET", "/api/auth/login", nil); resp.Status != 500 && resp.Status != 302 {
		t.Fatalf("login status = %d, want 500 or 302", resp.Status)
	}
	if resp := ta.Anon("GET", "/api/auth/callback", nil); resp.Status != 500 && resp.Status != 400 {
		t.Fatalf("callback status = %d, want 500 or 400", resp.Status)
	}
}

// test_logout_endpoint
func TestLogoutEndpoint(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.POST("/api/auth/logout", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	obj := resp.Obj()
	if obj["status"] != "logged out" {
		t.Fatalf("status field = %v, want %q", obj["status"], "logged out")
	}
	// No OIDC issuer configured → no end_session_url.
	if _, ok := obj["end_session_url"]; ok {
		t.Fatalf("unexpected end_session_url in %s", resp.Body)
	}
	// The session cookie is cleared.
	cookieCleared := false
	for _, c := range (&http.Response{Header: resp.Header}).Cookies() {
		if c.Name == "meal_planner_session" && c.MaxAge < 0 {
			cookieCleared = true
		}
	}
	if !cookieCleared {
		t.Fatal("logout did not clear the session cookie")
	}
}

// Go-specific extension of test_logout_endpoint: with OIDC configured the
// response carries authentik's invalidation-flow URL (no discovery needed).
func TestLogoutEndpointWithOIDC(t *testing.T) {
	ta := newTestAppWith(t, func(s *config.Settings) {
		s.OIDCIssuer = "https://auth.example.com/application/o/meal-planner/"
	})
	resp := ta.POST("/api/auth/logout", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	want := "https://auth.example.com/if/flow/default-invalidation-flow/"
	if resp.Obj()["end_session_url"] != want {
		t.Fatalf("end_session_url = %v, want %q", resp.Obj()["end_session_url"], want)
	}
}

// ---- Dev login (registered only when OIDC is not configured) ----

func TestDevLogin(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/auth/dev-login", nil)
	if resp.Status != 302 {
		t.Fatalf("status = %d, want 302: %s", resp.Status, resp.Body)
	}
	if loc := resp.Header.Get("Location"); loc != "/" {
		t.Fatalf("Location = %q, want %q", loc, "/")
	}
	// The response sets a usable session cookie for dev-user.
	var cookie *http.Cookie
	for _, c := range (&http.Response{Header: resp.Header}).Cookies() {
		if c.Name == "meal_planner_session" && c.MaxAge > 0 {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("dev-login did not set a session cookie")
	}
	me := ta.do("GET", "/api/auth/me", nil, cookie)
	if me.Status != 200 || me.Obj()["sub"] != "dev-user" {
		t.Fatalf("me = %d %s, want dev-user session", me.Status, me.Body)
	}
	// record_user upserted the directory row.
	var user models.User
	if err := ta.App.DB.Where("sub = ?", "dev-user").First(&user).Error; err != nil {
		t.Fatalf("dev-user not recorded: %v", err)
	}
	if user.Email == nil || *user.Email != "dev@localhost" {
		t.Fatalf("recorded email = %v, want dev@localhost", user.Email)
	}
	// A second dev-login updates rather than duplicates (upsert).
	if resp := ta.Anon("GET", "/api/auth/dev-login", nil); resp.Status != 302 {
		t.Fatalf("second dev-login status = %d", resp.Status)
	}
	var count int64
	ta.App.DB.Model(&models.User{}).Where("sub = ?", "dev-user").Count(&count)
	if count != 1 {
		t.Fatalf("dev-user rows = %d, want 1", count)
	}
}

func TestDevLoginDisabledWhenOIDCConfigured(t *testing.T) {
	ta := newTestAppWith(t, func(s *config.Settings) {
		s.OIDCIssuer = "https://auth.example.com"
	})
	resp := ta.Anon("GET", "/api/auth/dev-login", nil)
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404: %s", resp.Status, resp.Body)
	}
}
