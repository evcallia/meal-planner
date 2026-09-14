# Recipe Keeper Sync — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync the Recipe Keeper shopping list into the Meal Planner grocery list in both directions, preserving which recipe each item came from.

**Architecture:** A Go package `internal/recipekeeper` holds a protocol client (`client.go`, `auth.go`) strictly separated from sync logic (`reconcile.go`), driven by a long-poll loop (`loop.go`). Recipe Keeper rows are linked to grocery items through a `recipe_keeper_links` table — many links per item, since RK stores one row per recipe-ingredient occurrence. Outbound sync is declarative: each link caches the last known RK state, and a reconcile pass pushes whatever differs.

**Tech Stack:** Go, GORM, `glebarez/sqlite` (tests) / Postgres (prod), stdlib `net/http`.

**Spec:** [`docs/superpowers/specs/2026-09-13-recipe-keeper-sync-design.md`](../specs/2026-09-13-recipe-keeper-sync-design.md)
**Protocol reference:** [`docs/recipe-keeper-api.md`](../../recipe-keeper-api.md)

**Scope:** Backend only. Frontend surfacing (recipe names on rows, the popover, group-by-recipe, recipe chips, the pinned error row) is a separate plan that depends on Task 9 of this one.

## Global Constraints

- **The subsystem is off unless `RECIPE_KEEPER_ENABLED=true`.** No goroutine starts, no tables are read, nothing changes for existing installs.
- **Pull-heavy, write-narrow.** The only entity ever pushed is `ShoppingListItem`. Never push `Recipe`, `Meal`, or any other bucket.
- **Never push `IsDeleted: true` except from a tombstone row.** Deletion is the one irreversible operation against a third party's data.
- **Every push sends the complete entity.** The protocol has no partial-update semantics; a missing field overwrites the server's value.
- **`LastModified` Z-suffix rule:** server values carry `Z` (`2026-09-13T23:55:28.3967144Z`); pushed values are the same string with `Z` stripped. Creates send `null`. Never generate your own timestamp — echo the server's.
- **`X-RK-APIVersion: 10`** and the full `X-RK-*` header set on every request, including `/token`.
- **Timestamps in this codebase are naive UTC** — use `models.NowUTC()`, never `time.Now()`.
- **Raw SQL must run on both SQLite and Postgres** (tests use the former, prod the latter).
- Test fixtures live in `backend/internal/recipekeeper/testdata/` and are already committed.

---

### Task 1: Config and database models

**Files:**
- Modify: `backend/internal/config/config.go`
- Create: `backend/internal/models/recipekeeper.go`
- Modify: `backend/internal/models/models.go:690-703` (`AllModels`)
- Test: `backend/internal/models/recipekeeper_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.Settings.RecipeKeeperEnabled/Username/Password/ListID/ReceiptID`; models `RecipeKeeperLink`, `RecipeKeeperRecipe`, `RecipeKeeperTombstone`, `RecipeKeeperState`.

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/models/recipekeeper_test.go
package models_test

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"mealplanner/internal/models"
)

func TestRecipeKeeperTablesMigrate(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.AutoMigrate(models.AllModels()...); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	for _, table := range []string{
		"recipe_keeper_links",
		"recipe_keeper_recipes",
		"recipe_keeper_tombstones",
		"recipe_keeper_states",
	} {
		if !db.Migrator().HasTable(table) {
			t.Errorf("missing table %s", table)
		}
	}
}

func TestRecipeKeeperLinkRoundTrip(t *testing.T) {
	db, _ := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err := db.AutoMigrate(models.AllModels()...); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	link := models.RecipeKeeperLink{
		RKItemID:       "284055d7-f534-4aff-affd-0a0cc13a6fcf",
		MPName:         "fig",
		MPChecked:      false,
		RKRecipeID:     ptr("59b86e5d-4126-48bb-9d15-b3cd82d8df08"),
		RKName:         "Fig",
		RKChecked:      false,
		RKLastModified: "2026-09-13T23:24:53.7115541Z",
		RKPosition:     657,
	}
	if err := db.Create(&link).Error; err != nil {
		t.Fatalf("create: %v", err)
	}
	var got models.RecipeKeeperLink
	if err := db.First(&got, "rk_item_id = ?", link.RKItemID).Error; err != nil {
		t.Fatalf("read: %v", err)
	}
	if got.MPName != "fig" || *got.RKRecipeID != *link.RKRecipeID {
		t.Errorf("round trip mismatch: %+v", got)
	}
}

// The link must NOT reference grocery_items: PUT /api/grocery recreates every row
// with a new id, and a cascading FK would destroy the whole table on the first undo.
func TestRecipeKeeperLinkSurvivesGroceryIDChurn(t *testing.T) {
	db, _ := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err := db.AutoMigrate(models.AllModels()...); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	sec := models.GrocerySection{ID: models.NewID(), Name: "Produce"}
	db.Create(&sec)
	item := models.GroceryItem{ID: models.NewID(), SectionID: sec.ID, Name: "Fig"}
	db.Create(&item)
	db.Create(&models.RecipeKeeperLink{
		RKItemID: "rk-1", MPName: "fig", RKName: "Fig",
		RKLastModified: "2026-09-13T23:24:53.7115541Z",
	})

	// Simulate what undo-of-delete does: wipe everything, recreate with new ids.
	db.Where("1 = 1").Delete(&models.GrocerySection{})
	sec2 := models.GrocerySection{ID: models.NewID(), Name: "Produce"}
	db.Create(&sec2)
	db.Create(&models.GroceryItem{ID: models.NewID(), SectionID: sec2.ID, Name: "Fig"})

	var n int64
	db.Model(&models.RecipeKeeperLink{}).Count(&n)
	if n != 1 {
		t.Fatalf("links after id churn = %d, want 1 — a cascading FK would have wiped them", n)
	}
}

func ptr(s string) *string { return &s }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/models/ -run RecipeKeeper -v`
Expected: FAIL — `undefined: models.RecipeKeeperLink`

- [ ] **Step 3: Write the models**

```go
// backend/internal/models/recipekeeper.go
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// RecipeKeeperLink ties one Recipe Keeper shopping-list row to the grocery row
// that represents it. Many links may share a grocery row: Recipe Keeper stores a
// separate row per recipe-ingredient occurrence, so "Lemon" needed by six
// recipes is six RK rows collapsed into one grocery row.
//
// MPName/MPChecked are the COLLAPSE KEY, deliberately not a grocery_items FK.
// PUT /api/grocery (used by undo of delete and clear) deletes every section and
// recreates the list with fresh ids, so a real FK with ON DELETE CASCADE would
// wipe this entire table on the first undo. Keying by (name, checked) — what the
// model already groups on — survives that id churn.
//
// RKName/RKChecked cache the last known server state so the outbound reconcile
// can diff against it without a network round trip.
type RecipeKeeperLink struct {
	RKItemID       string `gorm:"type:text;primaryKey"`
	MPName         string `gorm:"type:text;index"` // normalized: lowercased, trimmed
	MPChecked      bool   `gorm:"index"`
	RKRecipeID     *string `gorm:"type:text;index"`
	RKName         string  `gorm:"type:text"`
	RKChecked      bool
	RKLastModified string `gorm:"type:text"`
	RKPosition     int
}

// RecipeKeeperRecipe caches recipe id -> title. Only the title is stored; the
// full recipe entity embeds base64 photos and is far too large to keep.
type RecipeKeeperRecipe struct {
	RKRecipeID     string `gorm:"type:text;primaryKey"`
	Title          string `gorm:"type:text"`
	RKLastModified string `gorm:"type:text"`
}

// RecipeKeeperTombstone records a locally-deleted RK row. It serves two jobs:
// PushedAt nil means the delete still needs pushing, and the row's existence
// stops a not-yet-synced delete from being re-imported on the next pull.
type RecipeKeeperTombstone struct {
	RKItemID        string     `gorm:"type:text;primaryKey"`
	DeletedAt       time.Time  `gorm:"type:timestamp"`
	PushedAt        *time.Time `gorm:"type:timestamp"`
	AckLastModified *string    `gorm:"type:text"`
}

// RecipeKeeperState is a key/value bag for sync watermarks, the generated
// device id, last sync time, and last error.
type RecipeKeeperState struct {
	Key   string `gorm:"type:text;primaryKey"`
	Value string `gorm:"type:text"`
}

func (m *RecipeKeeperTombstone) BeforeCreate(tx *gorm.DB) error {
	if m.DeletedAt.IsZero() {
		m.DeletedAt = NowUTC()
	}
	return nil
}
```

Append to the `AllModels` slice in `models.go`:

```go
		&RecipeKeeperLink{}, &RecipeKeeperRecipe{}, &RecipeKeeperTombstone{}, &RecipeKeeperState{},
```

- [ ] **Step 4: Add config fields**

In `config.go`, add to `Settings`:

```go
	// Recipe Keeper sync (see docs/recipe-keeper-api.md). Disabled unless
	// RECIPE_KEEPER_ENABLED is true.
	RecipeKeeperEnabled   bool
	RecipeKeeperUsername  string
	RecipeKeeperPassword  string
	RecipeKeeperListID    string
	RecipeKeeperReceiptID string
```

and to the `Load` return literal:

```go
		RecipeKeeperEnabled:   l.boolean("RECIPE_KEEPER_ENABLED", false),
		RecipeKeeperUsername:  l.str("RECIPE_KEEPER_USERNAME", ""),
		RecipeKeeperPassword:  l.str("RECIPE_KEEPER_PASSWORD", ""),
		RecipeKeeperListID:    l.str("RECIPE_KEEPER_LIST_ID", ""),
		RecipeKeeperReceiptID: l.str("RECIPE_KEEPER_RECEIPT_ID", ""),
```

Check the existing helper name for booleans in `config.go` (it may be `l.boolean` or `l.bl`) and match it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/models/ ./internal/config/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/internal/models/recipekeeper.go backend/internal/models/recipekeeper_test.go \
        backend/internal/models/models.go backend/internal/config/config.go
git commit -m "Recipe Keeper: config flags and sync tables"
```

---

### Task 2: Protocol client — authentication

**Files:**
- Create: `backend/internal/recipekeeper/auth.go`
- Create: `backend/internal/recipekeeper/headers.go`
- Test: `backend/internal/recipekeeper/auth_test.go`

**Interfaces:**
- Consumes: `config.Settings` from Task 1.
- Produces:
  - `type Headers struct { AppOS, AppOSVersion, AppVersion, DeviceID, ReceiptID string }`
  - `func (h Headers) apply(req *http.Request)`
  - `type Authenticator struct { BaseURL, Username, Password string; HTTP *http.Client; Hdr Headers; Now func() time.Time }`
  - `func (a *Authenticator) Token(ctx context.Context) (string, error)`

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/recipekeeper/auth_test.go
package recipekeeper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// makeJWT builds an unsigned-but-well-formed token whose exp is `exp`.
// Only the payload is ever parsed; the signature is never verified locally.
func makeJWT(exp time.Time) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	header := enc(map[string]string{"alg": "HS512", "typ": "JWT"})
	payload := enc(map[string]any{
		"nameid": "u1", "unique_name": "user@example.com",
		"nbf": exp.Add(-14 * 24 * time.Hour).Unix(),
		"exp": exp.Unix(),
		"iat": exp.Add(-14 * 24 * time.Hour).Unix(),
	})
	return header + "." + payload + ".sig"
}

func TestTokenFetchesAndCaches(t *testing.T) {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/token" {
			t.Errorf("path = %s, want /token", r.URL.Path)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/x-www-form-urlencoded" {
			t.Errorf("content-type = %q", ct)
		}
		if v := r.Header.Get("X-RK-APIVersion"); v != "10" {
			t.Errorf("X-RK-APIVersion = %q, want 10", v)
		}
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "password" {
			t.Errorf("grant_type = %q", r.Form.Get("grant_type"))
		}
		if r.Form.Get("username") != "user@example.com" || r.Form.Get("password") != "pw" {
			t.Errorf("credentials not sent: %v", r.Form)
		}
		// token_type is null in the real response — a client must not read it.
		fmt.Fprintf(w, `{"access_token":%q,"token_type":null,"expires_in":0,
		                 "userName":null,".issued":null,".expires":null}`,
			makeJWT(now.Add(14*24*time.Hour)))
	}))
	defer srv.Close()

	a := &Authenticator{
		BaseURL: srv.URL, Username: "user@example.com", Password: "pw",
		HTTP: srv.Client(), Now: func() time.Time { return now },
	}

	tok, err := a.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if !strings.HasPrefix(tok, "eyJ") {
		t.Errorf("token = %q, want a JWT", tok)
	}
	if _, err := a.Token(context.Background()); err != nil {
		t.Fatalf("second Token: %v", err)
	}
	if calls != 1 {
		t.Errorf("hit /token %d times, want 1 (second call must use cache)", calls)
	}
}

