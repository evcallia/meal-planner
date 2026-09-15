package app

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"mealplanner/internal/models"
	"mealplanner/internal/recipekeeper"
)

func TestGroceryItemCarriesRecipes(t *testing.T) {
	ta := newTestApp(t)
	sec := seedGrocerySection(t, ta, "Produce", 0)
	seedGroceryItem(t, ta, sec.ID, "Lemon", 0, false)
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail")

	resp := ta.GET("/api/grocery")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}

	found := false
	for _, s := range resp.List() {
		items, _ := s.(map[string]any)["items"].([]any)
		for _, raw := range items {
			it := raw.(map[string]any)
			if it["name"] != "Lemon" {
				continue
			}
			found = true
			recipes, ok := it["recipes"].([]any)
			if !ok || len(recipes) != 1 {
				t.Fatalf("recipes = %+v", it["recipes"])
			}
			ref := recipes[0].(map[string]any)
			if ref["id"] != "rec-1" || ref["title"] != "Fig Cocktail" {
				t.Errorf("recipe ref = %+v", ref)
			}
		}
	}
	if !found {
		t.Fatal("Lemon not in response")
	}
}

// Items with no Recipe Keeper links must serialize an empty array, never
// null — the frontend maps over this field unconditionally.
func TestGroceryItemWithoutLinksHasEmptyRecipes(t *testing.T) {
	ta := newTestApp(t)
	sec := seedGrocerySection(t, ta, "Produce", 0)
	seedGroceryItem(t, ta, sec.ID, "Salt", 0, false)

	resp := ta.GET("/api/grocery")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if !strings.Contains(string(resp.Body), `"recipes":[]`) {
		t.Errorf("want empty recipes array, body = %s", resp.Body)
	}
}

// A grocery row linked to more than one recipe (Recipe Keeper stores one row
// per recipe-ingredient occurrence) must surface every distinct recipe.
func TestGroceryItemWithMultipleRecipeLinks(t *testing.T) {
	ta := newTestApp(t)
	sec := seedGrocerySection(t, ta, "Produce", 0)
	seedGroceryItem(t, ta, sec.ID, "Lemon", 0, false)
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail")
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-2", "rec-2", "Lemon Bars")

	resp := ta.GET("/api/grocery")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	var recipes []any
	for _, s := range resp.List() {
		items, _ := s.(map[string]any)["items"].([]any)
		for _, raw := range items {
			it := raw.(map[string]any)
			if it["name"] == "Lemon" {
				recipes, _ = it["recipes"].([]any)
			}
		}
	}
	if len(recipes) != 2 {
		t.Fatalf("recipes = %+v, want 2", recipes)
	}
}

