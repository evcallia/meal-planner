package app

// Port of test_api.py classes: TestStoresAPI, TestGrocerySections,
// TestGroceryStoreDefaults, TestItemDefaultsAPI, TestSettingsAPI,
// TestStoresSSEPayloads, TestGrocerySSEPayloads.

import (
	"testing"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

func strp(s string) *string { return &s }

// seedGrocerySection creates a section directly in the DB (mirrors db_session seeding).
func seedGrocerySection(t *testing.T, ta *testApp, name string, position int) *models.GrocerySection {
	t.Helper()
	section := models.GrocerySection{Name: name, Position: position}
	if err := ta.App.DB.Create(&section).Error; err != nil {
		t.Fatalf("seed section: %v", err)
	}
	return &section
}

// countEventsOfType counts collected SSE events of a given type (replaces
// mock_broadcast.assert_called_once / assert_awaited).
func countEventsOfType(events []map[string]any, eventType string) int {
	n := 0
	for _, e := range events {
		if e["type"] == eventType {
			n++
		}
	}
	return n
}

// findItemDefault fetches an item_defaults row by (already lowercase) name.
func findItemDefault(ta *testApp, name string) (*models.ItemDefault, bool) {
	var def models.ItemDefault
	if ta.App.DB.Where("item_name = ?", name).First(&def).Error != nil {
		return nil, false
	}
	return &def, true
}

// ---- TestStoresAPI ----

func TestStoresCreateAndList(t *testing.T) {
	ta := newTestApp(t)
	col := ta.Collect(TestSub)

	resp := ta.POST("/api/stores", map[string]any{"name": "trader joes"})
	if resp.Status != 200 {
		t.Fatalf("create status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["name"] != "Trader Joes" {
		t.Fatalf("name = %v, want Trader Joes", data["name"])
	}
	if data["position"] != float64(0) {
		t.Fatalf("position = %v, want 0", data["position"])
	}

	list := ta.GET("/api/stores")
	if list.Status != 200 {
		t.Fatalf("list status = %d", list.Status)
	}
	stores := list.List()
	if len(stores) != 1 {
		t.Fatalf("len(stores) = %d, want 1", len(stores))
	}
	if stores[0].(map[string]any)["name"] != "Trader Joes" {
		t.Fatalf("stores[0].name = %v", stores[0].(map[string]any)["name"])
	}
	if countEventsOfType(col.Events(), "stores.updated") == 0 {
		t.Fatal("expected a stores.updated broadcast")
	}
}

func TestStoresCreateDuplicateReturnsExisting(t *testing.T) {
	ta := newTestApp(t)

	first := ta.POST("/api/stores", map[string]any{"name": "Whole Foods"})
	if first.Status != 200 {
		t.Fatalf("first create status = %d", first.Status)
	}
	firstID := first.Obj()["id"]

	second := ta.POST("/api/stores", map[string]any{"name": "whole foods"})
	if second.Status != 200 {
		t.Fatalf("second create status = %d", second.Status)
	}
	if second.Obj()["id"] != firstID {
		t.Fatalf("duplicate create id = %v, want %v", second.Obj()["id"], firstID)
	}
}

func TestStoresRename(t *testing.T) {
	ta := newTestApp(t)

	created := ta.POST("/api/stores", map[string]any{"name": "Costco"})
	storeID := created.Obj()["id"].(string)

	renamed := ta.PATCH("/api/stores/"+storeID, map[string]any{"name": "costco wholesale"})
	if renamed.Status != 200 {
		t.Fatalf("rename status = %d: %s", renamed.Status, renamed.Body)
	}
	if renamed.Obj()["name"] != "Costco Wholesale" {
		t.Fatalf("name = %v, want Costco Wholesale", renamed.Obj()["name"])
	}
}

func TestStoresDeleteNullifiesGroceryItems(t *testing.T) {
	ta := newTestApp(t)

	created := ta.POST("/api/stores", map[string]any{"name": "Target"})
	if created.Status != 200 {
		t.Fatalf("create status = %d", created.Status)
	}
	storeID := created.Obj()["id"].(string)
	storeUUID := uuid.MustParse(storeID)

	section := seedGrocerySection(t, ta, "General", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Milk", Position: 0, StoreID: &storeUUID}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	if item.StoreID == nil || item.StoreID.String() != storeID {
		t.Fatalf("item.store_id = %v, want %s", item.StoreID, storeID)
	}

	deleted := ta.DELETE("/api/stores/" + storeID)
	if deleted.Status != 200 {
		t.Fatalf("delete status = %d: %s", deleted.Status, deleted.Body)
	}

	var reloaded models.GroceryItem
	if err := ta.App.DB.Where("id = ?", item.ID).First(&reloaded).Error; err != nil {
		t.Fatalf("reload item: %v", err)
	}
	if reloaded.StoreID != nil {
		t.Fatalf("item.store_id = %v after store delete, want nil", reloaded.StoreID)
	}
}

func TestStoresReorder(t *testing.T) {
	ta := newTestApp(t)

	aID := ta.POST("/api/stores", map[string]any{"name": "Store A"}).Obj()["id"].(string)
	bID := ta.POST("/api/stores", map[string]any{"name": "Store B"}).Obj()["id"].(string)

	reorder := ta.PATCH("/api/stores/reorder", map[string]any{"store_ids": []string{bID, aID}})
	if reorder.Status != 200 {
		t.Fatalf("reorder status = %d: %s", reorder.Status, reorder.Body)
	}

	stores := ta.GET("/api/stores").List()
	if len(stores) != 2 {
		t.Fatalf("len(stores) = %d, want 2", len(stores))
	}
	if stores[0].(map[string]any)["id"] != bID {
		t.Fatalf("stores[0].id = %v, want %s", stores[0].(map[string]any)["id"], bID)
	}
	if stores[1].(map[string]any)["id"] != aID {
		t.Fatalf("stores[1].id = %v, want %s", stores[1].(map[string]any)["id"], aID)
	}
}

// ---- TestGrocerySections ----

func TestGroceryCreateSection(t *testing.T) {
	ta := newTestApp(t)
	col := ta.Collect(TestSub)

	resp := ta.POST("/api/grocery/sections", map[string]any{"name": "Produce"})
	if resp.Status != 201 {
		t.Fatalf("status = %d, want 201: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	if data["name"] != "Produce" {
		t.Fatalf("name = %v, want Produce", data["name"])
	}
	items, ok := data["items"].([]any)
	if !ok || len(items) != 0 {
		t.Fatalf("items = %v, want []", data["items"])
	}
	if countEventsOfType(col.Events(), "grocery.updated") == 0 {
		t.Fatal("expected a grocery.updated broadcast")
	}
}

func TestGroceryCreateSectionWithPosition(t *testing.T) {
	ta := newTestApp(t)

	resp := ta.POST("/api/grocery/sections", map[string]any{"name": "Dairy", "position": 2})
	if resp.Status != 201 {
		t.Fatalf("status = %d, want 201: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["position"] != float64(2) {
		t.Fatalf("position = %v, want 2", resp.Obj()["position"])
	}
}

func TestGroceryDeleteEmptySection(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Empty", 0)
	col := ta.Collect(TestSub)

	resp := ta.DELETE("/api/grocery/sections/" + section.ID.String())
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}
	if countEventsOfType(col.Events(), "grocery.updated") == 0 {
		t.Fatal("expected a grocery.updated broadcast")
	}

	var count int64
	ta.App.DB.Model(&models.GrocerySection{}).Where("id = ?", section.ID).Count(&count)
	if count != 0 {
		t.Fatal("section still present after delete")
	}
}

func TestGroceryDeleteSectionWithItemsFails(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "HasItems", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Milk", Position: 0}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}

	resp := ta.DELETE("/api/grocery/sections/" + section.ID.String())
	if resp.Status != 400 {
		t.Fatalf("status = %d, want 400: %s", resp.Status, resp.Body)
	}
}

func TestGroceryDeleteSectionIdempotent(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.DELETE("/api/grocery/sections/00000000-0000-0000-0000-000000000001")
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}
}

func TestGroceryRenameSection(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Old Name", 0)
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/grocery/sections/"+section.ID.String(), map[string]any{"name": "New Name"})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["name"] != "New Name" {
		t.Fatalf("name = %v, want New Name", resp.Obj()["name"])
	}
	if countEventsOfType(col.Events(), "grocery.updated") == 0 {
		t.Fatal("expected a grocery.updated broadcast")
	}
}

// ---- TestGroceryStoreDefaults ----

func TestGroceryAssignStoreCreatesDefault(t *testing.T) {
	ta := newTestApp(t)

	storeID := ta.POST("/api/stores", map[string]any{"name": "Safeway"}).Obj()["id"].(string)

	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Apples", Position: 0}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}

	patched := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"store_id": storeID})
	if patched.Status != 200 {
		t.Fatalf("patch status = %d: %s", patched.Status, patched.Body)
	}
	if patched.Obj()["store_id"] != storeID {
		t.Fatalf("store_id = %v, want %s", patched.Obj()["store_id"], storeID)
	}

	def, ok := findItemDefault(ta, "apples")
	if !ok {
		t.Fatal("item default for 'apples' not created")
	}
	if def.StoreID == nil || def.StoreID.String() != storeID {
		t.Fatalf("default.store_id = %v, want %s", def.StoreID, storeID)
	}
}