func TestTokenRenewsBeforeExpiry(t *testing.T) {
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		// Expires in 12h — inside the 24h renewal margin, so it must refetch.
		fmt.Fprintf(w, `{"access_token":%q}`, makeJWT(now.Add(12*time.Hour)))
	}))
	defer srv.Close()

	a := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}

	_, _ = a.Token(context.Background())
	_, _ = a.Token(context.Background())
	if calls != 2 {
		t.Errorf("calls = %d, want 2 (token inside renewal margin must refetch)", calls)
	}
}

func TestTokenErrorsOnBadCredentials(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":"invalid_grant"}`)
	}))
	defer srv.Close()

	a := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "bad",
		HTTP: srv.Client(), Now: time.Now}
	_, err := a.Token(context.Background())
	if err == nil {
		t.Fatal("want error on 400, got nil")
	}
	if !IsAuthError(err) {
		t.Errorf("IsAuthError(%v) = false, want true", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/recipekeeper/ -v`
Expected: FAIL — package does not exist / `undefined: Authenticator`

- [ ] **Step 3: Write headers.go**

```go
// backend/internal/recipekeeper/headers.go
package recipekeeper

import "net/http"

// APIVersion is the protocol version this client speaks. The server branches on
// it, so it is pinned rather than inferred — see docs/recipe-keeper-api.md.
const APIVersion = "10"

// Headers are the X-RK-* headers the app sends on every request, including
// /token. Which of them the server enforces is unknown, so we send the full set.
type Headers struct {
	AppOS        string
	AppOSVersion string
	AppVersion   string
	DeviceID     string
	ReceiptID    string
}

func (h Headers) apply(req *http.Request) {
	req.Header.Set("X-RK-APIVersion", APIVersion)
	req.Header.Set("X-RK-AppOS", h.AppOS)
	req.Header.Set("X-RK-AppOSVersion", h.AppOSVersion)
	req.Header.Set("X-RK-AppVersion", h.AppVersion)
	req.Header.Set("X-RK-DeviceId", h.DeviceID)
	req.Header.Set("X-RK-ReceiptId", h.ReceiptID)
	req.Header.Set("X-RK-Analytics", "")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("User-Agent", "RecipeKeeper/231 CFNetwork/3860.700.2 Darwin/25.6.0")
	// Accept-Encoding is deliberately NOT set: net/http decompresses
	// transparently only when it sets that header itself, and the server gzips.
}

// DefaultHeaders mirrors the captured iOS client. DeviceID must be stable
// across restarts — a fresh id per request looks like an unbounded device fleet.
func DefaultHeaders(deviceID, receiptID string) Headers {
	return Headers{
		AppOS: "iOS", AppOSVersion: "26.6.2", AppVersion: "3.46.2",
		DeviceID: deviceID, ReceiptID: receiptID,
	}
}
```

- [ ] **Step 4: Write auth.go**

```go
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/recipekeeper/ -v`
Expected: PASS — all three tests

- [ ] **Step 6: Commit**

```bash
git add backend/internal/recipekeeper/auth.go backend/internal/recipekeeper/headers.go \
        backend/internal/recipekeeper/auth_test.go
git commit -m "Recipe Keeper: token auth with proactive renewal"
```

---

### Task 3: Protocol client — sync envelope and change doorbell

**Files:**
- Create: `backend/internal/recipekeeper/client.go`
- Test: `backend/internal/recipekeeper/client_test.go`

**Interfaces:**
- Consumes: `Authenticator`, `Headers` from Task 2.
- Produces:
  - `type ShoppingListItem struct{...}` (fields below)
  - `type ItemBucket struct { MaxLastModified string; SyncEntities []ShoppingListItem; LocalChangesIds []string }`
  - `type SyncRequest struct{...}` / `type SyncResponse struct{...}`
  - `func (c *Client) Sync(ctx context.Context, req SyncRequest) (*SyncResponse, error)`
  - `func (c *Client) Notify(ctx context.Context) (changed bool, err error)`

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/recipekeeper/client_test.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	return &Client{
		BaseURL: srv.URL,
		HTTP:    srv.Client(),
		Auth: &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
			HTTP: srv.Client(), Now: func() time.Time { return now }},
	}
}

// The captured payload must still deserialize into our structs — this is the
// regression guard against the vendor changing shapes under us.
func TestSyncResponseParsesCapturedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "sync_inbound_item_response.json"))
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	var resp SyncResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.ShoppingListItem == nil {
		t.Fatal("ShoppingListItemSyncEntityResponse missing")
	}
	items := resp.ShoppingListItem.UpdatedServerItems
	if len(items) != 1 {
		t.Fatalf("UpdatedServerItems = %d, want 1", len(items))
	}
	it := items[0]
	if it.Name != "sample" || it.ID == "" {
		t.Errorf("item = %+v", it)
	}
	if it.LastModified == nil || (*it.LastModified)[len(*it.LastModified)-1] != 'Z' {
		t.Errorf("server LastModified must carry Z, got %v", it.LastModified)
	}
}

func TestSyncSendsAuthAndNullsUnusedBuckets(t *testing.T) {
	var got map[string]json.RawMessage
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		if r.Header.Get("Authorization") == "" {
			t.Error("missing Authorization header")
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{}`))
	})

	_, err := c.Sync(context.Background(), SyncRequest{
		ShoppingListItem: &ItemBucket{MaxLastModified: "0001-01-01T00:00:00Z"},
	})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if _, ok := got["ShoppingListItemSyncEntityRequest"]; !ok {
		t.Error("item bucket not sent")
	}
	if v, ok := got["RecipeSyncEntityRequest"]; !ok || string(v) != "null" {
		t.Errorf("unused bucket must serialize as null, got %s", v)
	}
}

