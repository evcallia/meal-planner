package app

// Port of test_item_defaults_section.py: remembering a grocery item's last
// section in item_defaults.

import (
	"testing"

	"mealplanner/internal/models"
)

// ---- TestSectionDefaultOnAdd ----

func TestAddItemCreatesSectionDefault(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)

	resp := ta.POST("/api/grocery/items", map[string]any{
		"section_id": section.ID.String(), "name": "Avocado",
	})
	if resp.Status != 200 {
		t.Fatalf("add status = %d: %s", resp.Status, resp.Body)
	}

	row, ok := findItemDefault(ta, "avocado")
	if !ok {
		t.Fatal("item default for 'avocado' not created")
	}
	if row.SectionName == nil || *row.SectionName != "Produce" {
		t.Fatalf("section_name = %v, want Produce", row.SectionName)
	}

	// Visible via GET even though store_id is null.
	getResp := ta.GET("/api/grocery/item-defaults")
	if getResp.Status != 200 {
		t.Fatalf("get status = %d", getResp.Status)
	}
	defaults := map[string]map[string]any{}
	for _, d := range getResp.List() {
		obj := d.(map[string]any)
		defaults[obj["item_name"].(string)] = obj
	}
	avocado, ok := defaults["avocado"]
	if !ok {
		t.Fatalf("avocado missing from GET item-defaults: %v", getResp.JSON())
	}
	if avocado["section_name"] != "Produce" {
		t.Fatalf("section_name = %v, want Produce", avocado["section_name"])
	}
	if avocado["store_id"] != nil {
		t.Fatalf("store_id = %v, want nil", avocado["store_id"])
	}
}

func TestAddItemUpdatesExistingDefault(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Dairy", 0)
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "butter", SectionName: strp("Produce")}).Error; err != nil {
		t.Fatalf("seed default: %v", err)
	}

	resp := ta.POST("/api/grocery/items", map[string]any{
		"section_id": section.ID.String(), "name": "Butter",
	})
	if resp.Status != 200 {
		t.Fatalf("add status = %d: %s", resp.Status, resp.Body)
	}

	row, ok := findItemDefault(ta, "butter")
	if !ok {
		t.Fatal("item default for 'butter' missing")
	}
	if row.SectionName == nil || *row.SectionName != "Dairy" {
		t.Fatalf("section_name = %v, want Dairy", row.SectionName)
	}
}

func TestAddItemPreservesStoreDefault(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Kroger"}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "milk", StoreID: &store.ID}).Error; err != nil {
		t.Fatalf("seed default: %v", err)
	}
	section := seedGrocerySection(t, ta, "Dairy", 0)

	resp := ta.POST("/api/grocery/items", map[string]any{
		"section_id": section.ID.String(), "name": "Milk",
	})
	if resp.Status != 200 {
		t.Fatalf("add status = %d: %s", resp.Status, resp.Body)
	}

	row, ok := findItemDefault(ta, "milk")
	if !ok {
		t.Fatal("item default for 'milk' missing")
	}
	if row.SectionName == nil || *row.SectionName != "Dairy" {
		t.Fatalf("section_name = %v, want Dairy", row.SectionName)
	}
	if row.StoreID == nil || row.StoreID.String() != store.ID.String() {
		t.Fatalf("store_id = %v, want %s (store default clobbered)", row.StoreID, store.ID)
	}
}

// ---- TestSectionDefaultOnMove ----

func TestMoveUpdatesSectionDefault(t *testing.T) {
	ta := newTestApp(t)
	source := seedGrocerySection(t, ta, "Produce", 0)
	target := seedGrocerySection(t, ta, "Frozen", 1)
	item := models.GroceryItem{SectionID: source.ID, Name: "Peas", Position: 0}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String()+"/move", map[string]any{
		"to_section_id": target.ID.String(), "to_position": 0,
	})
	if resp.Status != 200 {
		t.Fatalf("move status = %d: %s", resp.Status, resp.Body)
	}

	row, ok := findItemDefault(ta, "peas")
	if !ok {
		t.Fatal("item default for 'peas' not created")
	}
	if row.SectionName == nil || *row.SectionName != "Frozen" {
		t.Fatalf("section_name = %v, want Frozen", row.SectionName)
	}
}

func TestMoveWithinSameSectionDoesNotWriteDefault(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Kale", Position: 0}
	other := models.GroceryItem{SectionID: section.ID, Name: "Chard", Position: 1}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	if err := ta.App.DB.Create(&other).Error; err != nil {
		t.Fatalf("seed other: %v", err)
	}

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String()+"/move", map[string]any{
		"to_section_id": section.ID.String(), "to_position": 1,
	})
	if resp.Status != 200 {
		t.Fatalf("move status = %d: %s", resp.Status, resp.Body)
	}

	if _, ok := findItemDefault(ta, "kale"); ok {
		t.Fatal("item default for 'kale' written on same-section reorder")
	}
}

// ---- TestSectionDefaultOnMerge ----

