// backend/internal/recipekeeper/reconcile.go
package recipekeeper

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/models"
)

type Changes struct {
	Added   []uuid.UUID
	Updated []uuid.UUID
	Deleted []uuid.UUID
}

func (c *Changes) Any() bool {
	return len(c.Added)+len(c.Updated)+len(c.Deleted) > 0
}

// Reconciler owns all sync logic. It never performs HTTP: callers hand it
// entities and take away the entities to push.
type Reconciler struct {
	DB     *gorm.DB
	ListID string
	Now    func() time.Time
}

func (r *Reconciler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return models.NowUTC()
}

// ApplyInbound folds server entities into the grocery list.
func (r *Reconciler) ApplyInbound(items []ShoppingListItem) (Changes, error) {
	var ch Changes
	for _, in := range items {
		if in.ShoppingListID != "" && in.ShoppingListID != r.ListID {
			continue
		}
		if isTombstoned(r.DB, in.ID) {
			continue
		}
		if err := r.applyOne(in, &ch); err != nil {
			return ch, err
		}
	}
	return ch, nil
}

func (r *Reconciler) applyOne(in ShoppingListItem, ch *Changes) error {
	var link models.RecipeKeeperLink
	err := r.DB.First(&link, "rk_item_id = ?", in.ID).Error
	hasLink := err == nil

	if in.IsDeleted {
		if !hasLink {
			return nil
		}
		return r.detachLink(&link, ch)
	}

	if hasLink {
		// Our own push echoing back through the doorbell.
		if in.LastModified != nil && *in.LastModified == link.RKLastModified {
			return nil
		}
		return r.moveLink(&link, in, ch)
	}
	return r.attachNew(in, ch)
}

// detachLink drops a link and decrements its row, deleting the row when the
// last link goes and no MP-only units remain.
func (r *Reconciler) detachLink(link *models.RecipeKeeperLink, ch *Changes) error {
	row := findRow(r.DB, link.MPName, link.MPChecked)
	if row == nil {
		return r.DB.Delete(link).Error
	}
	item := *row
	if err := r.DB.Delete(link).Error; err != nil {
		return err
	}
	qty := quantityOf(&item) - 1
	if qty <= 0 {
		ch.Deleted = append(ch.Deleted, item.ID)
		return r.DB.Delete(&item).Error
	}
	setQuantity(&item, qty)
	item.UpdatedAt = r.now()
	ch.Updated = append(ch.Updated, item.ID)
	return r.DB.Save(&item).Error
}

// moveLink applies a server-side name or check change, relocating the link to
// the row matching its new (name, checked) key. Both the grocery row and the
// link's cached RK state are written, so the outbound diff stays clean and the
// two sides cannot oscillate.
func (r *Reconciler) moveLink(link *models.RecipeKeeperLink, in ShoppingListItem, ch *Changes) error {
	sameRow := strings.EqualFold(link.RKName, in.Name) && link.RKChecked == in.IsChecked
	if !sameRow {
		if err := r.detachLink(link, ch); err != nil {
			return err
		}
		if err := r.attachNew(in, ch); err != nil {
			return err
		}
		return nil
	}
	link.RKLastModified = derefOr(in.LastModified, link.RKLastModified)
	link.RKPosition = in.Position
	return r.DB.Save(link).Error
}

// attachNew adds a unit for an item we have not seen, collapsing onto an
// existing row of the same (name, checked) when one exists.
func (r *Reconciler) attachNew(in ShoppingListItem, ch *Changes) error {
	row := findRow(r.DB, in.Name, in.IsChecked)
	if row == nil {
		created, err := r.createRow(in)
		if err != nil {
			return err
		}
		row = created
		ch.Added = append(ch.Added, row.ID)
	} else {
		setQuantity(row, quantityOf(row)+1)
		row.UpdatedAt = r.now()
		if err := r.DB.Save(row).Error; err != nil {
			return err
		}
		ch.Updated = append(ch.Updated, row.ID)
	}

	return r.DB.Create(&models.RecipeKeeperLink{
		RKItemID:       in.ID,
		MPName:         normalizeName(row.Name),
		MPChecked:      row.Checked,
		RKRecipeID:     in.RecipeID,
		RKName:         in.Name,
		RKChecked:      in.IsChecked,
		RKLastModified: derefOr(in.LastModified, ""),
		RKPosition:     in.Position,
	}).Error
}

func derefOr(p *string, fallback string) string {
	if p == nil {
		return fallback
	}
	return *p
}

// createRow makes a grocery row for a newly-seen RK item. Section placement is
// resolved once, in priority order: MP's own learned default, then RK's category
// name if a section by that name already exists, then Uncategorized.
func (r *Reconciler) createRow(in ShoppingListItem) (*models.GroceryItem, error) {
	sectionID, err := r.placeSection(in.Name)
	if err != nil {
		return nil, err
	}
	var maxPos struct{ P int }
	r.DB.Model(&models.GroceryItem{}).
		Select("COALESCE(MAX(position), -1) AS p").
		Where("section_id = ?", sectionID).Scan(&maxPos)

	item := &models.GroceryItem{
		ID:        models.NewID(),
		SectionID: sectionID,
		Name:      in.Name,
		Checked:   in.IsChecked,
		Position:  maxPos.P + 1,
		CreatedAt: r.now(),
		UpdatedAt: r.now(),
	}
	// A brand-new row represents exactly one unit.
	setQuantity(item, 1)

	var def models.ItemDefault
	if err := r.DB.First(&def, "LOWER(item_name) = LOWER(?)", in.Name).Error; err == nil {
		item.StoreID = def.StoreID
	}
	if err := r.DB.Create(item).Error; err != nil {
		return nil, err
	}
	return item, nil
}

// placeSection resolves the section for a newly-imported item name.
func (r *Reconciler) placeSection(name string) (uuid.UUID, error) {
	var def models.ItemDefault
	if err := r.DB.First(&def, "LOWER(item_name) = LOWER(?)", name).Error; err == nil &&
		def.SectionName != nil && *def.SectionName != "" {
		var sec models.GrocerySection
		if err := r.DB.First(&sec, "LOWER(name) = LOWER(?)", *def.SectionName).Error; err == nil {
			return sec.ID, nil
		}
	}
	if id, ok := r.sectionFromRKCategory(name); ok {
		return id, nil
	}
	var sec models.GrocerySection
	if err := r.DB.First(&sec, "LOWER(name) = LOWER(?)", "uncategorized").Error; err == nil {
		return sec.ID, nil
	}
	sec = models.GrocerySection{ID: models.NewID(), Name: "Uncategorized", CreatedAt: r.now()}
	if err := r.DB.Create(&sec).Error; err != nil {
		return uuid.Nil, err
	}
	return sec.ID, nil
}

// sectionFromRKCategory is filled in by Task 6, which caches RK's
// name -> category mapping. Until then no RK-derived placement occurs and the
// Uncategorized fallback applies.
func (r *Reconciler) sectionFromRKCategory(string) (uuid.UUID, bool) {
	return uuid.Nil, false
}
