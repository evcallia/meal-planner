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
func checked(i *ShoppingListItem) { i.IsChecked = true }
func deleted(i *ShoppingListItem) { i.IsDeleted = true }

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
