// backend/internal/recipekeeper/reconcile.go
package recipekeeper

import (
	"errors"
	"log"
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
		// Strict comparison: importing a malformed or foreign-list item into
		// the shared household grocery list is worse than importing nothing.
		// An unset r.ListID therefore imports nothing — deliberate fail-safe
		// behavior until a later task resolves the list id before the first
		// sync.
		if in.ShoppingListID != r.ListID {
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
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}

	if in.IsDeleted {
		if !hasLink {
			return nil
		}
		return r.detachLink(&link, ch)
	}

	if hasLink {
		if in.LastModified == nil {
			// No new information from the server: nothing to apply.
			return nil
		}
		if *in.LastModified == link.RKLastModified {
			// Our own push echoing back through the doorbell.
			return nil
		}
		return r.moveLink(&link, in, ch)
	}
	return r.attachNew(in, ch)
}

// detachLink drops a link and decrements its row, deleting the row only once
// BOTH its quantity is spent AND no other link still references it. Quantity
// alone isn't enough: quantity >= COUNT(links) is the collapse invariant, but
// nothing enforces it against a manual user edit (e.g. a row with 3 links
// whose quantity gets edited down to 1) — checking linkCount here stops a
// row with surviving links from being deleted out from under them.
func (r *Reconciler) detachLink(link *models.RecipeKeeperLink, ch *Changes) error {
	row, err := findRow(r.DB, link.MPName, link.MPChecked)
	if err != nil {
		return err
	}
	if row == nil {
		return r.DB.Delete(link).Error
	}
	item := *row
	if err := r.DB.Delete(link).Error; err != nil {
		return err
	}
	qty := quantityOf(&item) - 1
	if qty <= 0 && linkCount(r.DB, item.Name, item.Checked) == 0 {
		ch.Deleted = append(ch.Deleted, item.ID)
		return r.DB.Delete(&item).Error
	}
	setQuantity(&item, qty)
	ch.Updated = append(ch.Updated, item.ID)
	return r.DB.Save(&item).Error
}