func TestNotifyMapsStatusToChanged(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   bool
	}{
		{http.StatusOK, true},        // 200: something changed, go sync
		{http.StatusCreated, false},  // 201: poll expired, nothing happened
	} {
		c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/token" {
				w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
				return
			}
			if r.URL.Path != "/api/syncnotification" {
				t.Errorf("path = %s", r.URL.Path)
			}
			w.WriteHeader(tc.status)
		})
		changed, err := c.Notify(context.Background())
		if err != nil {
			t.Fatalf("Notify(%d): %v", tc.status, err)
		}
		if changed != tc.want {
			t.Errorf("Notify(%d) changed = %v, want %v", tc.status, changed, tc.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/recipekeeper/ -run 'Sync|Notify' -v`
Expected: FAIL — `undefined: Client`

- [ ] **Step 3: Write client.go**

```go
// backend/internal/recipekeeper/client.go
package recipekeeper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"time"
)

// notifyTimeout must exceed the server's ~60s long-poll hold, or we abort our
// own polls.
const notifyTimeout = 90 * time.Second

// ShoppingListItem is the only entity this integration reads in detail or ever
// writes. Note there is no quantity field: Recipe Keeper stores one row per
// recipe-ingredient occurrence instead.
type ShoppingListItem struct {
	Name                   string  `json:"Name"`
	ShoppingListID         string  `json:"ShoppingListId"`
	IsChecked              bool    `json:"IsChecked"`
	Position               int     `json:"Position"`
	RecipeID               *string `json:"RecipeId"`
	CheckedDate            *string `json:"CheckedDate"`
	IsSyncedToExternalList *bool   `json:"IsSyncedToExternalList"`
	LastModified           *string `json:"LastModified"`
	ID                     string  `json:"Id"`
	IsDeleted              bool    `json:"IsDeleted"`
}

type ItemBucket struct {
	MaxLastModified string             `json:"MaxLastModified"`
	SyncEntities    []ShoppingListItem `json:"SyncEntities"`
	LocalChangesIds []string           `json:"LocalChangesIds"`
}

type ItemBucketResponse struct {
	UpdatedLocalItems         []AckItem          `json:"UpdatedLocalItems"`
	UpdatedServerItems        []ShoppingListItem `json:"UpdatedServerItems"`
	HasMoreUpdatedServerItems bool               `json:"HasMoreUpdatedServerItems"`
	MaxLastModified           string             `json:"MaxLastModified"`
}

// AckItem is what the server returns for entities we pushed: the authoritative
// LastModified, which must be written back to the link.
type AckItem struct {
	ID           string `json:"Id"`
	LastModified string `json:"LastModified"`
}

// RawBucket is used for buckets we pull but do not model in detail.
type RawBucket struct {
	MaxLastModified string            `json:"MaxLastModified"`
	SyncEntities    []json.RawMessage `json:"SyncEntities"`
	LocalChangesIds []string          `json:"LocalChangesIds"`
}

type RawBucketResponse struct {
	UpdatedLocalItems         []AckItem         `json:"UpdatedLocalItems"`
	UpdatedServerItems        []json.RawMessage `json:"UpdatedServerItems"`
	HasMoreUpdatedServerItems bool              `json:"HasMoreUpdatedServerItems"`
	MaxLastModified           string            `json:"MaxLastModified"`
}

// SyncRequest mirrors the twelve-bucket envelope. A nil bucket serializes to
// null and is skipped by the server — always null what you do not need, since
// the Recipe bucket alone can be hundreds of megabytes.
type SyncRequest struct {
	Recipe                   *RawBucket  `json:"RecipeSyncEntityRequest"`
	ShoppingListCategory     *RawBucket  `json:"ShoppingListCategorySyncEntityRequest"`
	ShoppingListCategoryItem *RawBucket  `json:"ShoppingListCategoryItemSyncEntityRequest"`
	ShoppingList             *RawBucket  `json:"ShoppingListSyncEntityRequest"`
	ShoppingListItem         *ItemBucket `json:"ShoppingListItemSyncEntityRequest"`
	Meal                     *RawBucket  `json:"MealSyncEntityRequest"`
	Course                   *RawBucket  `json:"CourseSyncEntityRequest"`
	Category                 *RawBucket  `json:"CategorySyncEntityRequest"`
	Collection               *RawBucket  `json:"CollectionSyncEntityRequest"`
	MealType                 *RawBucket  `json:"MealTypeSyncEntityRequest"`
	MealPlanner              *RawBucket  `json:"MealPlannerSyncEntityRequest"`
	Cookbook                 *RawBucket  `json:"CookbookSyncEntityRequest"`
}

type SyncResponse struct {
	Recipe                   *RawBucketResponse  `json:"RecipeSyncEntityResponse"`
	ShoppingListCategory     *RawBucketResponse  `json:"ShoppingListCategorySyncEntityResponse"`
	ShoppingListCategoryItem *RawBucketResponse  `json:"ShoppingListCategoryItemSyncEntityResponse"`
	ShoppingList             *RawBucketResponse  `json:"ShoppingListSyncEntityResponse"`
	ShoppingListItem         *ItemBucketResponse `json:"ShoppingListItemSyncEntityResponse"`
}

type Client struct {
	BaseURL string
	HTTP    *http.Client
	Auth    *Authenticator
	Hdr     Headers
}

// NewClient builds a client with a cookie jar, so the Azure ARRAffinity
// stickiness cookie is honoured across calls.
func NewClient(baseURL string, auth *Authenticator, hdr Headers) *Client {
	jar, _ := cookiejar.New(nil)
	return &Client{
		BaseURL: baseURL,
		HTTP:    &http.Client{Jar: jar, Timeout: notifyTimeout + 15*time.Second},
		Auth:    auth,
		Hdr:     hdr,
	}
}

func (c *Client) do(ctx context.Context, path string, body []byte) (*http.Response, error) {
	tok, err := c.Auth.Token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	c.Hdr.apply(req)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	return c.HTTP.Do(req)
}

func (c *Client) Sync(ctx context.Context, sreq SyncRequest) (*SyncResponse, error) {
	body, err := json.Marshal(sreq)
	if err != nil {
		return nil, err
	}
	resp, err := c.do(ctx, "/api/sync", body)
	if err != nil {
		return nil, fmt.Errorf("recipekeeper: sync: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("recipekeeper: sync status %d", resp.StatusCode)
	}
	var out SyncResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("recipekeeper: decode sync: %w", err)
	}
	return &out, nil
}

// Notify parks a long poll. It returns true when the server signals a change
// (200) and false when the poll simply expired (201). Both carry empty bodies —
// the status code is the entire message.
func (c *Client) Notify(ctx context.Context) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()

	resp, err := c.do(ctx, "/api/syncnotification", []byte(`""`))
	if err != nil {
		return false, fmt.Errorf("recipekeeper: notify: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusCreated:
		return false, nil
	default:
		return false, fmt.Errorf("recipekeeper: notify status %d", resp.StatusCode)
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/recipekeeper/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/recipekeeper/client.go backend/internal/recipekeeper/client_test.go
git commit -m "Recipe Keeper: sync envelope and long-poll client"
```

---

### Task 4: Reconciler — inbound (RK → Meal Planner)

**Files:**
- Create: `backend/internal/recipekeeper/reconcile.go`
- Create: `backend/internal/recipekeeper/store.go`
- Test: `backend/internal/recipekeeper/reconcile_inbound_test.go`

**Interfaces:**
- Consumes: `ShoppingListItem` (Task 3), models (Task 1).
- Produces:
  - `type Reconciler struct { DB *gorm.DB; ListID string; Now func() time.Time }`
  - `func (r *Reconciler) ApplyInbound(items []ShoppingListItem) (Changes, error)`
  - `type Changes struct { Added, Updated, Deleted []uuid.UUID }`
  - `func collapseKey(name string, checked bool) string`

**Behaviour being built** (from the spec's inbound table):

| Condition | Action |
|---|---|
| Tombstoned id | Ignore |
| `IsDeleted` | Drop link; `quantity--`; delete item when its last link goes and it has no MP-only units |
| Link exists, `LastModified` unchanged | No-op (our own echo) |
| Link exists, newer | Apply name/checked, moving the link between checked and unchecked rows |
| No link, live | Attach to the matching row or create one |

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/recipekeeper/reconcile_inbound_test.go
package recipekeeper

import (
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"

	"mealplanner/internal/models"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := db.AutoMigrate(models.AllModels()...); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.Create(&models.GrocerySection{ID: models.NewID(), Name: "Uncategorized", Position: 0})
	return db
}

func testReconciler(t *testing.T, db *gorm.DB) *Reconciler {
	t.Helper()
	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	return &Reconciler{DB: db, ListID: "list-1", Now: func() time.Time { return now }}
}

func rkItem(id, name string, opts ...func(*ShoppingListItem)) ShoppingListItem {
	lm := "2026-09-14T00:00:00.0000001Z"
	it := ShoppingListItem{
		ID: id, Name: name, ShoppingListID: "list-1",
		LastModified: &lm, Position: 1,
	}
	for _, o := range opts {
		o(&it)
	}
	return it
}

func withRecipe(rid string) func(*ShoppingListItem) {
	return func(i *ShoppingListItem) { i.RecipeID = &rid }
}
func checked(i *ShoppingListItem)  { i.IsChecked = true }
func deleted(i *ShoppingListItem)  { i.IsDeleted = true }

func itemByName(t *testing.T, db *gorm.DB, name string, isChecked bool) *models.GroceryItem {
	t.Helper()
	var it models.GroceryItem
	err := db.First(&it, "name = ? AND checked = ?", name, isChecked).Error
	if err != nil {
		return nil
	}
	return &it
}

// Six RK rows for one ingredient must collapse into one grocery item with
// quantity 6 and six links.
func TestInboundCollapsesDuplicatesByName(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)

	var items []ShoppingListItem
	for i, recipe := range []string{"r1", "r2", "r3", "r4", "r5", "r6"} {
		items = append(items, rkItem(string(rune('a'+i))+"-id", "Lemon", withRecipe(recipe)))
	}
	if _, err := r.ApplyInbound(items); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	var count int64
	db.Model(&models.GroceryItem{}).Where("name = ?", "Lemon").Count(&count)
	if count != 1 {
		t.Fatalf("grocery rows = %d, want 1", count)
	}
	it := itemByName(t, db, "Lemon", false)
	if it.Quantity == nil || *it.Quantity != "6" {
		t.Errorf("quantity = %v, want 6", it.Quantity)
	}
	var links int64
	db.Model(&models.RecipeKeeperLink{}).Where("mp_name = ?", "lemon").Count(&links)
	if links != 6 {
		t.Errorf("links = %d, want 6", links)
	}
}

// An inbound delete removes one unit, not the whole item.
func TestInboundDeleteDecrementsQuantity(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})

	lm := "2026-09-14T01:00:00.0000001Z"
	_, err := r.ApplyInbound([]ShoppingListItem{
		func() ShoppingListItem {
			i := rkItem("a-id", "Lemon", deleted)
			i.LastModified = &lm
			return i
		}(),
	})
	if err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	it := itemByName(t, db, "Lemon", false)
	if it == nil {
		t.Fatal("item deleted, want it to survive with quantity 1")
	}
	if it.Quantity != nil && *it.Quantity != "1" {
		t.Errorf("quantity = %v, want 1", it.Quantity)
	}
}

// Deleting the last link removes the item entirely.
func TestInboundDeleteOfLastLinkRemovesItem(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Basil", withRecipe("r1"))})

	lm := "2026-09-14T01:00:00.0000001Z"
	i := rkItem("a-id", "Basil", deleted)
	i.LastModified = &lm
	if _, err := r.ApplyInbound([]ShoppingListItem{i}); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if itemByName(t, db, "Basil", false) != nil {
		t.Error("item should be gone once its last link is deleted")
	}
}

// A tombstoned id must never be re-imported.
func TestInboundIgnoresTombstonedItem(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	db.Create(&models.RecipeKeeperTombstone{RKItemID: "a-id", DeletedAt: models.NowUTC()})

	if _, err := r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Ghost")}); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if itemByName(t, db, "Ghost", false) != nil {
		t.Error("tombstoned item was resurrected")
	}
}

// Re-delivering an entity we already have must change nothing — this is the
// echo of our own push coming back through the doorbell.
func TestInboundIgnoresUnchangedLastModified(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	in := rkItem("a-id", "Fig", withRecipe("r1"))
	_, _ = r.ApplyInbound([]ShoppingListItem{in})

	ch, err := r.ApplyInbound([]ShoppingListItem{in})
	if err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if len(ch.Added)+len(ch.Updated)+len(ch.Deleted) != 0 {
		t.Errorf("replaying an identical entity produced changes: %+v", ch)
	}
}

// RK checking 3 of 6 lemons yields a checked (3) row and an unchecked (3) row.
func TestInboundPartialCheckSplitsRows(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	var items []ShoppingListItem
	ids := []string{"a", "b", "c", "d", "e", "f"}
	for i, id := range ids {
		items = append(items, rkItem(id, "Lemon", withRecipe("r"+string(rune('1'+i)))))
	}
	_, _ = r.ApplyInbound(items)

	lm := "2026-09-14T02:00:00.0000001Z"
	var checks []ShoppingListItem
	for _, id := range ids[:3] {
		it := rkItem(id, "Lemon", checked)
		it.LastModified = &lm
		checks = append(checks, it)
	}
	if _, err := r.ApplyInbound(checks); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	unchecked := itemByName(t, db, "Lemon", false)
	checkedRow := itemByName(t, db, "Lemon", true)
	if unchecked == nil || checkedRow == nil {
		t.Fatal("want both a checked and an unchecked Lemon row")
	}
	if *unchecked.Quantity != "3" || *checkedRow.Quantity != "3" {
		t.Errorf("quantities = %v / %v, want 3 / 3", unchecked.Quantity, checkedRow.Quantity)
	}
}

// Items belonging to another RK list are not ours.
func TestInboundIgnoresOtherLists(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	it := rkItem("a-id", "Thrive Item")
	it.ShoppingListID = "other-list"
	if _, err := r.ApplyInbound([]ShoppingListItem{it}); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if itemByName(t, db, "Thrive Item", false) != nil {
		t.Error("item from a non-configured list was imported")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/recipekeeper/ -run Inbound -v`
Expected: FAIL — `undefined: Reconciler`

- [ ] **Step 3: Write store.go (small DB helpers)**

```go
// backend/internal/recipekeeper/store.go
package recipekeeper

import (
	"strconv"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/models"
)

// collapseKey groups grocery rows. Name is compared case-insensitively, and
// checked is part of the key because MP represents "bought 1, still need 3" as
// two rows of the same name (see useGroceryList.ts:458).
func collapseKey(name string, checked bool) string {
	k := strings.ToLower(strings.TrimSpace(name))
	if checked {
		return k + "\x00checked"
	}
	return k
}

func quantityOf(item *models.GroceryItem) int {
	if item.Quantity == nil || *item.Quantity == "" {
		return 1
	}
	n, err := strconv.Atoi(*item.Quantity)
	if err != nil || n < 1 {
		return 1
	}
	return n
}

func setQuantity(item *models.GroceryItem, n int) {
	if n <= 1 {
		item.Quantity = nil
		return
	}
	s := strconv.Itoa(n)
	item.Quantity = &s
}

// linksFor returns the links belonging to a grocery row, addressed by collapse
// key rather than id — grocery ids churn on every replace (see the model docs).
func linksFor(db *gorm.DB, name string, checked bool) []models.RecipeKeeperLink {
	var links []models.RecipeKeeperLink
	db.Order("rk_position asc").
		Find(&links, "mp_name = ? AND mp_checked = ?", normalizeName(name), checked)
	return links
}

func linkCount(db *gorm.DB, name string, checked bool) int {
	var n int64
	db.Model(&models.RecipeKeeperLink{}).
		Where("mp_name = ? AND mp_checked = ?", normalizeName(name), checked).Count(&n)
	return int(n)
}

// findRow returns the grocery item for a collapse key, or nil.
func findRow(db *gorm.DB, name string, checked bool) *models.GroceryItem {
	var items []models.GroceryItem
	db.Where("checked = ?", checked).Find(&items)
	want := normalizeName(name)
	for i := range items {
		if normalizeName(items[i].Name) == want {
			return &items[i]
		}
	}
	return nil
}

func isTombstoned(db *gorm.DB, rkItemID string) bool {
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Where("rk_item_id = ?", rkItemID).Count(&n)
	return n > 0
}
```

- [ ] **Step 4: Write reconcile.go — inbound half**

```go
// backend/internal/recipekeeper/reconcile.go
package recipekeeper

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/models"
)

type Changes struct {
	Added   []uuid.UUID
	Updated []uuid.UUID
	Deleted []uuid.UUID
}

func (c *Changes) Any() bool {
	return len(c.Added)+len(c.Updated)+len(c.Deleted) > 0
}

// Reconciler owns all sync logic. It never performs HTTP: callers hand it
// entities and take away the entities to push.
type Reconciler struct {
	DB     *gorm.DB
	ListID string
	Now    func() time.Time
}

func (r *Reconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return models.NowUTC()
}

// ApplyInbound folds server entities into the grocery list.
func (r *Reconciler) ApplyInbound(items []ShoppingListItem) (Changes, error) {
	var ch Changes
	for _, in := range items {
		if in.ShoppingListID != "" && in.ShoppingListID != r.ListID {
			continue
		}
		if isTombstoned(r.DB, in.ID) {
			continue
		}
		if err := r.applyOne(in, &ch); err != nil {
			return ch, err
		}
	}
	return ch, nil
}

func (r *Reconciler) applyOne(in ShoppingListItem, ch *Changes) error {
	var link models.RecipeKeeperLink
	err := r.DB.First(&link, "rk_item_id = ?", in.ID).Error
	hasLink := err == nil

	if in.IsDeleted {
		if !hasLink {
			return nil
		}
		return r.detachLink(&link, ch)
	}

	if hasLink {
		// Our own push echoing back through the doorbell.
		if in.LastModified != nil && *in.LastModified == link.RKLastModified {
			return nil
		}
		return r.moveLink(&link, in, ch)
	}
	return r.attachNew(in, ch)
}

// detachLink drops a link and decrements its row, deleting the row when the
// last link goes and no MP-only units remain.
func (r *Reconciler) detachLink(link *models.RecipeKeeperLink, ch *Changes) error {
	row := findRow(r.DB, link.MPName, link.MPChecked)
	if row == nil {
		return r.DB.Delete(link).Error
	}
	item := *row
	if err := r.DB.Delete(link).Error; err != nil {
		return err
	}
	qty := quantityOf(&item) - 1
	if qty <= 0 {
		ch.Deleted = append(ch.Deleted, item.ID)
		return r.DB.Delete(&item).Error
	}
	setQuantity(&item, qty)
	item.UpdatedAt = r.now()
	ch.Updated = append(ch.Updated, item.ID)
	return r.DB.Save(&item).Error
}

// moveLink applies a server-side name or check change, relocating the link to
// the row matching its new (name, checked) key. Both the grocery row and the
// link's cached RK state are written, so the outbound diff stays clean and the
// two sides cannot oscillate.
func (r *Reconciler) moveLink(link *models.RecipeKeeperLink, in ShoppingListItem, ch *Changes) error {
	sameRow := strings.EqualFold(link.RKName, in.Name) && link.RKChecked == in.IsChecked
	if !sameRow {
		if err := r.detachLink(link, ch); err != nil {
			return err
		}
		if err := r.attachNew(in, ch); err != nil {
			return err
		}
		return nil
	}
	link.RKLastModified = derefOr(in.LastModified, link.RKLastModified)
	link.RKPosition = in.Position
	return r.DB.Save(link).Error
}

// attachNew adds a unit for an item we have not seen, collapsing onto an
// existing row of the same (name, checked) when one exists.
func (r *Reconciler) attachNew(in ShoppingListItem, ch *Changes) error {
	row := findRow(r.DB, in.Name, in.IsChecked)
	if row == nil {
		created, err := r.createRow(in)
		if err != nil {
			return err
		}
		row = created
		ch.Added = append(ch.Added, row.ID)
	} else {
		setQuantity(row, quantityOf(row)+1)
		row.UpdatedAt = r.now()
		if err := r.DB.Save(row).Error; err != nil {
			return err
		}
		ch.Updated = append(ch.Updated, row.ID)
	}

	return r.DB.Create(&models.RecipeKeeperLink{
		RKItemID:       in.ID,
		MPName:         normalizeName(row.Name),
		MPChecked:      row.Checked,
		RKRecipeID:     in.RecipeID,
		RKName:         in.Name,
		RKChecked:      in.IsChecked,
		RKLastModified: derefOr(in.LastModified, ""),
		RKPosition:     in.Position,
	}).Error
}

func derefOr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}
```

- [ ] **Step 5: Add createRow with section placement**

Append to `reconcile.go`. Placement runs once, on arrival; nothing later moves the item, which is what "Meal Planner is authoritative" means operationally.

```go
// createRow makes a grocery row for a newly-seen RK item. Section placement is
// resolved once, in priority order: MP's own learned default, then RK's category
// name if a section by that name already exists, then Uncategorized.
func (r *Reconciler) createRow(in ShoppingListItem) (*models.GroceryItem, error) {
	sectionID, err := r.placeSection(in.Name)
	if err != nil {
		return nil, err
	}
	var maxPos struct{ P int }
	r.DB.Model(&models.GroceryItem{}).
		Select("COALESCE(MAX(position), -1) AS p").
		Where("section_id = ?", sectionID).Scan(&maxPos)

	item := &models.GroceryItem{
		ID:        models.NewID(),
		SectionID: sectionID,
		Name:      in.Name,
		Checked:   in.IsChecked,
		Position:  maxPos.P + 1,
		CreatedAt: r.now(),
		UpdatedAt: r.now(),
	}
	// A brand-new row represents exactly one unit.
	setQuantity(item, 1)

	var def models.ItemDefault
	if err := r.DB.First(&def, "LOWER(item_name) = LOWER(?)", in.Name).Error; err == nil {
		item.StoreID = def.StoreID
	}
	if err := r.DB.Create(item).Error; err != nil {
		return nil, err
	}
	return item, nil
}

// placeSection resolves the section for a newly-imported item name.
func (r *Reconciler) placeSection(name string) (uuid.UUID, error) {
	var def models.ItemDefault
	if err := r.DB.First(&def, "LOWER(item_name) = LOWER(?)", name).Error; err == nil &&
		def.SectionName != nil && *def.SectionName != "" {
		var sec models.GrocerySection
		if err := r.DB.First(&sec, "LOWER(name) = LOWER(?)", *def.SectionName).Error; err == nil {
			return sec.ID, nil
		}
	}
	if id, ok := r.sectionFromRKCategory(name); ok {
		return id, nil
	}
	var sec models.GrocerySection
	if err := r.DB.First(&sec, "LOWER(name) = LOWER(?)", "uncategorized").Error; err == nil {
		return sec.ID, nil
	}
	sec = models.GrocerySection{ID: models.NewID(), Name: "Uncategorized", CreatedAt: r.now()}
	if err := r.DB.Create(&sec).Error; err != nil {
		return uuid.Nil, err
	}
	return sec.ID, nil
}

// sectionFromRKCategory is filled in by Task 6, which caches RK's
// name -> category mapping. Until then no RK-derived placement occurs and the
// Uncategorized fallback applies.
func (r *Reconciler) sectionFromRKCategory(string) (uuid.UUID, bool) {
	return uuid.Nil, false
}
```

- [ ] **Step 6: Add the rename-split test**

A server-side rename changes an item's collapse key, so its link must leave the old row (decrementing it) and join the row matching the new name. Append to `reconcile_inbound_test.go`:

```go
func TestInboundRenameSplitsCollapseGroup(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})

	lm := "2026-09-14T03:00:00.0000001Z"
	renamed := rkItem("a-id", "Meyer Lemon", withRecipe("r1"))
	renamed.LastModified = &lm
	if _, err := r.ApplyInbound([]ShoppingListItem{renamed}); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	lemon := itemByName(t, db, "Lemon", false)
	meyer := itemByName(t, db, "Meyer Lemon", false)
	if lemon == nil || meyer == nil {
		t.Fatal("want both a Lemon and a Meyer Lemon row")
	}
	if quantityOf(lemon) != 1 || quantityOf(meyer) != 1 {
		t.Errorf("quantities = %d / %d, want 1 / 1", quantityOf(lemon), quantityOf(meyer))
	}

	// The link itself must have moved to the new collapse key.
	var moved models.RecipeKeeperLink
	db.First(&moved, "rk_item_id = ?", "a-id")
	if moved.MPName != "meyer lemon" {
		t.Errorf("link MPName = %q, want %q", moved.MPName, "meyer lemon")
	}
}

// NOTE: the companion assertion — that an inbound rename must not bounce back
// out as a push — lives in Task 5, where PendingPushes exists.
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && go test ./internal/recipekeeper/ -run Inbound -v`
Expected: PASS — all eight inbound tests

- [ ] **Step 8: Commit**

```bash
git add backend/internal/recipekeeper/reconcile.go backend/internal/recipekeeper/store.go \
        backend/internal/recipekeeper/reconcile_inbound_test.go
git commit -m "Recipe Keeper: inbound reconcile with collapse and partial checks"
```

---

### Task 5: Reconciler — outbound (Meal Planner → RK)

**Files:**
- Modify: `backend/internal/recipekeeper/reconcile.go`
- Test: `backend/internal/recipekeeper/reconcile_outbound_test.go`

**Interfaces:**
- Consumes: `Reconciler`, `ShoppingListItem`, `AckItem` from Tasks 3–4.
- Produces:
  - `func (r *Reconciler) PendingPushes() ([]ShoppingListItem, error)`
  - `func (r *Reconciler) ApplyAcks(acks []AckItem) error`
  - `func (r *Reconciler) TombstoneLinks(name string, checked bool) error`

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/recipekeeper/reconcile_outbound_test.go
package recipekeeper

import (
	"testing"

	"mealplanner/internal/models"
)

// A locally-checked row must produce a push for each of its links, carrying the
// complete entity with Z stripped from LastModified.
func TestPendingPushesOnLocalCheck(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})

	item := itemByName(t, db, "Lemon", false)
	item.Checked = true
	db.Save(item)

	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 2 {
		t.Fatalf("pushes = %d, want 2", len(pushes))
	}
	for _, p := range pushes {
		if !p.IsChecked {
			t.Errorf("push %s not checked", p.ID)
		}
		if p.CheckedDate == nil {
			t.Errorf("push %s missing CheckedDate", p.ID)
		}
		if p.LastModified == nil {
			t.Fatalf("push %s missing LastModified", p.ID)
		}
		if got := *p.LastModified; got[len(got)-1] == 'Z' {
			t.Errorf("pushed LastModified must have Z stripped, got %q", got)
		}
		if p.Name == "" || p.ShoppingListID != "list-1" {
			t.Errorf("push must carry the complete entity: %+v", p)
		}
	}
}

// Nothing changed locally => nothing to push. This is what stops echo loops.
func TestPendingPushesEmptyWhenInSync(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})

	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 0 {
		t.Errorf("pushes = %d, want 0", len(pushes))
	}
}

