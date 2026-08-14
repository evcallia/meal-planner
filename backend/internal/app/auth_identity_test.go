package app

// Identity-alias tests (docs/auth.md): provider subs are the stable ID,
// email is only the first-login bridge, so email changes at the provider
// must not orphan a user's data.

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"mealplanner/internal/models"
)

// The trap this feature closes: a provider-migrated user (canonical sub from
// the OLD provider) changes their email at the NEW provider. Login #1 links
// by email and writes the alias; login #2 carries the same provider sub but
// a brand-new email and must still resolve to the original account.
func TestEmailChangeAfterProviderSwitch(t *testing.T) {
	provider := newFakeOIDCProvider(t, "meal-planner-client")
	ta := newOIDCTestApp(t, provider)

	email := "evan@example.com"
	if err := ta.App.DB.Create(&models.User{Sub: "authentik-sub-123", Email: &email}).Error; err != nil {
		t.Fatal(err)
	}

	login := func(claims map[string]any) *http.Cookie {
		t.Helper()
		cookie, state, nonce := startLogin(t, ta)
		claims["nonce"] = nonce
		provider.extraClaims = claims
		req := httptest.NewRequest("GET", "/api/auth/callback?code=c&state="+url.QueryEscape(state), nil)
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		ta.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusFound {
			t.Fatalf("callback status = %d body = %s", rec.Code, rec.Body.String())
		}
		return rec.Result().Cookies()[0]
	}

	// Login #1: new provider, old email → email bridge.
	c1 := login(map[string]any{"sub": "authelia-sub-456", "email": "evan@example.com"})
	if me := ta.do("GET", "/api/auth/me", nil, c1); me.Obj()["sub"] != "authentik-sub-123" {
		t.Fatalf("first login sub = %v, want authentik-sub-123", me.Obj()["sub"])
	}
	var alias models.UserIdentity
	if err := ta.App.DB.Where("provider_sub = ?", "authelia-sub-456").First(&alias).Error; err != nil {
		t.Fatalf("alias not recorded on email-bridge login: %v", err)
	}
	if alias.Sub != "authentik-sub-123" {
		t.Fatalf("alias sub = %q, want authentik-sub-123", alias.Sub)
	}

	// Login #2: same provider sub, CHANGED email → alias must win.
	c2 := login(map[string]any{"sub": "authelia-sub-456", "email": "evan.new@example.com"})
	if me := ta.do("GET", "/api/auth/me", nil, c2); me.Obj()["sub"] != "authentik-sub-123" {
		t.Fatalf("post-email-change sub = %v, want authentik-sub-123 (data orphaned!)", me.Obj()["sub"])
	}

	// Directory refreshed in place; no second account appeared.
	var row models.User
	if err := ta.App.DB.Where("sub = ?", "authentik-sub-123").First(&row).Error; err != nil {
		t.Fatal(err)
	}
	if row.Email == nil || *row.Email != "evan.new@example.com" {
		t.Fatalf("directory email = %v, want refreshed", row.Email)
	}
	var count int64
	ta.App.DB.Model(&models.User{}).Count(&count)
	if count != 1 {
		t.Fatalf("users rows = %d, want 1", count)
	}
}

