// backend/internal/recipekeeper/state.go
package recipekeeper

import (
	"gorm.io/gorm"

	"mealplanner/internal/models"
)

const (
	stateWatermarkItem     = "watermark:ShoppingListItem"
	stateWatermarkRecipe   = "watermark:Recipe"
	stateWatermarkCategory = "watermark:ShoppingListCategory"
	stateWatermarkCatItem  = "watermark:ShoppingListCategoryItem"
	stateDeviceID          = "device_id"
	stateLastSync          = "last_sync"
	stateLastError         = "last_error"
	stateAuthFailed        = "auth_failed"

	// stateSelectedList/stateSelectedListName hold the household's chosen
	// Recipe Keeper shopping list — the household-global answer to "which
	// list do we mirror", set via PUT /api/recipe-keeper/list. The name is
	// cached alongside the id (captured from the live list at selection
	// time) purely so Status can display "Groceries" instead of a GUID
	// without an extra network round trip.
	stateSelectedList     = "selected_list_id"
	stateSelectedListName = "selected_list_name"
)

// epochWatermark bootstraps a bucket's first pull: old enough that
// everything is newer. It is deliberately NOT .NET's DateTime.MinValue
// ("0001-01-01T00:00:00Z") — the server returns 500 "An unhandled
// exception occurred" for that value, verified against the live API,
// almost certainly a timezone-conversion underflow on their side. Test
// doubles accept anything, so only live traffic catches this.
const epochWatermark = "1970-01-01T00:00:00.0000000Z"

func getState(db *gorm.DB, key, fallback string) string {
	var row models.RecipeKeeperState
	if err := db.First(&row, "key = ?", key).Error; err != nil {
		return fallback
	}
	return row.Value
}

func setState(db *gorm.DB, key, value string) {
	db.Save(&models.RecipeKeeperState{Key: key, Value: value})
}

// SelectedListID returns the persisted Recipe Keeper shopping-list selection,
// or "" if none has been made yet (the state a fresh install, or one whose
// credentials were just configured, is in).
func SelectedListID(db *gorm.DB) string {
	return getState(db, stateSelectedList, "")
}

// SelectedListName returns the cached display name for the selected list
// (see stateSelectedListName), or "" if none is selected.
func SelectedListName(db *gorm.DB) string {
	return getState(db, stateSelectedListName, "")
}

// DeviceID returns a stable per-install identifier, generating one on first use.
// It must not change between requests — a fresh id each time would present as an
// unbounded fleet of new devices.
func DeviceID(db *gorm.DB) string {
	if v := getState(db, stateDeviceID, ""); v != "" {
		return v
	}
	id := models.NewID().String()
	setState(db, stateDeviceID, id)
	return id
}
