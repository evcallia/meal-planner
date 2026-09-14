// backend/internal/recipekeeper/auth.go
package recipekeeper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// renewMargin is how far before expiry a token is proactively replaced. The
// 401 response shape was never observed, so renewal is time-driven, not
// failure-driven.
const renewMargin = 24 * time.Hour

type authError struct{ err error }

func (e authError) Error() string { return e.err.Error() }
func (e authError) Unwrap() error { return e.err }

// IsAuthError reports whether err came from rejected credentials, as opposed to
// a transport failure. Callers surface the two differently: bad credentials
// never self-heal, so they alert immediately.
func IsAuthError(err error) bool {
	var a authError
	return errors.As(err, &a)
}

// Authenticator owns the access token. Recipe Keeper issues no refresh token,
// so renewal replays the password grant — which is why credentials must be
// held for the life of the process.
type Authenticator struct {
	BaseURL  string
	Username string
	Password string
	HTTP     *http.Client
	Hdr      Headers
	Now      func() time.Time

	mu     sync.Mutex
	token  string
	expiry time.Time
}

func (a *Authenticator) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now().UTC()
}

// Token returns a valid access token, fetching or renewing as needed.
func (a *Authenticator) Token(ctx context.Context) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.token != "" && a.now().Add(renewMargin).Before(a.expiry) {
		return a.token, nil
	}

	form := url.Values{
		"username":   {a.Username},
		"password":   {a.Password},
		"grant_type": {"password"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		a.BaseURL+"/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	a.Hdr.apply(req)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := a.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("recipekeeper: token request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized {
		return "", authError{fmt.Errorf("recipekeeper: credentials rejected (%d)", resp.StatusCode)}
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("recipekeeper: token status %d", resp.StatusCode)
	}

	// Only access_token is usable: token_type is null and expires_in is 0.
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return "", fmt.Errorf("recipekeeper: malformed token response")
	}

	exp, err := jwtExpiry(out.AccessToken)
	if err != nil {
		return "", err
	}
	a.token, a.expiry = out.AccessToken, exp
	return a.token, nil
}

// jwtExpiry reads the exp claim. The signature is never verified — this token is
// an opaque bearer credential to us, and only the server can validate it.
func jwtExpiry(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, fmt.Errorf("recipekeeper: token is not a JWT")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, fmt.Errorf("recipekeeper: token payload: %w", err)
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil || claims.Exp == 0 {
		return time.Time{}, fmt.Errorf("recipekeeper: token has no exp claim")
	}
	return time.Unix(claims.Exp, 0).UTC(), nil
}
