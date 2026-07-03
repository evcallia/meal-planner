package db

// Port of backend/tests/test_cleanup.py, plus the meaningful remainder of
// backend/tests/test_database.py.
//
// Skipped from test_database.py: TestGetDb (test_get_db_yields_and_closes,
// test_get_db_closes_on_exception) — those verify SQLAlchemy's per-request
// session generator, which has no Go counterpart (GORM manages a connection
// pool; there is no get_db dependency to open/close). In their place,
// TestOpenSQLiteMemory* cover this package's actual database setup contract.

import (
	"testing"
	"time"

	"mealplanner/internal/models"

	"gorm.io/gorm"
)

func newTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	gdb, err := OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	return gdb
}

func todayUTC() time.Time {
	return time.Now().UTC().Truncate(24 * time.Hour)
}

// ---- test_cleanup.py ----

func TestCleanupUsesRetentionSettingForMealNotes(t *testing.T) {
	gdb := newTestDB(t)
	today := todayUTC()

	oldNote := models.MealNote{Date: today.AddDate(0, 0, -101), Notes: "too old"}
	keptNote := models.MealNote{Date: today.AddDate(0, 0, -99), Notes: "kept"}
	for _, n := range []*models.MealNote{&oldNote, &keptNote} {
		if err := gdb.Create(n).Error; err != nil {
			t.Fatalf("create note: %v", err)
		}
	}

	CleanupOldData(gdb, 100)

	var remaining []models.MealNote
	if err := gdb.Find(&remaining).Error; err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(remaining) != 1 || remaining[0].Notes != "kept" {
		got := make([]string, 0, len(remaining))
		for _, n := range remaining {
			got = append(got, n.Notes)
		}
		t.Fatalf("remaining notes = %v, want [kept]", got)
	}
}

func TestCleanupKeeps30DayCutoffForCachedEvents(t *testing.T) {
	gdb := newTestDB(t)
	today := todayUTC()

	for _, tc := range []struct {
		days  int
		title string
	}{{-31, "old"}, {-29, "kept"}} {
		eventDate := today.AddDate(0, 0, tc.days)
		endTime := eventDate.Add(24*time.Hour - time.Second)
		event := models.CachedCalendarEvent{
			EventDate:    eventDate,
			EventUID:     "uid-" + tc.title,
			CalendarName: "Personal",
			Title:        tc.title,
			StartTime:    eventDate,
			EndTime:      &endTime,
			AllDay:       true,
		}
		if err := gdb.Create(&event).Error; err != nil {
			t.Fatalf("create event: %v", err)
		}
	}

	// Retention setting only governs meal notes; cached events keep a fixed
	// 30-day cutoff.
	CleanupOldData(gdb, 365)

	var remaining []models.CachedCalendarEvent
	if err := gdb.Find(&remaining).Error; err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(remaining) != 1 || remaining[0].Title != "kept" {
		got := make([]string, 0, len(remaining))
		for _, e := range remaining {
			got = append(got, e.Title)
		}
		t.Fatalf("remaining events = %v, want [kept]", got)
	}
}

// ---- test_database.py (adapted) ----

func TestOpenSQLiteMemoryEnforcesForeignKeys(t *testing.T) {
	gdb := newTestDB(t)

	var fkOn int
	if err := gdb.Raw("PRAGMA foreign_keys").Scan(&fkOn).Error; err != nil {
		t.Fatalf("pragma query: %v", err)
	}
	if fkOn != 1 {
		t.Fatalf("foreign_keys pragma = %d, want 1", fkOn)
	}
}

func TestCreateAllCreatesTables(t *testing.T) {
	gdb := newTestDB(t)

	for _, table := range []string{
		"meal_notes", "meal_items", "cached_calendar_events",
		"calendar_cache_metadata", "hidden_calendar_events",
		"grocery_sections", "grocery_items", "pantry_sections", "pantry_items",
		"stores", "item_defaults", "meal_ideas", "user_settings", "users",
		"tracker_lists", "tracker_shares", "tracker_list_positions",
		"tracker_tasks", "tracker_logs",
	} {
		if !gdb.Migrator().HasTable(table) {
			t.Fatalf("table %q not created by CreateAll", table)
		}
	}
}
