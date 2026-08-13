package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"mealplanner/internal/config"
	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

// oidcClient lazily initializes the OIDC provider (discovery needs network,
// which may not be up when the server starts).
type oidcClient struct {
	settings *config.Settings
	mu       sync.Mutex
	provider *oidc.Provider
}

func newOIDCClient(s *config.Settings) *oidcClient { return &oidcClient{settings: s} }

func (c *oidcClient) get(ctx context.Context) (*oidc.Provider, *oauth2.Config, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.provider == nil {
		p, err := oidc.NewProvider(ctx, c.settings.OIDCIssuer)
		if err != nil {
			return nil, nil, err
		}
		c.provider = p
	}
	conf := &oauth2.Config{
		ClientID:     c.settings.OIDCClientID,
		ClientSecret: c.settings.OIDCClientSecret,
		Endpoint:     c.provider.Endpoint(),
		RedirectURL:  c.settings.OIDCRedirectURI,
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}
	return c.provider, conf, nil
}

func randomToken() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// resolveIdentity maps a login from ANY source (any OIDC provider, password
// auth, dev-login) onto the canonical directory user, so identities survive
// provider switches (docs/auth.md). Email is the linking key: an email match
// wins over the provider's sub, and the matched row's existing sub becomes
// the session identity — the new provider's sub never enters the DB. Without
// a match the login creates a fresh directory row keyed by providerSub.
func (a *App) resolveIdentity(providerSub string, email, name *string) *session.UserInfo {
	update := func(row *models.User) *session.UserInfo {
		if email != nil && *email != "" {
			row.Email = email
		}
		if name != nil && *name != "" {
			row.Name = name
		}
		if err := a.DB.Save(row).Error; err != nil {
			log.Printf("resolve_identity update failed: %v", err)
		}
		return &session.UserInfo{Sub: row.Sub, Email: row.Email, Name: row.Name}
	}
	var row models.User
	if email != nil && *email != "" {
		// Oldest row wins if duplicates exist — that's the original identity.
		err := a.DB.Where("email IS NOT NULL AND lower(email) = lower(?)", *email).
			Order("last_seen ASC").First(&row).Error
		if err == nil {
			return update(&row)
		}
	}
	if err := a.DB.Where("sub = ?", providerSub).First(&row).Error; err == nil {
		return update(&row)
	}
	if err := a.DB.Create(&models.User{Sub: providerSub, Email: email, Name: name}).Error; err != nil {
		log.Printf("resolve_identity insert failed: %v", err)
	}
	return &session.UserInfo{Sub: providerSub, Email: email, Name: name}
}

// saveUserSession writes the session cookie for a resolved identity (the
// exact map shape the Python app stored).
func (a *App) saveUserSession(w http.ResponseWriter, user *session.UserInfo) {
	userMap := map[string]any{"sub": user.Sub, "email": nil, "name": nil}
	if user.Email != nil {
		userMap["email"] = *user.Email
	}
	if user.Name != nil {
		userMap["name"] = *user.Name
	}
	a.Sessions.Save(w, map[string]any{"user": userMap})
}

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	if a.oidc == nil {
		httpx.Detail(w, http.StatusInternalServerError, "OIDC not configured")
		return
	}
	_, conf, err := a.oidc.get(r.Context())
	if err != nil {
		httpx.Detail(w, http.StatusInternalServerError, "OIDC discovery failed")
		return
	}
	state, nonce := randomToken(), randomToken()
	data := a.Sessions.Get(r)
	data["oauth_state"] = state
	data["oauth_nonce"] = nonce
	a.Sessions.Save(w, data)
	http.Redirect(w, r, conf.AuthCodeURL(state, oidc.Nonce(nonce)), http.StatusFound)
}