// The bulk (list) and targeted (single-row) recipe-attribution paths must
// return recipes in the same order for the same grocery row. Both order by
// rk_position asc — seeded here out of insertion/alphabetical order so an
// accidental fall-back to insertion order or a map-iteration order would be
// caught.
func TestRecipeOrderMatchesBetweenBulkAndSingleRowPaths(t *testing.T) {
	ta := newTestApp(t)
	sec := seedGrocerySection(t, ta, "Produce", 0)
	item := seedGroceryItem(t, ta, sec.ID, "Lemon", 0, false)
	seedRecipeKeeperLinkAt(t, ta, "Lemon", false, "rk-2", "rec-2", "Lemon Bars", 5)
	seedRecipeKeeperLinkAt(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail", 1)
	seedRecipeKeeperLinkAt(t, ta, "Lemon", false, "rk-3", "rec-3", "Lemonade", 3)

	listResp := ta.GET("/api/grocery")
	if listResp.Status != 200 {
		t.Fatalf("list status = %d: %s", listResp.Status, listResp.Body)
	}
	var listOrder []string
	for _, s := range listResp.List() {
		items, _ := s.(map[string]any)["items"].([]any)
		for _, raw := range items {
			it := raw.(map[string]any)
			if it["name"] != "Lemon" {
				continue
			}
			for _, r := range it["recipes"].([]any) {
				listOrder = append(listOrder, r.(map[string]any)["id"].(string))
			}
		}
	}

	// The update endpoint returns the item through the targeted single-row
	// path (a.groceryItemJSON -> recipeRefsForKey), not the bulk map.
	singleResp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": "2"})
	if singleResp.Status != 200 {
		t.Fatalf("update status = %d: %s", singleResp.Status, singleResp.Body)
	}
	var singleOrder []string
	for _, r := range singleResp.Obj()["recipes"].([]any) {
		singleOrder = append(singleOrder, r.(map[string]any)["id"].(string))
	}

	want := []string{"rec-1", "rec-3", "rec-2"} // rk_position asc: 1, 3, 5
	if len(listOrder) != len(want) {
		t.Fatalf("listOrder = %v, want %v", listOrder, want)
	}
	if len(singleOrder) != len(want) {
		t.Fatalf("singleOrder = %v, want %v", singleOrder, want)
	}
	for i := range want {
		if listOrder[i] != want[i] {
			t.Errorf("list order[%d] = %s, want %s (full: %v)", i, listOrder[i], want[i], listOrder)
		}
		if singleOrder[i] != want[i] {
			t.Errorf("single order[%d] = %s, want %s (full: %v)", i, singleOrder[i], want[i], singleOrder)
		}
	}
}

func TestStatusEndpointReportsDisabled(t *testing.T) {
	ta := newTestApp(t)
	// newTestApp never configures RecipeKeeper — App.RecipeKeeper is nil,
	// same as a deployment with no RECIPE_KEEPER_* env vars set.

	resp := ta.GET("/api/recipe-keeper/status")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	obj := resp.Obj()
	if obj["enabled"] != false {
		t.Errorf("enabled = %v, want false", obj["enabled"])
	}
}

func TestSyncEndpointRejectsWhenNotConfigured(t *testing.T) {
	ta := newTestApp(t)

	resp := ta.POST("/api/recipe-keeper/sync", nil)
	if resp.Status != 400 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
}

func TestRecipeKeeperRoutesRequireAuth(t *testing.T) {
	ta := newTestApp(t)

	if resp := ta.Anon("GET", "/api/recipe-keeper/status", nil); resp.Status != 401 {
		t.Errorf("status route unauth status = %d, want 401", resp.Status)
	}
	if resp := ta.Anon("POST", "/api/recipe-keeper/sync", nil); resp.Status != 401 {
		t.Errorf("sync route unauth status = %d, want 401", resp.Status)
	}
	if resp := ta.Anon("GET", "/api/recipe-keeper/lists", nil); resp.Status != 401 {
		t.Errorf("lists route unauth status = %d, want 401", resp.Status)
	}
	if resp := ta.Anon("PUT", "/api/recipe-keeper/list", map[string]any{"list_id": "x"}); resp.Status != 401 {
		t.Errorf("list route unauth status = %d, want 401", resp.Status)
	}
}

func TestListsEndpointRejectsWhenNotConfigured(t *testing.T) {
	ta := newTestApp(t)

	resp := ta.GET("/api/recipe-keeper/lists")
	if resp.Status != 400 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
}

func TestSelectListEndpointRejectsWhenNotConfigured(t *testing.T) {
	ta := newTestApp(t)

	resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "x"})
	if resp.Status != 400 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
}

// rkTestJWT builds a well-formed-but-unsigned JWT with a future exp, for the
// fake Recipe Keeper servers below. Duplicated from recipekeeper's own
// (unexported, package-private) auth_test.go helper.
func rkTestJWT(exp time.Time) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	header := enc(map[string]string{"alg": "HS512", "typ": "JWT"})
	payload := enc(map[string]any{"exp": exp.Unix()})
	return header + "." + payload + ".sig"
}

// enableRecipeKeeperWithLists wires ta.App.RecipeKeeper to a fake Recipe
// Keeper server whose ShoppingList bucket answers with entities — for
// exercising GET /api/recipe-keeper/lists and PUT /api/recipe-keeper/list
// end to end, as opposed to enableRecipeKeeper's always-401 server (which
// exists only to keep background sync goroutines harmless in grocery-hook
// tests that never touch list discovery).
func enableRecipeKeeperWithLists(t *testing.T, ta *testApp, entities []map[string]any) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Write([]byte(`{"access_token":"` + rkTestJWT(time.Now().Add(48*time.Hour)) + `"}`))
			return
		}
		raw := make([]json.RawMessage, len(entities))
		for i, e := range entities {
			b, _ := json.Marshal(e)
			raw[i] = b
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ShoppingListSyncEntityResponse": map[string]any{
				"UpdatedServerItems": raw,
				"MaxLastModified":    "2026-09-14T00:00:00.0000001Z",
			},
		})
	}))
	t.Cleanup(srv.Close)
	authr := &recipekeeper.Authenticator{BaseURL: srv.URL, Username: "test", Password: "test", HTTP: &http.Client{}}
	ta.App.RecipeKeeper = &recipekeeper.Service{
		DB:     ta.App.DB,
		Rec:    &recipekeeper.Reconciler{DB: ta.App.DB},
		Client: recipekeeper.NewClient(srv.URL, authr, recipekeeper.Headers{}),
	}
}

