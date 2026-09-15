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

// Recipe attribution for a collapsed item (several links, several titles) is
// covered on the shipped serialization path — recipeRefsForKey/recipeRefsByKey
// in package app — by TestGroceryItemWithMultipleRecipeLinks and
// TestRecipeOrderMatchesBetweenBulkAndSingleRowPaths. Reconciler.RecipeTitles
// used to duplicate that same query independently, with zero production
// callers; it was deleted rather than kept in sync by hand.