func (a *App) handleCallback(w http.ResponseWriter, r *http.Request) {
	if a.oidc == nil {
		httpx.Detail(w, http.StatusInternalServerError, "OIDC not configured")
		return
	}
	provider, conf, err := a.oidc.get(r.Context())
	if err != nil {
		httpx.Detail(w, http.StatusInternalServerError, "OIDC discovery failed")
		return
	}
	data := a.Sessions.Get(r)
	wantState, _ := data["oauth_state"].(string)
	if wantState == "" || r.URL.Query().Get("state") != wantState {
		httpx.Detail(w, http.StatusBadRequest, "Invalid OAuth state")
		return
	}
	token, err := conf.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		httpx.Detail(w, http.StatusBadRequest, "Token exchange failed")
		return
	}
	rawIDToken, _ := token.Extra("id_token").(string)
	if rawIDToken == "" {
		httpx.Detail(w, http.StatusBadRequest, "Failed to get user info")
		return
	}
	verifier := provider.Verifier(&oidc.Config{ClientID: conf.ClientID})
	idToken, err := verifier.Verify(r.Context(), rawIDToken)
	if err != nil {
		httpx.Detail(w, http.StatusBadRequest, "Invalid ID token")
		return
	}
	if nonce, _ := data["oauth_nonce"].(string); nonce != "" && idToken.Nonce != nonce {
		httpx.Detail(w, http.StatusBadRequest, "Invalid nonce")
		return
	}
	var claims struct {
		Sub               string  `json:"sub"`
		Email             *string `json:"email"`
		Name              *string `json:"name"`
		PreferredUsername *string `json:"preferred_username"`
	}
	if err := idToken.Claims(&claims); err != nil || claims.Sub == "" {
		httpx.Detail(w, http.StatusBadRequest, "Failed to get user info")
		return
	}
	name := claims.Name
	if name == nil || *name == "" {
		name = claims.PreferredUsername
	}
	user := a.resolveIdentity(claims.Sub, claims.Email, name)
	a.saveUserSession(w, user)

	http.Redirect(w, r, a.Settings.FrontendURL, http.StatusFound)
}

// endSessionEndpoint returns the provider's discovered end_session_endpoint,
// or "" when discovery fails or the provider doesn't advertise one.
func (c *oidcClient) endSessionEndpoint(ctx context.Context) string {
	p, _, err := c.get(ctx)
	if err != nil {
		return ""
	}
	var claims struct {
		EndSessionEndpoint string `json:"end_session_endpoint"`
	}
	if p.Claims(&claims) != nil {
		return ""
	}
	return claims.EndSessionEndpoint
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	a.Sessions.Clear(w)
	resp := map[string]string{"status": "logged out"}
	// LOGOUT_URL wins (lets the operator end the provider session too, e.g.
	// Authelia's /logout); else fall back to OIDC discovery. Logout must not
	// hang or fail on an unreachable provider — short timeout, omit on error.
	if a.Settings.LogoutURL != "" {
		resp["end_session_url"] = a.Settings.LogoutURL
	} else if a.oidc != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if u := a.oidc.endSessionEndpoint(ctx); u != "" {
			resp["end_session_url"] = u
		}
	}
	httpx.WriteJSON(w, 200, resp)
}

func (a *App) handleMe(w http.ResponseWriter, r *http.Request) {
	user := session.UserFrom(a.Sessions.Get(r))
	if user == nil {
		httpx.WriteJSON(w, 200, nil)
		return
	}
	httpx.WriteJSON(w, 200, map[string]any{"sub": user.Sub, "email": user.Email, "name": user.Name})
}

func (a *App) handleDevLogin(w http.ResponseWriter, r *http.Request) {
	email, name := "dev@localhost", "Dev User"
	user := a.resolveIdentity("dev-user", &email, &name)
	a.saveUserSession(w, user)
	http.Redirect(w, r, "/", http.StatusFound)
}

// handleAuthMethods is public: it drives the login screen before any session
// exists.
func (a *App) handleAuthMethods(w http.ResponseWriter, r *http.Request) {
	httpx.WriteJSON(w, 200, map[string]any{
		"oidc":      a.Settings.OIDCIssuer != "",
		"oidc_name": a.Settings.OIDCProviderName,
		"password":  a.Settings.PasswordAuthEnabled,
	})
}