func TestMergeWritesSectionDefaults(t *testing.T) {
	ta := newTestApp(t)

	resp := ta.PUT("/api/grocery", map[string]any{
		"sections": []map[string]any{
			{
				"name": "Bakery",
				"items": []map[string]any{
					{"name": "Bagels"},
					{"name": "Sourdough"},
				},
			},
			{
				"name": "Deli",
				"items": []map[string]any{
					{"name": "Turkey"},
				},
			},
		},
	})
	if resp.Status != 200 {
		t.Fatalf("replace status = %d: %s", resp.Status, resp.Body)
	}

	want := map[string]string{"bagels": "Bakery", "sourdough": "Bakery", "turkey": "Deli"}
	for name, sectionName := range want {
		row, ok := findItemDefault(ta, name)
		if !ok {
			t.Fatalf("item default for %q not created", name)
		}
		if row.SectionName == nil || *row.SectionName != sectionName {
			t.Fatalf("%q section_name = %v, want %s", name, row.SectionName, sectionName)
		}
	}
}

// ---- TestItemDefaultsGetAndPut ----

func TestGetReturnsSectionOnlyDefaults(t *testing.T) {
	ta := newTestApp(t)
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "cereal", SectionName: strp("Breakfast")}).Error; err != nil {
		t.Fatalf("seed cereal: %v", err)
	}
	// Row with neither store nor section should be excluded.
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "mystery"}).Error; err != nil {
		t.Fatalf("seed mystery: %v", err)
	}

	resp := ta.GET("/api/grocery/item-defaults")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	names := map[string]bool{}
	for _, d := range resp.List() {
		names[d.(map[string]any)["item_name"].(string)] = true
	}
	if !names["cereal"] {
		t.Fatalf("cereal missing from item-defaults: %v", resp.JSON())
	}
	if names["mystery"] {
		t.Fatal("mystery (no store, no section) should be excluded")
	}
}

func TestPutSectionNamePreservesStoreID(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Costco"}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "eggs", StoreID: &store.ID}).Error; err != nil {
		t.Fatalf("seed default: %v", err)
	}

	resp := ta.PUT("/api/grocery/item-defaults/eggs", map[string]any{"section_name": "Dairy"})
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}

	row, ok := findItemDefault(ta, "eggs")
	if !ok {
		t.Fatal("item default for 'eggs' missing")
	}
	if row.SectionName == nil || *row.SectionName != "Dairy" {
		t.Fatalf("section_name = %v, want Dairy", row.SectionName)
	}
	if row.StoreID == nil || row.StoreID.String() != store.ID.String() {
		t.Fatalf("store_id = %v, want %s (clobbered)", row.StoreID, store.ID)
	}
}

func TestPutStoreIDPreservesSectionName(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Aldi"}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "rice", SectionName: strp("Pantry")}).Error; err != nil {
		t.Fatalf("seed default: %v", err)
	}

	resp := ta.PUT("/api/grocery/item-defaults/rice", map[string]any{"store_id": store.ID.String()})
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}

	row, ok := findItemDefault(ta, "rice")
	if !ok {
		t.Fatal("item default for 'rice' missing")
	}
	if row.SectionName == nil || *row.SectionName != "Pantry" {
		t.Fatalf("section_name = %v, want Pantry (clobbered)", row.SectionName)
	}
	if row.StoreID == nil || row.StoreID.String() != store.ID.String() {
		t.Fatalf("store_id = %v, want %s", row.StoreID, store.ID)
	}
}

func TestPutCreatesRowWithSectionName(t *testing.T) {
	ta := newTestApp(t)

	resp := ta.PUT("/api/grocery/item-defaults/Flour", map[string]any{"section_name": "Baking"})
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}

	row, ok := findItemDefault(ta, "flour")
	if !ok {
		t.Fatal("item default for 'flour' not created")
	}
	if row.SectionName == nil || *row.SectionName != "Baking" {
		t.Fatalf("section_name = %v, want Baking", row.SectionName)
	}
	if row.StoreID != nil {
		t.Fatalf("store_id = %v, want nil", row.StoreID)
	}
}

// ---- TestStoreDefaultRegression ----

func TestPatchStoreIDStillUpsertsStoreDefault(t *testing.T) {
	ta := newTestApp(t)

	storeResp := ta.POST("/api/stores", map[string]any{"name": "Wegmans"})
	if storeResp.Status != 200 {
		t.Fatalf("create store status = %d", storeResp.Status)
	}
	storeID := storeResp.Obj()["id"].(string)

	section := seedGrocerySection(t, ta, "Snacks", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Pretzels", Position: 0}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}

	patched := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"store_id": storeID})
	if patched.Status != 200 {
		t.Fatalf("patch status = %d: %s", patched.Status, patched.Body)
	}

	row, ok := findItemDefault(ta, "pretzels")
	if !ok {
		t.Fatal("item default for 'pretzels' not created")
	}
	if row.StoreID == nil || row.StoreID.String() != storeID {
		t.Fatalf("store_id = %v, want %s", row.StoreID, storeID)
	}
}