// A rename propagates to every link of the row.
func TestPendingPushesOnRename(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Lemon", withRecipe("r1"))})

	item := itemByName(t, db, "Lemon", false)
	item.Name = "Meyer Lemon"
	db.Save(item)

	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 || pushes[0].Name != "Meyer Lemon" {
		t.Errorf("pushes = %+v, want one rename to Meyer Lemon", pushes)
	}
}

// Acks are the server's authoritative timestamps and must land on the link,
// or the next diff would push a stale LastModified forever.
func TestApplyAcksUpdatesLinkState(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)
	item.Checked = true
	db.Save(item)

	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 {
		t.Fatalf("pushes = %d, want 1", len(pushes))
	}
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T05:00:00.1234567Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}

	var link models.RecipeKeeperLink
	db.First(&link, "rk_item_id = ?", "a-id")
	if link.RKLastModified != "2026-09-14T05:00:00.1234567Z" {
		t.Errorf("link LastModified = %q", link.RKLastModified)
	}
	if !link.RKChecked {
		t.Error("link RKChecked should be true after ack")
	}

	again, _ := r.PendingPushes()
	if len(again) != 0 {
		t.Errorf("after ack, pushes = %d, want 0", len(again))
	}
}

// Deleting a grocery item tombstones its links so the delete can be pushed and
// the row can never be re-imported.
func TestTombstoneLinksOnDelete(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})
	item := itemByName(t, db, "Lemon", false)

	if err := r.TombstoneLinks(item.Name, item.Checked); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Where("pushed_at IS NULL").Count(&n)
	if n != 2 {
		t.Errorf("pending tombstones = %d, want 2", n)
	}

	pushes, _ := r.PendingPushes()
	if len(pushes) != 2 {
		t.Fatalf("delete pushes = %d, want 2", len(pushes))
	}
	for _, p := range pushes {
		if !p.IsDeleted {
			t.Errorf("push %s should be a delete", p.ID)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/recipekeeper/ -run 'Pending|Acks|Tombstone' -v`
Expected: FAIL — `undefined: (*Reconciler).PendingPushes`

- [ ] **Step 3: Implement the outbound half**

Append to `reconcile.go`:

```go
// stripZ converts a server timestamp to the form the client must echo back.
// Server values carry Z; pushed values must not (docs/recipe-keeper-api.md).
func stripZ(s string) string { return strings.TrimSuffix(s, "Z") }

// PendingPushes diffs every link against its grocery row and returns the
// complete entities to push. Outbound state is derived, not queued: a failed
// push simply reappears on the next pass, and a restart loses nothing.
func (r *Reconciler) PendingPushes() ([]ShoppingListItem, error) {
	var out []ShoppingListItem

	// Tombstones: either a delete to push, or an undo to reverse.
	var tombs []models.RecipeKeeperTombstone
	if err := r.DB.Find(&tombs).Error; err != nil {
		return nil, err
	}
	for _, tomb := range tombs {
		var link models.RecipeKeeperLink
		hasLink := r.DB.First(&link, "rk_item_id = ?", tomb.RKItemID).Error == nil

		// Undo: the row is back. Recipe Keeper's deletes are soft, so reversing
		// one is an ordinary field update rather than a restore path.
		if hasLink && findRow(r.DB, link.MPName, link.MPChecked) != nil {
			if tomb.PushedAt == nil {
				// The delete never went out — just forget it.
				r.DB.Delete(&tomb)
				continue
			}
			out = append(out, r.entityFor(link, link.RKName, link.RKChecked, false))
			continue
		}

		if tomb.PushedAt != nil {
			continue // already deleted on the server
		}
		if !hasLink {
			// Link already gone; synthesize the minimum the server needs.
			out = append(out, ShoppingListItem{
				ID: tomb.RKItemID, ShoppingListID: r.ListID, IsDeleted: true,
			})
			continue
		}
		out = append(out, r.entityFor(link, link.RKName, link.RKChecked, true))
	}

	// Then field diffs for links whose row has drifted from cached RK state.
	var links []models.RecipeKeeperLink
	if err := r.DB.Find(&links).Error; err != nil {
		return nil, err
	}
	for _, link := range links {
		if isTombstoned(r.DB, link.RKItemID) {
			continue // handled above
		}
		row := findRow(r.DB, link.MPName, link.MPChecked)
		if row == nil {
			// An unresolvable link with no tombstone is an orphan. Log and drop
			// it: deletion is only ever expressed by a tombstone, never inferred.
			log.Printf("recipekeeper: orphan link %s (%s/%v), dropping",
				link.RKItemID, link.MPName, link.MPChecked)
			r.DB.Delete(&models.RecipeKeeperLink{}, "rk_item_id = ?", link.RKItemID)
			continue
		}
		if strings.EqualFold(row.Name, link.RKName) && row.Checked == link.RKChecked {
			continue
		}
		out = append(out, r.entityFor(link, row.Name, row.Checked, false))
	}
	return out, nil
}

// entityFor builds a complete entity from the link's cached fields, replacing
// only what changed. The protocol has no partial updates: any field omitted or
// stale here overwrites the server's value.
func (r *Reconciler) entityFor(link models.RecipeKeeperLink, name string, checkedNow, isDelete bool) ShoppingListItem {
	synced := true
	item := ShoppingListItem{
		ID:                     link.RKItemID,
		Name:                   name,
		ShoppingListID:         r.ListID,
		IsChecked:              checkedNow,
		Position:               link.RKPosition,
		RecipeID:               link.RKRecipeID,
		IsSyncedToExternalList: &synced,
		IsDeleted:              isDelete,
	}
	if lm := stripZ(link.RKLastModified); lm != "" {
		item.LastModified = &lm
	}
	if checkedNow {
		// Naive UTC with no zone suffix, matching the client's own encoding.
		d := r.now().UTC().Format("2006-01-02T15:04:05.0000000")
		item.CheckedDate = &d
	}
	return item
}

// ApplyAcks writes the server's authoritative timestamps back onto links and
// marks pushed tombstones. Skipping this would leave every link permanently
// dirty, re-pushing the same change forever.
func (r *Reconciler) ApplyAcks(acks []AckItem) error {
	now := r.now()
	for _, ack := range acks {
		var link models.RecipeKeeperLink
		hasLink := r.DB.First(&link, "rk_item_id = ?", ack.ID).Error == nil

		var tomb models.RecipeKeeperTombstone
		if err := r.DB.First(&tomb, "rk_item_id = ?", ack.ID).Error; err == nil {
			// An un-delete: the row came back, so the tombstone is spent.
			if hasLink && findRow(r.DB, link.MPName, link.MPChecked) != nil {
				if err := r.DB.Delete(&tomb).Error; err != nil {
					return err
				}
				link.RKLastModified = ack.LastModified
				if err := r.DB.Save(&link).Error; err != nil {
					return err
				}
				continue
			}
			tomb.PushedAt = &now
			lm := ack.LastModified
			tomb.AckLastModified = &lm
			if err := r.DB.Save(&tomb).Error; err != nil {
				return err
			}
			// The link is KEPT until the tombstone is pruned, so an undo arriving
			// after the push still has an entity to rebuild from.
			continue
		}

		if !hasLink {
			continue
		}
		if row := findRow(r.DB, link.MPName, link.MPChecked); row != nil {
			link.RKName = row.Name
			link.RKChecked = row.Checked
		}
		link.RKLastModified = ack.LastModified
		if err := r.DB.Save(&link).Error; err != nil {
			return err
		}
	}
	return nil
}

// TombstoneLinks records that a grocery row was deleted locally, so each of its
// RK rows gets a delete push and cannot be re-imported meanwhile. Addressed by
// collapse key, since the row may already be gone by the time this runs.
func (r *Reconciler) TombstoneLinks(name string, checked bool) error {
	for _, link := range linksFor(r.DB, name, checked) {
		tomb := models.RecipeKeeperTombstone{RKItemID: link.RKItemID, DeletedAt: r.now()}
		if err := r.DB.Where("rk_item_id = ?", link.RKItemID).
			FirstOrCreate(&tomb).Error; err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/recipekeeper/ -v`
Expected: PASS — inbound and outbound suites

- [ ] **Step 5: Commit**

```bash
git add backend/internal/recipekeeper/reconcile.go backend/internal/recipekeeper/reconcile_outbound_test.go
git commit -m "Recipe Keeper: declarative outbound reconcile with tombstoned deletes"
```

---

### Task 6: The echo round-trip guard

This task adds no features. It exists because an echo loop would silently hammer a third party's API while looking correct in every isolated test — the spec calls it out as required.

**Files:**
- Test: `backend/internal/recipekeeper/reconcile_echo_test.go`

**Interfaces:**
- Consumes: everything from Tasks 3–5. Produces nothing.

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/recipekeeper/reconcile_echo_test.go
package recipekeeper

import "testing"

// The full loop: check locally, push, ack, then receive our own change back
// through the doorbell. Nothing further may be pushed.
func TestPushAckEchoProducesNoFurtherPush(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)

	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})

	item := itemByName(t, db, "Fig", false)
	item.Checked = true
	db.Save(item)

	pushes, err := r.PendingPushes()
	if err != nil || len(pushes) != 1 {
		t.Fatalf("pushes = %d (err %v), want 1", len(pushes), err)
	}

	const serverLM = "2026-09-14T06:00:00.7654321Z"
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: serverLM}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}

	// The doorbell fires for our own write and the server replays the entity.
	echo := rkItem("a-id", "Fig", withRecipe("r1"), checked)
	lm := serverLM
	echo.LastModified = &lm
	ch, err := r.ApplyInbound([]ShoppingListItem{echo})
	if err != nil {
		t.Fatalf("ApplyInbound(echo): %v", err)
	}
	if ch.Any() {
		t.Errorf("echo produced changes: %+v", ch)
	}

	after, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(after) != 0 {
		t.Fatalf("ECHO LOOP: %d pushes after round trip, want 0: %+v", len(after), after)
	}
}

// A delete round trip must also settle: after the ack, the replayed tombstoned
// entity must not resurrect the item or re-push.
func TestDeleteRoundTripSettles(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)

	if err := r.TombstoneLinks(item.Name, item.Checked); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	db.Delete(item)

	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 || !pushes[0].IsDeleted {
		t.Fatalf("want one delete push, got %+v", pushes)
	}
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T07:00:00.1111111Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}

	echo := rkItem("a-id", "Fig", deleted)
	if _, err := r.ApplyInbound([]ShoppingListItem{echo}); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}
	if itemByName(t, db, "Fig", false) != nil {
		t.Error("deleted item was resurrected by its own echo")
	}
	after, _ := r.PendingPushes()
	if len(after) != 0 {
		t.Errorf("delete still pending after ack: %+v", after)
	}
}
```

- [ ] **Step 2: Add the undo tests**

Append to `reconcile_echo_test.go`. These are the reason links are keyed by collapse key rather than by grocery id — see the model comment in Task 1.

```go
// Undo of a delete, BEFORE the delete was pushed: the tombstone is simply
// forgotten and nothing goes to Recipe Keeper.
func TestUndoDeleteBeforePushCancelsIt(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)

	if err := r.TombstoneLinks(item.Name, item.Checked); err != nil {
		t.Fatalf("TombstoneLinks: %v", err)
	}
	db.Delete(item)

	// Undo replays a snapshot through PUT /api/grocery: the row returns with a
	// brand-new id, which the link must not care about.
	db.Create(&models.GroceryItem{
		ID: models.NewID(), SectionID: item.SectionID, Name: "Fig",
		CreatedAt: models.NowUTC(), UpdatedAt: models.NowUTC(),
	})

	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 0 {
		t.Errorf("undo before push must send nothing, got %+v", pushes)
	}
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Count(&n)
	if n != 0 {
		t.Errorf("tombstone should be gone, %d remain", n)
	}
}

// Undo of a delete AFTER the push: Recipe Keeper's deletes are soft, so the fix
// is to push IsDeleted:false rather than to recreate anything.
func TestUndoDeleteAfterPushUndeletes(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)

	_ = r.TombstoneLinks(item.Name, item.Checked)
	db.Delete(item)
	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 || !pushes[0].IsDeleted {
		t.Fatalf("want one delete push, got %+v", pushes)
	}
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T08:00:00.1111111Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}

	// Now undo.
	db.Create(&models.GroceryItem{
		ID: models.NewID(), SectionID: item.SectionID, Name: "Fig",
		CreatedAt: models.NowUTC(), UpdatedAt: models.NowUTC(),
	})

	after, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(after) != 1 || after[0].IsDeleted {
		t.Fatalf("want one un-delete push, got %+v", after)
	}
	if err := r.ApplyAcks([]AckItem{{ID: "a-id", LastModified: "2026-09-14T09:00:00.2222222Z"}}); err != nil {
		t.Fatalf("ApplyAcks: %v", err)
	}
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Count(&n)
	if n != 0 {
		t.Errorf("tombstone should be spent after un-delete, %d remain", n)
	}
	settled, _ := r.PendingPushes()
	if len(settled) != 0 {
		t.Errorf("un-delete did not settle: %+v", settled)
	}
}

// A full list replace (merge, clear-undo, redo) churns every grocery id. Links
// must survive it — this is the failure that would silently detach the whole
// list from Recipe Keeper.
func TestReplaceStyleIDChurnPreservesLinks(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})

	// Exactly what handleReplaceGrocery does.
	var sections []models.GrocerySection
	db.Find(&sections)
	db.Where("1 = 1").Delete(&models.GrocerySection{})
	newSec := models.GrocerySection{ID: models.NewID(), Name: "Produce", CreatedAt: models.NowUTC()}
	db.Create(&newSec)
	qty := "2"
	db.Create(&models.GroceryItem{
		ID: models.NewID(), SectionID: newSec.ID, Name: "Lemon", Quantity: &qty,
		CreatedAt: models.NowUTC(), UpdatedAt: models.NowUTC(),
	})

	if n := linkCount(db, "Lemon", false); n != 2 {
		t.Fatalf("links after replace = %d, want 2", n)
	}
	pushes, err := r.PendingPushes()
	if err != nil {
		t.Fatalf("PendingPushes: %v", err)
	}
	if len(pushes) != 0 {
		t.Errorf("an id churn must not push anything, got %+v", pushes)
	}
	refs, _ := r.RecipeTitles("Lemon", false)
	if len(refs) != 0 && len(refs) != 2 {
		t.Errorf("attribution should be intact, got %+v", refs)
	}
}
```

- [ ] **Step 3: Run the tests**

Run: `cd backend && go test ./internal/recipekeeper/ -run 'Echo|RoundTrip|Undo|Churn' -v`
Expected: PASS. If either fails, **stop and fix the reconciler** — do not adjust the test. A failure here means the running system would push in a loop.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/recipekeeper/reconcile_echo_test.go
git commit -m "Recipe Keeper: echo round-trip guard"
```

---

### Task 7: Recipe title cache and RK category placement

**Files:**
- Create: `backend/internal/recipekeeper/recipes.go`
- Modify: `backend/internal/recipekeeper/reconcile.go` (replace the `sectionFromRKCategory` stub from Task 4)
- Test: `backend/internal/recipekeeper/recipes_test.go`

**Interfaces:**
- Consumes: `Client`, `Reconciler`.
- Produces:
  - `func (r *Reconciler) StoreRecipes(raw []json.RawMessage) error`
  - `func (r *Reconciler) RecipeTitles(name string, checked bool) ([]RecipeRef, error)`
  - `type RecipeRef struct { ID, Title string }`
  - `func (r *Reconciler) StoreCategories(cats, catItems []json.RawMessage) error`

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/recipekeeper/recipes_test.go
package recipekeeper

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Only Id and Title are kept. The full entity embeds base64 photos and is far
// too large to store.
func TestStoreRecipesKeepsOnlyIdAndTitle(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)

	raw, err := os.ReadFile(filepath.Join("testdata", "sync_recipe_request.json"))
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	var env struct {
		Recipe struct {
			SyncEntities []json.RawMessage `json:"SyncEntities"`
		} `json:"RecipeSyncEntityRequest"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Recipe.SyncEntities) == 0 {
		t.Fatal("fixture has no recipe entities")
	}
	if err := r.StoreRecipes(env.Recipe.SyncEntities); err != nil {
		t.Fatalf("StoreRecipes: %v", err)
	}

	var got []struct {
		RKRecipeID string
		Title      string
	}
	db.Table("recipe_keeper_recipes").Select("rk_recipe_id", "title").Scan(&got)
	if len(got) == 0 {
		t.Fatal("no recipes cached")
	}
	for _, g := range got {
		if g.Title == "" || g.RKRecipeID == "" {
			t.Errorf("incomplete cache row: %+v", g)
		}
		if len(g.Title) > 500 {
			t.Errorf("title suspiciously large (%d bytes) — photo data leaked in?", len(g.Title))
		}
	}
}

func TestRecipeTitlesForCollapsedItem(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)

	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("rec-1")),
		rkItem("b-id", "Lemon", withRecipe("rec-2")),
	})
	if err := r.StoreRecipes([]json.RawMessage{
		json.RawMessage(`{"Id":"rec-1","Title":"Fig Cocktail"}`),
		json.RawMessage(`{"Id":"rec-2","Title":"Thai Curry"}`),
	}); err != nil {
		t.Fatalf("StoreRecipes: %v", err)
	}

	item := itemByName(t, db, "Lemon", false)
	refs, err := r.RecipeTitles(item.Name, item.Checked)
	if err != nil {
		t.Fatalf("RecipeTitles: %v", err)
	}
	if len(refs) != 2 {
		t.Fatalf("refs = %d, want 2", len(refs))
	}
	seen := map[string]bool{}
	for _, ref := range refs {
		seen[ref.Title] = true
	}
	if !seen["Fig Cocktail"] || !seen["Thai Curry"] {
		t.Errorf("titles = %+v", refs)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/recipekeeper/ -run Recipe -v`
Expected: FAIL — `undefined: (*Reconciler).StoreRecipes`

- [ ] **Step 3: Write recipes.go**

```go
// backend/internal/recipekeeper/recipes.go
package recipekeeper

import (
	"encoding/json"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

type RecipeRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// StoreRecipes caches id -> title from Recipe entities, discarding everything
// else. Recipe payloads embed base64 photos (~100-300 KB each), so nothing but
// the title is retained.
func (r *Reconciler) StoreRecipes(raw []json.RawMessage) error {
	for _, blob := range raw {
		var rec struct {
			ID           string `json:"Id"`
			Title        string `json:"Title"`
			IsDeleted    bool   `json:"IsDeleted"`
			LastModified string `json:"LastModified"`
		}
		if err := json.Unmarshal(blob, &rec); err != nil || rec.ID == "" {
			continue
		}
		if rec.IsDeleted {
			r.DB.Delete(&models.RecipeKeeperRecipe{}, "rk_recipe_id = ?", rec.ID)
			continue
		}
		row := models.RecipeKeeperRecipe{
			RKRecipeID: rec.ID, Title: rec.Title, RKLastModified: rec.LastModified,
		}
		if err := r.DB.Save(&row).Error; err != nil {
			return err
		}
	}
	return nil
}

// RecipeTitles returns the distinct recipes a grocery item came from. A
// collapsed item legitimately has several; an unknown id is skipped rather than
// rendered as a bare GUID.
func (r *Reconciler) RecipeTitles(name string, checked bool) ([]RecipeRef, error) {
	var links []models.RecipeKeeperLink
	if err := r.DB.Order("rk_position asc").Find(&links,
		"mp_name = ? AND mp_checked = ? AND rk_recipe_id IS NOT NULL",
		normalizeName(name), checked).Error; err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []RecipeRef{}
	for _, link := range links {
		id := *link.RKRecipeID
		if seen[id] {
			continue
		}
		seen[id] = true
		var rec models.RecipeKeeperRecipe
		if err := r.DB.First(&rec, "rk_recipe_id = ?", id).Error; err != nil {
			continue
		}
		out = append(out, RecipeRef{ID: rec.RKRecipeID, Title: rec.Title})
	}
	return out, nil
}
```

- [ ] **Step 4: Add category placement**

Add to `recipes.go`, then **delete the `sectionFromRKCategory` stub** written in Task 4 and replace it with this one.

```go
// rkCategoryForItem maps an item name to RK's category name via the
// ShoppingListCategoryItem bucket, which joins by NAME, not by id.
func (r *Reconciler) rkCategoryForItem(name string) (string, bool) {
	var state models.RecipeKeeperState
	if err := r.DB.First(&state, "key = ?", "category:"+normalizeName(name)).Error; err != nil {
		return "", false
	}
	return state.Value, true
}

// StoreCategories caches the name -> category-name mapping used for the initial
// placement of newly imported items.
func (r *Reconciler) StoreCategories(cats, catItems []json.RawMessage) error {
	byID := map[string]string{}
	for _, blob := range cats {
		var c struct {
			ID        string `json:"Id"`
			Name      string `json:"Name"`
			IsDeleted bool   `json:"IsDeleted"`
		}
		if err := json.Unmarshal(blob, &c); err != nil || c.IsDeleted {
			continue
		}
		byID[c.ID] = c.Name
	}
	for _, blob := range catItems {
		var ci struct {
			Name       string `json:"Name"`
			CategoryID string `json:"ShoppingListCategoryId"`
			IsDeleted  bool   `json:"IsDeleted"`
		}
		if err := json.Unmarshal(blob, &ci); err != nil || ci.IsDeleted || ci.Name == "" {
			continue
		}
		catName, ok := byID[ci.CategoryID]
		if !ok {
			continue
		}
		row := models.RecipeKeeperState{Key: "category:" + normalizeName(ci.Name), Value: catName}
		if err := r.DB.Save(&row).Error; err != nil {
			return err
		}
	}
	return nil
}

// sectionFromRKCategory resolves RK's category to an EXISTING MP section.
// It never creates one: Meal Planner's sections are authoritative, so RK may
// only suggest a home that already exists.
func (r *Reconciler) sectionFromRKCategory(name string) (uuid.UUID, bool) {
	catName, ok := r.rkCategoryForItem(name)
	if !ok {
		return uuid.Nil, false
	}
	var sec models.GrocerySection
	if err := r.DB.First(&sec, "LOWER(name) = LOWER(?)", catName).Error; err != nil {
		return uuid.Nil, false
	}
	return sec.ID, true
}
```

Add `normalizeName` to `store.go`:

```go
func normalizeName(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/recipekeeper/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/internal/recipekeeper/recipes.go backend/internal/recipekeeper/recipes_test.go \
        backend/internal/recipekeeper/reconcile.go backend/internal/recipekeeper/store.go
git commit -m "Recipe Keeper: recipe title cache and category-based placement"
```

---

### Task 8: Sync loop, state, and error reporting

**Files:**
- Create: `backend/internal/recipekeeper/loop.go`
- Create: `backend/internal/recipekeeper/state.go`
- Modify: `backend/cmd/server/main.go`
- Test: `backend/internal/recipekeeper/loop_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `type Service struct { Client *Client; Rec *Reconciler; DB *gorm.DB; OnChange func(Changes) }`
  - `func (s *Service) SyncOnce(ctx context.Context) error`
  - `func (s *Service) Run(ctx context.Context)`
  - `func (s *Service) Status() Status`
  - `type Status struct { Enabled bool; LastSync *time.Time; LastError string; AuthFailed bool }`

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/recipekeeper/loop_test.go
package recipekeeper

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"mealplanner/internal/models"
)

func TestSyncOnceAppliesInboundAndPushesOutbound(t *testing.T) {
	db := testDB(t)
	rec := testReconciler(t, db)

	var pushed []ShoppingListItem
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var req SyncRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.ShoppingListItem != nil {
			pushed = append(pushed, req.ShoppingListItem.SyncEntities...)
		}
		lm := "2026-09-14T00:00:00.0000001Z"
		_ = json.NewEncoder(w).Encode(SyncResponse{
			ShoppingListItem: &ItemBucketResponse{
				UpdatedServerItems: []ShoppingListItem{{
					ID: "srv-1", Name: "Cilantro", ShoppingListID: "list-1", LastModified: &lm,
				}},
				MaxLastModified: lm,
			},
		})
	}))
	defer srv.Close()

	now := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "p",
		HTTP: srv.Client(), Now: func() time.Time { return now }}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    rec, DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if itemByName(t, db, "Cilantro", false) == nil {
		t.Error("inbound item was not applied")
	}
	if st := svc.Status(); st.LastError != "" {
		t.Errorf("LastError = %q, want empty", st.LastError)
	}

	// A local change must be pushed on the next pass.
	it := itemByName(t, db, "Cilantro", false)
	it.Checked = true
	db.Save(it)
	pushed = nil
	if err := svc.SyncOnce(context.Background()); err != nil {
		t.Fatalf("SyncOnce 2: %v", err)
	}
	if len(pushed) != 1 || !pushed[0].IsChecked {
		t.Errorf("pushed = %+v, want one checked entity", pushed)
	}
}

