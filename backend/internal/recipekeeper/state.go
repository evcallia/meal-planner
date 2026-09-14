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
)

// epochWatermark pulls everything: the .NET zero date.
const epochWatermark = "0001-01-01T00:00:00Z"

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
