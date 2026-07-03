// Package session implements HMAC-signed cookie sessions (the Go counterpart
// of Starlette's SessionMiddleware; same cookie name, not wire-compatible —
// users just sign in again after the switchover).
package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"
)

const CookieName = "meal_planner_session"

// maxAge mirrors Starlette's SessionMiddleware default (14 days). The
// issued-at stamp lives INSIDE the signed payload and is enforced
// server-side — cookie Max-Age alone is client-enforced and worthless
// against a captured cookie (itsdangerous.TimestampSigner parity).
const maxAge = 14 * 24 * time.Hour

// timestampKey is reserved in the session map for the signed issued-at.
const timestampKey = "_ts"

type Manager struct {
	secret   []byte
	secure   bool
	sameSite http.SameSite
}

func NewManager(secretKey string, secure bool, sameSiteNone bool) *Manager {
	ss := http.SameSiteLaxMode
	if sameSiteNone {
		ss = http.SameSiteNoneMode
	}
	return &Manager{secret: []byte(secretKey), secure: secure, sameSite: ss}
}

func (m *Manager) sign(payload []byte) string {
	mac := hmac.New(sha256.New, m.secret)
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Get returns the session data map (empty map when absent/invalid).
func (m *Manager) Get(r *http.Request) map[string]any {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return map[string]any{}
	}
	parts := c.Value
	dot := -1
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] == '.' {
			dot = i
			break
		}
	}
	if dot < 0 {
		return map[string]any{}
	}
	payloadB64, sig := parts[:dot], parts[dot+1:]
	payload, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return map[string]any{}
	}
	if !hmac.Equal([]byte(m.sign(payload)), []byte(sig)) {
		return map[string]any{}
	}
	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		return map[string]any{}
	}
	issuedAt, ok := data[timestampKey].(float64)
	if !ok || time.Since(time.Unix(int64(issuedAt), 0)) > maxAge {
		return map[string]any{} // missing or expired issued-at → not a session
	}
	delete(data, timestampKey)
	return data
}

// refreshAfter is how old a session may get before Touch re-stamps it.
const refreshAfter = 24 * time.Hour

// Touch re-issues a valid session cookie when it's older than a day, giving
// active users a sliding 14-day window (Starlette re-signs on every
// response; once a day is enough and avoids a Set-Cookie on every request).
func (m *Manager) Touch(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return
	}
	dot := -1
	for i := len(c.Value) - 1; i >= 0; i-- {
		if c.Value[i] == '.' {
			dot = i
			break
		}
	}
	if dot < 0 {
		return
	}
	payload, err := base64.RawURLEncoding.DecodeString(c.Value[:dot])
	if err != nil || !hmac.Equal([]byte(m.sign(payload)), []byte(c.Value[dot+1:])) {
		return
	}
	var data map[string]any
	if json.Unmarshal(payload, &data) != nil {
		return
	}
	issuedAt, ok := data[timestampKey].(float64)
	if !ok {
		return
	}
	age := time.Since(time.Unix(int64(issuedAt), 0))
	if age <= refreshAfter || age > maxAge {
		return // fresh enough, or expired (Get will reject it)
	}
	delete(data, timestampKey)
	m.Save(w, data)
}

// Save writes the session cookie with the given data.
func (m *Manager) Save(w http.ResponseWriter, data map[string]any) {
	stamped := make(map[string]any, len(data)+1)
	for k, v := range data {
		stamped[k] = v
	}
	stamped[timestampKey] = time.Now().Unix()
	payload, _ := json.Marshal(stamped)
	value := base64.RawURLEncoding.EncodeToString(payload) + "." + m.sign(payload)
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   int(maxAge / time.Second),
		HttpOnly: true,
		Secure:   m.secure,
		SameSite: m.sameSite,
	})
}

// Clear expires the session cookie.
func (m *Manager) Clear(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   m.secure,
		SameSite: m.sameSite,
	})
}

// UserInfo is the session's stored user identity.
type UserInfo struct {
	Sub   string  `json:"sub"`
	Email *string `json:"email"`
	Name  *string `json:"name"`
}

// UserFrom extracts the "user" entry from a session map, or nil.
func UserFrom(data map[string]any) *UserInfo {
	raw, ok := data["user"].(map[string]any)
	if !ok {
		return nil
	}
	u := &UserInfo{}
	if s, ok := raw["sub"].(string); ok {
		u.Sub = s
	}
	if u.Sub == "" {
		return nil
	}
	if s, ok := raw["email"].(string); ok {
		u.Email = &s
	}
	if s, ok := raw["name"].(string); ok {
		u.Name = &s
	}
	return u
}
