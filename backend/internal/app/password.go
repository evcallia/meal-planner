package app

// Username/password ("basic") auth — the provider-independent fallback login
// (docs/auth.md). Credentials live in user_credentials keyed by lowercase
// username (normally an email) and point at the canonical users row, so
// password logins share identity with OIDC logins. Gated by
// PASSWORD_AUTH_ENABLED (routes are simply not registered when disabled).

import (
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

const minPasswordLength = 8

// bcrypt only reads the first 72 bytes; GenerateFromPassword errors beyond
// that. Reject explicitly instead of surfacing a 500.
const maxPasswordBytes = 72

// Online brute-force throttle: after this many failures for one username
// within the window, logins for it get 429 until attempts age out. In-memory
// (restart resets), like the push batch state.
const (
	maxLoginFailures   = 10
	loginFailureWindow = 15 * time.Minute
)

type loginLimiter struct {
	mu    sync.Mutex
	fails map[string][]time.Time
	now   func() time.Time // injectable for tests
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{fails: map[string][]time.Time{}, now: time.Now}
}

// prune drops aged-out failures for username; caller holds mu.
func (l *loginLimiter) prune(username string) {
	cutoff := l.now().Add(-loginFailureWindow)
	kept := l.fails[username][:0]
	for _, t := range l.fails[username] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.fails, username)
		return
	}
	l.fails[username] = kept
}

func (l *loginLimiter) blocked(username string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(username)
	return len(l.fails[username]) >= maxLoginFailures
}

func (l *loginLimiter) recordFailure(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(username)
	l.fails[username] = append(l.fails[username], l.now())
}

func (l *loginLimiter) reset(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.fails, username)
}

// dummyHash keeps the compare cost identical for unknown usernames so the
// login endpoint doesn't leak which usernames exist via timing.
var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("dummy-password-for-timing"), bcrypt.DefaultCost)

func upsertCredential(db *gorm.DB, username, sub, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	username = strings.ToLower(strings.TrimSpace(username))
	var existing models.UserCredential
	if err := db.Where("username = ?", username).First(&existing).Error; err == nil {
		existing.Sub = sub
		existing.PasswordHash = string(hash)
		return db.Save(&existing).Error
	}
	return db.Create(&models.UserCredential{
		Username: username, Sub: sub, PasswordHash: string(hash),
	}).Error
}

// migrateCredentialUsername renames a password credential when an account's
// email changes so the user keeps signing in with their CURRENT email.
// Best-effort: skipped when no credential exists for the old email or when
// the new username is already taken (logged, never fatal — the old
// credential still works).
func migrateCredentialUsername(db *gorm.DB, sub, oldEmail, newEmail string) {
	oldU := strings.ToLower(strings.TrimSpace(oldEmail))
	newU := strings.ToLower(strings.TrimSpace(newEmail))
	if oldU == "" || newU == "" || oldU == newU {
		return
	}
	var cred models.UserCredential
	if err := db.Where("username = ? AND sub = ?", oldU, sub).First(&cred).Error; err != nil {
		return
	}
	var clash int64
	db.Model(&models.UserCredential{}).Where("username = ?", newU).Count(&clash)
	if clash > 0 {
		log.Printf("credential rename %s -> %s skipped: username already in use", oldU, newU)
		return
	}
	if err := db.Model(&models.UserCredential{}).Where("username = ?", oldU).
		Updates(map[string]any{"username": newU, "updated_at": models.NowUTC()}).Error; err != nil {
		log.Printf("credential rename %s -> %s failed: %v", oldU, newU, err)
	}
}

// SetUserEmail is the `server -set-email` CLI helper — the escape hatch for
// a user who changed provider AND email before ever logging in (no alias row
// and no email match possible). Updates the directory email and renames any
// password credential to match.
func SetUserEmail(db *gorm.DB, oldEmail, newEmail string) (string, error) {
	var user models.User
	if err := db.Where("email IS NOT NULL AND lower(email) = lower(?)", oldEmail).
		Order("last_seen ASC").First(&user).Error; err != nil {
		return "", fmt.Errorf("no user with email %s", oldEmail)
	}
	migrateCredentialUsername(db, user.Sub, oldEmail, newEmail)
	trimmed := strings.TrimSpace(newEmail)
	user.Email = &trimmed
	if err := db.Save(&user).Error; err != nil {
		return "", err
	}
	return user.Sub, nil
}

