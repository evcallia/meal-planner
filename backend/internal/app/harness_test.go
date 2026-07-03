package app

// Shared test harness mirroring backend/tests/conftest.py:
// in-memory SQLite, a signed session cookie for the mock user, JSON request
// helpers, and an SSE collector replacing the Python broadcast mocks.

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"mealplanner/internal/config"
	"mealplanner/internal/db"
	"mealplanner/internal/ical"
	"mealplanner/internal/realtime"
)

// Mock user matching conftest.mock_user.
const (
	TestSub   = "test-user-123"
	TestEmail = "test@example.com"
	TestName  = "Test User"
)

type testApp struct {
	t   *testing.T
	App *App
	h   http.Handler
	// Cookie for the default authenticated user.
	Cookie *http.Cookie
}

func testSettings() *config.Settings {
	return &config.Settings{
		PostgresHost: "test", PostgresPort: 5432, PostgresDB: "test",
		PostgresUser: "test", PostgresPassword: "test",
		SecretKey:                "test-secret-key-for-testing-only",
		FrontendURL:              "http://localhost:3000",
		StaticDir:                "/nonexistent-static-dir",
		MealHistoryRetentionDays: 365,
	}
}

func newTestApp(t *testing.T) *testApp {
	t.Helper()
	gdb, err := db.OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	a := New(testSettings(), gdb)
	// No network in tests: calendar fetchers are stubbed to empty.
	a.Calendar.FetchCalDAVEvents = func(start, end time.Time) []ical.EventWithSource { return nil }
	a.Calendar.FetchHolidaysRaw = func() ([]byte, error) { return nil, errors.New("no network in tests") }
	a.Calendar.ListCalendarsFn = func() ([]ical.Calendar, error) { return nil, nil }
	ta := &testApp{t: t, App: a, h: a.Handler()}
	ta.Cookie = ta.LoginAs(TestSub, TestEmail, TestName)
	return ta
}

// LoginAs builds a signed session cookie for the given identity.
func (ta *testApp) LoginAs(sub, email, name string) *http.Cookie {
	rec := httptest.NewRecorder()
	ta.App.Sessions.Save(rec, map[string]any{"user": map[string]any{
		"sub": sub, "email": email, "name": name,
	}})
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		ta.t.Fatal("no session cookie produced")
	}
	return cookies[0]
}

type result struct {
	Status int
	Body   []byte
	Header http.Header
}

// JSON decodes the response body into a generic value.
func (r *result) JSON() any {
	var v any
	if len(r.Body) == 0 {
		return nil
	}
	if err := json.Unmarshal(r.Body, &v); err != nil {
		return nil
	}
	return v
}

// Obj returns the body as a JSON object.
func (r *result) Obj() map[string]any {
	v, _ := r.JSON().(map[string]any)
	return v
}

// List returns the body as a JSON array.
func (r *result) List() []any {
	v, _ := r.JSON().([]any)
	return v
}

// do performs a request. cookie may be nil for unauthenticated calls.
func (ta *testApp) do(method, path string, body any, cookie *http.Cookie) *result {
	ta.t.Helper()
	var reader *bytes.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			ta.t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(buf)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	ta.h.ServeHTTP(rec, req)
	return &result{Status: rec.Code, Body: rec.Body.Bytes(), Header: rec.Header()}
}

// Authenticated request helpers (mirror authenticated_client).
func (ta *testApp) GET(path string) *result { return ta.do("GET", path, nil, ta.Cookie) }
func (ta *testApp) DELETE(path string) *result {
	return ta.do("DELETE", path, nil, ta.Cookie)
}
func (ta *testApp) POST(path string, body any) *result {
	return ta.do("POST", path, body, ta.Cookie)
}
func (ta *testApp) PUT(path string, body any) *result {
	return ta.do("PUT", path, body, ta.Cookie)
}
func (ta *testApp) PATCH(path string, body any) *result {
	return ta.do("PATCH", path, body, ta.Cookie)
}

// Anonymous request helper (mirrors the bare `client` fixture).
func (ta *testApp) Anon(method, path string, body any) *result {
	return ta.do(method, path, body, nil)
}

// ---- SSE collection (replaces @patch broadcast mocks) ----

// Collector drains a broadcaster subscription into parsed events.
type Collector struct {
	sub *realtime.Subscriber
	b   *realtime.Broadcaster
}

// Collect subscribes to events for the given user sub. Global publishes
// reach every subscriber regardless of sub.
func (ta *testApp) Collect(sub string) *Collector {
	return &Collector{sub: ta.App.Broadcaster.Subscribe(sub), b: ta.App.Broadcaster}
}

// Events drains all queued messages: [{type, payload, source_id?}, ...].
func (c *Collector) Events() []map[string]any {
	var out []map[string]any
	for {
		select {
		case msg := <-c.sub.Ch:
			// Strip "data: " prefix and trailing newlines.
			trimmed := msg
			if len(trimmed) > 6 && trimmed[:6] == "data: " {
				trimmed = trimmed[6:]
			}
			var v map[string]any
			if json.Unmarshal([]byte(trimmed), &v) == nil {
				out = append(out, v)
			}
		default:
			c.b.Unsubscribe(c.sub)
			return out
		}
	}
}

// LastPayload returns the payload of the most recent event of the given type,
// or nil.
func (c *Collector) LastPayload(eventType string) map[string]any {
	events := c.Events()
	for i := len(events) - 1; i >= 0; i-- {
		if events[i]["type"] == eventType {
			p, _ := events[i]["payload"].(map[string]any)
			return p
		}
	}
	return nil
}