func TestSyncOnceRecordsAuthFailureImmediately(t *testing.T) {
	db := testDB(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	auth := &Authenticator{BaseURL: srv.URL, Username: "u", Password: "bad",
		HTTP: srv.Client(), Now: time.Now}
	svc := &Service{
		Client: &Client{BaseURL: srv.URL, HTTP: srv.Client(), Auth: auth},
		Rec:    testReconciler(t, db), DB: db,
	}

	if err := svc.SyncOnce(context.Background()); err == nil {
		t.Fatal("want error")
	}
	st := svc.Status()
	if !st.AuthFailed {
		t.Error("AuthFailed should be true — credential failures never self-heal")
	}
	if st.LastError == "" {
		t.Error("LastError should be recorded for the bell")
	}
	var row models.RecipeKeeperState
	if err := db.First(&row, "key = ?", stateLastError).Error; err != nil {
		t.Error("last error must persist across restarts")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/recipekeeper/ -run SyncOnce -v`
Expected: FAIL — `undefined: Service`

- [ ] **Step 3: Write state.go**

```go
// backend/internal/recipekeeper/state.go
package recipekeeper

import (
	"gorm.io/gorm"

	"mealplanner/internal/models"
)

const (
	stateWatermarkItem     = "watermark:ShoppingListItem"
	stateWatermarkRecipe   = "watermark:Recipe"
	stateWatermarkCategory = "watermark:ShoppingListCategory"
	stateWatermarkCatItem  = "watermark:ShoppingListCategoryItem"
	stateDeviceID          = "device_id"
	stateLastSync          = "last_sync"
	stateLastError         = "last_error"
	stateAuthFailed        = "auth_failed"
)

// epochWatermark pulls everything: the .NET zero date.
const epochWatermark = "0001-01-01T00:00:00Z"

func getState(db *gorm.DB, key, fallback string) string {
	var row models.RecipeKeeperState
	if err := db.First(&row, "key = ?", key).Error; err != nil {
		return fallback
	}
	return row.Value
}

func setState(db *gorm.DB, key, value string) {
	db.Save(&models.RecipeKeeperState{Key: key, Value: value})
}

// DeviceID returns a stable per-install identifier, generating one on first use.
// It must not change between requests — a fresh id each time would present as an
// unbounded fleet of new devices.
func DeviceID(db *gorm.DB) string {
	if v := getState(db, stateDeviceID, ""); v != "" {
		return v
	}
	id := models.NewID().String()
	setState(db, stateDeviceID, id)
	return id
}
```

- [ ] **Step 4: Write loop.go**

```go
// backend/internal/recipekeeper/loop.go
package recipekeeper

import (
	"context"
	"log"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/models"
)

const (
	safetyInterval   = 15 * time.Minute
	transientAlertAt = 3
	backoffBase      = 30 * time.Second
	backoffMax       = 30 * time.Minute
)

type Status struct {
	Enabled    bool       `json:"enabled"`
	LastSync   *time.Time `json:"last_sync"`
	LastError  string     `json:"last_error"`
	AuthFailed bool       `json:"auth_failed"`
}

// Service drives the sync. OnChange is called after any inbound change so the
// caller can broadcast SSE; it is nil in tests.
type Service struct {
	Client   *Client
	Rec      *Reconciler
	DB       *gorm.DB
	OnChange func(Changes)

	failures int
}

// SyncOnce performs one pull/apply/push cycle.
func (s *Service) SyncOnce(ctx context.Context) error {
	wm := getState(s.DB, stateWatermarkItem, epochWatermark)

	pushes, err := s.Rec.PendingPushes()
	if err != nil {
		return err
	}
	ids := make([]string, 0, len(pushes))
	for _, p := range pushes {
		ids = append(ids, p.ID)
	}

	resp, err := s.Client.Sync(ctx, SyncRequest{
		ShoppingListItem: &ItemBucket{
			MaxLastModified: wm,
			SyncEntities:    pushes,
			LocalChangesIds: ids,
		},
	})
	if err != nil {
		s.recordError(err)
		return err
	}

	bucket := resp.ShoppingListItem
	if bucket == nil {
		s.recordSuccess()
		return nil
	}
	if err := s.Rec.ApplyAcks(bucket.UpdatedLocalItems); err != nil {
		return err
	}
	ch, err := s.Rec.ApplyInbound(bucket.UpdatedServerItems)
	if err != nil {
		return err
	}
	if bucket.MaxLastModified != "" {
		setState(s.DB, stateWatermarkItem, bucket.MaxLastModified)
	}
	s.recordSuccess()
	if ch.Any() && s.OnChange != nil {
		s.OnChange(ch)
	}
	return nil
}

func (s *Service) recordSuccess() {
	s.failures = 0
	setState(s.DB, stateLastSync, models.NowUTC().Format(time.RFC3339))
	setState(s.DB, stateLastError, "")
	setState(s.DB, stateAuthFailed, "false")
}

// recordError surfaces auth failures immediately — they never self-heal — but
// holds transient failures back until they have repeated, so a momentary blip
// does not raise an alert that trains the user to ignore it.
func (s *Service) recordError(err error) {
	s.failures++
	if IsAuthError(err) {
		setState(s.DB, stateAuthFailed, "true")
		setState(s.DB, stateLastError, "Recipe Keeper sign-in failed — check RECIPE_KEEPER_PASSWORD")
		log.Printf("recipekeeper: auth failure: %v", err)
		return
	}
	log.Printf("recipekeeper: sync failed (%d consecutive): %v", s.failures, err)
	if s.failures >= transientAlertAt {
		setState(s.DB, stateLastError, "Can't reach Recipe Keeper")
	}
}

func (s *Service) Status() Status {
	st := Status{
		Enabled:    true,
		LastError:  getState(s.DB, stateLastError, ""),
		AuthFailed: getState(s.DB, stateAuthFailed, "false") == "true",
	}
	if v := getState(s.DB, stateLastSync, ""); v != "" {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			st.LastSync = &t
		}
	}
	return st
}

// Run drives the long-poll doorbell until ctx is cancelled. A 200 means
// something changed; a 201 means the poll simply expired. A safety timer covers
// anything missed while the process was down.
func (s *Service) Run(ctx context.Context) {
	if err := s.SyncOnce(ctx); err != nil {
		log.Printf("recipekeeper: initial sync: %v", err)
	}
	safety := time.NewTicker(safetyInterval)
	defer safety.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-safety.C:
			_ = s.SyncOnce(ctx)
		default:
		}

		changed, err := s.Client.Notify(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			s.recordError(err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(s.backoff()):
			}
			continue
		}
		if changed {
			_ = s.SyncOnce(ctx)
		}
	}
}