// GET /lists is the whole discovery path and must work with credentials
// alone — no list selected yet, exactly the state a first-time user is in.
func TestListsEndpointWorksWithNoListSelected(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeperWithLists(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
		{"Id": "list-b", "Name": "Camping", "IsDeleted": false},
		{"Id": "list-c", "Name": "Deleted List", "IsDeleted": true},
	})
	if got := recipekeeper.SelectedListID(ta.App.DB); got != "" {
		t.Fatalf("SelectedListID = %q, want empty", got)
	}

	resp := ta.GET("/api/recipe-keeper/lists")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	items := resp.List()
	if len(items) != 2 {
		t.Fatalf("lists = %+v, want 2 (deleted excluded)", items)
	}
	// Sorted by name: Camping, Groceries.
	first := items[0].(map[string]any)
	if first["id"] != "list-b" || first["name"] != "Camping" {
		t.Errorf("first = %+v, want list-b/Camping", first)
	}
}

// An unknown id in PUT /api/recipe-keeper/list is almost always a typo —
// reject it with a 4xx naming the valid options rather than silently
// persisting a selection that will never match anything the vendor sends.
func TestSelectListEndpointRejectsUnknownID(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeperWithLists(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	})

	resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "does-not-exist"})
	if resp.Status < 400 || resp.Status >= 500 {
		t.Fatalf("status = %d, want a 4xx: %s", resp.Status, resp.Body)
	}
	if !strings.Contains(string(resp.Body), "Groceries") {
		t.Errorf("body = %s, want it to name the valid option(s)", resp.Body)
	}
	if got := recipekeeper.SelectedListID(ta.App.DB); got != "" {
		t.Errorf("SelectedListID = %q, want unchanged (empty) after a rejected selection", got)
	}
}

// A valid selection persists to recipe_keeper_state and is reflected back
// through Status.
func TestSelectListEndpointPersistsSelection(t *testing.T) {
	ta := newTestApp(t)
	enableRecipeKeeperWithLists(t, ta, []map[string]any{
		{"Id": "list-a", "Name": "Groceries", "IsDeleted": false},
	})

	resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "list-a"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	obj := resp.Obj()
	if obj["selected_list_id"] != "list-a" || obj["selected_list_name"] != "Groceries" {
		t.Errorf("status = %+v, want selected_list_id/name = list-a/Groceries", obj)
	}
	if got := recipekeeper.SelectedListID(ta.App.DB); got != "list-a" {
		t.Errorf("SelectedListID = %q, want list-a", got)
	}
}

// A genuine change of selection must reset links/tombstones/watermark but
// leave the grocery row itself in place — proven here through the real HTTP
// endpoint, not just the package-level unit test.
func TestSelectListEndpointChangeResetsLinksButKeepsGroceryItem(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := seedGroceryItem(t, ta, section.ID, "Lemon", 0, false)
	seedRecipeKeeperLink(t, ta, "Lemon", false, "rk-1", "rec-1", "Fig Cocktail")

	enableRecipeKeeperWithLists(t, ta, []map[string]any{
		{"Id": "list-old", "Name": "Old List", "IsDeleted": false},
		{"Id": "list-new", "Name": "New List", "IsDeleted": false},
	})
	if resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "list-old"}); resp.Status != 200 {
		t.Fatalf("first selection status = %d: %s", resp.Status, resp.Body)
	}

	resp := ta.PUT("/api/recipe-keeper/list", map[string]any{"list_id": "list-new"})
	if resp.Status != 200 {
		t.Fatalf("second selection status = %d: %s", resp.Status, resp.Body)
	}

	var linkCount int64
	ta.App.DB.Model(&models.RecipeKeeperLink{}).Count(&linkCount)
	if linkCount != 0 {
		t.Errorf("link count = %d, want 0 after a genuine list change", linkCount)
	}
	var reloaded models.GroceryItem
	if err := ta.App.DB.First(&reloaded, "id = ?", item.ID).Error; err != nil {
		t.Fatalf("grocery item was deleted on a list change: %v", err)
	}
}
