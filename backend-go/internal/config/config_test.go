package config

// Port of backend/tests/test_config.py.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---- TestIsLocalhostUrl ----

func TestIsLocalhostURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		// test_localhost
		{"http://localhost:8000", true},
		{"https://localhost:443", true},
		{"http://localhost", true},
		// test_127_0_0_1
		{"http://127.0.0.1:8000", true},
		{"https://127.0.0.1", true},
		// test_ipv6_localhost
		{"http://[::1]:8000", true},
		// test_non_localhost
		{"http://example.com", false},
		{"https://myapp.com:8000", false},
		{"http://192.168.1.1:8000", false},
		// test_invalid_url
		{"", false},
		{"not-a-url", false},
		{"://invalid", false},
	}
	for _, c := range cases {
		if got := isLocalhostURL(c.url); got != c.want {
			t.Errorf("isLocalhostURL(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

// ---- TestSettings ----

// baseSettings mirrors pydantic's Settings(...) constructor defaults for the
// fields validate_security cares about.
func baseSettings() *Settings {
	return &Settings{
		PostgresHost: "db", PostgresPort: 5432, PostgresDB: "mealplanner",
		PostgresUser: "mealplanner", PostgresPassword: "changeme",
		SecretKey:   "change-me-in-production",
		FrontendURL: "http://localhost:8000",
	}
}

func TestDatabaseURLProperty(t *testing.T) {
	s := &Settings{
		PostgresHost: "myhost", PostgresPort: 5432, PostgresDB: "mydb",
		PostgresUser: "myuser", PostgresPassword: "mypass",
	}
	want := "postgresql://myuser:mypass@myhost:5432/mydb"
	if got := s.DatabaseURL(); got != want {
		t.Fatalf("DatabaseURL() = %q, want %q", got, want)
	}
}

func TestValidateSecurityLocalNoOIDC(t *testing.T) {
	s := baseSettings()
	s.FrontendURL = "http://localhost:8000"
	s.OIDCIssuer = ""
	s.SecretKey = "change-me-in-production"
	s.SecureCookies = false
	if err := s.ValidateSecurity(); err != nil {
		t.Fatalf("ValidateSecurity() = %v, want nil", err)
	}
}

func TestValidateSecurityWithTunnel(t *testing.T) {
	s := baseSettings()
	s.FrontendURL = "https://myapp.example.com"
	s.OIDCIssuer = "https://auth.example.com"
	s.SecretKey = "change-me-in-production"
	s.SecureCookies = false
	s.AllowTunnel = true
	if err := s.ValidateSecurity(); err != nil {
		t.Fatalf("ValidateSecurity() = %v, want nil", err)
	}
}

func TestValidateSecurityInsecureSecretKey(t *testing.T) {
	s := baseSettings()
	s.FrontendURL = "https://myapp.example.com"
	s.OIDCIssuer = "https://auth.example.com"
	s.SecretKey = "change-me-in-production"
	s.SecureCookies = true
	err := s.ValidateSecurity()
	if err == nil || !strings.Contains(err.Error(), "SECRET_KEY must be set") {
		t.Fatalf("ValidateSecurity() = %v, want SECRET_KEY error", err)
	}
}

func TestValidateSecurityInsecureCookies(t *testing.T) {
	s := baseSettings()
	s.FrontendURL = "https://myapp.example.com"
	s.OIDCIssuer = "https://auth.example.com"
	s.SecretKey = "proper-secure-key-here"
	s.SecureCookies = false
	err := s.ValidateSecurity()
	if err == nil || !strings.Contains(err.Error(), "SECURE_COOKIES must be true") {
		t.Fatalf("ValidateSecurity() = %v, want SECURE_COOKIES error", err)
	}
}

func TestValidateSecurityAllSecure(t *testing.T) {
	s := baseSettings()
	s.FrontendURL = "https://myapp.example.com"
	s.OIDCIssuer = "https://auth.example.com"
	s.SecretKey = "proper-secure-key-here"
	s.SecureCookies = true
	s.PostgresPassword = "a-real-password"
	if err := s.ValidateSecurity(); err != nil {
		t.Fatalf("ValidateSecurity() = %v, want nil", err)
	}
}

func TestValidateSecurityNonLocalRequiresOIDC(t *testing.T) {
	s := baseSettings()
	s.FrontendURL = "https://myapp.example.com"
	s.OIDCIssuer = ""
	s.SecretKey = "proper-secure-key-here"
	s.SecureCookies = true
	s.PostgresPassword = "a-real-password"
	err := s.ValidateSecurity()
	if err == nil || !strings.Contains(err.Error(), "OIDC_ISSUER must be configured") {
		t.Fatalf("ValidateSecurity() = %v, want OIDC_ISSUER error", err)
	}
}

func TestValidateSecurityTunnelAllowsNoOIDC(t *testing.T) {
	s := baseSettings()
	s.FrontendURL = "https://abc123.ngrok.io"
	s.OIDCIssuer = ""
	s.SecretKey = "change-me-in-production"
	s.SecureCookies = false
	s.AllowTunnel = true
	if err := s.ValidateSecurity(); err != nil {
		t.Fatalf("ValidateSecurity() = %v, want nil", err)
	}
}

func TestValidateSecurityDefaultDBPassword(t *testing.T) {
	s := baseSettings()
	s.FrontendURL = "https://myapp.example.com"
	s.OIDCIssuer = "https://auth.example.com"
	s.SecretKey = "proper-secure-key-here"
	s.SecureCookies = true
	s.PostgresPassword = "changeme"
	err := s.ValidateSecurity()
	if err == nil || !strings.Contains(err.Error(), "POSTGRES_PASSWORD must be set") {
		t.Fatalf("ValidateSecurity() = %v, want POSTGRES_PASSWORD error", err)
	}
}

// ---- defaults (test_apple_calendar_names_default etc.) ----

// settingsEnvKeys are all env vars Load consults; unset them so defaults are
// deterministic regardless of the host environment.
var settingsEnvKeys = []string{
	"POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD",
	"APPLE_CALENDAR_EMAIL", "APPLE_CALENDAR_APP_PASSWORD", "APPLE_CALENDAR_NAMES",
	"OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI",
	"SECRET_KEY", "FRONTEND_URL", "SECURE_COOKIES", "DEBUG_TIMING", "ALLOW_TUNNEL",
	"MEAL_HISTORY_RETENTION_DAYS", "STATIC_DIR",
}

// clearSettingsEnv unsets every settings env var for the test's duration
// (t.Setenv registers restoration of the original value).
func clearSettingsEnv(t *testing.T) {
	t.Helper()
	for _, key := range settingsEnvKeys {
		t.Setenv(key, "")
		os.Unsetenv(key)
	}
}

// loadClean loads settings from a nonexistent .env with a scrubbed env.
func loadClean(t *testing.T) *Settings {
	t.Helper()
	clearSettingsEnv(t)
	return Load(filepath.Join(t.TempDir(), "does-not-exist.env"))
}

func TestAppleCalendarNamesDefault(t *testing.T) {
	if s := loadClean(t); s.AppleCalendarNames != "" {
		t.Fatalf("AppleCalendarNames = %q, want empty", s.AppleCalendarNames)
	}
}

func TestDebugTimingDefault(t *testing.T) {
	if s := loadClean(t); s.DebugTiming {
		t.Fatal("DebugTiming = true, want false")
	}
}

func TestAllowTunnelDefault(t *testing.T) {
	if s := loadClean(t); s.AllowTunnel {
		t.Fatal("AllowTunnel = true, want false")
	}
}

// ---- TestMealHistoryRetention ----

func TestMealHistoryRetentionDefaultsToOneYear(t *testing.T) {
	if s := loadClean(t); s.MealHistoryRetentionDays != 365 {
		t.Fatalf("MealHistoryRetentionDays = %d, want 365", s.MealHistoryRetentionDays)
	}
}

func TestMealHistoryRetentionEnvOverride(t *testing.T) {
	clearSettingsEnv(t)
	t.Setenv("MEAL_HISTORY_RETENTION_DAYS", "30")
	s := Load(filepath.Join(t.TempDir(), "does-not-exist.env"))
	if s.MealHistoryRetentionDays != 30 {
		t.Fatalf("MealHistoryRetentionDays = %d, want 30", s.MealHistoryRetentionDays)
	}
}

// ---- TestGetSettings (test_get_settings_returns_settings) ----

func TestLoadReturnsSettings(t *testing.T) {
	s := loadClean(t)
	if s == nil {
		t.Fatal("Load returned nil")
	}
	// Spot-check core defaults from the pydantic field definitions.
	if s.PostgresHost != "db" || s.PostgresPort != 5432 || s.PostgresDB != "mealplanner" {
		t.Fatalf("postgres defaults = %s:%d/%s", s.PostgresHost, s.PostgresPort, s.PostgresDB)
	}
	if s.SecretKey != "change-me-in-production" {
		t.Fatalf("SecretKey = %q", s.SecretKey)
	}
	if s.FrontendURL != "http://localhost:8000" {
		t.Fatalf("FrontendURL = %q", s.FrontendURL)
	}
	if s.OIDCRedirectURI != "http://localhost:8000/api/auth/callback" {
		t.Fatalf("OIDCRedirectURI = %q", s.OIDCRedirectURI)
	}
	if s.SecureCookies {
		t.Fatal("SecureCookies default = true, want false")
	}
}

// ---- .env handling (pydantic-settings env_file counterpart) ----

func TestLoadReadsDotEnvFile(t *testing.T) {
	clearSettingsEnv(t)
	path := filepath.Join(t.TempDir(), ".env")
	content := "" +
		"# comment line\n" +
		"POSTGRES_HOST=envfile-host\n" +
		"SECRET_KEY=\"quoted-secret\"\n" +
		"SECURE_COOKIES=true\n" +
		"MEAL_HISTORY_RETENTION_DAYS=42\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}

	s := Load(path)
	if s.PostgresHost != "envfile-host" {
		t.Fatalf("PostgresHost = %q, want envfile-host", s.PostgresHost)
	}
	if s.SecretKey != "quoted-secret" {
		t.Fatalf("SecretKey = %q, want quoted-secret (quotes stripped)", s.SecretKey)
	}
	if !s.SecureCookies {
		t.Fatal("SecureCookies = false, want true from .env")
	}
	if s.MealHistoryRetentionDays != 42 {
		t.Fatalf("MealHistoryRetentionDays = %d, want 42", s.MealHistoryRetentionDays)
	}
}

func TestEnvVarsWinOverDotEnv(t *testing.T) {
	clearSettingsEnv(t)
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("POSTGRES_HOST=from-dotenv\n"), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	t.Setenv("POSTGRES_HOST", "from-env")

	if s := Load(path); s.PostgresHost != "from-env" {
		t.Fatalf("PostgresHost = %q, want from-env (env beats .env)", s.PostgresHost)
	}
}
