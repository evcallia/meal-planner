package models

import (
	"time"

	"gorm.io/gorm"
)

// RecipeKeeperLink ties one Recipe Keeper shopping-list row to the grocery row
// that represents it. Many links may share a grocery row: Recipe Keeper stores a
// separate row per recipe-ingredient occurrence, so "Lemon" needed by six
// recipes is six RK rows collapsed into one grocery row.
//
// MPName/MPChecked are the COLLAPSE KEY, deliberately not a grocery_items FK.
// PUT /api/grocery (used by undo of delete and clear) deletes every section and
// recreates the list with fresh ids, so a real FK with ON DELETE CASCADE would
// wipe this entire table on the first undo. Keying by (name, checked) — what the
// model already groups on — survives that id churn.
//
// RKName/RKChecked cache the last known server state so the outbound reconcile
// can diff against it without a network round trip.
type RecipeKeeperLink struct {
	RKItemID       string  `gorm:"type:text;primaryKey"`
	MPName         string  `gorm:"type:text;index"` // normalized: lowercased, trimmed
	MPChecked      bool    `gorm:"index"`
	RKRecipeID     *string `gorm:"type:text;index"`
	RKName         string  `gorm:"type:text"`
	RKChecked      bool
	RKLastModified string `gorm:"type:text"`
	RKPosition     int
}

// RecipeKeeperRecipe caches recipe id -> title. Only the title is stored; the
// full recipe entity embeds base64 photos and is far too large to keep.
type RecipeKeeperRecipe struct {
	RKRecipeID     string `gorm:"type:text;primaryKey"`
	Title          string `gorm:"type:text"`
	RKLastModified string `gorm:"type:text"`
}

// RecipeKeeperTombstone records a locally-deleted RK row. It serves two jobs:
// PushedAt nil means the delete still needs pushing, and the row's existence
// stops a not-yet-synced delete from being re-imported on the next pull.
type RecipeKeeperTombstone struct {
	RKItemID        string `gorm:"type:text;primaryKey"`
	DeletedAt       time.Time
	PushedAt        *time.Time
	AckLastModified *string `gorm:"type:text"`
}

// RecipeKeeperState is a key/value bag for sync watermarks, the generated
// device id, last sync time, and last error.
type RecipeKeeperState struct {
	Key   string `gorm:"type:text;primaryKey"`
	Value string `gorm:"type:text"`
}

func (m *RecipeKeeperTombstone) BeforeCreate(tx *gorm.DB) error {
	if m.DeletedAt.IsZero() {
		m.DeletedAt = NowUTC()
	}
	return nil
}
