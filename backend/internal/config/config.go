// Package config mirrors backend/app/config.py: settings from env vars with a
// .env file fallback (real environment variables win over .env entries).
package config

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Settings struct {
	// Database
	PostgresHost     string
	PostgresPort     int
	PostgresDB       string
	PostgresUser     string
	PostgresPassword string

	// Apple Calendar (CalDAV)
	AppleCalendarEmail       string
	AppleCalendarAppPassword string
	AppleCalendarNames       string // comma-separated list of calendar names to sync

	// OIDC (Authentik)
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string
	OIDCRedirectURI  string

	// App
	SecretKey                string
	FrontendURL              string
	SecureCookies            bool
	DebugTiming              bool
	AllowTunnel              bool
	MealHistoryRetentionDays int

	// StaticDir is where the built React app lives (not part of the Python
	// Settings class; the Python app derived it from __file__).
	StaticDir string
}

// loadDotEnv parses a .env file of KEY=VALUE lines. Missing file is fine.
func loadDotEnv(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		eq := strings.Index(line, "=")
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		// python-dotenv parity: quoted values keep '#' verbatim; an
		// unterminated quote is an invalid binding and the key is skipped;
		// unquoted values are cut at a whitespace-preceded inline comment.
		if len(val) >= 1 && (val[0] == '"' || val[0] == '\'') {
			end := strings.IndexByte(val[1:], val[0])
			if end < 0 {
				continue // unterminated quote — skip the binding
			}
			val = val[1 : 1+end]
		} else {
			for _, marker := range []string{" #", "\t#"} {
				if idx := strings.Index(val, marker); idx >= 0 {
					val = strings.TrimSpace(val[:idx])
				}
			}
		}
		out[strings.ToUpper(key)] = val
	}
	return out
}

type lookup struct{ dotenv map[string]string }

func (l lookup) str(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	if v, ok := l.dotenv[key]; ok {
		return v
	}
	return def
}

func (l lookup) boolean(key string, def bool) bool {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on", "t", "y":
		return true
	case "0", "false", "no", "off", "f", "n":
		return false
	}
	return def
}

func (l lookup) integer(key string, def int) int {
	raw := l.str(key, "")
	if raw == "" {
		return def
	}
	if n, err := strconv.Atoi(raw); err == nil {
		return n
	}
	return def
}

// Load reads settings, checking os env first then the .env file at envPath.
func Load(envPath string) *Settings {
	l := lookup{dotenv: loadDotEnv(envPath)}
	return &Settings{
		PostgresHost:     l.str("POSTGRES_HOST", "db"),
		PostgresPort:     l.integer("POSTGRES_PORT", 5432),
		PostgresDB:       l.str("POSTGRES_DB", "mealplanner"),
		PostgresUser:     l.str("POSTGRES_USER", "mealplanner"),
		PostgresPassword: l.str("POSTGRES_PASSWORD", "changeme"),

		AppleCalendarEmail:       l.str("APPLE_CALENDAR_EMAIL", ""),
		AppleCalendarAppPassword: l.str("APPLE_CALENDAR_APP_PASSWORD", ""),
		AppleCalendarNames:       l.str("APPLE_CALENDAR_NAMES", ""),

		OIDCIssuer:       l.str("OIDC_ISSUER", ""),
		OIDCClientID:     l.str("OIDC_CLIENT_ID", ""),
		OIDCClientSecret: l.str("OIDC_CLIENT_SECRET", ""),
		OIDCRedirectURI:  l.str("OIDC_REDIRECT_URI", "http://localhost:8000/api/auth/callback"),

		SecretKey:                l.str("SECRET_KEY", "change-me-in-production"),
		FrontendURL:              l.str("FRONTEND_URL", "http://localhost:8000"),
		SecureCookies:            l.boolean("SECURE_COOKIES", false),
		DebugTiming:              l.boolean("DEBUG_TIMING", false),
		AllowTunnel:              l.boolean("ALLOW_TUNNEL", false),
		MealHistoryRetentionDays: l.integer("MEAL_HISTORY_RETENTION_DAYS", 365),

		StaticDir: l.str("STATIC_DIR", "static"),
	}
}

func (s *Settings) DatabaseURL() string {
	return fmt.Sprintf("postgresql://%s:%s@%s:%d/%s",
		s.PostgresUser, s.PostgresPassword, s.PostgresHost, s.PostgresPort, s.PostgresDB)
}

func isLocalhostURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// ValidateSecurity fails fast when running in a non-local environment with
// insecure defaults (mirrors Settings.validate_security).
func (s *Settings) ValidateSecurity() error {
	isLocal := isLocalhostURL(s.FrontendURL)
	usesOIDC := s.OIDCIssuer != ""
	if isLocal && !usesOIDC {
		return nil
	}
	if s.AllowTunnel {
		return nil
	}
	if s.SecretKey == "change-me-in-production" {
		return fmt.Errorf("SECRET_KEY must be set to a secure value for non-local deployments.")
	}
	if !s.SecureCookies {
		return fmt.Errorf("SECURE_COOKIES must be true for non-local deployments.")
	}
	if !usesOIDC {
		return fmt.Errorf("OIDC_ISSUER must be configured for non-local deployments.")
	}
	if s.PostgresPassword == "changeme" {
		return fmt.Errorf("POSTGRES_PASSWORD must be set to a secure value for non-local deployments.")
	}
	return nil
}
