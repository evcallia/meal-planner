package app

// Password (basic) auth + auth-methods + identity-resolution tests
// (docs/auth.md).

import (
	"net/http"
	"strings"
	"testing"

	"mealplanner/internal/config"
	"mealplanner/internal/models"
)

func TestAuthMethodsEndpoint(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/auth/methods", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	obj := resp.Obj()
	if obj["oidc"] != false || obj["password"] != true || obj["oidc_name"] != "SSO" {
		t.Fatalf("methods = %v", obj)
	}

	ta2 := newTestAppWith(t, func(s *config.Settings) {
		s.OIDCIssuer = "https://auth.example.com"
		s.OIDCProviderName = "Authelia"
		s.PasswordAuthEnabled = false
	})
	obj = ta2.Anon("GET", "/api/auth/methods", nil).Obj()
	if obj["oidc"] != true || obj["password"] != false || obj["oidc_name"] != "Authelia" {
		t.Fatalf("methods = %v", obj)
	}
}

// Self-service set-password, then login with it: the session must carry the
// SAME sub the user already had (identity survives the provider switch).
func TestSetPasswordAndLogin(t *testing.T) {
	ta := newTestApp(t)

	resp := ta.POST("/api/auth/password", map[string]any{"password": "hunter2hunter2"})
	if resp.Status != 200 {
		t.Fatalf("set password status = %d: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["username"] != TestEmail {
		t.Fatalf("username = %v, want %q", resp.Obj()["username"], TestEmail)
	}

	// Login with a differently-cased username still matches.
	login := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": strings.ToUpper(TestEmail), "password": "hunter2hunter2",
	})
	if login.Status != 200 {
		t.Fatalf("login status = %d: %s", login.Status, login.Body)
	}
	if login.Obj()["sub"] != TestSub {
		t.Fatalf("sub = %v, want canonical %q", login.Obj()["sub"], TestSub)
	}

	// The returned cookie authenticates /api/auth/me with the canonical sub.
	var cookie *http.Cookie
	for _, c := range (&http.Response{Header: login.Header}).Cookies() {
		if c.Name == "meal_planner_session" && c.MaxAge > 0 {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("password login did not set a session cookie")
	}
	me := ta.do("GET", "/api/auth/me", nil, cookie)
	if me.Status != 200 || me.Obj()["sub"] != TestSub {
		t.Fatalf("me = %d %s, want sub %q", me.Status, me.Body, TestSub)
	}

	// Setting a new password overwrites (upsert, no duplicate rows).
	if resp := ta.POST("/api/auth/password", map[string]any{"password": "new-password-9"}); resp.Status != 200 {
		t.Fatalf("re-set password status = %d", resp.Status)
	}
	var count int64
	ta.App.DB.Model(&models.UserCredential{}).Where("username = ?", TestEmail).Count(&count)
	if count != 1 {
		t.Fatalf("credential rows = %d, want 1", count)
	}
	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": TestEmail, "password": "hunter2hunter2",
	}); resp.Status != 401 {
		t.Fatalf("old password status = %d, want 401", resp.Status)
	}
	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": TestEmail, "password": "new-password-9",
	}); resp.Status != 200 {
		t.Fatalf("new password status = %d", resp.Status)
	}
}

func TestPasswordLoginRejections(t *testing.T) {
	ta := newTestApp(t)
	ta.POST("/api/auth/password", map[string]any{"password": "correct-horse"})

	cases := []struct {
		name   string
		body   map[string]any
		status int
		detail string
	}{
		{"wrong password", map[string]any{"username": TestEmail, "password": "wrong"}, 401, "Invalid username or password"},
		{"unknown user", map[string]any{"username": "nobody@example.com", "password": "whatever"}, 401, "Invalid username or password"},
		{"missing fields", map[string]any{"username": TestEmail}, 400, "Username and password required"},
	}
	for _, c := range cases {
		resp := ta.Anon("POST", "/api/auth/login/password", c.body)
		if resp.Status != c.status {
			t.Fatalf("%s: status = %d, want %d: %s", c.name, resp.Status, c.status, resp.Body)
		}
		if detail, _ := resp.Obj()["detail"].(string); detail != c.detail {
			t.Fatalf("%s: detail = %q, want %q", c.name, detail, c.detail)
		}
	}
}

