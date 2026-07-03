package app

// Full OIDC login/callback flow tests (port of test_auth.py's
// test_callback_successful / test_callback_missing_userinfo, which mocked the
// authlib client). Here a fake OIDC provider (discovery + JWKS + token
// endpoint) runs on an httptest server and the real handlers do the work.

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"mealplanner/internal/db"
	"mealplanner/internal/models"
)

type fakeOIDCProvider struct {
	key    *rsa.PrivateKey
	server *httptest.Server
	// claims merged into every issued id_token (test sets nonce etc).
	extraClaims map[string]any
	// when true the token response omits id_token.
	omitIDToken bool
	// when non-zero the token endpoint fails with this status.
	tokenStatus int
	clientID    string
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (p *fakeOIDCProvider) signIDToken(t *testing.T) string {
	t.Helper()
	claims := map[string]any{
		"iss": p.server.URL,
		"aud": p.clientID,
		"exp": time.Now().Add(time.Hour).Unix(),
		"iat": time.Now().Unix(),
	}
	for k, v := range p.extraClaims {
		claims[k] = v
	}
	header, _ := json.Marshal(map[string]any{"alg": "RS256", "typ": "JWT", "kid": "test-key"})
	payload, _ := json.Marshal(claims)
	signingInput := b64url(header) + "." + b64url(payload)
	digest := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign id_token: %v", err)
	}
	return signingInput + "." + b64url(sig)
}

func newFakeOIDCProvider(t *testing.T, clientID string) *fakeOIDCProvider {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa key: %v", err)
	}
	p := &fakeOIDCProvider{key: key, clientID: clientID, extraClaims: map[string]any{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                p.server.URL,
			"authorization_endpoint":                p.server.URL + "/authorize",
			"token_endpoint":                        p.server.URL + "/token",
			"jwks_uri":                              p.server.URL + "/jwks",
			"response_types_supported":              []string{"code"},
			"subject_types_supported":               []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []map[string]any{{
				"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "test-key",
				"n": b64url(key.N.Bytes()),
				"e": b64url(big.NewInt(int64(key.E)).Bytes()),
			}},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if p.tokenStatus != 0 {
			http.Error(w, "token error", p.tokenStatus)
			return
		}
		resp := map[string]any{"access_token": "fake-access-token", "token_type": "Bearer"}
		if !p.omitIDToken {
			resp["id_token"] = p.signIDToken(t)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	p.server = httptest.NewServer(mux)
	t.Cleanup(p.server.Close)
	return p
}

// newOIDCTestApp builds an app configured against the fake provider.
func newOIDCTestApp(t *testing.T, provider *fakeOIDCProvider) *testApp {
	t.Helper()
	gdb, err := db.OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	settings := testSettings()
	settings.OIDCIssuer = provider.server.URL
	settings.OIDCClientID = provider.clientID
	settings.OIDCClientSecret = "test-client-secret"
	settings.OIDCRedirectURI = "http://localhost:8000/api/auth/callback"
	a := New(settings, gdb)
	return &testApp{t: t, App: a, h: a.Handler()}
}

// startLogin performs GET /api/auth/login and returns the session cookie plus
// the state/nonce embedded in the authorize redirect.
func startLogin(t *testing.T, ta *testApp) (*http.Cookie, string, string) {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/auth/login", nil)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("login status = %d body = %s", rec.Code, rec.Body.String())
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse authorize URL: %v", err)
	}
	state := loc.Query().Get("state")
	nonce := loc.Query().Get("nonce")
	if state == "" || nonce == "" {
		t.Fatalf("authorize URL missing state/nonce: %s", loc)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("login did not set a session cookie")
	}
	return cookies[0], state, nonce
}

func TestLoginOIDCConfiguredRedirectsToAuthorize(t *testing.T) {
	provider := newFakeOIDCProvider(t, "meal-planner-client")
	ta := newOIDCTestApp(t, provider)

	req := httptest.NewRequest("GET", "/api/auth/login", nil)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, provider.server.URL+"/authorize") {
		t.Fatalf("Location = %q, want provider authorize endpoint", loc)
	}
	u, _ := url.Parse(loc)
	q := u.Query()
	if q.Get("client_id") != "meal-planner-client" ||
		q.Get("redirect_uri") != "http://localhost:8000/api/auth/callback" ||
		q.Get("response_type") != "code" {
		t.Fatalf("authorize params = %v", q)
	}
	if !strings.Contains(q.Get("scope"), "openid") {
		t.Fatalf("scope = %q, want openid", q.Get("scope"))
	}
}