func TestGroceryAddItemAutoPopulatesStore(t *testing.T) {
	ta := newTestApp(t)

	storeID := ta.POST("/api/stores", map[string]any{"name": "Kroger"}).Obj()["id"].(string)
	section := seedGrocerySection(t, ta, "Dairy", 0)
	sectionID := section.ID.String()

	added := ta.POST("/api/grocery/items", map[string]any{"section_id": sectionID, "name": "Butter"})
	if added.Status != 200 {
		t.Fatalf("add status = %d: %s", added.Status, added.Body)
	}
	itemID := added.Obj()["id"].(string)

	patched := ta.PATCH("/api/grocery/items/"+itemID, map[string]any{"store_id": storeID})
	if patched.Status != 200 {
		t.Fatalf("patch status = %d: %s", patched.Status, patched.Body)
	}

	deleted := ta.DELETE("/api/grocery/items/" + itemID)
	if deleted.Status != 200 {
		t.Fatalf("delete status = %d: %s", deleted.Status, deleted.Body)
	}

	readded := ta.POST("/api/grocery/items", map[string]any{"section_id": sectionID, "name": "Butter"})
	if readded.Status != 200 {
		t.Fatalf("re-add status = %d: %s", readded.Status, readded.Body)
	}
	if readded.Obj()["store_id"] != storeID {
		t.Fatalf("re-added store_id = %v, want %s", readded.Obj()["store_id"], storeID)
	}
}

