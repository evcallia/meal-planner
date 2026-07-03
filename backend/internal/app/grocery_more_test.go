package app

// Coverage additions for grocery handlers: the list endpoint (checked-last
// sort order), section/item reorder endpoints, and update/move edge cases.

import (
	"testing"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

func seedGroceryItem(t *testing.T, ta *testApp, sectionID uuid.UUID, name string, position int, checked bool) *models.GroceryItem {
	t.Helper()
	item := models.GroceryItem{SectionID: sectionID, Name: name, Position: position, Checked: checked}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item %s: %v", name, err)
	}
	return &item
}

func TestListGrocerySortsCheckedLast(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	seedGroceryItem(t, ta, section.ID, "Checked Early", 0, true)
	seedGroceryItem(t, ta, section.ID, "Unchecked B", 2, false)
	seedGroceryItem(t, ta, section.ID, "Unchecked A", 1, false)

	resp := ta.GET("/api/grocery")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	sections := resp.List()
	if len(sections) != 1 {
		t.Fatalf("sections = %d, want 1", len(sections))
	}
	items := sections[0].(map[string]any)["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3", len(items))
	}
	// Unchecked first by position, checked last.
	names := []string{}
	for _, it := range items {
		names = append(names, it.(map[string]any)["name"].(string))
	}
	if names[0] != "Unchecked A" || names[1] != "Unchecked B" || names[2] != "Checked Early" {
		t.Fatalf("order = %v", names)
	}
}

func TestReorderGrocerySections(t *testing.T) {
	ta := newTestApp(t)
	s1 := seedGrocerySection(t, ta, "Produce", 0)
	s2 := seedGrocerySection(t, ta, "Dairy", 1)
	s3 := seedGrocerySection(t, ta, "Bakery", 2)
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/grocery/reorder-sections", map[string]any{
		"section_ids": []string{s3.ID.String(), s1.ID.String(), s2.ID.String()},
	})
	if resp.Status != 200 || resp.Obj()["status"] != "ok" {
		t.Fatalf("status = %d body = %s", resp.Status, resp.Body)
	}

	list := ta.GET("/api/grocery").List()
	order := []string{}
	for _, s := range list {
		order = append(order, s.(map[string]any)["name"].(string))
	}
	if order[0] != "Bakery" || order[1] != "Produce" || order[2] != "Dairy" {
		t.Fatalf("order = %v", order)
	}

	payload := col2payload(t, col.Events(), "grocery.updated")
	if payload["action"] != "section-reordered" {
		t.Fatalf("action = %v, want section-reordered", payload["action"])
	}
	if sections := payload["sections"].([]any); len(sections) != 3 {
		t.Fatalf("broadcast sections = %d, want 3", len(sections))
	}
}

func TestReorderGrocerySectionsInvalidUUID(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/grocery/reorder-sections", map[string]any{
		"section_ids": []string{"not-a-uuid"},
	})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422", resp.Status)
	}
}

func TestReorderGroceryItems(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	i1 := seedGroceryItem(t, ta, section.ID, "Apples", 0, false)
	i2 := seedGroceryItem(t, ta, section.ID, "Bananas", 1, false)
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/grocery/sections/"+section.ID.String()+"/reorder-items", map[string]any{
		"item_ids": []string{i2.ID.String(), i1.ID.String()},
	})
	if resp.Status != 200 || resp.Obj()["status"] != "ok" {
		t.Fatalf("status = %d body = %s", resp.Status, resp.Body)
	}

	items := ta.GET("/api/grocery").List()[0].(map[string]any)["items"].([]any)
	if items[0].(map[string]any)["name"] != "Bananas" || items[1].(map[string]any)["name"] != "Apples" {
		t.Fatalf("order = %v", items)
	}

	payload := col2payload(t, col.Events(), "grocery.updated")
	if payload["action"] != "items-reordered" || payload["sectionId"] != section.ID.String() {
		t.Fatalf("payload = %v", payload)
	}
}

func TestReorderGroceryItemsSectionNotFound(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/grocery/sections/"+uuid.NewString()+"/reorder-items", map[string]any{
		"item_ids": []string{},
	})
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404", resp.Status)
	}
}

func TestUpdateGroceryItemNotFound(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/grocery/items/"+uuid.NewString(), map[string]any{"checked": true})
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404", resp.Status)
	}
}

func TestUpdateGroceryItemEmptyNameRejected(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := seedGroceryItem(t, ta, section.ID, "Apples", 0, false)
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"name": "   "})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422", resp.Status)
	}
}

func TestUpdateGroceryItemInvalidStoreUUID(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := seedGroceryItem(t, ta, section.ID, "Apples", 0, false)
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"store_id": "nope"})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422", resp.Status)
	}
}

func TestUpdateGroceryItemClearQuantity(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Apples", Quantity: strp("3"), Position: 0}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Explicit null clears the quantity.
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": nil})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["quantity"] != nil {
		t.Fatalf("quantity = %v, want null", resp.Obj()["quantity"])
	}
	// Empty string clears too.
	resp = ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": ""})
	if resp.Status != 200 || resp.Obj()["quantity"] != nil {
		t.Fatalf("empty-string clear: status = %d quantity = %v", resp.Status, resp.Obj()["quantity"])
	}
	// Omitting quantity leaves it untouched.
	resp = ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"quantity": "5"})
	if resp.Obj()["quantity"] != "5" {
		t.Fatalf("quantity = %v, want 5", resp.Obj()["quantity"])
	}
	resp = ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"checked": true})
	if resp.Obj()["quantity"] != "5" {
		t.Fatalf("quantity after unrelated patch = %v, want 5", resp.Obj()["quantity"])
	}
}