func (s *Service) backoff() time.Duration {
	d := backoffBase << min(s.failures, 6)
	if d > backoffMax {
		return backoffMax
	}
	return d
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
```

- [ ] **Step 5: Wire it into cmd/server**

In `backend/cmd/server/main.go`, after the calendar cache init and alongside the `RunDueLoop` start, add:

```go
	if cfg.RecipeKeeperEnabled {
		rkAuth := &recipekeeper.Authenticator{
			BaseURL:  "https://recipekeeper.azurewebsites.net",
			Username: cfg.RecipeKeeperUsername,
			Password: cfg.RecipeKeeperPassword,
			HTTP:     &http.Client{Timeout: 30 * time.Second},
			Hdr:      recipekeeper.DefaultHeaders(recipekeeper.DeviceID(database), cfg.RecipeKeeperReceiptID),
		}
		hdr := recipekeeper.DefaultHeaders(recipekeeper.DeviceID(database), cfg.RecipeKeeperReceiptID)
		rkSvc := &recipekeeper.Service{
			Client: recipekeeper.NewClient("https://recipekeeper.azurewebsites.net", rkAuth, hdr),
			Rec: &recipekeeper.Reconciler{
				DB:     database,
				ListID: cfg.RecipeKeeperListID,
			},
			DB: database,
			OnChange: func(ch recipekeeper.Changes) {
				// The sync loop has no *http.Request, so it broadcasts directly
				// with a synthetic source id rather than via App.broadcast.
				broadcaster.BroadcastEvent("grocery.updated",
					map[string]any{"action": "replaced", "source": "recipe-keeper"},
					"recipe-keeper")
			},
		}
		application.RecipeKeeper = rkSvc
		go rkSvc.Run(ctx)
	}
```

Match the local variable names already used in `main.go` (`cfg`, `database`, `broadcaster`, `application`, `ctx`); read the surrounding code before inserting.

- [ ] **Step 6: Run tests and build**

Run: `cd backend && go build ./... && go test ./internal/recipekeeper/ -v`
Expected: build succeeds, all tests PASS

- [ ] **Step 7: Commit**

```bash
git add backend/internal/recipekeeper/loop.go backend/internal/recipekeeper/state.go \
        backend/internal/recipekeeper/loop_test.go backend/cmd/server/main.go
git commit -m "Recipe Keeper: sync loop, persisted state, error reporting"
```

---

### Task 9: API surface — status endpoint and recipes on grocery items

**Files:**
- Create: `backend/internal/app/recipekeeper.go`
- Modify: `backend/internal/app/serialize.go:61-73` (`groceryItemJSON`)
- Modify: `backend/internal/app/app.go` (route registration, `App` struct field)
- Test: `backend/internal/app/recipekeeper_test.go`

**Interfaces:**
- Consumes: `recipekeeper.Service`, `recipekeeper.RecipeRef` from Tasks 7–8.
- Produces: `GET /api/recipe-keeper/status`, `POST /api/recipe-keeper/sync`, and a `recipes` array on every grocery item JSON.

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/app/recipekeeper_test.go
package app

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestGroceryItemCarriesRecipes(t *testing.T) {
	h := newHarness(t)
	defer h.Close()

	sec := h.createGrocerySection("Produce")
	item := h.createGroceryItem(sec, "Lemon")
	_ = item
	h.linkRecipeKeeper("Lemon", false, "rk-1", "rec-1", "Fig Cocktail")

	resp := h.get("/api/grocery")
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d", resp.Code)
	}
	var out []struct {
		Items []struct {
			Name    string `json:"name"`
			Recipes []struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"recipes"`
		} `json:"items"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	found := false
	for _, s := range out {
		for _, it := range s.Items {
			if it.Name != "Lemon" {
				continue
			}
			found = true
			if len(it.Recipes) != 1 || it.Recipes[0].Title != "Fig Cocktail" {
				t.Errorf("recipes = %+v", it.Recipes)
			}
		}
	}
	if !found {
		t.Fatal("Lemon not in response")
	}
}

// Items with no Recipe Keeper links must serialize an empty array, never null —
// the frontend maps over this field unconditionally.
func TestGroceryItemWithoutLinksHasEmptyRecipes(t *testing.T) {
	h := newHarness(t)
	defer h.Close()
	sec := h.createGrocerySection("Produce")
	h.createGroceryItem(sec, "Salt")

	resp := h.get("/api/grocery")
	if got := resp.Body.String(); !contains(got, `"recipes":[]`) {
		t.Errorf("want empty recipes array, body = %s", got)
	}
}

func TestStatusEndpointReportsDisabled(t *testing.T) {
	h := newHarness(t)
	defer h.Close()

	resp := h.get("/api/recipe-keeper/status")
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d", resp.Code)
	}
	var st struct {
		Enabled   bool   `json:"enabled"`
		LastError string `json:"last_error"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if st.Enabled {
		t.Error("enabled should be false when the service is not configured")
	}
}
```

Add the two harness helpers to `backend/internal/app/harness_test.go`, matching the style of the existing helpers there:

```go
func (h *harness) linkRecipeKeeper(itemName string, checked bool, rkItemID, recipeID, title string) {
	h.t.Helper()
	rid := recipeID
	h.DB.Create(&models.RecipeKeeperLink{
		RKItemID:  rkItemID,
		MPName:    strings.ToLower(strings.TrimSpace(itemName)),
		MPChecked: checked,
		RKRecipeID: &rid, RKName: itemName,
		RKLastModified: "2026-09-14T00:00:00.0000001Z",
	})
	h.DB.Create(&models.RecipeKeeperRecipe{RKRecipeID: recipeID, Title: title})
}