func TestGroceryClearStoreClearsDefault(t *testing.T) {
	ta := newTestApp(t)

	storeID := ta.POST("/api/stores", map[string]any{"name": "Aldi"}).Obj()["id"].(string)
	section := seedGrocerySection(t, ta, "Snacks", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Chips", Position: 0}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}

	patched := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"store_id": storeID})
	if patched.Status != 200 {
		t.Fatalf("patch status = %d: %s", patched.Status, patched.Body)
	}

	def, ok := findItemDefault(ta, "chips")
	if !ok {
		t.Fatal("item default for 'chips' not created")
	}
	if def.StoreID == nil || def.StoreID.String() != storeID {
		t.Fatalf("default.store_id = %v, want %s", def.StoreID, storeID)
	}

	cleared := ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"store_id": nil})
	if cleared.Status != 200 {
		t.Fatalf("clear status = %d: %s", cleared.Status, cleared.Body)
	}
	if cleared.Obj()["store_id"] != nil {
		t.Fatalf("cleared store_id = %v, want nil", cleared.Obj()["store_id"])
	}

	def, ok = findItemDefault(ta, "chips")
	if !ok {
		t.Fatal("item default for 'chips' missing after clear")
	}
	if def.StoreID != nil {
		t.Fatalf("default.store_id = %v after clear, want nil", def.StoreID)
	}
}

