package app

// Tests for serveSPA — the static catch-all mirroring main.py's SPAStaticFiles:
// exact files served as-is, no-cache headers on SW/version files, index.html
// fallback for client-side routes, and traversal attempts never escaping the
// static dir.

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mealplanner/internal/db"
)

// newTestAppWithStatic builds a test app whose StaticDir is a real temp dir.
func newTestAppWithStatic(t *testing.T) (*testApp, string) {
	t.Helper()
	staticDir := t.TempDir()
	writeFile := func(rel, content string) {
		full := filepath.Join(staticDir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	writeFile("index.html", "<html>INDEX</html>")
	writeFile("sw.js", "// service worker")
	writeFile("assets/app.js", "console.log('app')")

	gdb, err := db.OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	settings := testSettings()
	settings.StaticDir = staticDir
	a := New(settings, gdb)
	ta := &testApp{t: t, App: a, h: a.Handler()}
	ta.Cookie = ta.LoginAs(TestSub, TestEmail, TestName)
	return ta, staticDir
}

func TestSPARootServesIndexWithNoCache(t *testing.T) {
	ta, _ := newTestAppWithStatic(t)
	res := ta.Anon("GET", "/", nil)
	if res.Status != 200 {
		t.Fatalf("status = %d", res.Status)
	}
	if !strings.Contains(string(res.Body), "INDEX") {
		t.Fatalf("body = %q, want index.html content", res.Body)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-cache, no-store, must-revalidate" {
		t.Fatalf("Cache-Control = %q", cc)
	}
}

func TestSPAServesExactAssetWithoutNoCache(t *testing.T) {
	ta, _ := newTestAppWithStatic(t)
	res := ta.Anon("GET", "/assets/app.js", nil)
	if res.Status != 200 || !strings.Contains(string(res.Body), "console.log") {
		t.Fatalf("status = %d body = %q", res.Status, res.Body)
	}
	if cc := res.Header.Get("Cache-Control"); strings.Contains(cc, "no-store") {
		t.Fatalf("regular assets must not get no-cache headers, got %q", cc)
	}
}

func TestSPAServiceWorkerGetsNoCacheHeaders(t *testing.T) {
	ta, _ := newTestAppWithStatic(t)
	res := ta.Anon("GET", "/sw.js", nil)
	if res.Status != 200 || !strings.Contains(string(res.Body), "service worker") {
		t.Fatalf("status = %d body = %q", res.Status, res.Body)
	}
	if cc := res.Header.Get("Cache-Control"); cc != "no-cache, no-store, must-revalidate" {
		t.Fatalf("sw.js Cache-Control = %q", cc)
	}
}

func TestSPAUnknownRouteFallsBackToIndex(t *testing.T) {
	ta, _ := newTestAppWithStatic(t)
	// Client-side routes (deep links) get index.html, not 404.
	for _, path := range []string{"/lists", "/grocery/some/deep/route"} {
		res := ta.Anon("GET", path, nil)
		if res.Status != 200 || !strings.Contains(string(res.Body), "INDEX") {
			t.Fatalf("%s: status = %d body = %q, want index fallback", path, res.Status, res.Body)
		}
		if cc := res.Header.Get("Cache-Control"); cc != "no-cache, no-store, must-revalidate" {
			t.Fatalf("%s: index fallback Cache-Control = %q", path, cc)
		}
	}
}

func TestSPATraversalAttemptReturnsIndex(t *testing.T) {
	ta, staticDir := newTestAppWithStatic(t)
	// Plant a file just outside the static dir that must never be served.
	secret := filepath.Join(filepath.Dir(staticDir), "secret.txt")
	if err := os.WriteFile(secret, []byte("TOP-SECRET"), 0o644); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	defer os.Remove(secret)

	for _, path := range []string{
		"/../secret.txt",
		"/assets/../../secret.txt",
		"/..%2fsecret.txt",
	} {
		res := ta.Anon("GET", path, nil)
		// Go's ServeMux may answer unclean paths with a redirect to the
		// cleaned path; follow it once — the destination must stay in-bounds.
		if res.Status == 301 || res.Status == 307 || res.Status == 308 {
			loc := res.Header.Get("Location")
			if strings.Contains(loc, "..") {
				t.Fatalf("%s: redirect keeps traversal: %q", path, loc)
			}
			res = ta.Anon("GET", loc, nil)
		}
		if strings.Contains(string(res.Body), "TOP-SECRET") {
			t.Fatalf("%s leaked file outside static dir", path)
		}
		// The mux rejects percent-encoded traversal outright (400) — also safe.
		if res.Status == 400 {
			continue
		}
		if res.Status != 200 || !strings.Contains(string(res.Body), "INDEX") {
			t.Fatalf("%s: status = %d body = %q, want index", path, res.Status, res.Body)
		}
	}

	// Hit serveSPA directly (bypassing the mux's path cleaning) so its own
	// out-of-bounds guard is exercised. http.ServeFile additionally rejects
	// raw ".." request paths with 400 — either way the file must not leak.
	req := httptest.NewRequest("GET", "http://example.test/", nil)
	req.URL.Path = "/../secret.txt"
	rec := httptest.NewRecorder()
	ta.App.serveSPA(rec, req)
	if strings.Contains(rec.Body.String(), "TOP-SECRET") {
		t.Fatal("serveSPA leaked file outside static dir")
	}
	if rec.Code != 400 && !(rec.Code == 200 && strings.Contains(rec.Body.String(), "INDEX")) {
		t.Fatalf("serveSPA traversal: status = %d body = %q, want 400 or index", rec.Code, rec.Body.String())
	}
}

func TestSPASecurityHeadersOnHTMLOnly(t *testing.T) {
	ta, _ := newTestAppWithStatic(t)
	res := ta.Anon("GET", "/", nil)
	if res.Header.Get("X-Frame-Options") != "DENY" ||
		res.Header.Get("Content-Security-Policy") == "" ||
		res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing security headers on SPA response: %v", res.Header)
	}
	// API responses don't get the CSP headers.
	api := ta.Anon("GET", "/api/health", nil)
	if api.Header.Get("Content-Security-Policy") != "" {
		t.Fatalf("API response must not carry CSP header")
	}
}

func TestSPAMissingStaticDirReturns404(t *testing.T) {
	ta := newTestApp(t) // testSettings uses /nonexistent-static-dir
	res := ta.Anon("GET", "/", nil)
	if res.Status != 404 {
		t.Fatalf("status = %d, want 404 when static dir absent", res.Status)
	}
}

func TestUnknownAPIPathReturnsJSON404(t *testing.T) {
	ta, _ := newTestAppWithStatic(t)
	res := ta.GET("/api/definitely-not-a-route")
	if res.Status != 404 {
		t.Fatalf("status = %d, want 404", res.Status)
	}
	if res.Obj()["detail"] != "Not Found" {
		t.Fatalf("body = %s, want JSON detail (not index.html)", res.Body)
	}
}