func TestUpdateGroceryItemRenameAdoptsStoreDefault(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Costco", Position: 0}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "milk", StoreID: &store.ID}).Error; err != nil {
		t.Fatalf("seed default: %v", err)
	}
	section := seedGrocerySection(t, ta, "Dairy", 0)
	item := seedGroceryItem(t, ta, section.ID, "Mlk", 0, false)

	// Renaming a storeless item to a remembered name adopts that store.
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"name": "Milk"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["store_id"] != store.ID.String() {
		t.Fatalf("store_id = %v, want remembered default %s", resp.Obj()["store_id"], store.ID)
	}
}

func TestUpdateGroceryItemClearStoreClearsDefaultRow(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Costco", Position: 0}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	section := seedGrocerySection(t, ta, "Dairy", 0)
	item := seedGroceryItem(t, ta, section.ID, "Milk", 0, false)

	// Assign then clear.
	resp := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"store_id": store.ID.String()})
	if resp.Status != 200 || resp.Obj()["store_id"] != store.ID.String() {
		t.Fatalf("assign: status = %d store = %v", resp.Status, resp.Obj()["store_id"])
	}
	resp = ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"store_id": nil})
	if resp.Status != 200 || resp.Obj()["store_id"] != nil {
		t.Fatalf("clear: status = %d store = %v", resp.Status, resp.Obj()["store_id"])
	}
	var def models.ItemDefault
	if err := ta.App.DB.Where("item_name = ?", "milk").First(&def).Error; err != nil {
		t.Fatalf("default row: %v", err)
	}
	if def.StoreID != nil {
		t.Fatalf("default store_id = %v, want cleared", def.StoreID)
	}
}

func TestMoveGroceryItemNotFoundCases(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := seedGroceryItem(t, ta, section.ID, "Apples", 0, false)

	resp := ta.PATCH("/api/grocery/items/"+uuid.NewString()+"/move", map[string]any{
		"to_section_id": section.ID.String(), "to_position": 0,
	})
	if resp.Status != 404 || resp.Obj()["detail"] != "Item not found" {
		t.Fatalf("missing item: status = %d body = %s", resp.Status, resp.Body)
	}
	resp = ta.PATCH("/api/grocery/items/"+item.ID.String()+"/move", map[string]any{
		"to_section_id": uuid.NewString(), "to_position": 0,
	})
	if resp.Status != 404 || resp.Obj()["detail"] != "Target section not found" {
		t.Fatalf("missing target: status = %d body = %s", resp.Status, resp.Body)
	}
}

func TestMoveGroceryItemReindexesBothSections(t *testing.T) {
	ta := newTestApp(t)
	s1 := seedGrocerySection(t, ta, "Produce", 0)
	s2 := seedGrocerySection(t, ta, "Dairy", 1)
	a := seedGroceryItem(t, ta, s1.ID, "A", 0, false)
	seedGroceryItem(t, ta, s1.ID, "B", 1, false)
	seedGroceryItem(t, ta, s2.ID, "X", 0, false)

	// Move A to the middle of Dairy.
	resp := ta.PATCH("/api/grocery/items/"+a.ID.String()+"/move", map[string]any{
		"to_section_id": s2.ID.String(), "to_position": 0,
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	// Source section reindexed from 0.
	var b models.GroceryItem
	ta.App.DB.Where("section_id = ? AND name = ?", s1.ID, "B").First(&b)
	if b.Position != 0 {
		t.Fatalf("B position = %d, want 0 after reindex", b.Position)
	}
	// Cross-section move remembers the new section for the item name.
	var def models.ItemDefault
	if err := ta.App.DB.Where("item_name = ?", "a").First(&def).Error; err != nil {
		t.Fatalf("section default: %v", err)
	}
	if def.SectionName == nil || *def.SectionName != "Dairy" {
		t.Fatalf("section default = %v, want Dairy", def.SectionName)
	}
}

func TestClearGroceryItemsInvalidMode(t *testing.T) {
	ta := newTestApp(t)
	for _, q := range []string{"", "?mode=bogus"} {
		resp := ta.DELETE("/api/grocery/items" + q)
		if resp.Status != 422 {
			t.Fatalf("mode %q: status = %d, want 422", q, resp.Status)
		}
	}
}

func TestReplaceGroceryInvalidStoreUUIDRejected(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/grocery", map[string]any{
		"sections": []map[string]any{{
			"name":  "Produce",
			"items": []map[string]any{{"name": "Apples", "store_id": "not-a-uuid"}},
		}},
	})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422", resp.Status)
	}
}

func TestReplaceGroceryAppliesRememberedStoreDefaults(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Costco", Position: 0}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "milk", StoreID: &store.ID}).Error; err != nil {
		t.Fatalf("seed default: %v", err)
	}
	resp := ta.PUT("/api/grocery", map[string]any{
		"sections": []map[string]any{{
			"name":  "Dairy",
			"items": []map[string]any{{"name": "Milk"}},
		}},
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	item := resp.List()[0].(map[string]any)["items"].([]any)[0].(map[string]any)
	if item["store_id"] != store.ID.String() {
		t.Fatalf("store_id = %v, want remembered default", item["store_id"])
	}
}