func contains(haystack, needle string) bool { return strings.Contains(haystack, needle) }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/app/ -run RecipeKeeper -v`
Expected: FAIL — route not found / `recipes` missing

- [ ] **Step 3: Add recipes to groceryItemJSON**

`groceryItemJSON` currently takes only the item. Give it access to the DB so it can resolve links. Change the signature and update its callers in `serialize.go`:

```go
func groceryItemJSON(item *models.GroceryItem, recipes []recipekeeper.RecipeRef) J {
	if recipes == nil {
		recipes = []recipekeeper.RecipeRef{}
	}
	return J{
		"id":              item.ID.String(),
		"section_id":      item.SectionID.String(),
		"name":            item.Name,
		"quantity":        strOrNil(item.Quantity),
		"checked":         item.Checked,
		"position":        item.Position,
		"global_position": item.GlobalPosition,
		"store_id":        uuidPtr(item.StoreID),
		"recipes":         recipes,
		"updated_at":      httpx.FormatDateTime(item.UpdatedAt),
	}
}
```

To avoid an N+1 query per item, load the whole map once per response. Add to `serialize.go`:

```go
// recipeRefsByKey loads recipe attributions for a whole response in two queries
// rather than two per item. Keyed by collapse key, matching how links address
// grocery rows.
func recipeRefsByKey(db *gorm.DB) map[string][]recipekeeper.RecipeRef {
	out := map[string][]recipekeeper.RecipeRef{}
	var links []models.RecipeKeeperLink
	if err := db.Order("rk_position asc").
		Find(&links, "rk_recipe_id IS NOT NULL").Error; err != nil {
		return out
	}
	var recipes []models.RecipeKeeperRecipe
	db.Find(&recipes)
	titles := make(map[string]string, len(recipes))
	for _, rec := range recipes {
		titles[rec.RKRecipeID] = rec.Title
	}
	seen := map[string]bool{}
	for _, link := range links {
		id := *link.RKRecipeID
		rowKey := recipekeeper.RowKey(link.MPName, link.MPChecked)
		if seen[rowKey+"|"+id] {
			continue
		}
		seen[rowKey+"|"+id] = true
		title, ok := titles[id]
		if !ok {
			continue
		}
		out[rowKey] = append(out[rowKey], recipekeeper.RecipeRef{ID: id, Title: title})
	}
	return out
}
```

Export the key helper from `store.go` so `app` can build the same key:

```go
// RowKey is the collapse key linking a Recipe Keeper row to a grocery row.
func RowKey(name string, checked bool) string { return collapseKey(name, checked) }
```

Thread the map through `grocerySectionJSON` and its callers, looking each item up with `recipekeeper.RowKey(item.Name, item.Checked)`.

- [ ] **Step 4: Write the endpoints**

```go
// backend/internal/app/recipekeeper.go
package app

import (
	"net/http"

	"mealplanner/internal/httpx"
	"mealplanner/internal/recipekeeper"
)

func (a *App) handleRecipeKeeperStatus(w http.ResponseWriter, r *http.Request) {
	if a.RecipeKeeper == nil {
		httpx.JSON(w, http.StatusOK, recipekeeper.Status{Enabled: false})
		return
	}
	httpx.JSON(w, http.StatusOK, a.RecipeKeeper.Status())
}

