package session

// Regression: sessions must expire server-side 14 days after issuance —
// the signed payload carries the issued-at, so a captured cookie cannot be
// replayed forever (itsdangerous.TimestampSigner parity).

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func mintCookie(m *Manager, data map[string]any) string {
	payload, _ := json.Marshal(data)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + m.sign(payload)
}

func getWithCookie(m *Manager, value string) map[string]any {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Cookie", CookieName+"="+value)
	return m.Get(req)
}

func TestFreshSessionAccepted(t *testing.T) {
	m := NewManager("secret", false, false)
	rec := httptest.NewRecorder()
	m.Save(rec, map[string]any{"user": map[string]any{"sub": "u1"}})
	cookie := rec.Result().Cookies()[0]
	data := getWithCookie(m, cookie.Value)
	if UserFrom(data) == nil {
		t.Fatal("fresh session rejected")
	}
	if _, present := data["_ts"]; present {
		t.Fatal("internal timestamp leaked into session data")
	}
}

func TestExpiredSessionRejected(t *testing.T) {
	m := NewManager("secret", false, false)
	old := time.Now().Add(-15 * 24 * time.Hour).Unix()
	value := mintCookie(m, map[string]any{
		"user": map[string]any{"sub": "u1"}, "_ts": old,
	})
	if UserFrom(getWithCookie(m, value)) != nil {
		t.Fatal("15-day-old session accepted")
	}
}

func TestSessionWithoutTimestampRejected(t *testing.T) {
	m := NewManager("secret", false, false)
	value := mintCookie(m, map[string]any{"user": map[string]any{"sub": "u1"}})
	if UserFrom(getWithCookie(m, value)) != nil {
		t.Fatal("session without issued-at accepted")
	}
}

func TestTouchSlidesWindow(t *testing.T) {
	m := NewManager("secret", false, false)
	// 2-day-old session: Touch must re-issue a freshly-stamped cookie.
	old := time.Now().Add(-2 * 24 * time.Hour).Unix()
	value := mintCookie(m, map[string]any{"user": map[string]any{"sub": "u1"}, "_ts": old})
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Cookie", CookieName+"="+value)
	rec := httptest.NewRecorder()
	m.Touch(rec, req)
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected re-issued cookie, got %d", len(cookies))
	}
	data := getWithCookie(m, cookies[0].Value)
	if UserFrom(data) == nil {
		t.Fatal("re-issued cookie invalid")
	}

	// Fresh session: no Set-Cookie churn.
	rec2 := httptest.NewRecorder()
	m.Save(rec2, map[string]any{"user": map[string]any{"sub": "u1"}})
	fresh := rec2.Result().Cookies()[0]
	req3 := httptest.NewRequest("GET", "/", nil)
	req3.AddCookie(fresh)
	rec3 := httptest.NewRecorder()
	m.Touch(rec3, req3)
	if len(rec3.Result().Cookies()) != 0 {
		t.Fatal("fresh session should not be re-issued")
	}

	// Expired session: Touch must NOT resurrect it.
	expired := mintCookie(m, map[string]any{
		"user": map[string]any{"sub": "u1"},
		"_ts":  time.Now().Add(-15 * 24 * time.Hour).Unix(),
	})
	req4 := httptest.NewRequest("GET", "/", nil)
	req4.Header.Set("Cookie", CookieName+"="+expired)
	rec4 := httptest.NewRecorder()
	m.Touch(rec4, req4)
	if len(rec4.Result().Cookies()) != 0 {
		t.Fatal("expired session was resurrected by Touch")
	}
}
