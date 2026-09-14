package app

import (
	"strings"
	"testing"
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
}
