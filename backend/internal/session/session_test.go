package session

// Tests for the signed-cookie session layer, focusing on tamper rejection:
// any modification to payload or signature must yield an empty session.

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func managerAndCookie(t *testing.T, data map[string]any) (*Manager, *http.Cookie) {
	t.Helper()
	m := NewManager("test-secret", false, false)
	rec := httptest.NewRecorder()
	m.Save(rec, data)
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected one cookie, got %d", len(cookies))
	}
	return m, cookies[0]
}

func requestWithCookieValue(value string) *http.Request {
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: value})
	return req
}

func TestSaveGetRoundtrip(t *testing.T) {
	m, cookie := managerAndCookie(t, map[string]any{"user": map[string]any{
		"sub": "abc", "email": "a@b.c", "name": "A",
	}})
	data := m.Get(requestWithCookieValue(cookie.Value))
	user := UserFrom(data)
	if user == nil || user.Sub != "abc" || user.Email == nil || *user.Email != "a@b.c" {
		t.Fatalf("roundtrip user = %+v", user)
	}
}

func TestGetMissingCookieReturnsEmpty(t *testing.T) {
	m := NewManager("test-secret", false, false)
	data := m.Get(httptest.NewRequest("GET", "/", nil))
	if len(data) != 0 {
		t.Fatalf("expected empty session, got %v", data)
	}
}

func TestTamperedPayloadRejected(t *testing.T) {
	m, cookie := managerAndCookie(t, map[string]any{"user": map[string]any{"sub": "abc"}})
	dot := strings.LastIndex(cookie.Value, ".")
	payload, sig := cookie.Value[:dot], cookie.Value[dot+1:]

	// Forge a payload claiming a different sub, keep the original signature.
	forged := base64.RawURLEncoding.EncodeToString([]byte(`{"user":{"sub":"admin"}}`))
	data := m.Get(requestWithCookieValue(forged + "." + sig))
	if len(data) != 0 {
		t.Fatalf("tampered payload must be rejected, got %v", data)
	}
	// Tamper with the signature instead.
	flipped := sig[:len(sig)-1] + string('A'+(sig[len(sig)-1]-'A'+1)%26)
	data = m.Get(requestWithCookieValue(payload + "." + flipped))
	if len(data) != 0 {
		t.Fatalf("tampered signature must be rejected, got %v", data)
	}
}

func TestWrongSecretRejected(t *testing.T) {
	_, cookie := managerAndCookie(t, map[string]any{"user": map[string]any{"sub": "abc"}})
	other := NewManager("different-secret", false, false)
	if data := other.Get(requestWithCookieValue(cookie.Value)); len(data) != 0 {
		t.Fatalf("cookie signed with another secret must be rejected, got %v", data)
	}
}

func TestMalformedCookieValuesRejected(t *testing.T) {
	m := NewManager("test-secret", false, false)
	for _, value := range []string{
		"",                 // empty
		"no-dot-here",      // missing signature separator
		"!!!not-base64.ok", // invalid base64 payload
		"aGVsbG8.c2ln",     // valid base64 but bad signature
	} {
		if data := m.Get(requestWithCookieValue(value)); len(data) != 0 {
			t.Fatalf("value %q must yield empty session, got %v", value, data)
		}
	}
}

func TestNonJSONPayloadRejected(t *testing.T) {
	m := NewManager("test-secret", false, false)
	payload := []byte("this is not json")
	value := base64.RawURLEncoding.EncodeToString(payload) + "." + m.sign(payload)
	if data := m.Get(requestWithCookieValue(value)); len(data) != 0 {
		t.Fatalf("non-JSON payload must yield empty session, got %v", data)
	}
}

func TestCookieAttributes(t *testing.T) {
	// Insecure/lax mode.
	m := NewManager("s", false, false)
	rec := httptest.NewRecorder()
	m.Save(rec, map[string]any{})
	c := rec.Result().Cookies()[0]
	if c.Name != CookieName || !c.HttpOnly || c.Secure || c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie attrs = %+v", c)
	}
	if c.MaxAge != 14*24*3600 {
		t.Fatalf("MaxAge = %d, want 14 days", c.MaxAge)
	}
	// Secure + SameSite=None (tunnel mode).
	m = NewManager("s", true, true)
	rec = httptest.NewRecorder()
	m.Save(rec, map[string]any{})
	c = rec.Result().Cookies()[0]
	if !c.Secure || c.SameSite != http.SameSiteNoneMode {
		t.Fatalf("tunnel cookie attrs = %+v", c)
	}
}

func TestClearExpiresCookie(t *testing.T) {
	m := NewManager("s", false, false)
	rec := httptest.NewRecorder()
	m.Clear(rec)
	c := rec.Result().Cookies()[0]
	if c.Value != "" || c.MaxAge != -1 {
		t.Fatalf("Clear cookie = %+v", c)
	}
}

func TestUserFromVariants(t *testing.T) {
	if UserFrom(map[string]any{}) != nil {
		t.Fatal("empty session must yield nil user")
	}
	if UserFrom(map[string]any{"user": "not-a-map"}) != nil {
		t.Fatal("non-map user must yield nil")
	}
	if UserFrom(map[string]any{"user": map[string]any{"email": "x@y.z"}}) != nil {
		t.Fatal("user without sub must yield nil")
	}
	u := UserFrom(map[string]any{"user": map[string]any{"sub": "s1"}})
	if u == nil || u.Sub != "s1" || u.Email != nil || u.Name != nil {
		t.Fatalf("sub-only user = %+v", u)
	}
}