func (a *App) handleRecipeKeeperSync(w http.ResponseWriter, r *http.Request) {
	if a.RecipeKeeper == nil {
		httpx.Error(w, http.StatusBadRequest, "Recipe Keeper sync is not configured")
		return
	}
	if err := a.RecipeKeeper.SyncOnce(r.Context()); err != nil {
		httpx.Error(w, http.StatusBadGateway, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, a.RecipeKeeper.Status())
}
```

Add the field to the `App` struct and register both routes next to the other authenticated `/api` routes. Match the existing route-registration and `httpx` helper names — read `app.go` first, since `httpx.JSON`/`httpx.Error` may be spelled differently in this codebase.

```go
	RecipeKeeper *recipekeeper.Service
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/app/ -v`
Expected: PASS, including `TestAllAPIRoutesAuthenticatedUnlessAllowlisted` — both new routes require auth.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && go build ./... && go test ./... 2>&1 | tail -20`
Expected: all packages PASS

- [ ] **Step 7: Commit**

```bash
git add backend/internal/app/recipekeeper.go backend/internal/app/recipekeeper_test.go \
        backend/internal/app/serialize.go backend/internal/app/app.go \
        backend/internal/app/harness_test.go
git commit -m "Recipe Keeper: status endpoints and recipe attribution in grocery JSON"
```

---

### Task 10: Tombstone retention

**Files:**
- Modify: `backend/internal/db/db.go:164` (`CleanupOldData`)
- Test: `backend/internal/db/db_test.go`

**Interfaces:**
- Consumes: models from Task 1, `stateWatermarkItem` semantics from Task 8.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```go
// append to backend/internal/db/db_test.go
func TestCleanupPrunesSettledTombstones(t *testing.T) {
	database := newTestDB(t) // use the helper already in this file
	database.Create(&models.RecipeKeeperState{
		Key: "watermark:ShoppingListItem", Value: "2026-09-14T12:00:00.0000000Z",
	})
	now := models.NowUTC()

	// Settled: pushed, and the watermark has moved past the ack.
	database.Create(&models.RecipeKeeperTombstone{
		RKItemID: "settled", DeletedAt: now, PushedAt: &now,
		AckLastModified: strPtr("2026-09-14T10:00:00.0000000Z"),
	})
	// Pushed, but the watermark has NOT yet passed it — still needed.
	database.Create(&models.RecipeKeeperTombstone{
		RKItemID: "recent", DeletedAt: now, PushedAt: &now,
		AckLastModified: strPtr("2026-09-14T13:00:00.0000000Z"),
	})
	// Never pushed — this is a pending delete and must survive.
	database.Create(&models.RecipeKeeperTombstone{RKItemID: "pending", DeletedAt: now})

	db.CleanupOldData(database, 30)

	var ids []string
	database.Model(&models.RecipeKeeperTombstone{}).Pluck("rk_item_id", &ids)
	if len(ids) != 2 {
		t.Fatalf("remaining = %v, want [recent pending]", ids)
	}
	for _, id := range ids {
		if id == "settled" {
			t.Error("settled tombstone should have been pruned")
		}
	}
}

func strPtr(s string) *string { return &s }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/db/ -run Tombstone -v`
Expected: FAIL — all three rows remain

- [ ] **Step 3: Implement pruning**

Add to `CleanupOldData`, after the existing retention work. The string comparison is safe because .NET round-trip timestamps are fixed-width and lexically ordered, and it runs identically on SQLite and Postgres.

```go
	// Recipe Keeper tombstones exist only until a delete is acknowledged AND the
	// sync watermark has moved past it — after that the row can never come back
	// in UpdatedServerItems, so the guard is no longer needed. The link is kept
	// alive alongside the tombstone purely so an undo can rebuild the entity, so
	// the two are pruned together.
	var wm models.RecipeKeeperState
	if err := db.First(&wm, "key = ?", "watermark:ShoppingListItem").Error; err == nil {
		var settled []string
		db.Model(&models.RecipeKeeperTombstone{}).
			Where("pushed_at IS NOT NULL AND ack_last_modified IS NOT NULL AND ack_last_modified <= ?", wm.Value).
			Pluck("rk_item_id", &settled)
		if len(settled) > 0 {
			db.Where("rk_item_id IN ?", settled).Delete(&models.RecipeKeeperLink{})
			db.Where("rk_item_id IN ?", settled).Delete(&models.RecipeKeeperTombstone{})
		}
	}
	// Backstops: drop settled tombstones after 30 days regardless of watermark
	// bookkeeping, and give up on deletes that have been undeliverable for 90.
	cutoff := models.NowUTC().AddDate(0, 0, -30)
	db.Where("pushed_at IS NOT NULL AND deleted_at < ?", cutoff).
		Delete(&models.RecipeKeeperTombstone{})
	stale := models.NowUTC().AddDate(0, 0, -90)
	var abandoned int64
	db.Model(&models.RecipeKeeperTombstone{}).
		Where("pushed_at IS NULL AND deleted_at < ?", stale).Count(&abandoned)
	if abandoned > 0 {
		log.Printf("recipekeeper: abandoning %d undeliverable deletes older than 90 days", abandoned)
		db.Where("pushed_at IS NULL AND deleted_at < ?", stale).
			Delete(&models.RecipeKeeperTombstone{})
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/db/ -v`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `bash run-tests.sh 2>&1 | tail -20`
Expected: backend and frontend suites pass

- [ ] **Step 6: Commit**

```bash
git add backend/internal/db/db.go backend/internal/db/db_test.go
git commit -m "Recipe Keeper: prune settled tombstones in cleanup"
```

---

### Task 11: Grocery mutation hooks — deletes and partial acquisition

Without this task the sync is read-mostly: local deletes never reach Recipe Keeper, and decrementing a quantity does nothing to the linked rows. This is where "changes reflect in both directions" is actually earned.

**Files:**
- Modify: `backend/internal/recipekeeper/reconcile.go` (add `ConsumeUnits`, `moveLinkToRow`)
- Modify: `backend/internal/app/grocery.go` (delete item, clear checked, clear all, quantity update)
- Test: `backend/internal/recipekeeper/reconcile_consume_test.go`

**Interfaces:**
- Consumes: `Reconciler`, `TombstoneLinks` (Task 5).
- Produces: `func (r *Reconciler) ConsumeUnits(itemID uuid.UUID, n int) error`

- [ ] **Step 1: Write the failing test**

```go
// backend/internal/recipekeeper/reconcile_consume_test.go
package recipekeeper

import (
	"testing"

	"mealplanner/internal/models"
)

// Decrementing must spend MP-only units before touching anything linked to a
// recipe — a locally-added unit costs nothing to give up, a linked one costs a
// write to a third party.
func TestConsumeUnitsSpendsLocalUnitsFirst(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{
		rkItem("a-id", "Lemon", withRecipe("r1")),
		rkItem("b-id", "Lemon", withRecipe("r2")),
	})
	// User adds one of their own: quantity 3, two links.
	item := itemByName(t, db, "Lemon", false)
	setQuantity(item, 3)
	db.Save(item)

	if err := r.ConsumeUnits(item.ID, 1); err != nil {
		t.Fatalf("ConsumeUnits: %v", err)
	}

	item = itemByName(t, db, "Lemon", false)
	if quantityOf(item) != 2 {
		t.Errorf("quantity = %d, want 2", quantityOf(item))
	}
	if n := linkCount(db, item.Name, item.Checked); n != 2 {
		t.Errorf("links = %d, want 2 — no link should have moved", n)
	}
	pushes, _ := r.PendingPushes()
	if len(pushes) != 0 {
		t.Errorf("spending a local unit must not push: %+v", pushes)
	}
}

// Once local units run out, decrementing checks off linked rows, lowest
// rk_position first, and those become pending pushes.
func TestConsumeUnitsChecksLinksWhenLocalExhausted(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	a := rkItem("a-id", "Lemon", withRecipe("r1"))
	a.Position = 10
	b := rkItem("b-id", "Lemon", withRecipe("r2"))
	b.Position = 20
	_, _ = r.ApplyInbound([]ShoppingListItem{a, b})

	item := itemByName(t, db, "Lemon", false)
	if err := r.ConsumeUnits(item.ID, 1); err != nil {
		t.Fatalf("ConsumeUnits: %v", err)
	}

	unchecked := itemByName(t, db, "Lemon", false)
	checkedRow := itemByName(t, db, "Lemon", true)
	if unchecked == nil || checkedRow == nil {
		t.Fatal("want both an unchecked and a checked Lemon row")
	}
	if quantityOf(unchecked) != 1 || quantityOf(checkedRow) != 1 {
		t.Errorf("quantities = %d / %d, want 1 / 1", quantityOf(unchecked), quantityOf(checkedRow))
	}

	// The lowest-position link (a-id) is the one that moved.
	var moved models.RecipeKeeperLink
	db.First(&moved, "rk_item_id = ?", "a-id")
	if moved.MPName != "lemon" || !moved.MPChecked {
		t.Error("lowest-position link should have moved to the checked row")
	}

	pushes, _ := r.PendingPushes()
	if len(pushes) != 1 || pushes[0].ID != "a-id" || !pushes[0].IsChecked {
		t.Errorf("pushes = %+v, want a-id checked", pushes)
	}
}

// Consuming everything empties the source row entirely.
func TestConsumeUnitsAllRemovesSourceRow(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)
	_, _ = r.ApplyInbound([]ShoppingListItem{rkItem("a-id", "Fig", withRecipe("r1"))})
	item := itemByName(t, db, "Fig", false)

	if err := r.ConsumeUnits(item.ID, 1); err != nil {
		t.Fatalf("ConsumeUnits: %v", err)
	}
	if itemByName(t, db, "Fig", false) != nil {
		t.Error("source row should be gone once fully consumed")
	}
	if itemByName(t, db, "Fig", true) == nil {
		t.Error("checked row should exist")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/recipekeeper/ -run Consume -v`
Expected: FAIL — `undefined: (*Reconciler).ConsumeUnits`

- [ ] **Step 3: Implement ConsumeUnits**

Append to `reconcile.go`:

```go
// ConsumeUnits marks n units of an item as acquired, moving them from the
// unchecked row to the checked row. Local (MP-only) units are spent first
// because they cost nothing to give up; only then are recipe-linked rows
// checked, lowest rk_position first for determinism.
//
// Nothing is pushed here. Moving a link leaves it disagreeing with its row, and
// the next PendingPushes picks that up — one code path for every kind of change.
func (r *Reconciler) ConsumeUnits(itemID uuid.UUID, n int) error {
	if n <= 0 {
		return nil
	}
	var item models.GroceryItem
	if err := r.DB.First(&item, "id = ?", itemID).Error; err != nil {
		return err
	}
	links := linksFor(r.DB, item.Name, item.Checked)

	qty := quantityOf(&item)
	if n > qty {
		n = qty
	}
	localUnits := qty - len(links)
	fromLinks := n - localUnits
	if fromLinks < 0 {
		fromLinks = 0
	}
	if fromLinks > len(links) {
		fromLinks = len(links)
	}

	if fromLinks > 0 {
		dest, err := r.checkedRowFor(item)
		if err != nil {
			return err
		}
		for _, link := range links[:fromLinks] {
			if err := r.moveLinkToRow(link, dest); err != nil {
				return err
			}
		}
		setQuantity(dest, quantityOf(dest)+fromLinks)
		dest.UpdatedAt = r.now()
		if err := r.DB.Save(dest).Error; err != nil {
			return err
		}
	} else {
		// Purely local consumption still lands on the checked row, so the UI
		// shows what was acquired.
		dest, err := r.checkedRowFor(item)
		if err != nil {
			return err
		}
		setQuantity(dest, quantityOf(dest)+n)
		dest.UpdatedAt = r.now()
		if err := r.DB.Save(dest).Error; err != nil {
			return err
		}
	}

	remaining := qty - n
	if remaining <= 0 {
		return r.DB.Delete(&item).Error
	}
	setQuantity(&item, remaining)
	item.UpdatedAt = r.now()
	return r.DB.Save(&item).Error
}

// checkedRowFor finds or creates the checked sibling of a row.
func (r *Reconciler) checkedRowFor(src models.GroceryItem) (*models.GroceryItem, error) {
	if row := findRow(r.DB, src.Name, true); row != nil {
		return row, nil
	}
	row := &models.GroceryItem{
		ID:        models.NewID(),
		SectionID: src.SectionID,
		Name:      src.Name,
		Checked:   true,
		Position:  src.Position,
		StoreID:   src.StoreID,
		CreatedAt: r.now(),
		UpdatedAt: r.now(),
	}
	setQuantity(row, 0)
	if err := r.DB.Create(row).Error; err != nil {
		return nil, err
	}
	return row, nil
}

func (r *Reconciler) moveLinkToRow(link models.RecipeKeeperLink, dest *models.GroceryItem) error {
	link.MPName = normalizeName(dest.Name)
	link.MPChecked = dest.Checked
	return r.DB.Save(&link).Error
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/recipekeeper/ -run Consume -v`
Expected: PASS — all three

- [ ] **Step 5: Hook the grocery endpoints**

In `backend/internal/app/grocery.go`, add calls at four sites. Guard every one with `if a.RecipeKeeper != nil` so nothing changes when the feature is off.

1. **Delete item** — before deleting the row (links cascade away with it):

```go
	if a.RecipeKeeper != nil {
		if err := a.RecipeKeeper.Rec.TombstoneLinks(item.Name, item.Checked); err != nil {
			log.Printf("recipekeeper: tombstone on delete: %v", err)
		}
	}
```

2. **Clear checked** and 3. **Clear all** (`handleClearGroceryItems`) — loop the items being removed and call `TombstoneLinks(item.Name, item.Checked)` for each, before deletion. The spec is explicit that bulk clears propagate: a local-only delete would resurrect on the next pull.

3a. **Delete section** (`handleDeleteGrocerySection`) — the section's items cascade away with it, so tombstone each of them first, or their links become orphans and the rows silently stay in Recipe Keeper.

**`handleReplaceGrocery` must NOT tombstone anything.** It is an id churn, not a deletion — merge, and undo/redo of delete and clear, all route through it. Tombstoning there would delete the user's entire Recipe Keeper list the first time they undo.

4. **Quantity decrease** in the item PATCH handler — when the new quantity is lower than the old:

```go
	if a.RecipeKeeper != nil && newQty < oldQty {
		if err := a.RecipeKeeper.Rec.ConsumeUnits(item.ID, oldQty-newQty); err != nil {
			log.Printf("recipekeeper: consume units: %v", err)
		}
	}
```

5. **Tolerate a missing row on update.** Recipe Keeper is a writer the client cannot see, so a change queued while a device was offline may land on a row RK has since deleted or split. In `handleUpdateGroceryItem`, a missing row must be treated as already-applied (return success) rather than 404 — a 404 burns all 20 `MAX_SYNC_ATTEMPTS` retries before the change is discarded, turning a benign race into a stuck sync queue. Offline changes otherwise need no special handling: they drain into the backend as usual, and the declarative diff pushes whatever differs regardless of when it arrived.

After any of these, kick a reconcile so the push goes out promptly rather than waiting for the safety timer:

```go
	if a.RecipeKeeper != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			_ = a.RecipeKeeper.SyncOnce(ctx)
		}()
	}
```

Read the existing handlers before editing — match how they resolve the item, and place the tombstone call before the row is deleted, since the link rows cascade.

- [ ] **Step 6: Run the full backend suite**

Run: `cd backend && go build ./... && go test ./... 2>&1 | tail -20`
Expected: all packages PASS

- [ ] **Step 7: Commit**

```bash
git add backend/internal/recipekeeper/reconcile.go \
        backend/internal/recipekeeper/reconcile_consume_test.go \
        backend/internal/app/grocery.go
git commit -m "Recipe Keeper: propagate deletes and partial acquisition from grocery edits"
```

---

## Verification

After Task 10, verify the whole backend against a real account:

1. Set `RECIPE_KEEPER_ENABLED=true`, `RECIPE_KEEPER_USERNAME`, `RECIPE_KEEPER_PASSWORD`, `RECIPE_KEEPER_LIST_ID` in `.env`
2. Start the server from the project root so `config.Load(".env")` finds the file
3. Confirm the grocery list populates, and `GET /api/recipe-keeper/status` reports a recent `last_sync` with an empty `last_error`
4. Check an item in Meal Planner; confirm it checks in the Recipe Keeper app within seconds
5. Add an item in the Recipe Keeper app; confirm it appears in Meal Planner within ~10 seconds
6. **Watch the server log for repeated pushes of the same entity id** — that is what an echo loop looks like in production, and Task 6 exists to prevent it

## Deferred to the frontend plan

Recipe names on rows, the all-recipes popover, `groceryGroupBy: 'recipe'`, recipe filter chips, the pinned error row in `ActivityPanel`, and the Settings status section. All depend on the `recipes` field added in Task 9 and the status endpoint from the same task.
