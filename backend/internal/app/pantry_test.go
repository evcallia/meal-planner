package app

// Port of test_api.py TestPantryAPI + TestPantrySSEPayloads.

import (
	"testing"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

func TestListPantryEmpty(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/pantry")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200", resp.Status)
	}
	if len(resp.List()) != 0 {
		t.Fatalf("expected empty list, got %v", resp.JSON())
	}
}

func TestCreateUpdateDeletePantryItem(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "General", Position: 0}
	ta.App.DB.Create(&section)
	sectionID := section.ID.String()
	col := ta.Collect(TestSub)

	created := ta.POST("/api/pantry/items", map[string]any{
		"section_id": sectionID, "name": "Meatballs", "quantity": 2,
	})
	if created.Status != 200 {
		t.Fatalf("create status = %d: %s", created.Status, created.Body)
	}
	obj := created.Obj()
	if obj["name"] != "Meatballs" {
		t.Fatalf("name = %v", obj["name"])
	}
	if obj["quantity"] != float64(2) {
		t.Fatalf("quantity = %v", obj["quantity"])
	}
	if obj["section_id"] != sectionID {
		t.Fatalf("section_id = %v, want %s", obj["section_id"], sectionID)
	}

	itemID := obj["id"].(string)
	updated := ta.PUT("/api/pantry/items/"+itemID, map[string]any{"quantity": 3})
	if updated.Status != 200 {
		t.Fatalf("update status = %d: %s", updated.Status, updated.Body)
	}
	if updated.Obj()["quantity"] != float64(3) {
		t.Fatalf("quantity = %v", updated.Obj()["quantity"])
	}

	deleted := ta.DELETE("/api/pantry/items/" + itemID)
	if deleted.Status != 200 {
		t.Fatalf("delete status = %d: %s", deleted.Status, deleted.Body)
	}
	if events := col.Events(); len(events) < 3 {
		t.Fatalf("expected >= 3 broadcasts, got %d", len(events))
	}

	var count int64
	ta.App.DB.Model(&models.PantryItem{}).Where("id = ?", uuid.MustParse(itemID)).Count(&count)
	if count != 0 {
		t.Fatal("item still present after delete")
	}
}

func TestCreatePantryItemEmptyName(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "General", Position: 0}
	ta.App.DB.Create(&section)

	resp := ta.POST("/api/pantry/items", map[string]any{
		"section_id": section.ID.String(), "name": "  ", "quantity": 1,
	})
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Name is required" {
		t.Fatalf("detail = %q", detail)
	}
}

func TestUpdatePantryItemNotFound(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/pantry/items/00000000-0000-0000-0000-000000000001",
		map[string]any{"quantity": 5})
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Item not found" {
		t.Fatalf("detail = %q", detail)
	}
}

func TestUpdatePantryItemEmptyName(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "General", Position: 0}
	ta.App.DB.Create(&section)

	created := ta.POST("/api/pantry/items", map[string]any{
		"section_id": section.ID.String(), "name": "Test Item", "quantity": 1,
	})
	itemID := created.Obj()["id"].(string)

	resp := ta.PUT("/api/pantry/items/"+itemID, map[string]any{"name": "  "})
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Name is required" {
		t.Fatalf("detail = %q", detail)
	}
}

func TestUpdatePantryItemWithName(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "General", Position: 0}
	ta.App.DB.Create(&section)

	created := ta.POST("/api/pantry/items", map[string]any{
		"section_id": section.ID.String(), "name": "Old Name", "quantity": 1,
	})
	itemID := created.Obj()["id"].(string)

	resp := ta.PUT("/api/pantry/items/"+itemID, map[string]any{"name": "New Name"})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["name"] != "New Name" {
		t.Fatalf("name = %v", resp.Obj()["name"])
	}
}

func TestDeletePantryItemNotFound(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.DELETE("/api/pantry/items/00000000-0000-0000-0000-000000000001")
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Item not found" {
		t.Fatalf("detail = %q", detail)
	}
}

func TestReplacePantry(t *testing.T) {
	ta := newTestApp(t)
	old := models.PantrySection{Name: "Old", Position: 0}
	ta.App.DB.Create(&old)
	col := ta.Collect(TestSub)

	resp := ta.PUT("/api/pantry", map[string]any{
		"sections": []map[string]any{
			{"name": "Fridge", "items": []map[string]any{
				{"name": "Milk", "quantity": 1}, {"name": "Eggs", "quantity": 12},
			}},
			{"name": "Freezer", "items": []map[string]any{
				{"name": "Ice cream", "quantity": 2},
			}},
		},
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	data := resp.List()
	if len(data) != 2 {
		t.Fatalf("len(sections) = %d, want 2", len(data))
	}
	s0 := data[0].(map[string]any)
	s1 := data[1].(map[string]any)
	if s0["name"] != "Fridge" {
		t.Fatalf("sections[0].name = %v", s0["name"])
	}
	if items, _ := s0["items"].([]any); len(items) != 2 {
		t.Fatalf("sections[0].items = %v", s0["items"])
	}
	if s1["name"] != "Freezer" {
		t.Fatalf("sections[1].name = %v", s1["name"])
	}
	if items, _ := s1["items"].([]any); len(items) != 1 {
		t.Fatalf("sections[1].items = %v", s1["items"])
	}
	if payload := col.LastPayload("pantry.updated"); payload == nil {
		t.Fatal("expected pantry.updated broadcast")
	}

	var count int64
	ta.App.DB.Model(&models.PantrySection{}).Where("name = ?", "Old").Count(&count)
	if count != 0 {
		t.Fatal("old section still present after replace")
	}
}

func TestRenamePantrySection(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "General", Position: 0}
	ta.App.DB.Create(&section)
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/pantry/sections/"+section.ID.String(),
		map[string]any{"name": "Fridge"})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["name"] != "Fridge" {
		t.Fatalf("name = %v", resp.Obj()["name"])
	}
	if payload := col.LastPayload("pantry.updated"); payload == nil {
		t.Fatal("expected pantry.updated broadcast")
	}
}

