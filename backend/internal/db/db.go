// Package db opens the database and ports main.py's startup work:
// create_all (AutoMigrate), run_migrations, and cleanup_old_data.
package db

import (
	"fmt"
	"log"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"mealplanner/internal/config"
	"mealplanner/internal/models"
)

// Open connects to Postgres using the app settings.
func Open(s *config.Settings) (*gorm.DB, error) {
	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable client_encoding=UTF8",
		s.PostgresHost, s.PostgresPort, s.PostgresUser, s.PostgresPassword, s.PostgresDB)
	return gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
}

// OpenSQLiteMemory opens an in-memory SQLite DB (tests), with FKs enforced.
func OpenSQLiteMemory() (*gorm.DB, error) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		return nil, err
	}
	if err := db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
		return nil, err
	}
	// A single shared in-memory DB must not be used from multiple pooled
	// connections (each pool conn would get its own empty DB).
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(1)
	return db, nil
}

// CreateAll mirrors Base.metadata.create_all + adds missing columns.
func CreateAll(db *gorm.DB) error {
	return db.AutoMigrate(models.AllModels()...)
}

// RunMigrations ports main.run_migrations. AutoMigrate already adds missing
// columns, so what remains is backfilling values Python set via column
// DEFAULTs, and the pantry section data migration.
func RunMigrations(db *gorm.DB) error {
	// Columns Python added with a DEFAULT: backfill NULLs so non-pointer Go
	// fields scan cleanly on databases upgraded in place.
	backfills := []struct{ table, column, value string }{
		{"cached_calendar_events", "calendar_name", "''"},
		{"cached_calendar_events", "event_uid", "''"},
		{"tracker_logs", "kind", "'done'"},
		{"grocery_items", "position", "0"},
		{"pantry_items", "position", "0"},
	}
	for _, b := range backfills {
		if db.Migrator().HasColumn(b.table, b.column) {
			if err := db.Exec(fmt.Sprintf(
				"UPDATE %s SET %s = %s WHERE %s IS NULL", b.table, b.column, b.value, b.column,
			)).Error; err != nil {
				return err
			}
		}
	}

	// Pantry section migration: items that predate sections have NULL
	// section_id — collect them into a "General" section, ordered by name.
	var orphanCount int64
	if err := db.Model(&models.PantryItem{}).Where("section_id IS NULL").Count(&orphanCount).Error; err == nil && orphanCount > 0 {
		log.Println("Migrating pantry_items to section-based structure...")
		section := models.PantrySection{Name: "General", Position: 0}
		if err := db.Create(&section).Error; err != nil {
			return err
		}
		var orphans []models.PantryItem
		if err := db.Where("section_id IS NULL").Order("name ASC").Find(&orphans).Error; err != nil {
			return err
		}
		for i, item := range orphans {
			if err := db.Model(&models.PantryItem{}).Where("id = ?", item.ID).
				Updates(map[string]any{"section_id": section.ID, "position": i}).Error; err != nil {
				return err
			}
		}
		log.Println("Migration complete: pantry_items now use sections")
	}

	// Drop the broken functional index if it exists (replaced with a plain
	// unique constraint) — best-effort, mirroring Python.
	_ = db.Exec("DROP INDEX IF EXISTS ix_stores_name_lower").Error

	return nil
}

// CleanupOldData deletes old meal notes and stale cached calendar events.
func CleanupOldData(db *gorm.DB, retentionDays int) {
	today := time.Now().UTC().Truncate(24 * time.Hour)
	notesCutoff := today.AddDate(0, 0, -retentionDays)
	eventsCutoff := today.AddDate(0, 0, -30)

	notes := db.Where("date < ?", notesCutoff).Delete(&models.MealNote{})
	events := db.Where("event_date < ?", eventsCutoff).Delete(&models.CachedCalendarEvent{})
	log.Printf("Cleaned up %d meal notes older than %s and %d cached events older than %s",
		notes.RowsAffected, notesCutoff.Format("2006-01-02"),
		events.RowsAffected, eventsCutoff.Format("2006-01-02"))
}