// resolveIdentity unit coverage for the resolution order and alias writes.
func TestResolveIdentityOrder(t *testing.T) {
	ta := newTestApp(t)
	email := "a@example.com"
	ta.App.DB.Create(&models.User{Sub: "canonical-1", Email: &email})

	// Email bridge writes an alias…
	if got := ta.App.resolveIdentity("prov-1", strPtr("A@Example.com"), nil); got.Sub != "canonical-1" {
		t.Fatalf("email bridge sub = %q", got.Sub)
	}
	// …so a later login with a different email still resolves via the alias.
	if got := ta.App.resolveIdentity("prov-1", strPtr("b@example.com"), nil); got.Sub != "canonical-1" {
		t.Fatalf("alias sub = %q", got.Sub)
	}

	// Direct canonical-sub match (no alias row needed, none written).
	if got := ta.App.resolveIdentity("canonical-1", strPtr("c@example.com"), nil); got.Sub != "canonical-1" {
		t.Fatalf("direct sub = %q", got.Sub)
	}
	var selfAliases int64
	ta.App.DB.Model(&models.UserIdentity{}).Where("provider_sub = ?", "canonical-1").Count(&selfAliases)
	if selfAliases != 0 {
		t.Fatal("self-alias written for canonical sub")
	}

	// Sub match beats email match: a provider identity that already resolves
	// must not be re-linked to another account via a colliding email.
	other := "other@example.com"
	ta.App.DB.Create(&models.User{Sub: "canonical-2", Email: &other})
	if got := ta.App.resolveIdentity("prov-1", strPtr("other@example.com"), nil); got.Sub != "canonical-1" {
		t.Fatalf("alias vs email precedence: sub = %q, want canonical-1", got.Sub)
	}

	// Unknown sub + unknown email creates a fresh row.
	if got := ta.App.resolveIdentity("prov-9", strPtr("new@example.com"), nil); got.Sub != "prov-9" {
		t.Fatalf("create sub = %q", got.Sub)
	}
}

// An email change renames the password credential so the user signs in with
// their current email; a collision leaves the old credential untouched.
func TestEmailChangeRenamesCredential(t *testing.T) {
	ta := newTestApp(t)
	old, updated := "old@example.com", "new@example.com"
	ta.App.DB.Create(&models.User{Sub: "sub-1", Email: &old})
	if _, err := SetPasswordCredential(ta.App.DB, old, "long-password-1"); err != nil {
		t.Fatal(err)
	}

	ta.App.resolveIdentity("sub-1", &updated, nil)

	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": updated, "password": "long-password-1",
	}); resp.Status != 200 || resp.Obj()["sub"] != "sub-1" {
		t.Fatalf("login with new email = %d %s", resp.Status, resp.Body)
	}
	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": old, "password": "long-password-1",
	}); resp.Status != 401 {
		t.Fatalf("old username still works: %d", resp.Status)
	}

	// Collision: someone else already owns the target username — skip.
	taken := "taken@example.com"
	ta.App.DB.Create(&models.User{Sub: "sub-2", Email: &taken})
	if _, err := SetPasswordCredential(ta.App.DB, taken, "long-password-2"); err != nil {
		t.Fatal(err)
	}
	ta.App.resolveIdentity("sub-1", &taken, nil)
	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": updated, "password": "long-password-1",
	}); resp.Status != 200 || resp.Obj()["sub"] != "sub-1" {
		t.Fatalf("credential lost on collision: %d %s", resp.Status, resp.Body)
	}
}

// The -set-email CLI escape hatch: directory email + credential move so the
// user's next login (new provider, new email) email-bridges correctly.
func TestSetUserEmailCLI(t *testing.T) {
	ta := newTestApp(t)
	old := "old@example.com"
	ta.App.DB.Create(&models.User{Sub: "sub-1", Email: &old})
	if _, err := SetPasswordCredential(ta.App.DB, old, "long-password-1"); err != nil {
		t.Fatal(err)
	}

	sub, err := SetUserEmail(ta.App.DB, "OLD@example.com", "fresh@example.com")
	if err != nil || sub != "sub-1" {
		t.Fatalf("SetUserEmail = %q, %v", sub, err)
	}
	if got := ta.App.resolveIdentity("brand-new-provider-sub", strPtr("fresh@example.com"), nil); got.Sub != "sub-1" {
		t.Fatalf("post-set-email bridge sub = %q, want sub-1", got.Sub)
	}
	if resp := ta.Anon("POST", "/api/auth/login/password", map[string]any{
		"username": "fresh@example.com", "password": "long-password-1",
	}); resp.Status != 200 {
		t.Fatalf("password login with fresh email = %d", resp.Status)
	}

	if _, err := SetUserEmail(ta.App.DB, "nobody@example.com", "x@example.com"); err == nil {
		t.Fatal("unknown old email should error")
	}
}
