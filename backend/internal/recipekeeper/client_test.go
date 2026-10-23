package recipekeeper

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
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
	if it.Name != "sample" {
		t.Errorf("Name = %q, want %q", it.Name, "sample")
	}
	if it.ID != "1fe8c051-1937-4c8e-b83a-52c42218f1fb" {
		t.Errorf("ID = %q, want %q", it.ID, "1fe8c051-1937-4c8e-b83a-52c42218f1fb")
	}
	if it.ShoppingListID != "123fa458-8676-4a4b-9060-0a932d2dbaa4" {
		t.Errorf("ShoppingListID = %q, want %q", it.ShoppingListID, "123fa458-8676-4a4b-9060-0a932d2dbaa4")
	}
	if it.IsChecked != false {
		t.Errorf("IsChecked = %v, want false", it.IsChecked)
	}
	if it.Position != 565 {
		t.Errorf("Position = %d, want 565", it.Position)
	}
	if it.IsDeleted != false {
		t.Errorf("IsDeleted = %v, want false", it.IsDeleted)
	}
	if it.RecipeID != nil {
		t.Errorf("RecipeID = %v, want nil", it.RecipeID)
	}
	if it.LastModified == nil || (*it.LastModified)[len(*it.LastModified)-1] != 'Z' {
		t.Errorf("server LastModified must carry Z, got %v", it.LastModified)
	}
	if it.LastModified != nil && *it.LastModified != "2026-09-13T23:55:28.3967144Z" {
		t.Errorf("LastModified = %q, want %q", *it.LastModified, "2026-09-13T23:55:28.3967144Z")
	}
}

// Round-tripping a ShoppingListItem with non-nil RecipeID verifies the JSON tag
// is correct — this field carries the recipe attribution that the whole feature exists for.
func TestShoppingListItemRecipeIDTag(t *testing.T) {
	recipe := "abc123"
	it := ShoppingListItem{
		Name:      "flour",
		ID:        "id1",
		RecipeID:  &recipe,
		IsChecked: false,
		IsDeleted: false,
		Position:  0,
	}
	data, err := json.Marshal(it)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Verify "RecipeId" appears in the JSON (not "RecipeID" or any typo)
	if !bytes.Contains(data, []byte(`"RecipeId"`)) {
		t.Errorf("JSON tag mismatch: %s", data)
	}
	var parsed ShoppingListItem
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if parsed.RecipeID == nil || *parsed.RecipeID != recipe {
		t.Errorf("round-trip failed: got %v, want %v", parsed.RecipeID, &recipe)
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

// A 401 mid-sync must be treated as "the token we hold is no longer good",
// not as a transient outage: invalidate it, fetch a fresh one, and retry the
// same request once. A server that accepts the fresh token must see no error
// at all.
func TestSyncRetriesOnceOn401ThenSucceeds(t *testing.T) {
	tokenCalls := 0
	syncCalls := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			tokenCalls++
			// Every token fetch returns a technically-valid-looking JWT; the
			// point is the SERVER rejects it once regardless of exp.
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		syncCalls++
		if syncCalls == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{}`))
	})

	_, err := c.Sync(context.Background(), SyncRequest{
		ShoppingListItem: &ItemBucket{MaxLastModified: "0001-01-01T00:00:00Z"},
	})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if syncCalls != 2 {
		t.Errorf("sync calls = %d, want 2 (one retry after the 401)", syncCalls)
	}
	if tokenCalls != 2 {
		t.Errorf("token calls = %d, want 2 (cached token invalidated, fresh one fetched)", tokenCalls)
	}
}

// If the retried request is ALSO rejected, the token wasn't a fluke — this
// must surface as an auth error (so the caller's latch/alerting engages),
// and must not retry a second time.
func TestSyncReturnsAuthErrorWhenRetryAlsoRejected(t *testing.T) {
	syncCalls := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		syncCalls++
		w.WriteHeader(http.StatusForbidden)
	})

	_, err := c.Sync(context.Background(), SyncRequest{
		ShoppingListItem: &ItemBucket{MaxLastModified: "0001-01-01T00:00:00Z"},
	})
	if err == nil {
		t.Fatal("want error when both attempts are rejected")
	}
	if !IsAuthError(err) {
		t.Errorf("IsAuthError(%v) = false, want true", err)
	}
	if syncCalls != 2 {
		t.Errorf("sync calls = %d, want exactly 2 (one retry, then stop)", syncCalls)
	}
}

// The live vendor API returns HTTP 500 "An unhandled exception occurred"
// whenever a present bucket's SyncEntities or LocalChangesIds serializes as
// JSON null instead of []. Go marshals a nil slice as null, so Sync must
// normalize both fields on every present bucket before marshaling — this
// locks that in by inspecting the actual bytes sent over the wire.
func TestSyncNormalizesNilSliceFieldsToEmptyArrays(t *testing.T) {
	var body []byte
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + makeJWT(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) + `"}`))
			return
		}
		var err error
		body, err = io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		w.Write([]byte(`{}`))
	})

	_, err := c.Sync(context.Background(), SyncRequest{
		// Deliberately nil SyncEntities/LocalChangesIds on both bucket
		// types — exactly what SyncOnce sends when there is nothing to push.
		ShoppingListItem: &ItemBucket{MaxLastModified: "0001-01-01T00:00:00Z"},
		ShoppingList:     &RawBucket{MaxLastModified: "0001-01-01T00:00:00Z"},
	})
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}

	for _, field := range []string{"SyncEntities", "LocalChangesIds"} {
		if bytes.Contains(body, []byte(`"`+field+`":null`)) {
			t.Errorf("body contains %q:null, want []; body=%s", field, body)
		}
	}
	// ItemBucket
	if !bytes.Contains(body, []byte(`"ShoppingListItemSyncEntityRequest":{"MaxLastModified":"0001-01-01T00:00:00Z","SyncEntities":[],"LocalChangesIds":[]}`)) {
		t.Errorf("ItemBucket did not normalize to empty arrays; body=%s", body)
	}
	// RawBucket
	if !bytes.Contains(body, []byte(`"ShoppingListSyncEntityRequest":{"MaxLastModified":"0001-01-01T00:00:00Z","SyncEntities":[],"LocalChangesIds":[]}`)) {
		t.Errorf("RawBucket did not normalize to empty arrays; body=%s", body)
	}
	// A nil bucket must still be skipped via JSON null — the mechanism that
	// keeps the huge Recipe bucket off the wire when unused.
	if !bytes.Contains(body, []byte(`"RecipeSyncEntityRequest":null`)) {
		t.Errorf("nil bucket must still serialize as null; body=%s", body)
	}
}