func TestSetPasswordValidation(t *testing.T) {
	ta := newTestApp(t)
	if resp := ta.POST("/api/auth/password", map[string]any{"password": "short"}); resp.Status != 400 {
		t.Fatalf("short password status = %d, want 400", resp.Status)
	}
	// A session without an email has no username to key the credential on.
	cookie := ta.LoginAs("no-email-sub", "", "")
	resp := ta.do("POST", "/api/auth/password", map[string]any{"password": "long-enough-pw"}, cookie)
	if resp.Status != 400 {
		t.Fatalf("no-email status = %d, want 400: %s", resp.Status, resp.Body)
	}
}

// PASSWORD_AUTH_ENABLED=false removes the endpoints entirely.
func TestPasswordAuthDisabled(t *testing.T) {
	ta := newTestAppWith(t, func(s *config.Settings) { s.PasswordAuthEnabled = false })
	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": "a@b.c", "password": "12345678",
	}); resp.Status != 404 {
		t.Fatalf("login status = %d, want 404", resp.Status)
	}
	if resp := ta.POST("/api/auth/password", map[string]any{"password": "12345678"}); resp.Status != 404 {
		t.Fatalf("set-password status = %d, want 404", resp.Status)
	}
}

// The -set-password CLI helper links to an existing directory user by email,
// and creates a local:<username> user otherwise.
func TestSetPasswordCredentialLinksByEmail(t *testing.T) {
	ta := newTestApp(t)
	email := "evan@example.com"
	if err := ta.App.DB.Create(&models.User{Sub: "authentik-original-sub", Email: &email}).Error; err != nil {
		t.Fatal(err)
	}

	sub, err := SetPasswordCredential(ta.App.DB, "Evan@Example.com", "family-password")
	if err != nil {
		t.Fatalf("SetPasswordCredential: %v", err)
	}
	if sub != "authentik-original-sub" {
		t.Fatalf("sub = %q, want existing authentik-original-sub", sub)
	}

	sub, err = SetPasswordCredential(ta.App.DB, "new@example.com", "another-password")
	if err != nil {
		t.Fatalf("SetPasswordCredential (new): %v", err)
	}
	if sub != "local:new@example.com" {
		t.Fatalf("sub = %q, want local:new@example.com", sub)
	}
	var user models.User
	if err := ta.App.DB.Where("sub = ?", "local:new@example.com").First(&user).Error; err != nil {
		t.Fatalf("directory user not created: %v", err)
	}

	// Both credentials log in and land on their canonical subs.
	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": "evan@example.com", "password": "family-password",
	}); resp.Status != 200 || resp.Obj()["sub"] != "authentik-original-sub" {
		t.Fatalf("linked login = %d %s", resp.Status, resp.Body)
	}
	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": "new@example.com", "password": "another-password",
	}); resp.Status != 200 || resp.Obj()["sub"] != "local:new@example.com" {
		t.Fatalf("local login = %d %s", resp.Status, resp.Body)
	}
}

// Dev-login must not exist on non-localhost deployments: password auth now
// satisfies ValidateSecurity without OIDC, so "no OIDC" no longer implies a
// local environment.
func TestDevLoginDisabledOnNonLocalFrontend(t *testing.T) {
	ta := newTestAppWith(t, func(s *config.Settings) { s.FrontendURL = "https://meals.example.com" })
	if resp := ta.Anon("GET", "/api/auth/dev-login", nil); resp.Status != 404 {
		t.Fatalf("status = %d, want 404", resp.Status)
	}
}

func TestLogoutURLOverride(t *testing.T) {
	ta := newTestAppWith(t, func(s *config.Settings) {
		s.OIDCIssuer = "https://auth.example.com" // would be used for discovery, but…
		s.LogoutURL = "https://auth.example.com/logout"
	})
	resp := ta.POST("/api/auth/logout", nil)
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["end_session_url"] != "https://auth.example.com/logout" {
		t.Fatalf("end_session_url = %v, want the LOGOUT_URL override", resp.Obj()["end_session_url"])
	}
}
