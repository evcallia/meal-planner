package config

// Regression for the .env audit finding: python-dotenv strips inline
// comments from unquoted values (the project's real .env uses them) and
// keeps '#' inside quoted values.

import (
	"os"
	"path/filepath"
	"testing"
)

func writeEnv(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestDotEnvInlineComments(t *testing.T) {
	path := writeEnv(t, `
DEBUG_TIMING=true  # timing logs
SECURE_COOKIES=false	# tab comment
FRONTEND_URL="http://localhost:8000#fragment"  # quoted keeps hash
SECRET_KEY='sk#with#hashes'
MEAL_HISTORY_RETENTION_DAYS=90 # three months
export ALLOW_TUNNEL=true
`)
	s := Load(path)
	if !s.DebugTiming {
		t.Fatal("DEBUG_TIMING with inline comment parsed wrong")
	}
	if s.SecureCookies {
		t.Fatal("SECURE_COOKIES with tab comment parsed wrong")
	}
	if s.FrontendURL != "http://localhost:8000#fragment" {
		t.Fatalf("quoted value mangled: %q", s.FrontendURL)
	}
	if s.SecretKey != "sk#with#hashes" {
		t.Fatalf("single-quoted value mangled: %q", s.SecretKey)
	}
	if s.MealHistoryRetentionDays != 90 {
		t.Fatalf("int with comment = %d", s.MealHistoryRetentionDays)
	}
	if !s.AllowTunnel {
		t.Fatal("export-prefixed line ignored")
	}
}

func TestBoolTokenParity(t *testing.T) {
	// pydantic accepts t/f/y/n; so must we.
	path := writeEnv(t, "SECURE_COOKIES=t\nDEBUG_TIMING=n\n")
	s := Load(path)
	if !s.SecureCookies || s.DebugTiming {
		t.Fatalf("t/n tokens parsed wrong: secure=%v debug=%v", s.SecureCookies, s.DebugTiming)
	}
}

func TestUnterminatedQuoteSkipsBinding(t *testing.T) {
	// python-dotenv treats an unterminated quote as an invalid binding and
	// skips the key entirely (default applies).
	path := writeEnv(t, "FRONTEND_URL=\"http://unterminated\nSECRET_KEY='\n")
	s := Load(path)
	if s.FrontendURL != "http://localhost:8000" {
		t.Fatalf("unterminated quote not skipped: %q", s.FrontendURL)
	}
	if s.SecretKey != "change-me-in-production" {
		t.Fatalf("bare-quote value not skipped: %q", s.SecretKey)
	}
}
