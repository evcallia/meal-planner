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