// moveLink applies a server-side name or check change, relocating the link to
// the row matching its new (name, checked) key. Both the grocery row and the
// link's cached RK state are written, so the outbound diff stays clean and the
// two sides cannot oscillate. Comparison is by collapse key, not raw name —
// collapseKey normalizes and trims, so e.g. "Lemon" -> "Lemon " must NOT read
// as a different row (that would detach-and-recreate a single-link row,
// resetting its id/StoreID/Position/section for no real change).
func (r *Reconciler) moveLink(link *models.RecipeKeeperLink, in ShoppingListItem, ch *Changes) error {
	sameRow := collapseKey(link.RKName, link.RKChecked) == collapseKey(in.Name, in.IsChecked)
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
	row, err := findRow(r.DB, in.Name, in.IsChecked)
	if err != nil {
		return err
	}
	if row == nil {
		created, err := r.createRow(in)
		if err != nil {
			return err
		}
		row = created
		ch.Added = append(ch.Added, row.ID)
	} else {
		setQuantity(row, quantityOf(row)+1)
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
	var maxPos struct{ P int }
	r.DB.Model(&models.GrocerySection{}).
		Select("COALESCE(MAX(position), -1) AS p").Scan(&maxPos)
	sec = models.GrocerySection{ID: models.NewID(), Name: "Uncategorized", Position: maxPos.P + 1, CreatedAt: r.now()}
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

// stripZ converts a server timestamp to the form the client must echo back.
// Server values carry Z; pushed values must not (docs/recipe-keeper-api.md).
func stripZ(s string) string { return strings.TrimSuffix(s, "Z") }

// PendingPushes diffs every link against its grocery row and returns the
// complete entities to push. Outbound state is derived, not queued: a failed
// push simply reappears on the next pass, and a restart loses nothing.
func (r *Reconciler) PendingPushes() ([]ShoppingListItem, error) {
	var out []ShoppingListItem

	// Tombstones: either a delete to push, or an undo to reverse.
	var tombs []models.RecipeKeeperTombstone
	if err := r.DB.Find(&tombs).Error; err != nil {
		return nil, err
	}
	for _, tomb := range tombs {
		var link models.RecipeKeeperLink
		hasLink := r.DB.First(&link, "rk_item_id = ?", tomb.RKItemID).Error == nil

		var row *models.GroceryItem
		if hasLink {
			var err error
			row, err = findRow(r.DB, link.MPName, link.MPChecked)
			if err != nil {
				return nil, err
			}
		}

		// Undo: the row is back. Recipe Keeper's deletes are soft, so reversing
		// one is an ordinary field update rather than a restore path.
		if hasLink && row != nil {
			if tomb.PushedAt == nil {
				// The delete never went out — just forget it.
				if err := r.DB.Delete(&tomb).Error; err != nil {
					return nil, err
				}
				continue
			}
			out = append(out, r.entityFor(link, link.RKName, link.RKChecked, false))
			continue
		}

		if tomb.PushedAt != nil {
			continue // already deleted on the server
		}
		if !hasLink {
			// Link already gone; synthesize the minimum the server needs.
			out = append(out, ShoppingListItem{
				ID: tomb.RKItemID, ShoppingListID: r.ListID, IsDeleted: true,
			})
			continue
		}
		out = append(out, r.entityFor(link, link.RKName, link.RKChecked, true))
	}

	// Then field diffs for links whose row has drifted from cached RK state.
	var links []models.RecipeKeeperLink
	if err := r.DB.Find(&links).Error; err != nil {
		return nil, err
	}
	for _, link := range links {
		if isTombstoned(r.DB, link.RKItemID) {
			continue // handled above
		}
		row, err := findRow(r.DB, link.MPName, link.MPChecked)
		if err != nil {
			return nil, err
		}
		if row == nil {
			// An unresolvable link with no tombstone is an orphan. Log and drop
			// it: deletion is only ever expressed by a tombstone, never inferred.
			log.Printf("recipekeeper: orphan link %s (%s/%v), dropping",
				link.RKItemID, link.MPName, link.MPChecked)
			if err := r.DB.Delete(&models.RecipeKeeperLink{}, "rk_item_id = ?", link.RKItemID).Error; err != nil {
				return nil, err
			}
			continue
		}
		if collapseKey(row.Name, row.Checked) == collapseKey(link.RKName, link.RKChecked) {
			continue
		}
		out = append(out, r.entityFor(link, row.Name, row.Checked, false))
	}
	return out, nil
}

// entityFor builds a complete entity from the link's cached fields, replacing
// only what changed. The protocol has no partial updates: any field omitted or
// stale here overwrites the server's value.
func (r *Reconciler) entityFor(link models.RecipeKeeperLink, name string, checkedNow, isDelete bool) ShoppingListItem {
	synced := true
	item := ShoppingListItem{
		ID:                     link.RKItemID,
		Name:                   name,
		ShoppingListID:         r.ListID,
		IsChecked:              checkedNow,
		Position:               link.RKPosition,
		RecipeID:               link.RKRecipeID,
		IsSyncedToExternalList: &synced,
		IsDeleted:              isDelete,
	}
	if lm := stripZ(link.RKLastModified); lm != "" {
		item.LastModified = &lm
	}
	if checkedNow {
		// Naive UTC with no zone suffix, matching the client's own encoding.
		d := r.now().UTC().Format("2006-01-02T15:04:05.0000000")
		item.CheckedDate = &d
	}
	return item
}

// ApplyAcks writes the server's authoritative timestamps back onto links and
// marks pushed tombstones. Skipping this would leave every link permanently
// dirty, re-pushing the same change forever.
func (r *Reconciler) ApplyAcks(acks []AckItem) error {
	now := r.now()
	for _, ack := range acks {
		var link models.RecipeKeeperLink
		hasLink := r.DB.First(&link, "rk_item_id = ?", ack.ID).Error == nil

		var tomb models.RecipeKeeperTombstone
		if err := r.DB.First(&tomb, "rk_item_id = ?", ack.ID).Error; err == nil {
			var row *models.GroceryItem
			if hasLink {
				var ferr error
				row, ferr = findRow(r.DB, link.MPName, link.MPChecked)
				if ferr != nil {
					return ferr
				}
			}
			// An un-delete: the row came back, so the tombstone is spent.
			if hasLink && row != nil {
				if err := r.DB.Delete(&tomb).Error; err != nil {
					return err
				}
				link.RKLastModified = ack.LastModified
				if err := r.DB.Save(&link).Error; err != nil {
					return err
				}
				continue
			}
			tomb.PushedAt = &now
			lm := ack.LastModified
			tomb.AckLastModified = &lm
			if err := r.DB.Save(&tomb).Error; err != nil {
				return err
			}
			// The link is KEPT until the tombstone is pruned, so an undo arriving
			// after the push still has an entity to rebuild from.
			continue
		}

		if !hasLink {
			continue
		}
		row, err := findRow(r.DB, link.MPName, link.MPChecked)
		if err != nil {
			return err
		}
		if row != nil {
			link.RKName = row.Name
			link.RKChecked = row.Checked
		}
		link.RKLastModified = ack.LastModified
		if err := r.DB.Save(&link).Error; err != nil {
			return err
		}
	}
	return nil
}

// TombstoneLinks records that a grocery row was deleted locally, so each of its
// RK rows gets a delete push and cannot be re-imported meanwhile. Addressed by
// collapse key, since the row may already be gone by the time this runs.
func (r *Reconciler) TombstoneLinks(name string, checked bool) error {
	for _, link := range linksFor(r.DB, name, checked) {
		tomb := models.RecipeKeeperTombstone{RKItemID: link.RKItemID, DeletedAt: r.now()}
		if err := r.DB.Where("rk_item_id = ?", link.RKItemID).
			FirstOrCreate(&tomb).Error; err != nil {
			return err
		}
	}
	return nil
}

// RetargetLinks moves a row's links from one collapse key to another. Meal
// Planner mutates a grocery row in place — checking it flips a flag, renaming
// it rewrites Name — but links are keyed by (name, checked). Without
// retargeting, the link resolves to nothing, PendingPushes classifies it as an
// orphan and drops it, and the edit never reaches Recipe Keeper.
func (r *Reconciler) RetargetLinks(fromName string, fromChecked bool, toName string, toChecked bool) error {
	from := normalizeName(fromName)
	to := normalizeName(toName)
	if from == to && fromChecked == toChecked {
		return nil
	}
	return r.DB.Model(&models.RecipeKeeperLink{}).
		Where("mp_name = ? AND mp_checked = ?", from, fromChecked).
		Updates(map[string]any{"mp_name": to, "mp_checked": toChecked}).Error
}