// ---- TestItemDefaultsAPI ----

func TestDeleteItemDefault(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Trader Joe's"}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	def := models.ItemDefault{ItemName: "sweet potato", StoreID: &store.ID}
	if err := ta.App.DB.Create(&def).Error; err != nil {
		t.Fatalf("seed default: %v", err)
	}

	resp := ta.DELETE("/api/grocery/item-defaults/sweet%20potato")
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}
	if _, ok := findItemDefault(ta, "sweet potato"); ok {
		t.Fatal("item default still present after delete")
	}
}

func TestDeleteItemDefaultIdempotent(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.DELETE("/api/grocery/item-defaults/nonexistent")
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}
}

func TestUpsertItemDefaultCreate(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/grocery/item-defaults/banana", map[string]any{"store_id": nil})
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}
	if _, ok := findItemDefault(ta, "banana"); !ok {
		t.Fatal("item default for 'banana' not created")
	}
}

func TestUpsertItemDefaultUpdate(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Costco"}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	if err := ta.App.DB.Create(&models.ItemDefault{ItemName: "apple"}).Error; err != nil {
		t.Fatalf("seed default: %v", err)
	}

	resp := ta.PUT("/api/grocery/item-defaults/apple", map[string]any{"store_id": store.ID.String()})
	if resp.Status != 204 {
		t.Fatalf("status = %d, want 204: %s", resp.Status, resp.Body)
	}
	def, ok := findItemDefault(ta, "apple")
	if !ok {
		t.Fatal("item default for 'apple' missing")
	}
	if def.StoreID == nil || def.StoreID.String() != store.ID.String() {
		t.Fatalf("default.store_id = %v, want %s", def.StoreID, store.ID)
	}
}

// ---- TestSettingsAPI ----

func TestGetSettingsEmpty(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.GET("/api/settings")
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	settings, ok := data["settings"].(map[string]any)
	if !ok || len(settings) != 0 {
		t.Fatalf("settings = %v, want {}", data["settings"])
	}
	if data["updated_at"] != nil {
		t.Fatalf("updated_at = %v, want nil", data["updated_at"])
	}
}

func TestPutAndGetSettings(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/settings", map[string]any{
		"settings":   map[string]any{"compactView": true, "calendarColor": "blue"},
		"updated_at": "2026-04-01T12:00:00",
	})
	if resp.Status != 200 {
		t.Fatalf("put status = %d: %s", resp.Status, resp.Body)
	}
	data := resp.Obj()
	settings := data["settings"].(map[string]any)
	if settings["compactView"] != true {
		t.Fatalf("compactView = %v, want true", settings["compactView"])
	}
	if settings["calendarColor"] != "blue" {
		t.Fatalf("calendarColor = %v, want blue", settings["calendarColor"])
	}
	if data["updated_at"] == nil {
		t.Fatal("updated_at is nil, want non-nil")
	}

	got := ta.GET("/api/settings")
	if got.Status != 200 {
		t.Fatalf("get status = %d", got.Status)
	}
	if got.Obj()["settings"].(map[string]any)["compactView"] != true {
		t.Fatalf("GET compactView = %v, want true", got.Obj()["settings"].(map[string]any)["compactView"])
	}
}

func TestPutSettingsUpsert(t *testing.T) {
	ta := newTestApp(t)
	ta.PUT("/api/settings", map[string]any{
		"settings":   map[string]any{"compactView": true},
		"updated_at": "2026-04-01T12:00:00",
	})
	ta.PUT("/api/settings", map[string]any{
		"settings":   map[string]any{"compactView": false, "holidayColor": "green"},
		"updated_at": "2026-04-01T13:00:00",
	})
	resp := ta.GET("/api/settings")
	settings := resp.Obj()["settings"].(map[string]any)
	if settings["compactView"] != false {
		t.Fatalf("compactView = %v, want false", settings["compactView"])
	}
	if settings["holidayColor"] != "green" {
		t.Fatalf("holidayColor = %v, want green", settings["holidayColor"])
	}
}

