package app

// Port of backend/tests/test_models.py: exercise the GORM models against the
// harness's in-memory sqlite DB — uuid defaults, created_at/updated_at,
// unique/foreign-key constraints, and FK cascade deletes (sqlite FKs are ON).
//
// Adaptations from the Python suite:
//   - test_meal_item_relationship asserted the SQLAlchemy back-reference
//     (item.meal_note); the Go model has no back-ref field, so the note is
//     looked up via item.MealNoteID instead.
//   - isinstance(id, uuid.UUID) checks become "ID != uuid.Nil".

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/db"
	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
)

// newModelsDB opens the same sqlite DB the app harness uses (FKs enforced).
func newModelsDB(t *testing.T) *gorm.DB {
	t.Helper()
	gdb, err := db.OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	return gdb
}

func mustCreate(t *testing.T, gdb *gorm.DB, value any) {
	t.Helper()
	if err := gdb.Create(value).Error; err != nil {
		t.Fatalf("create %T: %v", value, err)
	}
}

// sampleMealNote mirrors the conftest sample_meal_note fixture.
func sampleMealNote(t *testing.T, gdb *gorm.DB) *models.MealNote {
	t.Helper()
	note := models.MealNote{Date: utcDate(2024, 2, 15), Notes: "Test notes"}
	mustCreate(t, gdb, &note)
	return &note
}

// ---- TestMealNote ----

