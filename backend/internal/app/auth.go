package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"log"
	"net/http"
	"net/url"
	"sync"

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

// recordUser mirrors auth.record_user: best-effort upsert into the user
// directory used by the tracker share picker.
func (a *App) recordUser(u *session.UserInfo) {
	if u == nil || u.Sub == "" {
		return
	}
	var existing models.User
	err := a.DB.Where("sub = ?", u.Sub).First(&existing).Error
	if err == nil {
		existing.Email = u.Email
		existing.Name = u.Name
		if err := a.DB.Save(&existing).Error; err != nil {
			log.Printf("record_user update failed: %v", err)
		}
		return
	}
	if err := a.DB.Create(&models.User{Sub: u.Sub, Email: u.Email, Name: u.Name}).Error; err != nil {
		log.Printf("record_user insert failed: %v", err)
	}
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
	user := &session.UserInfo{Sub: claims.Sub, Email: claims.Email, Name: name}

	newSession := map[string]any{"user": map[string]any{}}
	userMap := map[string]any{"sub": user.Sub}
	if user.Email != nil {
		userMap["email"] = *user.Email
	} else {
		userMap["email"] = nil
	}
	if user.Name != nil {
		userMap["name"] = *user.Name
	} else {
		userMap["name"] = nil
	}
	newSession["user"] = userMap
	a.Sessions.Save(w, newSession)
	a.recordUser(user)

	http.Redirect(w, r, a.Settings.FrontendURL, http.StatusFound)
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	a.Sessions.Clear(w)
	if a.Settings.OIDCIssuer != "" {
		if u, err := url.Parse(a.Settings.OIDCIssuer); err == nil {
			httpx.WriteJSON(w, 200, map[string]string{
				"status":          "logged out",
				"end_session_url": u.Scheme + "://" + u.Host + "/if/flow/default-invalidation-flow/",
			})
			return
		}
	}
	httpx.WriteJSON(w, 200, map[string]string{"status": "logged out"})
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
	user := &session.UserInfo{Sub: "dev-user", Email: &email, Name: &name}
	a.Sessions.Save(w, map[string]any{"user": map[string]any{
		"sub": user.Sub, "email": email, "name": name,
	}})
	a.recordUser(user)
	http.Redirect(w, r, "/", http.StatusFound)
}
