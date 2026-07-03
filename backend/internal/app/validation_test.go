package app

// Port of backend/tests/test_schemas.py.
//
// The Python file tested pydantic schemas directly. Request-side validation is
// part of the HTTP contract, so those tests become endpoint tests asserting
// the same accept/reject outcomes (422 for validation failures). Skipped as
// pure pydantic mechanics with no request-side contract:
//   - test_meal_note_schema_valid / _with_items (response-model construction;
//     the response shape is asserted here via PUT .../notes round-trips)
//   - test_calendar_event_schema_valid / _all_day / _missing_title
//     (CalendarEvent is a response/serialization schema only)
//   - test_day_data_schema_complete / _minimal (response schema construction)
//   - test_schema_json_serialization, test_schema_from_orm_model,
//     test_nested_validation_errors (pydantic serialization internals)
//   - test_meal_item_schema_invalid_line_index: MealItemSchema(line_index=-1)
//     only fails Python *response* validation (a 500, not a 4xx contract);
//     the Go handler accepts a negative path index like FastAPI's request
//     parsing does, and days.go is out of scope for changes.

import "testing"

// test_meal_note_update_valid + response shape of MealNoteSchema.
func TestUpdateNotesValid(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/days/2024-02-15/notes", map[string]any{"notes": "<p>Breakfast: Oatmeal</p>"})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	obj := resp.Obj()
	if obj["notes"] != "<p>Breakfast: Oatmeal</p>" {
		t.Fatalf("notes = %v", obj["notes"])
	}
	if obj["date"] != "2024-02-15" {
		t.Fatalf("date = %v, want 2024-02-15", obj["date"])
	}
	if _, ok := obj["id"].(string); !ok {
		t.Fatalf("id = %v, want UUID string", obj["id"])
	}
	items, ok := obj["items"].([]any)
	if !ok {
		t.Fatalf("items = %v, want list", obj["items"])
	}
	// One note line -> one MealItemSchema entry with line_index >= 0.
	if len(items) != 1 {
		t.Fatalf("items = %v, want 1 entry", items)
	}
	item := items[0].(map[string]any)
	if item["line_index"] != float64(0) {
		t.Fatalf("line_index = %v, want 0", item["line_index"])
	}
	if _, ok := obj["updated_at"].(string); !ok {
		t.Fatalf("updated_at = %v, want string", obj["updated_at"])
	}
}

// test_meal_note_update_empty_notes: empty string is a valid value.
func TestUpdateNotesEmptyAllowed(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/days/2024-02-15/notes", map[string]any{"notes": ""})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	if resp.Obj()["notes"] != "" {
		t.Fatalf("notes = %v, want empty", resp.Obj()["notes"])
	}
}

// MealNoteUpdate.notes is required: missing field -> 422.
func TestUpdateNotesMissingField(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/days/2024-02-15/notes", map[string]any{})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
}

// test_meal_note_schema_invalid_date / test_day_data_schema_invalid_date
// translated to the path/query date parsing contract.
func TestInvalidDateRejected(t *testing.T) {
	ta := newTestApp(t)
	if resp := ta.PUT("/api/days/invalid-date/notes", map[string]any{"notes": "x"}); resp.Status != 422 {
		t.Fatalf("path date: status = %d, want 422: %s", resp.Status, resp.Body)
	}
	if resp := ta.GET("/api/days?start_date=2024-02-15&end_date=not-a-date"); resp.Status != 422 {
		t.Fatalf("query date: status = %d, want 422: %s", resp.Status, resp.Body)
	}
	if resp := ta.GET("/api/days"); resp.Status != 422 {
		t.Fatalf("missing dates: status = %d, want 422: %s", resp.Status, resp.Body)
	}
}

// test_meal_item_schema_valid / _defaults + test_meal_item_toggle_valid:
// toggling an item round-trips {line_index, itemized}.
func TestToggleItemValid(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/days/2024-02-15/items/0", map[string]any{"itemized": true})
	if resp.Status != 200 {
		t.Fatalf("status = %d, want 200: %s", resp.Status, resp.Body)
	}
	obj := resp.Obj()
	if obj["line_index"] != float64(0) || obj["itemized"] != true {
		t.Fatalf("body = %s, want line_index 0 itemized true", resp.Body)
	}

	resp = ta.PATCH("/api/days/2024-02-15/items/0", map[string]any{"itemized": false})
	if resp.Status != 200 || resp.Obj()["itemized"] != false {
		t.Fatalf("toggle off = %d %s", resp.Status, resp.Body)
	}
}

// test_meal_item_toggle_invalid: MealItemToggle.itemized is required.
func TestToggleItemMissingBody(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/days/2024-02-15/items/0", map[string]any{})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
}

// line_index path param must be an int (FastAPI type coercion contract).
func TestToggleItemNonIntLineIndex(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PATCH("/api/days/2024-02-15/items/abc", map[string]any{"itemized": true})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
}

// test_meal_note_schema_invalid_uuid translated to the UUID parsing contract
// (invalid UUIDs in paths are rejected with 422 wherever they appear).
func TestInvalidUUIDRejected(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.PUT("/api/meal-ideas/invalid-uuid", map[string]any{"title": "New"})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
	if detail, _ := resp.Obj()["detail"].(string); detail != "Input should be a valid UUID" {
		t.Fatalf("detail = %q", detail)
	}
}

// min_length=1 contract (MealIdeaCreate.title): empty/missing -> 422.
func TestMinLengthTitleRejected(t *testing.T) {
	ta := newTestApp(t)
	if resp := ta.POST("/api/meal-ideas", map[string]any{"title": ""}); resp.Status != 422 {
		t.Fatalf("empty title: status = %d, want 422: %s", resp.Status, resp.Body)
	}
	if resp := ta.POST("/api/meal-ideas", map[string]any{}); resp.Status != 422 {
		t.Fatalf("missing title: status = %d, want 422: %s", resp.Status, resp.Body)
	}
}

// ge=0 contract (PantryItemCreate.quantity): negative -> 422.
func TestNegativeQuantityRejected(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.POST("/api/pantry/items", map[string]any{
		"section_id": "123e4567-e89b-12d3-a456-426614174000",
		"name":       "Rice",
		"quantity":   -1,
	})
	if resp.Status != 422 {
		t.Fatalf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
}