func TestCreateMealNote(t *testing.T) {
	gdb := newModelsDB(t)
	testDate := utcDate(2024, 2, 15)
	notes := "<p>Breakfast: Eggs</p>"

	note := models.MealNote{Date: testDate, Notes: notes}
	mustCreate(t, gdb, &note)

	var saved models.MealNote
	if err := gdb.First(&saved, "id = ?", note.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if saved.ID == uuid.Nil {
		t.Fatal("id not assigned")
	}
	if httpx.FormatDate(saved.Date) != "2024-02-15" {
		t.Fatalf("date = %v", saved.Date)
	}
	if saved.Notes != notes {
		t.Fatalf("notes = %q", saved.Notes)
	}
	if saved.CreatedAt.IsZero() {
		t.Fatal("created_at not set")
	}
	if saved.UpdatedAt.IsZero() {
		t.Fatal("updated_at not set")
	}
}

func TestMealNoteDefaults(t *testing.T) {
	gdb := newModelsDB(t)
	note := models.MealNote{Date: utcDate(2024, 2, 15)}
	mustCreate(t, gdb, &note)

	var saved models.MealNote
	if err := gdb.First(&saved, "id = ?", note.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if saved.Notes != "" {
		t.Fatalf("notes = %q, want empty default", saved.Notes)
	}
	if saved.CreatedAt.IsZero() || saved.UpdatedAt.IsZero() {
		t.Fatal("timestamps not set")
	}
}

func TestMealNoteUniqueDate(t *testing.T) {
	gdb := newModelsDB(t)
	testDate := utcDate(2024, 2, 15)
	mustCreate(t, gdb, &models.MealNote{Date: testDate, Notes: "First note"})

	dup := models.MealNote{Date: testDate, Notes: "Second note"}
	if err := gdb.Create(&dup).Error; err == nil {
		t.Fatal("expected unique-constraint error for duplicate date")
	}
}

func TestMealNoteRelationships(t *testing.T) {
	gdb := newModelsDB(t)
	note := models.MealNote{Date: utcDate(2024, 2, 15), Notes: "Test notes"}
	mustCreate(t, gdb, &note)

	var loaded models.MealNote
	if err := gdb.Preload("Items").First(&loaded, "id = ?", note.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(loaded.Items) != 0 {
		t.Fatalf("items = %d, want 0", len(loaded.Items))
	}

	mustCreate(t, gdb, &models.MealItem{MealNoteID: note.ID, LineIndex: 0, Itemized: true})
	mustCreate(t, gdb, &models.MealItem{MealNoteID: note.ID, LineIndex: 1, Itemized: false})

	if err := gdb.Preload("Items").First(&loaded, "id = ?", note.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if len(loaded.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(loaded.Items))
	}
	for _, item := range loaded.Items {
		if item.LineIndex != 0 && item.LineIndex != 1 {
			t.Fatalf("unexpected line_index %d", item.LineIndex)
		}
	}
}

func TestMealNoteCascadeDelete(t *testing.T) {
	gdb := newModelsDB(t)
	note := models.MealNote{Date: utcDate(2024, 2, 15), Notes: "Test notes"}
	mustCreate(t, gdb, &note)
	mustCreate(t, gdb, &models.MealItem{MealNoteID: note.ID, LineIndex: 0, Itemized: true})
	mustCreate(t, gdb, &models.MealItem{MealNoteID: note.ID, LineIndex: 1, Itemized: false})

	var count int64
	gdb.Model(&models.MealItem{}).Where("meal_note_id = ?", note.ID).Count(&count)
	if count != 2 {
		t.Fatalf("items before delete = %d, want 2", count)
	}

	if err := gdb.Delete(&note).Error; err != nil {
		t.Fatalf("delete note: %v", err)
	}

	gdb.Model(&models.MealItem{}).Where("meal_note_id = ?", note.ID).Count(&count)
	if count != 0 {
		t.Fatalf("items after delete = %d, want 0 (cascade)", count)
	}
}

// ---- TestMealItem ----

func TestCreateMealItem(t *testing.T) {
	gdb := newModelsDB(t)
	note := sampleMealNote(t, gdb)

	item := models.MealItem{MealNoteID: note.ID, LineIndex: 0, Itemized: true}
	mustCreate(t, gdb, &item)

	var saved models.MealItem
	if err := gdb.First(&saved, "id = ?", item.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if saved.ID == uuid.Nil {
		t.Fatal("id not assigned")
	}
	if saved.MealNoteID != note.ID {
		t.Fatalf("meal_note_id = %v", saved.MealNoteID)
	}
	if saved.LineIndex != 0 || saved.Itemized != true {
		t.Fatalf("line_index=%d itemized=%v", saved.LineIndex, saved.Itemized)
	}
	if saved.CreatedAt.IsZero() {
		t.Fatal("created_at not set")
	}
}

func TestMealItemDefaults(t *testing.T) {
	gdb := newModelsDB(t)
	note := sampleMealNote(t, gdb)

	item := models.MealItem{MealNoteID: note.ID, LineIndex: 0}
	mustCreate(t, gdb, &item)

	var saved models.MealItem
	if err := gdb.First(&saved, "id = ?", item.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if saved.Itemized != false {
		t.Fatal("itemized should default to false")
	}
	if saved.CreatedAt.IsZero() {
		t.Fatal("created_at not set")
	}
}

func TestMealItemRelationship(t *testing.T) {
	gdb := newModelsDB(t)
	note := sampleMealNote(t, gdb)
	item := models.MealItem{MealNoteID: note.ID, LineIndex: 0, Itemized: true}
	mustCreate(t, gdb, &item)

	// No back-reference field in Go — resolve the parent via the FK.
	var parent models.MealNote
	if err := gdb.First(&parent, "id = ?", item.MealNoteID).Error; err != nil {
		t.Fatalf("load parent: %v", err)
	}
	if parent.ID != note.ID {
		t.Fatalf("parent id = %v, want %v", parent.ID, note.ID)
	}
	if httpx.FormatDate(parent.Date) != httpx.FormatDate(note.Date) {
		t.Fatalf("parent date = %v, want %v", parent.Date, note.Date)
	}
}

func TestMealItemMultiplePerNote(t *testing.T) {
	gdb := newModelsDB(t)
	note := sampleMealNote(t, gdb)
	mustCreate(t, gdb, &models.MealItem{MealNoteID: note.ID, LineIndex: 0, Itemized: true})
	mustCreate(t, gdb, &models.MealItem{MealNoteID: note.ID, LineIndex: 1, Itemized: false})
	mustCreate(t, gdb, &models.MealItem{MealNoteID: note.ID, LineIndex: 2, Itemized: true})

	var saved []models.MealItem
	if err := gdb.Where("meal_note_id = ?", note.ID).Order("line_index").Find(&saved).Error; err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(saved) != 3 {
		t.Fatalf("items = %d, want 3", len(saved))
	}
	wantItemized := []bool{true, false, true}
	for i, item := range saved {
		if item.LineIndex != i || item.Itemized != wantItemized[i] {
			t.Fatalf("item %d: line_index=%d itemized=%v", i, item.LineIndex, item.Itemized)
		}
	}
}

func TestMealItemForeignKeyConstraint(t *testing.T) {
	gdb := newModelsDB(t)
	item := models.MealItem{MealNoteID: uuid.New(), LineIndex: 0}
	if err := gdb.Create(&item).Error; err == nil {
		t.Fatal("expected foreign-key constraint error for nonexistent meal note")
	}
}

// ---- TestCachedCalendarEvent ----

func TestCreateCachedEvent(t *testing.T) {
	gdb := newModelsDB(t)
	endTime := utcDateTime(2024, 2, 15, 11, 0)
	event := models.CachedCalendarEvent{
		EventDate: utcDate(2024, 2, 15), Title: "Test Event",
		StartTime: utcDateTime(2024, 2, 15, 10, 0), EndTime: &endTime, AllDay: false,
	}
	mustCreate(t, gdb, &event)

	var saved models.CachedCalendarEvent
	if err := gdb.First(&saved, "id = ?", event.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if saved.ID == uuid.Nil {
		t.Fatal("id not assigned")
	}
	if httpx.FormatDate(saved.EventDate) != "2024-02-15" {
		t.Fatalf("event_date = %v", saved.EventDate)
	}
	if saved.Title != "Test Event" {
		t.Fatalf("title = %q", saved.Title)
	}
	if !saved.StartTime.UTC().Equal(utcDateTime(2024, 2, 15, 10, 0)) {
		t.Fatalf("start_time = %v", saved.StartTime)
	}
	if saved.EndTime == nil || !saved.EndTime.UTC().Equal(endTime) {
		t.Fatalf("end_time = %v", saved.EndTime)
	}
	if saved.AllDay != false {
		t.Fatal("all_day should be false")
	}
	if saved.CreatedAt.IsZero() {
		t.Fatal("created_at not set")
	}
}

func TestCachedEventAllDay(t *testing.T) {
	gdb := newModelsDB(t)
	event := models.CachedCalendarEvent{
		EventDate: utcDate(2024, 2, 15), Title: "All Day Event",
		StartTime: utcDateTime(2024, 2, 15, 0, 0), EndTime: nil, AllDay: true,
	}
	mustCreate(t, gdb, &event)

	var saved models.CachedCalendarEvent
	if err := gdb.First(&saved, "id = ?", event.ID).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if !saved.AllDay {
		t.Fatal("all_day should be true")
	}
	if saved.EndTime != nil {
		t.Fatalf("end_time = %v, want nil", saved.EndTime)
	}
}

func TestCachedEventsMultiplePerDay(t *testing.T) {
	gdb := newModelsDB(t)
	day := utcDate(2024, 2, 15)
	for i, hour := range []int{9, 14, 18} {
		mustCreate(t, gdb, &models.CachedCalendarEvent{
			EventDate: day, Title: []string{"Event 1", "Event 2", "Event 3"}[i],
			StartTime: day.Add(time.Duration(hour) * time.Hour), AllDay: false,
		})
	}

	var saved []models.CachedCalendarEvent
	if err := gdb.Where("event_date = ?", day).Order("start_time").Find(&saved).Error; err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(saved) != 3 {
		t.Fatalf("events = %d, want 3", len(saved))
	}
	for i, want := range []string{"Event 1", "Event 2", "Event 3"} {
		if saved[i].Title != want {
			t.Fatalf("event %d title = %q, want %q", i, saved[i].Title, want)
		}
	}
}

func TestCachedEventDateIndexQuery(t *testing.T) {
	gdb := newModelsDB(t)
	for i := 0; i < 10; i++ {
		day := utcDate(2024, 2, i+1)
		mustCreate(t, gdb, &models.CachedCalendarEvent{
			EventDate: day, Title: "Event " + string(rune('0'+i)),
			StartTime: day.Add(10 * time.Hour), AllDay: false,
		})
	}

	var results []models.CachedCalendarEvent
	if err := gdb.Where("event_date = ?", utcDate(2024, 2, 5)).Find(&results).Error; err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1", len(results))
	}
	if results[0].Title != "Event 4" {
		t.Fatalf("title = %q, want Event 4", results[0].Title)
	}
}

// ---- TestCalendarCacheMetadata ----

func TestCreateMetadata(t *testing.T) {
	gdb := newModelsDB(t)
	lastRefresh := utcDateTime(2024, 2, 15, 12, 0)
	cacheStart := utcDate(2024, 1, 15)
	cacheEnd := utcDate(2024, 4, 15)
	meta := models.CalendarCacheMetadata{
		ID: 1, LastRefresh: &lastRefresh, CacheStart: &cacheStart, CacheEnd: &cacheEnd,
	}
	mustCreate(t, gdb, &meta)

	var saved models.CalendarCacheMetadata
	if err := gdb.First(&saved, "id = ?", 1).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if saved.ID != 1 {
		t.Fatalf("id = %d", saved.ID)
	}
	if saved.LastRefresh == nil || !saved.LastRefresh.UTC().Equal(lastRefresh) {
		t.Fatalf("last_refresh = %v", saved.LastRefresh)
	}
	if saved.CacheStart == nil || httpx.FormatDate(*saved.CacheStart) != "2024-01-15" {
		t.Fatalf("cache_start = %v", saved.CacheStart)
	}
	if saved.CacheEnd == nil || httpx.FormatDate(*saved.CacheEnd) != "2024-04-15" {
		t.Fatalf("cache_end = %v", saved.CacheEnd)
	}
}

func TestMetadataNullableFields(t *testing.T) {
	gdb := newModelsDB(t)
	mustCreate(t, gdb, &models.CalendarCacheMetadata{ID: 1})

	var saved models.CalendarCacheMetadata
	if err := gdb.First(&saved, "id = ?", 1).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if saved.LastRefresh != nil || saved.CacheStart != nil || saved.CacheEnd != nil {
		t.Fatalf("expected all-nil fields, got %+v", saved)
	}
}

func TestMetadataUpdate(t *testing.T) {
	gdb := newModelsDB(t)
	lastRefresh := utcDateTime(2024, 2, 15, 12, 0)
	cacheStart := utcDate(2024, 1, 15)
	cacheEnd := utcDate(2024, 4, 15)
	meta := models.CalendarCacheMetadata{
		ID: 1, LastRefresh: &lastRefresh, CacheStart: &cacheStart, CacheEnd: &cacheEnd,
	}
	mustCreate(t, gdb, &meta)

	newRefresh := utcDateTime(2024, 2, 16, 12, 0)
	newStart := utcDate(2024, 1, 16)
	newEnd := utcDate(2024, 4, 16)
	err := gdb.Model(&models.CalendarCacheMetadata{}).Where("id = ?", 1).Updates(map[string]any{
		"last_refresh": newRefresh, "cache_start": newStart, "cache_end": newEnd,
	}).Error
	if err != nil {
		t.Fatalf("update: %v", err)
	}

	var saved models.CalendarCacheMetadata
	if err := gdb.First(&saved, "id = ?", 1).Error; err != nil {
		t.Fatalf("reload: %v", err)
	}
	if saved.LastRefresh == nil || !saved.LastRefresh.UTC().Equal(newRefresh) {
		t.Fatalf("last_refresh = %v", saved.LastRefresh)
	}
	if saved.CacheStart == nil || httpx.FormatDate(*saved.CacheStart) != "2024-01-16" {
		t.Fatalf("cache_start = %v", saved.CacheStart)
	}
	if saved.CacheEnd == nil || httpx.FormatDate(*saved.CacheEnd) != "2024-04-16" {
		t.Fatalf("cache_end = %v", saved.CacheEnd)
	}
}

func TestMetadataSingleton(t *testing.T) {
	gdb := newModelsDB(t)
	lastRefresh := models.NowUTC()
	mustCreate(t, gdb, &models.CalendarCacheMetadata{ID: 1, LastRefresh: &lastRefresh})

	var count int64
	gdb.Model(&models.CalendarCacheMetadata{}).Count(&count)
	if count != 1 {
		t.Fatalf("metadata rows = %d, want 1", count)
	}
}

// ---- Additional cascade coverage (grocery/pantry sections, tracker) ----

func TestGrocerySectionCascadeDeletesItems(t *testing.T) {
	gdb := newModelsDB(t)
	section := models.GrocerySection{Name: "Produce", Position: 0}
	mustCreate(t, gdb, &section)
	mustCreate(t, gdb, &models.GroceryItem{SectionID: section.ID, Name: "Apples", Position: 0})
	mustCreate(t, gdb, &models.GroceryItem{SectionID: section.ID, Name: "Bananas", Position: 1})

	if err := gdb.Delete(&section).Error; err != nil {
		t.Fatalf("delete section: %v", err)
	}
	var count int64
	gdb.Model(&models.GroceryItem{}).Where("section_id = ?", section.ID).Count(&count)
	if count != 0 {
		t.Fatalf("grocery items after delete = %d, want 0 (cascade)", count)
	}
}

func TestPantrySectionCascadeDeletesItems(t *testing.T) {
	gdb := newModelsDB(t)
	section := models.PantrySection{Name: "Freezer", Position: 0}
	mustCreate(t, gdb, &section)
	mustCreate(t, gdb, &models.PantryItem{SectionID: section.ID, Name: "Peas", Quantity: 2})

	if err := gdb.Delete(&section).Error; err != nil {
		t.Fatalf("delete section: %v", err)
	}
	var count int64
	gdb.Model(&models.PantryItem{}).Where("section_id = ?", section.ID).Count(&count)
	if count != 0 {
		t.Fatalf("pantry items after delete = %d, want 0 (cascade)", count)
	}
}

func TestTrackerListCascadeDeletesTasksSharesLogs(t *testing.T) {
	gdb := newModelsDB(t)
	list := models.TrackerList{OwnerSub: TestSub, Name: "Chores"}
	mustCreate(t, gdb, &list)
	task := models.TrackerTask{ListID: list.ID, Name: "Vacuum"}
	mustCreate(t, gdb, &task)
	mustCreate(t, gdb, &models.TrackerShare{ListID: list.ID, Sub: "friend-sub"})
	mustCreate(t, gdb, &models.TrackerLog{TaskID: task.ID})

	if err := gdb.Delete(&list).Error; err != nil {
		t.Fatalf("delete list: %v", err)
	}
	var tasks, shares, logs int64
	gdb.Model(&models.TrackerTask{}).Where("list_id = ?", list.ID).Count(&tasks)
	gdb.Model(&models.TrackerShare{}).Where("list_id = ?", list.ID).Count(&shares)
	gdb.Model(&models.TrackerLog{}).Where("task_id = ?", task.ID).Count(&logs)
	if tasks != 0 || shares != 0 || logs != 0 {
		t.Fatalf("after delete: tasks=%d shares=%d logs=%d, want all 0 (cascade)", tasks, shares, logs)
	}
}
