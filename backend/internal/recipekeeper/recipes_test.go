// backend/internal/recipekeeper/recipes_test.go
package recipekeeper

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/models"
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

// TestInboundCreatesSectionFromRKCategoryWhenMissing proves an item whose RK
// category has no matching MP section gets that section CREATED (appended at
// the end) instead of falling through to Uncategorized — measured live, a
// real category on a real account ("Canned Goods & Soups" for ginger)
// routinely has no MP counterpart yet, and dumping every such import into
// Uncategorized just moves the same sorting problem into Meal Planner. Also
// proves a category that DOES match an existing section still uses it
// (no duplicate section), and that item_defaults still takes precedence
// over both.
func TestInboundCreatesSectionFromRKCategoryWhenMissing(t *testing.T) {
	db := testDB(t)
	r := testReconciler(t, db)

	// An existing section RK's category name will already match.
	db.Create(&models.GrocerySection{ID: models.NewID(), Name: "Produce", Position: 1})

	setCategory(t, db, "Cilantro", "Produce")
	setCategory(t, db, "Ginger", "Canned Goods & Soups")
	setCategory(t, db, "Milk", "Dairy")

	// item_defaults must still win over both RK's category and Uncategorized.
	fridge := "Fridge"
	db.Create(&models.GrocerySection{ID: models.NewID(), Name: fridge, Position: 2})
	db.Create(&models.ItemDefault{ItemName: "milk", SectionName: &fridge})

	items := []ShoppingListItem{
		rkItem("srv-1", "Cilantro"),
		rkItem("srv-2", "Ginger"),
		rkItem("srv-3", "Milk"),
	}
	if _, err := r.ApplyInbound(items); err != nil {
		t.Fatalf("ApplyInbound: %v", err)
	}

	// Cilantro: category matched an EXISTING section — must land there, no
	// new section created for it.
	cilantro := itemByName(t, db, "Cilantro", false)
	if cilantro == nil {
		t.Fatal("Cilantro was not imported")
	}
	assertSectionName(t, db, cilantro.SectionID, "Produce")

	// Ginger: category has NO matching section — one must be CREATED and
	// used, not Uncategorized.
	ginger := itemByName(t, db, "Ginger", false)
	if ginger == nil {
		t.Fatal("Ginger was not imported")
	}
	assertSectionName(t, db, ginger.SectionID, "Canned Goods & Soups")

	var created models.GrocerySection
	if err := db.First(&created, "LOWER(name) = LOWER(?)", "Canned Goods & Soups").Error; err != nil {
		t.Fatalf("expected a new section named %q to have been created: %v", "Canned Goods & Soups", err)
	}
	var maxOther struct{ P int }
	db.Model(&models.GrocerySection{}).
		Where("id <> ?", created.ID).
		Select("COALESCE(MAX(position), -1) AS p").Scan(&maxOther)
	if created.Position <= maxOther.P {
		t.Errorf("new section position = %d, want appended after every existing section (> %d)", created.Position, maxOther.P)
	}

	// Milk: item_defaults still wins over RK's category ("Dairy") — no
	// "Dairy" section should have been created at all.
	milk := itemByName(t, db, "Milk", false)
	if milk == nil {
		t.Fatal("Milk was not imported")
	}
	assertSectionName(t, db, milk.SectionID, fridge)
	if err := db.First(&models.GrocerySection{}, "LOWER(name) = LOWER(?)", "Dairy").Error; err == nil {
		t.Error("a Dairy section should not exist — item_defaults must take precedence over RK's category before it is ever created")
	}
}

func setCategory(t *testing.T, db *gorm.DB, itemName, categoryName string) {
	t.Helper()
	row := models.RecipeKeeperState{Key: "category:" + normalizeName(itemName), Value: categoryName}
	if err := db.Save(&row).Error; err != nil {
		t.Fatalf("setCategory: %v", err)
	}
}

func assertSectionName(t *testing.T, db *gorm.DB, id uuid.UUID, want string) {
	t.Helper()
	var sec models.GrocerySection
	if err := db.First(&sec, "id = ?", id).Error; err != nil {
		t.Fatalf("section lookup: %v", err)
	}
	if sec.Name != want {
		t.Errorf("section = %q, want %q", sec.Name, want)
	}
}

// Recipe attribution for a collapsed item (several links, several titles) is
// covered on the shipped serialization path — recipeRefsForKey/recipeRefsByKey
// in package app — by TestGroceryItemWithMultipleRecipeLinks and
// TestRecipeOrderMatchesBetweenBulkAndSingleRowPaths. Reconciler.RecipeTitles
// used to duplicate that same query independently, with zero production
// callers; it was deleted rather than kept in sync by hand.
