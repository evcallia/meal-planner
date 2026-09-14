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

// ---- Recipe Keeper tombstone pruning ----

func strPtr(s string) *string { return &s }

func TestCleanupPrunesSettledTombstones(t *testing.T) {
	gdb := newTestDB(t)
	gdb.Create(&models.RecipeKeeperState{
		Key: "watermark:ShoppingListItem", Value: "2026-09-14T12:00:00.0000000Z",
	})
	now := models.NowUTC()

	// Settled: pushed, and the watermark has moved past the ack — safe to prune,
	// along with its paired link row.
	gdb.Create(&models.RecipeKeeperTombstone{
		RKItemID: "settled", DeletedAt: now, PushedAt: &now,
		AckLastModified: strPtr("2026-09-14T10:00:00.0000000Z"),
	})
	gdb.Create(&models.RecipeKeeperLink{RKItemID: "settled", MPName: "settled item"})

	// Pushed, but the watermark has NOT yet passed the ack — still needed.
	gdb.Create(&models.RecipeKeeperTombstone{
		RKItemID: "recent", DeletedAt: now, PushedAt: &now,
		AckLastModified: strPtr("2026-09-14T13:00:00.0000000Z"),
	})
	gdb.Create(&models.RecipeKeeperLink{RKItemID: "recent", MPName: "recent item"})

	// Never pushed — this is a pending delete and must survive.
	gdb.Create(&models.RecipeKeeperTombstone{RKItemID: "pending", DeletedAt: now})

	CleanupOldData(gdb, 30)

	var ids []string
	gdb.Model(&models.RecipeKeeperTombstone{}).Pluck("rk_item_id", &ids)
	if len(ids) != 2 {
		t.Fatalf("remaining tombstones = %v, want [recent pending]", ids)
	}
	for _, id := range ids {
		if id == "settled" {
			t.Error("settled tombstone should have been pruned")
		}
	}

	var linkIDs []string
	gdb.Model(&models.RecipeKeeperLink{}).Pluck("rk_item_id", &linkIDs)
	if len(linkIDs) != 1 || linkIDs[0] != "recent" {
		t.Fatalf("remaining links = %v, want [recent] (settled's paired link should be pruned too)", linkIDs)
	}
}

func TestCleanupDropsOldSettledTombstonesEvenWithoutWatermark(t *testing.T) {
	gdb := newTestDB(t)
	old := models.NowUTC().AddDate(0, 0, -31)
	gdb.Create(&models.RecipeKeeperTombstone{RKItemID: "old-settled", DeletedAt: old, PushedAt: &old})

	CleanupOldData(gdb, 30)

	var ids []string
	gdb.Model(&models.RecipeKeeperTombstone{}).Pluck("rk_item_id", &ids)
	if len(ids) != 0 {
		t.Fatalf("remaining = %v, want none (30-day backstop should have pruned it)", ids)
	}
}

func TestCleanupAbandonsStaleUnpushedTombstones(t *testing.T) {
	gdb := newTestDB(t)
	stale := models.NowUTC().AddDate(0, 0, -91)
	recent := models.NowUTC().AddDate(0, 0, -10)
	gdb.Create(&models.RecipeKeeperTombstone{RKItemID: "abandoned", DeletedAt: stale})
	gdb.Create(&models.RecipeKeeperTombstone{RKItemID: "still-pending", DeletedAt: recent})

	CleanupOldData(gdb, 30)

	var ids []string
	gdb.Model(&models.RecipeKeeperTombstone{}).Pluck("rk_item_id", &ids)
	if len(ids) != 1 || ids[0] != "still-pending" {
		t.Fatalf("remaining = %v, want [still-pending]", ids)
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