// Port of test_callback_successful.
func TestCallbackSuccessful(t *testing.T) {
	provider := newFakeOIDCProvider(t, "meal-planner-client")
	ta := newOIDCTestApp(t, provider)
	cookie, state, nonce := startLogin(t, ta)

	provider.extraClaims = map[string]any{
		"sub": "oidc-user-1", "email": "user@example.com", "name": "OIDC User", "nonce": nonce,
	}

	req := httptest.NewRequest("GET", "/api/auth/callback?code=fake-code&state="+url.QueryEscape(state), nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("callback status = %d body = %s", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc != ta.App.Settings.FrontendURL {
		t.Fatalf("redirect = %q, want frontend URL %q", loc, ta.App.Settings.FrontendURL)
	}

	// The new session cookie authenticates /api/auth/me.
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("callback did not set a session cookie")
	}
	me := ta.do("GET", "/api/auth/me", nil, cookies[0])
	if me.Status != 200 {
		t.Fatalf("me status = %d", me.Status)
	}
	user := me.Obj()
	if user["sub"] != "oidc-user-1" || user["email"] != "user@example.com" || user["name"] != "OIDC User" {
		t.Fatalf("me = %v", user)
	}

	// record_user upserted the directory row (used by the tracker share picker).
	var row models.User
	if err := ta.App.DB.Where("sub = ?", "oidc-user-1").First(&row).Error; err != nil {
		t.Fatalf("user not recorded: %v", err)
	}
	if row.Email == nil || *row.Email != "user@example.com" {
		t.Fatalf("recorded user = %+v", row)
	}
}

// Port of test_callback_missing_userinfo: no id_token → 400 "Failed to get user info".
func TestCallbackMissingIDToken(t *testing.T) {
	provider := newFakeOIDCProvider(t, "meal-planner-client")
	ta := newOIDCTestApp(t, provider)
	cookie, state, nonce := startLogin(t, ta)
	provider.extraClaims = map[string]any{"sub": "x", "nonce": nonce}
	provider.omitIDToken = true

	req := httptest.NewRequest("GET", "/api/auth/callback?code=fake-code&state="+url.QueryEscape(state), nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "Failed to get user info") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCallbackInvalidState(t *testing.T) {
	provider := newFakeOIDCProvider(t, "meal-planner-client")
	ta := newOIDCTestApp(t, provider)
	cookie, _, _ := startLogin(t, ta)

	req := httptest.NewRequest("GET", "/api/auth/callback?code=fake-code&state=wrong-state", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Invalid OAuth state") {
		t.Fatalf("status = %d body = %s, want 400 Invalid OAuth state", rec.Code, rec.Body.String())
	}

	// No session at all (e.g. cold callback hit) is also rejected.
	req = httptest.NewRequest("GET", "/api/auth/callback?code=c&state=s", nil)
	rec = httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Invalid OAuth state") {
		t.Fatalf("cold callback: status = %d body = %s", rec.Code, rec.Body.String())
	}
}

func TestCallbackTokenExchangeFailure(t *testing.T) {
	provider := newFakeOIDCProvider(t, "meal-planner-client")
	ta := newOIDCTestApp(t, provider)
	cookie, state, _ := startLogin(t, ta)
	provider.tokenStatus = http.StatusInternalServerError

	req := httptest.NewRequest("GET", "/api/auth/callback?code=fake-code&state="+url.QueryEscape(state), nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Token exchange failed") {
		t.Fatalf("status = %d body = %s, want 400 Token exchange failed", rec.Code, rec.Body.String())
	}
}

func TestCallbackInvalidNonce(t *testing.T) {
	provider := newFakeOIDCProvider(t, "meal-planner-client")
	ta := newOIDCTestApp(t, provider)
	cookie, state, _ := startLogin(t, ta)
	provider.extraClaims = map[string]any{"sub": "x", "nonce": "some-other-nonce"}

	req := httptest.NewRequest("GET", "/api/auth/callback?code=fake-code&state="+url.QueryEscape(state), nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Invalid nonce") {
		t.Fatalf("status = %d body = %s, want 400 Invalid nonce", rec.Code, rec.Body.String())
	}
}

// preferred_username is used when the name claim is absent.
func TestCallbackFallsBackToPreferredUsername(t *testing.T) {
	provider := newFakeOIDCProvider(t, "meal-planner-client")
	ta := newOIDCTestApp(t, provider)
	cookie, state, nonce := startLogin(t, ta)
	provider.extraClaims = map[string]any{
		"sub": "oidc-user-2", "email": "u2@example.com", "preferred_username": "u2handle", "nonce": nonce,
	}

	req := httptest.NewRequest("GET", "/api/auth/callback?code=fake-code&state="+url.QueryEscape(state), nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	me := ta.do("GET", "/api/auth/me", nil, rec.Result().Cookies()[0])
	if me.Obj()["name"] != "u2handle" {
		t.Fatalf("name = %v, want preferred_username fallback", me.Obj()["name"])
	}
}