func TestRenamePantrySectionNotFound(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/pantry/sections/00000000-0000-0000-0000-000000000001",
		map[string]any{"name": "Nope"})
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404: %s", resp.Status, resp.Body)
	}
}

func TestReorderPantrySections(t *testing.T) {
	ta := newTestApp(t)
	s1 := models.PantrySection{Name: "A", Position: 0}
	s2 := models.PantrySection{Name: "B", Position: 1}
	ta.App.DB.Create(&s1)
	ta.App.DB.Create(&s2)
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/pantry/reorder-sections", map[string]any{
		"section_ids": []string{s2.ID.String(), s1.ID.String()},
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if payload := col.LastPayload("pantry.updated"); payload == nil {
		t.Fatal("expected pantry.updated broadcast")
	}

	var r1, r2 models.PantrySection
	ta.App.DB.First(&r1, "id = ?", s1.ID)
	ta.App.DB.First(&r2, "id = ?", s2.ID)
	if r2.Position != 0 {
		t.Fatalf("s2.position = %d, want 0", r2.Position)
	}
	if r1.Position != 1 {
		t.Fatalf("s1.position = %d, want 1", r1.Position)
	}
}

func TestReorderPantryItems(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "General", Position: 0}
	ta.App.DB.Create(&section)
	i1 := models.PantryItem{SectionID: section.ID, Name: "A", Quantity: 1, Position: 0}
	i2 := models.PantryItem{SectionID: section.ID, Name: "B", Quantity: 1, Position: 1}
	ta.App.DB.Create(&i1)
	ta.App.DB.Create(&i2)
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/pantry/sections/"+section.ID.String()+"/reorder-items",
		map[string]any{"item_ids": []string{i2.ID.String(), i1.ID.String()}})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if payload := col.LastPayload("pantry.updated"); payload == nil {
		t.Fatal("expected pantry.updated broadcast")
	}

	var r1, r2 models.PantryItem
	ta.App.DB.First(&r1, "id = ?", i1.ID)
	ta.App.DB.First(&r2, "id = ?", i2.ID)
	if r2.Position != 0 {
		t.Fatalf("i2.position = %d, want 0", r2.Position)
	}
	if r1.Position != 1 {
		t.Fatalf("i1.position = %d, want 1", r1.Position)
	}
}

func TestReorderPantryItemsSectionNotFound(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/pantry/sections/00000000-0000-0000-0000-000000000001/reorder-items",
		map[string]any{"item_ids": []string{}})
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404: %s", resp.Status, resp.Body)
	}
}

func TestCreatePantryItemSectionNotFound(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.POST("/api/pantry/items", map[string]any{
		"section_id": "00000000-0000-0000-0000-000000000001",
		"name":       "Test",
		"quantity":   1,
	})
	if resp.Status != 404 {
		t.Fatalf("status = %d, want 404: %s", resp.Status, resp.Body)
	}
}

func TestClearPantry(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "General", Position: 0}
	ta.App.DB.Create(&section)
	item := models.PantryItem{SectionID: section.ID, Name: "Milk", Quantity: 1, Position: 0}
	ta.App.DB.Create(&item)
	col := ta.Collect(TestSub)

	resp := ta.DELETE("/api/pantry/items?mode=all")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if len(resp.List()) != 0 {
		t.Fatalf("expected empty list, got %v", resp.JSON())
	}
	if payload := col.LastPayload("pantry.updated"); payload == nil {
		t.Fatal("expected pantry.updated broadcast")
	}

	var count int64
	ta.App.DB.Model(&models.PantrySection{}).Count(&count)
	if count != 0 {
		t.Fatalf("section count = %d, want 0", count)
	}
}

// ---- SSE payloads ----

func TestPantryAddItemBroadcastsItemAdded(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "Spices", Position: 0}
	ta.App.DB.Create(&section)
	col := ta.Collect(TestSub)

	resp := ta.POST("/api/pantry/items", map[string]any{
		"section_id": section.ID.String(), "name": "Salt", "quantity": 1,
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	payload := col.LastPayload("pantry.updated")
	if payload == nil || payload["action"] != "item-added" {
		t.Fatalf("payload = %v", payload)
	}
	if payload["sectionId"] != section.ID.String() {
		t.Fatalf("sectionId = %v", payload["sectionId"])
	}
	if payload["item"].(map[string]any)["name"] != "Salt" {
		t.Fatalf("item = %v", payload["item"])
	}
}

func TestPantryDeleteSectionBroadcastsSectionDeleted(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "Empty", Position: 0}
	ta.App.DB.Create(&section)
	col := ta.Collect(TestSub)

	resp := ta.DELETE("/api/pantry/sections/" + section.ID.String())
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	payload := col.LastPayload("pantry.updated")
	if payload == nil || payload["action"] != "section-deleted" {
		t.Fatalf("payload = %v", payload)
	}
	if payload["sectionId"] != section.ID.String() {
		t.Fatalf("sectionId = %v", payload["sectionId"])
	}
}

func TestPantryClearAllBroadcastsClearedAll(t *testing.T) {
	ta := newTestApp(t)
	section := models.PantrySection{Name: "Spices", Position: 0}
	ta.App.DB.Create(&section)
	col := ta.Collect(TestSub)

	resp := ta.DELETE("/api/pantry/items?mode=all")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	payload := col.LastPayload("pantry.updated")
	if payload == nil || payload["action"] != "cleared-all" {
		t.Fatalf("payload = %v", payload)
	}
}
