// backend/internal/recipekeeper/store.go
package recipekeeper

import (
	"strconv"
	"strings"

	"gorm.io/gorm"

	"mealplanner/internal/models"
)

// normalizeName is the case/whitespace-insensitive comparison used for both
// the collapse key and link lookups.
func normalizeName(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// collapseKey groups grocery rows. Name is compared case-insensitively, and
// checked is part of the key because MP represents "bought 1, still need 3" as
// two rows of the same name (see useGroceryList.ts:458).
func collapseKey(name string, checked bool) string {
	k := normalizeName(name)
	if checked {
		return k + "\x00checked"
	}
	return k
}

func quantityOf(item *models.GroceryItem) int {
	if item.Quantity == nil || *item.Quantity == "" {
		return 1
	}
	n, err := strconv.Atoi(*item.Quantity)
	if err != nil || n < 1 {
		return 1
	}
	return n
}

func setQuantity(item *models.GroceryItem, n int) {
	if n <= 1 {
		item.Quantity = nil
		return
	}
	s := strconv.Itoa(n)
	item.Quantity = &s
}

// linksFor returns the links belonging to a grocery row, addressed by collapse
// key rather than id — grocery ids churn on every replace (see the model docs).
func linksFor(db *gorm.DB, name string, checked bool) []models.RecipeKeeperLink {
	var links []models.RecipeKeeperLink
	db.Order("rk_position asc").
		Find(&links, "mp_name = ? AND mp_checked = ?", normalizeName(name), checked)
	return links
}

func linkCount(db *gorm.DB, name string, checked bool) int {
	var n int64
	db.Model(&models.RecipeKeeperLink{}).
		Where("mp_name = ? AND mp_checked = ?", normalizeName(name), checked).Count(&n)
	return int(n)
}

// findRow returns the grocery item for a collapse key, or nil.
func findRow(db *gorm.DB, name string, checked bool) *models.GroceryItem {
	var items []models.GroceryItem
	db.Where("checked = ?", checked).Find(&items)
	want := normalizeName(name)
	for i := range items {
		if normalizeName(items[i].Name) == want {
			return &items[i]
		}
	}
	return nil
}

func isTombstoned(db *gorm.DB, rkItemID string) bool {
	var n int64
	db.Model(&models.RecipeKeeperTombstone{}).Where("rk_item_id = ?", rkItemID).Count(&n)
	return n > 0
}
