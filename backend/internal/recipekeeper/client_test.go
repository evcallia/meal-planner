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
		{http.StatusOK, true},       // 200: something changed, go sync
		{http.StatusCreated, false}, // 201: poll expired, nothing happened
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
