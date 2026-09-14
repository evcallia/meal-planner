// backend/internal/recipekeeper/store.go
package recipekeeper

import (
	"log"
	"strconv"
	"strings"

	"gorm.io/gorm"

	"mealplanner/internal/models"
)

// normalizeName is the case/whitespace-insensitive comparison used for both
// the collapse key and link lookups.
func normalizeName(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

// NormalizeName is normalizeName, exported so the app package can query
// RecipeKeeperLink.MPName directly (a targeted single-row lookup) without
// duplicating the case/whitespace rule.
func NormalizeName(s string) string { return normalizeName(s) }

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

// RowKey is the collapse key linking a Recipe Keeper row to a grocery row —
// exported so the app package can build the same key when joining
// RecipeKeeperLink rows against grocery items for serialization.
func RowKey(name string, checked bool) string { return collapseKey(name, checked) }

// QuantityOf is quantityOf, exported so the app package can detect a
// quantity decrease using the exact same string-to-int rule ConsumeUnits
// applies (unparseable or absent Quantity means "1 unit") — a handler that
// parsed it differently could diff a decrease ConsumeUnits would not see, or
// vice versa.
func QuantityOf(item *models.GroceryItem) int { return quantityOf(item) }

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

// findRow returns the grocery item for a collapse key, or nil if none exists.
// The query error is returned rather than swallowed: callers use a nil result
// to decide whether to CREATE a new row, so a transient DB error mistaken for
// "not found" would create a duplicate. Ordering is deterministic
// (position asc, id asc) so which row wins is defined if duplicates exist.
func findRow(db *gorm.DB, name string, checked bool) (*models.GroceryItem, error) {
	var items []models.GroceryItem
	if err := db.Where("checked = ?", checked).
		Order("position asc, id asc").Find(&items).Error; err != nil {
		return nil, err
	}
	want := normalizeName(name)
	for i := range items {
		if normalizeName(items[i].Name) == want {
			return &items[i], nil
		}
	}
	return nil, nil
}

// isTombstoned reports whether an RK item id was deleted locally and must not
// be re-imported. It fails CLOSED: a query error is treated as tombstoned
// (skipping this one item) rather than open, because the tombstone table IS
// the resurrection guard — skipping an item is recoverable on the next pull,
// resurrecting a deleted one is not.
func isTombstoned(db *gorm.DB, rkItemID string) bool {
	var n int64
	if err := db.Model(&models.RecipeKeeperTombstone{}).
		Where("rk_item_id = ?", rkItemID).Count(&n).Error; err != nil {
		log.Printf("recipekeeper: tombstone check failed for %s, treating as tombstoned: %v", rkItemID, err)
		return true
	}
	return n > 0
}
