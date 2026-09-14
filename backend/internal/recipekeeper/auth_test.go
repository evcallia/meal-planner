// backend/internal/recipekeeper/auth_test.go
package recipekeeper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// makeJWT builds an unsigned-but-well-formed token whose exp is `exp`.
// Only the payload is ever parsed; the signature is never verified locally.
func makeJWT(exp time.Time) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	header := enc(map[string]string{"alg": "HS512", "typ": "JWT"})
	payload := enc(map[string]any{
		"nameid": "u1", "unique_name": "user@example.com",
		"nbf": exp.Add(-14 * 24 * time.Hour).Unix(),
		"exp": exp.Unix(),
		"iat": exp.Add(-14 * 24 * time.Hour).Unix(),
	})
	return header + "." + payload + ".sig"
}

func TestTokenFetchesAndCaches(t *testing.T) {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/token" {
			t.Errorf("path = %s, want /token", r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/x-www-form-urlencoded" {
			t.Errorf("content-type = %q", ct)
		}
		if v := r.Header.Get("X-RK-APIVersion"); v != "10" {
			t.Errorf("X-RK-APIVersion = %q, want 10", v)
		}
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "password" {
			t.Errorf("grant_type = %q", r.Form.Get("grant_type"))
		}
		if r.Form.Get("username") != "user@example.com" || r.Form.Get("password") != "pw" {
			t.Errorf("credentials not sent: %v", r.Form)
		}
		// token_type is null in the real response — a client must not read it.
		fmt.Fprintf(w, `{"access_token":%q,"token_type":null,"expires_in":0,
		                 "userName":null,".issued":null,".expires":null}`,
			makeJWT(now.Add(14*24*time.Hour)))
	}))
	defer srv.Close()

	a := &Authenticator{
		BaseURL: srv.URL, Username: "user@example.com", Password: "pw",
		HTTP: srv.Client(), Now: func() time.Time { return now },
	}

	tok, err := a.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if !strings.HasPrefix(tok, "eyJ") {
		t.Errorf("token = %q, want a JWT", tok)
	}
	if _, err := a.Token(context.Background()); err != nil {
		t.Fatalf("second Token: %v", err)
	}
	if calls != 1 {
		t.Errorf("hit /token %d times, want 1 (second call must use cache)", calls)
	}
}

func TestTokenRenewsBeforeExpiry(t *testing.T) {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		// Expires in 12h — inside the 24h renewal margin, so it must refetch.
		fmt.Fprintf(w, `{"access_token":%q}`, makeJWT(now.Add(12*time.Hour)))
	}))
	defer srv.Close()

	a := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}

	_, _ = a.Token(context.Background())
	_, _ = a.Token(context.Background())
	if calls != 2 {
		t.Errorf("calls = %d, want 2 (token inside renewal margin must refetch)", calls)
	}
}

func TestTokenErrorsOnBadCredentials(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":"invalid_grant"}`)
	}))
	defer srv.Close()

	a := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "bad",
		HTTP: srv.Client(), Now: time.Now}
	_, err := a.Token(context.Background())
	if err == nil {
		t.Fatal("want error on 400, got nil")
	}
	if !IsAuthError(err) {
		t.Errorf("IsAuthError(%v) = false, want true", err)
	}
}
