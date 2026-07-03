package db

// Tests for RunMigrations, the port of main.run_migrations: NULL backfills for
// columns Python added with DEFAULTs, and the pantry orphan-item migration.

import (
	"testing"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

func TestRunMigrationsBackfillsNullTrackerLogKind(t *testing.T) {
	gdb, err := OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	lst := models.TrackerList{OwnerSub: "u1", Name: "L"}
	if err := gdb.Create(&lst).Error; err != nil {
		t.Fatalf("create list: %v", err)
	}
	task := models.TrackerTask{ListID: lst.ID, Name: "T"}
	if err := gdb.Create(&task).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}
	// A pre-upgrade row: kind is NULL (the column DEFAULT only applies to new rows).
	logID := uuid.New().String()
	if err := gdb.Exec(
		"INSERT INTO tracker_logs (id, task_id, done_at, kind, created_at) VALUES (?, ?, ?, NULL, ?)",
		logID, task.ID.String(), models.NowUTC(), models.NowUTC(),
	).Error; err != nil {
		t.Fatalf("insert legacy log: %v", err)
	}

	if err := RunMigrations(gdb); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}

	var kind string
	if err := gdb.Raw("SELECT kind FROM tracker_logs WHERE id = ?", logID).Scan(&kind).Error; err != nil {
		t.Fatalf("select kind: %v", err)
	}
	if kind != "done" {
		t.Fatalf("kind = %q, want done", kind)
	}
}

func TestRunMigrationsBackfillsNullCachedEventColumns(t *testing.T) {
	gdb, err := OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	id := uuid.New().String()
	if err := gdb.Exec(
		"INSERT INTO cached_calendar_events (id, event_date, event_uid, calendar_name, title, start_time, all_day, created_at) "+
			"VALUES (?, ?, NULL, NULL, 'Legacy', ?, 0, ?)",
		id, models.NowUTC(), models.NowUTC(), models.NowUTC(),
	).Error; err != nil {
		t.Fatalf("insert legacy event: %v", err)
	}

	if err := RunMigrations(gdb); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}

	var row struct {
		EventUID     string
		CalendarName string
	}
	if err := gdb.Raw("SELECT event_uid, calendar_name FROM cached_calendar_events WHERE id = ?", id).
		Scan(&row).Error; err != nil {
		t.Fatalf("select: %v", err)
	}
	if row.EventUID != "" || row.CalendarName != "" {
		t.Fatalf("backfill failed: %+v", row)
	}
	// The row scans cleanly through GORM's non-pointer fields now.
	var ev models.CachedCalendarEvent
	if err := gdb.Where("id = ?", id).First(&ev).Error; err != nil {
		t.Fatalf("scan model: %v", err)
	}
}

func TestRunMigrationsBackfillsNullPositions(t *testing.T) {
	gdb, err := OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	gsec := models.GrocerySection{Name: "Produce"}
	if err := gdb.Create(&gsec).Error; err != nil {
		t.Fatalf("create grocery section: %v", err)
	}
	psec := models.PantrySection{Name: "Staples"}
	if err := gdb.Create(&psec).Error; err != nil {
		t.Fatalf("create pantry section: %v", err)
	}
	gid, pid := uuid.New().String(), uuid.New().String()
	if err := gdb.Exec(
		"INSERT INTO grocery_items (id, section_id, name, checked, position, created_at, updated_at) VALUES (?, ?, 'Apples', 0, NULL, ?, ?)",
		gid, gsec.ID.String(), models.NowUTC(), models.NowUTC(),
	).Error; err != nil {
		t.Fatalf("insert grocery item: %v", err)
	}
	if err := gdb.Exec(
		"INSERT INTO pantry_items (id, section_id, name, quantity, position, created_at, updated_at) VALUES (?, ?, 'Rice', 1, NULL, ?, ?)",
		pid, psec.ID.String(), models.NowUTC(), models.NowUTC(),
	).Error; err != nil {
		t.Fatalf("insert pantry item: %v", err)
	}

	if err := RunMigrations(gdb); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}

	var pos int
	if err := gdb.Raw("SELECT position FROM grocery_items WHERE id = ?", gid).Scan(&pos).Error; err != nil || pos != 0 {
		t.Fatalf("grocery position = %d err = %v, want 0", pos, err)
	}
	if err := gdb.Raw("SELECT position FROM pantry_items WHERE id = ?", pid).Scan(&pos).Error; err != nil || pos != 0 {
		t.Fatalf("pantry position = %d err = %v, want 0", pos, err)
	}
}

func TestRunMigrationsCollectsOrphanPantryItemsIntoGeneral(t *testing.T) {
	gdb, err := OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	// Pre-section rows: NULL section_id. Inserted out of name order to verify
	// the migration orders positions by name ASC.
	for _, name := range []string{"Zucchini", "Apples", "Milk"} {
		if err := gdb.Exec(
			"INSERT INTO pantry_items (id, section_id, name, quantity, position, created_at, updated_at) VALUES (?, NULL, ?, 1, 0, ?, ?)",
			uuid.New().String(), name, models.NowUTC(), models.NowUTC(),
		).Error; err != nil {
			t.Fatalf("insert orphan %s: %v", name, err)
		}
	}

	if err := RunMigrations(gdb); err != nil {
		t.Fatalf("RunMigrations: %v", err)
	}

	var section models.PantrySection
	if err := gdb.Where("name = ?", "General").First(&section).Error; err != nil {
		t.Fatalf("General section not created: %v", err)
	}
	if section.Position != 0 {
		t.Fatalf("General position = %d, want 0", section.Position)
	}
	var items []models.PantryItem
	if err := gdb.Where("section_id = ?", section.ID).Order("position ASC").Find(&items).Error; err != nil {
		t.Fatalf("find items: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("migrated items = %d, want 3", len(items))
	}
	wantOrder := []string{"Apples", "Milk", "Zucchini"}
	for i, item := range items {
		if item.Name != wantOrder[i] || item.Position != i {
			t.Fatalf("item[%d] = %s pos %d, want %s pos %d", i, item.Name, item.Position, wantOrder[i], i)
		}
	}
	// No orphans remain.
	var orphanCount int64
	gdb.Model(&models.PantryItem{}).Where("section_id IS NULL").Count(&orphanCount)
	if orphanCount != 0 {
		t.Fatalf("orphans remaining = %d", orphanCount)
	}
}

func TestRunMigrationsNoOpOnCleanDatabase(t *testing.T) {
	gdb, err := OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	if err := RunMigrations(gdb); err != nil {
		t.Fatalf("RunMigrations on clean DB: %v", err)
	}
	// No General section should be invented when there are no orphans.
	var count int64
	gdb.Model(&models.PantrySection{}).Where("name = ?", "General").Count(&count)
	if count != 0 {
		t.Fatalf("unexpected General section created")
	}
}