// SetPasswordCredential creates or updates a password login (used by the
// `server -set-password` CLI). The username links to an existing directory
// user by email; without a match a new user `local:<username>` is created.
func SetPasswordCredential(db *gorm.DB, username, password string) (string, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	var user models.User
	err := db.Where("email IS NOT NULL AND lower(email) = lower(?)", username).
		Order("last_seen ASC").First(&user).Error
	if err != nil {
		user = models.User{Sub: "local:" + username, Email: &username}
		if err := db.Where("sub = ?", user.Sub).First(&models.User{}).Error; err != nil {
			if err := db.Create(&user).Error; err != nil {
				return "", err
			}
		}
	}
	if err := upsertCredential(db, username, user.Sub, password); err != nil {
		return "", err
	}
	return user.Sub, nil
}

func (a *App) handlePasswordLogin(w http.ResponseWriter, r *http.Request) {
	// Public endpoint: requireUser's body cap doesn't apply, so cap here.
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if _, err := httpx.DecodeBody(r, &body); err != nil || body.Username == "" || body.Password == "" {
		httpx.Detail(w, http.StatusBadRequest, "Username and password required")
		return
	}
	username := strings.ToLower(strings.TrimSpace(body.Username))
	if a.loginLimiter.blocked(username) {
		httpx.Detail(w, http.StatusTooManyRequests, "Too many failed attempts. Try again later.")
		return
	}
	var cred models.UserCredential
	err := a.DB.Where("username = ?", username).First(&cred).Error
	if err != nil {
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(body.Password))
		a.loginLimiter.recordFailure(username)
		httpx.Detail(w, http.StatusUnauthorized, "Invalid username or password")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(cred.PasswordHash), []byte(body.Password)) != nil {
		a.loginLimiter.recordFailure(username)
		httpx.Detail(w, http.StatusUnauthorized, "Invalid username or password")
		return
	}
	a.loginLimiter.reset(username)
	// The credential pins the canonical sub; the directory row supplies
	// email/name for the session (fall back to the username as email).
	var user models.User
	info := &session.UserInfo{Sub: cred.Sub, Email: &cred.Username}
	if err := a.DB.Where("sub = ?", cred.Sub).First(&user).Error; err == nil {
		info.Email, info.Name = user.Email, user.Name
	} else {
		log.Printf("password login: no users row for sub %s", cred.Sub)
	}
	a.saveUserSession(w, info)
	httpx.WriteJSON(w, 200, map[string]any{"sub": info.Sub, "email": info.Email, "name": info.Name})
}

// handleSetPassword lets a signed-in user (however they signed in) set a
// password for their own account — the self-service migration path before
// switching OIDC providers.
func (a *App) handleSetPassword(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var body struct {
		Password string `json:"password"`
	}
	if _, err := httpx.DecodeBody(r, &body); err != nil {
		httpx.Detail(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if len(body.Password) < minPasswordLength {
		httpx.Detail(w, http.StatusBadRequest, "Password must be at least 8 characters")
		return
	}
	if len(body.Password) > maxPasswordBytes {
		httpx.Detail(w, http.StatusBadRequest, "Password must be at most 72 characters")
		return
	}
	if user.Email == nil || *user.Email == "" {
		httpx.Detail(w, http.StatusBadRequest, "Account has no email address to use as username")
		return
	}
	username := strings.ToLower(*user.Email)
	if err := upsertCredential(a.DB, username, user.Sub, body.Password); err != nil {
		httpx.Detail(w, http.StatusInternalServerError, "Failed to save password")
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"status": "password set", "username": username})
}