// ---- TestStoresSSEPayloads ----

func TestCreateStoreBroadcastsAdded(t *testing.T) {
	ta := newTestApp(t)
	col := ta.Collect(TestSub)

	resp := ta.POST("/api/stores", map[string]any{"name": "Costco"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	events := col.Events()
	if n := countEventsOfType(events, "stores.updated"); n != 1 {
		t.Fatalf("stores.updated broadcasts = %d, want 1", n)
	}
	payload := col2payload(t, events, "stores.updated")
	if payload["action"] != "added" {
		t.Fatalf("action = %v, want added", payload["action"])
	}
	store := payload["store"].(map[string]any)
	if store["name"] != "Costco" {
		t.Fatalf("store.name = %v, want Costco", store["name"])
	}
	if _, ok := store["id"]; !ok {
		t.Fatal("store payload missing id")
	}
}

func TestUpdateStoreBroadcastsUpdated(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Old Name", Position: 0}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/stores/"+store.ID.String(), map[string]any{"name": "New Name"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	events := col.Events()
	if n := countEventsOfType(events, "stores.updated"); n != 1 {
		t.Fatalf("stores.updated broadcasts = %d, want 1", n)
	}
	payload := col2payload(t, events, "stores.updated")
	if payload["action"] != "updated" {
		t.Fatalf("action = %v, want updated", payload["action"])
	}
	if payload["store"].(map[string]any)["name"] != "New Name" {
		t.Fatalf("store.name = %v, want New Name", payload["store"].(map[string]any)["name"])
	}
}

func TestDeleteStoreBroadcastsDeleted(t *testing.T) {
	ta := newTestApp(t)
	store := models.Store{Name: "Target", Position: 0}
	if err := ta.App.DB.Create(&store).Error; err != nil {
		t.Fatalf("seed store: %v", err)
	}
	col := ta.Collect(TestSub)

	resp := ta.DELETE("/api/stores/" + store.ID.String())
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	events := col.Events()
	if n := countEventsOfType(events, "stores.updated"); n != 1 {
		t.Fatalf("stores.updated broadcasts = %d, want 1", n)
	}
	payload := col2payload(t, events, "stores.updated")
	if payload["action"] != "deleted" {
		t.Fatalf("action = %v, want deleted", payload["action"])
	}
	if payload["storeId"] != store.ID.String() {
		t.Fatalf("storeId = %v, want %s", payload["storeId"], store.ID)
	}
}

func TestReorderStoresBroadcastsReordered(t *testing.T) {
	ta := newTestApp(t)
	s1 := models.Store{Name: "A", Position: 0}
	s2 := models.Store{Name: "B", Position: 1}
	if err := ta.App.DB.Create(&s1).Error; err != nil {
		t.Fatalf("seed s1: %v", err)
	}
	if err := ta.App.DB.Create(&s2).Error; err != nil {
		t.Fatalf("seed s2: %v", err)
	}
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/stores/reorder", map[string]any{
		"store_ids": []string{s2.ID.String(), s1.ID.String()},
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	events := col.Events()
	if n := countEventsOfType(events, "stores.updated"); n != 1 {
		t.Fatalf("stores.updated broadcasts = %d, want 1", n)
	}
	payload := col2payload(t, events, "stores.updated")
	if payload["action"] != "reordered" {
		t.Fatalf("action = %v, want reordered", payload["action"])
	}
	if stores := payload["stores"].([]any); len(stores) != 2 {
		t.Fatalf("len(stores) = %d, want 2", len(stores))
	}
}

// col2payload returns the payload of the last event of the given type.
func col2payload(t *testing.T, events []map[string]any, eventType string) map[string]any {
	t.Helper()
	for i := len(events) - 1; i >= 0; i-- {
		if events[i]["type"] == eventType {
			p, _ := events[i]["payload"].(map[string]any)
			return p
		}
	}
	t.Fatalf("no %s event found in %v", eventType, events)
	return nil
}

// ---- TestGrocerySSEPayloads ----

func TestAddItemBroadcastsItemAdded(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	col := ta.Collect(TestSub)

	resp := ta.POST("/api/grocery/items", map[string]any{
		"section_id": section.ID.String(), "name": "Apples", "quantity": "3",
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	payload := col2payload(t, col.Events(), "grocery.updated")
	if payload["action"] != "item-added" {
		t.Fatalf("action = %v, want item-added", payload["action"])
	}
	if payload["sectionId"] != section.ID.String() {
		t.Fatalf("sectionId = %v, want %s", payload["sectionId"], section.ID)
	}
	if payload["item"].(map[string]any)["name"] != "Apples" {
		t.Fatalf("item.name = %v, want Apples", payload["item"].(map[string]any)["name"])
	}
}

func TestDeleteItemBroadcastsItemDeleted(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Milk", Quantity: strp("1"), Position: 0}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	col := ta.Collect(TestSub)

	resp := ta.DELETE("/api/grocery/items/" + item.ID.String())
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	payload := col2payload(t, col.Events(), "grocery.updated")
	if payload["action"] != "item-deleted" {
		t.Fatalf("action = %v, want item-deleted", payload["action"])
	}
	if payload["itemId"] != item.ID.String() {
		t.Fatalf("itemId = %v, want %s", payload["itemId"], item.ID)
	}
	if payload["sectionId"] != section.ID.String() {
		t.Fatalf("sectionId = %v, want %s", payload["sectionId"], section.ID)
	}
}

func TestClearCheckedBroadcastsClearedChecked(t *testing.T) {
	ta := newTestApp(t)
	section := seedGrocerySection(t, ta, "Produce", 0)
	item := models.GroceryItem{SectionID: section.ID, Name: "Milk", Quantity: strp("1"), Position: 0, Checked: true}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	col := ta.Collect(TestSub)

	resp := ta.DELETE("/api/grocery/items?mode=checked")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	payload := col2payload(t, col.Events(), "grocery.updated")
	if payload["action"] != "cleared-checked" {
		t.Fatalf("action = %v, want cleared-checked", payload["action"])
	}
}

func TestClearAllBroadcastsClearedAll(t *testing.T) {
	ta := newTestApp(t)
	seedGrocerySection(t, ta, "Produce", 0)
	col := ta.Collect(TestSub)

	resp := ta.DELETE("/api/grocery/items?mode=all")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	payload := col2payload(t, col.Events(), "grocery.updated")
	if payload["action"] != "cleared-all" {
		t.Fatalf("action = %v, want cleared-all", payload["action"])
	}
}

func TestMoveItemBroadcastsItemMoved(t *testing.T) {
	ta := newTestApp(t)
	s1 := seedGrocerySection(t, ta, "Produce", 0)
	s2 := seedGrocerySection(t, ta, "Dairy", 1)
	item := models.GroceryItem{SectionID: s1.ID, Name: "Milk", Quantity: strp("1"), Position: 0}
	if err := ta.App.DB.Create(&item).Error; err != nil {
		t.Fatalf("seed item: %v", err)
	}
	col := ta.Collect(TestSub)

	resp := ta.PATCH("/api/grocery/items/"+item.ID.String()+"/move", map[string]any{
		"to_section_id": s2.ID.String(), "to_position": 0,
	})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	payload := col2payload(t, col.Events(), "grocery.updated")
	if payload["action"] != "item-moved" {
		t.Fatalf("action = %v, want item-moved", payload["action"])
	}
	if payload["fromSectionId"] != s1.ID.String() {
		t.Fatalf("fromSectionId = %v, want %s", payload["fromSectionId"], s1.ID)
	}
	if payload["toSectionId"] != s2.ID.String() {
		t.Fatalf("toSectionId = %v, want %s", payload["toSectionId"], s2.ID)
	}
	if payload["item"].(map[string]any)["name"] != "Milk" {
		t.Fatalf("item.name = %v, want Milk", payload["item"].(map[string]any)["name"])
	}
}
