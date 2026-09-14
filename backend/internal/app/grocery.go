package app

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/push"
	"mealplanner/internal/recipekeeper"
	"mealplanner/internal/session"
)

func (a *App) broadcast(eventType string, payload J, r *http.Request) {
	// A "pushDetail" entry customizes the notification/activity phrasing for
	// actions whose SSE payload doesn't carry a name (deletes); it is
	// stripped before the payload goes out on the wire.
	detailOverride, _ := payload["pushDetail"].(string)
	delete(payload, "pushDetail")
	a.Broadcaster.BroadcastEvent(eventType, payload, httpx.SourceID(r))
	// Shared-data edits also fan out as push notifications to everyone except
	// the editor (suppressed while the editor keeps editing — see push pkg).
	detail, notify := editPushDetail(eventType, payload)
	if !notify {
		return
	}
	if detailOverride != "" {
		detail = detailOverride
	}
	if actor := session.UserFrom(a.Sessions.Get(r)); actor != nil {
		a.Push.QueueEdit(eventType, actor.Sub, displayName(actor), detail)
		if category, ok := push.EditEventCategories[eventType]; ok {
			a.logActivity(category, detail, actor, nil)
		}
	}
}

// recipeKeeperTombstone records that a grocery row (addressed by its
// collapse key) was deleted locally, so any Recipe Keeper rows linked to it
// get a delete pushed on the next reconcile and are not re-imported in the
// meantime. A no-op — and safe to call unconditionally from call sites that
// already guard on a.RecipeKeeper themselves — when the integration is off.
// Failures are logged, not surfaced: the grocery mutation itself must
// succeed even if Recipe Keeper bookkeeping fails.
func (a *App) recipeKeeperTombstone(name string, checked bool) {
	if a.RecipeKeeper == nil {
		return
	}
	if err := a.RecipeKeeper.Rec.TombstoneLinks(name, checked); err != nil {
		log.Printf("recipekeeper: tombstone: %v", err)
	}
}

// recipeKeeperKick fires an out-of-band reconcile after a mutation touched
// Recipe Keeper links, so the resulting push goes out within seconds instead
// of waiting for the 15-minute safety timer. It runs detached with its own
// timeout and must never block the HTTP response — SyncOnce talks to a
// third-party API over the network.
func (a *App) recipeKeeperKick() {
	if a.RecipeKeeper == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = a.RecipeKeeper.SyncOnce(ctx)
	}()
}

// upsertSectionDefault mirrors grocery._upsert_section_default: remember the
// section an item was placed in (leaves store_id untouched).
func upsertSectionDefault(db *gorm.DB, itemName, sectionName string) error {
	normalized := strings.ToLower(strings.TrimSpace(itemName))
	var def models.ItemDefault
	err := db.Where("item_name = ?", normalized).First(&def).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return db.Create(&models.ItemDefault{ItemName: normalized, SectionName: &sectionName}).Error
	}
	if err != nil {
		return err
	}
	def.SectionName = &sectionName
	return db.Save(&def).Error
}

// storeDefaultFor returns the remembered store for an item name, if any.
func storeDefaultFor(db *gorm.DB, itemName string) *uuid.UUID {
	var def models.ItemDefault
	err := db.Where("item_name = ?", strings.ToLower(strings.TrimSpace(itemName))).First(&def).Error
	if err != nil || def.StoreID == nil {
		return nil
	}
	return def.StoreID
}

func (a *App) loadGrocerySections() ([]models.GrocerySection, error) {
	var sections []models.GrocerySection
	err := a.DB.Preload("Items").Order("position ASC").Find(&sections).Error
	return sections, err
}

// grocerySectionsJSON serializes a full response. It loads the recipe
// attribution map once (recipeRefsByKey) rather than per item, since a
// response can carry ~200 items.
func grocerySectionsJSON(db *gorm.DB, sections []models.GrocerySection) []J {
	refsByKey := recipeRefsByKey(db)
	out := make([]J, 0, len(sections))
	for i := range sections {
		out = append(out, grocerySectionJSON(&sections[i], refsByKey))
	}
	return out
}

// groceryItemJSON and grocerySectionJSON (App methods, below) are
// single-item/single-section convenience wrappers for the mutation
// endpoints. They use recipeRefsForKey (targeted per-row queries) rather
// than the bulk recipeRefsByKey — these are the hottest endpoints in the
// app (add/update/move item, rename/create section), and a full-table scan
// of every Recipe Keeper link and recipe on each of them would grow with
// the size of the whole Recipe Keeper cache instead of with what's actually
// being returned.
func (a *App) groceryItemJSON(item *models.GroceryItem) J {
	return groceryItemJSON(item, recipeRefsForKey(a.DB, item.Name, item.Checked))
}

func (a *App) grocerySectionJSON(section *models.GrocerySection) J {
	// A section's items are few (a handful, not the ~200-item whole list),
	// so one targeted query per item still scales with the response, not
	// with total Recipe Keeper data.
	refsByKey := make(map[string][]recipekeeper.RecipeRef, len(section.Items))
	for i := range section.Items {
		it := &section.Items[i]
		refsByKey[recipekeeper.RowKey(it.Name, it.Checked)] = recipeRefsForKey(a.DB, it.Name, it.Checked)
	}
	return grocerySectionJSON(section, refsByKey)
}

func (a *App) handleListGrocery(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	sections, err := a.loadGrocerySections()
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, grocerySectionsJSON(a.DB, sections))
}

func (a *App) handleListItemDefaults(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var defaults []models.ItemDefault
	if err := a.DB.Where("store_id IS NOT NULL OR section_name IS NOT NULL").Find(&defaults).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]J, 0, len(defaults))
	for i := range defaults {
		out = append(out, itemDefaultJSON(&defaults[i]))
	}
	httpx.WriteJSON(w, 200, out)
}

func (a *App) handleDeleteItemDefault(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	name := strings.ToLower(r.PathValue("itemName"))
	if err := a.DB.Where("LOWER(item_name) = ?", name).Delete(&models.ItemDefault{}).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleUpsertItemDefault(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		StoreID     *string `json:"store_id"`
		SectionName *string `json:"section_name"`
	}
	present, err := httpx.DecodeBody(r, &payload)
	if err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	// Validate before touching the DB so a bad store_id never persists a row.
	var newStoreID *uuid.UUID
	if present["store_id"] && payload.StoreID != nil && *payload.StoreID != "" {
		id, perr := uuid.Parse(*payload.StoreID)
		if perr != nil {
			httpx.ValidationError(w, "Input should be a valid UUID")
			return
		}
		newStoreID = &id
	}
	itemName := r.PathValue("itemName")
	var def models.ItemDefault
	err = a.DB.Where("LOWER(item_name) = ?", strings.ToLower(itemName)).First(&def).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		def = models.ItemDefault{ItemName: strings.ToLower(itemName)}
		if err := a.DB.Create(&def).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	} else if err != nil {
		httpx.WriteError(w, err)
		return
	}
	if present["store_id"] {
		def.StoreID = newStoreID
	}
	if present["section_name"] {
		def.SectionName = payload.SectionName
	}
	// Save with explicit column list so nil pointers overwrite (GORM's Save
	// skips zero-valued fields only with struct updates; Select forces them).
	if err := a.DB.Model(&def).Select("store_id", "section_name").Updates(map[string]any{
		"store_id": def.StoreID, "section_name": def.SectionName,
	}).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleReplaceGrocery(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		Sections []struct {
			Name  *string `json:"name"`
			Items []struct {
				Name     string  `json:"name"`
				Quantity *string `json:"quantity"`
				Checked  bool    `json:"checked"`
				StoreID  *string `json:"store_id"`
			} `json:"items"`
		} `json:"sections"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	// A missing/null `sections` must 422 like pydantic — otherwise a
	// malformed body would silently wipe the whole list.
	if payload.Sections == nil {
		httpx.ValidationError(w, "sections is required")
		return
	}
	for _, sec := range payload.Sections {
		if sec.Name == nil || sec.Items == nil {
			httpx.ValidationError(w, "each section requires name and items")
			return
		}
	}

	err := a.DB.Transaction(func(tx *gorm.DB) error {
		// Deliberately NOT a RecipeKeeper tombstone site, even though every
		// section (and its items) is wiped and recreated with fresh ids
		// right here. This is an id churn, not a user delete: merge/paste,
		// and undo/redo of delete and clear-checked/clear-all, all route
		// through this endpoint. Tombstoning here would push a delete of the
		// user's entire Recipe Keeper list the first time they hit undo.
		if err := tx.Where("1 = 1").Delete(&models.GrocerySection{}).Error; err != nil {
			return err
		}
		globalPos := 0
		for i, sec := range payload.Sections {
			section := models.GrocerySection{Name: *sec.Name, Position: i}
			if err := tx.Create(&section).Error; err != nil {
				return err
			}
			for j, item := range sec.Items {
				var storeID *uuid.UUID
				if item.StoreID != nil {
					id, perr := uuid.Parse(*item.StoreID)
					if perr != nil {
						return httpx.NewHTTPError(http.StatusUnprocessableEntity, "Input should be a valid UUID")
					}
					storeID = &id
				}
				if storeID == nil {
					storeID = storeDefaultFor(tx, item.Name)
				}
				gi := models.GroceryItem{
					SectionID:      section.ID,
					Name:           item.Name,
					Quantity:       item.Quantity,
					Checked:        item.Checked,
					Position:       j,
					GlobalPosition: globalPos,
					StoreID:        storeID,
				}
				globalPos++
				if err := tx.Create(&gi).Error; err != nil {
					return err
				}
				if err := upsertSectionDefault(tx, item.Name, *sec.Name); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		httpx.WriteError(w, err)
		return
	}

	sections, err := a.loadGrocerySections()
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	result := grocerySectionsJSON(a.DB, sections)
	replacedItems := 0
	for _, sec := range payload.Sections {
		replacedItems += len(sec.Items)
	}
	a.broadcast("grocery.updated", J{
		"action": "replaced", "sections": result,
		"pushDetail": "replaced the grocery list (" + countNoun(len(payload.Sections), "section") + ", " + countNoun(replacedItems, "item") + ")",
	}, r)
	httpx.WriteJSON(w, 200, result)
}

func (a *App) handleUpdateGrocerySection(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	sectionID, err := httpx.ParseUUID(r.PathValue("sectionId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name string `json:"name"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	var section models.GrocerySection
	if err := a.DB.Preload("Items").Where("id = ?", sectionID).First(&section).Error; err != nil {
		httpx.Detail(w, http.StatusNotFound, "Section not found")
		return
	}
	section.Name = strings.TrimSpace(payload.Name)
	// Targeted update — Save() on a struct with preloaded Items upserts the
	// association and resurrects concurrently-deleted items.
	if err := a.DB.Model(&models.GrocerySection{}).Where("id = ?", section.ID).
		Update("name", section.Name).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("grocery.updated", J{
		"action": "section-renamed", "sectionId": section.ID.String(), "name": section.Name,
	}, r)
	httpx.WriteJSON(w, 200, a.grocerySectionJSON(&section))
}

func (a *App) handleDeleteGrocerySection(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	sectionID, err := httpx.ParseUUID(r.PathValue("sectionId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var section models.GrocerySection
	if dbErr := a.DB.Preload("Items").Where("id = ?", sectionID).First(&section).Error; dbErr != nil {
		w.WriteHeader(http.StatusNoContent) // already deleted — idempotent
		return
	}
	if len(section.Items) > 0 {
		httpx.Detail(w, http.StatusBadRequest, "Cannot delete section with items")
		return
	}
	// section.Items is guaranteed empty by the check above — this endpoint
	// requires an empty section, unlike Travel/packing's cascade delete — so
	// this loop is a no-op today. It stays as defense-in-depth: if that
	// invariant is ever relaxed, items cascading away with the section would
	// otherwise orphan their links and leave the rows stuck in Recipe Keeper
	// forever with nothing left locally to delete them from.
	for _, item := range section.Items {
		a.recipeKeeperTombstone(item.Name, item.Checked)
	}
	if err := a.DB.Delete(&section).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("grocery.updated", J{
		"action": "section-deleted", "sectionId": section.ID.String(),
		"pushDetail": "removed the “" + section.Name + "” section",
	}, r)
	a.recipeKeeperKick()
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleCreateGrocerySection(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		Name     string `json:"name"`
		Position *int   `json:"position"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	position := 0
	if payload.Position != nil {
		position = *payload.Position
	} else {
		var count int64
		a.DB.Model(&models.GrocerySection{}).Count(&count)
		position = int(count)
	}
	section := models.GrocerySection{Name: strings.TrimSpace(payload.Name), Position: position}
	if err := a.DB.Create(&section).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("grocery.updated", J{
		"action":  "section-added",
		"section": J{"id": section.ID.String(), "name": section.Name, "position": section.Position, "items": []J{}},
	}, r)
	section.Items = []models.GroceryItem{}
	httpx.WriteJSON(w, http.StatusCreated, a.grocerySectionJSON(&section))
}

func (a *App) handleReorderGrocerySections(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		SectionIDs []string `json:"section_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	ids, err := parseUUIDList(payload.SectionIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		var section models.GrocerySection
		if a.DB.Where("id = ?", id).First(&section).Error == nil {
			section.Position = i
			a.DB.Save(&section)
		}
	}
	var sections []models.GrocerySection
	a.DB.Order("position ASC").Find(&sections)
	positions := make([]J, 0, len(sections))
	for _, s := range sections {
		positions = append(positions, J{"id": s.ID.String(), "position": s.Position})
	}
	a.broadcast("grocery.updated", J{"action": "section-reordered", "sections": positions}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

func (a *App) handleReorderGroceryItems(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	sectionID, err := httpx.ParseUUID(r.PathValue("sectionId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		ItemIDs []string `json:"item_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	var section models.GrocerySection
	if a.DB.Where("id = ?", sectionID).First(&section).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Section not found")
		return
	}
	ids, err := parseUUIDList(payload.ItemIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		var item models.GroceryItem
		if a.DB.Where("id = ? AND section_id = ?", id, sectionID).First(&item).Error == nil {
			item.Position = i
			a.DB.Save(&item)
		}
	}
	var items []models.GroceryItem
	a.DB.Where("section_id = ?", sectionID).Order("position ASC").Find(&items)
	positions := make([]J, 0, len(items))
	for _, item := range items {
		positions = append(positions, J{"id": item.ID.String(), "position": item.Position})
	}
	a.broadcast("grocery.updated", J{
		"action": "items-reordered", "sectionId": sectionID.String(), "items": positions,
	}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

// handleReorderGroceryItemsGlobal sets the cross-section GlobalPosition for the
// given items in the order received. Used by the "group by: none" flat view.
// Section-scoped Position is untouched, so category grouping keeps its order.
func (a *App) handleReorderGroceryItemsGlobal(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		ItemIDs []string `json:"item_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	ids, err := parseUUIDList(payload.ItemIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		a.DB.Model(&models.GroceryItem{}).Where("id = ?", id).
			UpdateColumn("global_position", i)
	}
	positions := make([]J, 0, len(ids))
	for i, id := range ids {
		positions = append(positions, J{"id": id.String(), "global_position": i})
	}
	a.broadcast("grocery.updated", J{
		"action": "items-reordered-global", "items": positions,
	}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

func (a *App) handleUpdateGroceryItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	itemID, err := httpx.ParseUUID(r.PathValue("itemId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name     *string `json:"name"`
		Quantity *string `json:"quantity"`
		Checked  *bool   `json:"checked"`
		StoreID  *string `json:"store_id"`
	}
	present, err := httpx.DecodeBody(r, &payload)
	if err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	if payload.Name != nil && strings.TrimSpace(*payload.Name) == "" {
		httpx.ValidationError(w, "name must be non-empty")
		return
	}
	var item models.GroceryItem
	if a.DB.Where("id = ?", itemID).First(&item).Error != nil {
		// Recipe Keeper is a writer the client can't see: a change queued
		// while a device was offline may land on a row RK has since deleted
		// or split. Treat "not found" as "already applied" rather than 404 —
		// a 404 here would burn all MAX_SYNC_ATTEMPTS client retries before
		// the queued change is discarded, turning a benign race into a stuck
		// sync queue.
		httpx.WriteJSON(w, 200, J{"status": "ok"})
		return
	}
	oldName := item.Name
	oldChecked := item.Checked
	oldQty := recipekeeper.QuantityOf(&item)
	// Write only the columns this PATCH actually changes — full-row writes
	// let concurrent PATCHes of disjoint fields clobber each other, and a
	// no-op must not bump updated_at (drives checked-item ordering).
	updates := map[string]any{}
	if payload.Checked != nil && *payload.Checked != item.Checked {
		item.Checked = *payload.Checked
		updates["checked"] = item.Checked
	}
	if payload.Name != nil {
		if name := strings.TrimSpace(*payload.Name); name != item.Name {
			item.Name = name
			updates["name"] = name
		}
		// If item has no store and name changed, adopt the new name's default.
		if !present["store_id"] && item.StoreID == nil {
			if def := storeDefaultFor(a.DB, item.Name); def != nil {
				item.StoreID = def
				updates["store_id"] = def
			}
		}
	}
	// pendingConsume, when > 0, means the quantity write below was withheld
	// because ConsumeUnits (after the batched update lands) must own it — see
	// the comment at that call.
	pendingConsume := 0
	if present["quantity"] {
		var newQuantity *string
		if payload.Quantity != nil && *payload.Quantity != "" {
			newQuantity = payload.Quantity
		}
		if (newQuantity == nil) != (item.Quantity == nil) ||
			(newQuantity != nil && *newQuantity != *item.Quantity) {
			newQty := recipekeeper.QuantityOf(&models.GroceryItem{Quantity: newQuantity})
			if a.RecipeKeeper != nil && newQty < oldQty {
				// A decrease with Recipe Keeper enabled is not a plain
				// column write: ConsumeUnits spends MP-only units first and
				// only then checks off linked rows, and it persists the
				// row's own final quantity as part of that. Writing
				// "quantity" here too would double-decrement — this PATCH
				// would set it to newQty, then ConsumeUnits would subtract
				// the same delta again from that already-reduced value.
				pendingConsume = oldQty - newQty
			} else {
				item.Quantity = newQuantity
				updates["quantity"] = newQuantity
			}
		}
	}
	if present["store_id"] {
		var storeID *uuid.UUID
		if payload.StoreID != nil {
			id, perr := uuid.Parse(*payload.StoreID)
			if perr != nil {
				httpx.ValidationError(w, "Input should be a valid UUID")
				return
			}
			storeID = &id
		}
		if (storeID == nil) != (item.StoreID == nil) ||
			(storeID != nil && *storeID != *item.StoreID) {
			item.StoreID = storeID
			updates["store_id"] = storeID
		}
		// Upsert item_defaults for this name (side effect happens whether or
		// not the item's own store changed, mirroring Python).
		normalized := strings.ToLower(strings.TrimSpace(item.Name))
		var def models.ItemDefault
		derr := a.DB.Where("item_name = ?", normalized).First(&def).Error
		var uerr error
		if storeID != nil {
			if errors.Is(derr, gorm.ErrRecordNotFound) {
				uerr = a.DB.Create(&models.ItemDefault{ItemName: normalized, StoreID: storeID}).Error
			} else if derr == nil {
				uerr = a.DB.Model(&def).Update("store_id", storeID).Error
			}
		} else if derr == nil {
			// Clearing store — also clear the default.
			uerr = a.DB.Model(&def).Update("store_id", nil).Error
		}
		if uerr != nil {
			httpx.WriteError(w, uerr)
			return
		}
	}
	if len(updates) > 0 {
		updates["updated_at"] = models.NowUTC()
		if err := a.DB.Model(&models.GroceryItem{}).Where("id = ?", itemID).Updates(updates).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	a.DB.Where("id = ?", itemID).First(&item)

	if a.RecipeKeeper != nil {
		// Links are keyed by (name, checked) — Meal Planner mutates the row
		// in place, so renaming or checking must retarget any link to follow
		// it. Retarget BEFORE consuming: ConsumeUnits looks up links under
		// the item's CURRENT (name, checked), and a PATCH can rename and
		// decrease quantity in the same request.
		if item.Name != oldName || item.Checked != oldChecked {
			if err := a.RecipeKeeper.Rec.RetargetLinks(oldName, oldChecked, item.Name, item.Checked); err != nil {
				log.Printf("recipekeeper: retarget links: %v", err)
			}
		}
		if pendingConsume > 0 {
			if err := a.RecipeKeeper.Rec.ConsumeUnits(item.ID, pendingConsume); err != nil {
				log.Printf("recipekeeper: consume units: %v", err)
			}
			// ConsumeUnits persists the row's reduced quantity itself (and
			// may have deleted it once fully consumed, or created its
			// checked sibling) — reload so the broadcast and response
			// reflect the post-consume state.
			a.DB.Where("id = ?", itemID).First(&item)
		}
	}

	// Check/uncheck and renames get precise phrasing; the generic derivation
	// ("updated X") covers quantity/store tweaks.
	updatePayload := J{
		"action": "item-updated", "sectionId": item.SectionID.String(), "item": a.groceryItemJSON(&item),
	}
	if _, ok := updates["checked"]; ok {
		verb := "unchecked"
		if item.Checked {
			verb = "checked off"
		}
		updatePayload["pushDetail"] = verb + " “" + item.Name + "”"
	} else if _, ok := updates["name"]; ok {
		updatePayload["pushDetail"] = "renamed “" + oldName + "” to “" + item.Name + "”"
	}
	a.broadcast("grocery.updated", updatePayload, r)
	a.recipeKeeperKick()
	httpx.WriteJSON(w, 200, a.groceryItemJSON(&item))
}

func (a *App) handleAddGroceryItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	var payload struct {
		SectionID string  `json:"section_id"`
		Name      string  `json:"name"`
		Quantity  *string `json:"quantity"`
		StoreID   *string `json:"store_id"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	sectionID, err := httpx.ParseUUID(payload.SectionID)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var section models.GrocerySection
	if a.DB.Where("id = ?", sectionID).First(&section).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Section not found")
		return
	}
	var maxPos struct{ Position int }
	nextPos := 0
	if a.DB.Model(&models.GroceryItem{}).Where("section_id = ?", sectionID).
		Order("position DESC").Limit(1).Scan(&maxPos).RowsAffected > 0 {
		nextPos = maxPos.Position + 1
	}
	// Global (cross-section) order: append to the end of the flat list.
	var maxGlobal struct{ GlobalPosition int }
	nextGlobal := 0
	if a.DB.Model(&models.GroceryItem{}).
		Order("global_position DESC").Limit(1).Scan(&maxGlobal).RowsAffected > 0 {
		nextGlobal = maxGlobal.GlobalPosition + 1
	}

	var storeID *uuid.UUID
	if payload.StoreID != nil {
		id, perr := uuid.Parse(*payload.StoreID)
		if perr != nil {
			httpx.ValidationError(w, "Input should be a valid UUID")
			return
		}
		storeID = &id
	}
	if storeID == nil {
		storeID = storeDefaultFor(a.DB, payload.Name)
	}

	item := models.GroceryItem{
		SectionID:      sectionID,
		Name:           strings.TrimSpace(payload.Name),
		Quantity:       payload.Quantity,
		Position:       nextPos,
		GlobalPosition: nextGlobal,
		StoreID:        storeID,
	}
	if err := a.DB.Create(&item).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	if err := upsertSectionDefault(a.DB, payload.Name, section.Name); err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("grocery.updated", J{
		"action": "item-added", "sectionId": item.SectionID.String(), "item": a.groceryItemJSON(&item),
	}, r)
	httpx.WriteJSON(w, 200, a.groceryItemJSON(&item))
}

func (a *App) handleMoveGroceryItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	itemID, err := httpx.ParseUUID(r.PathValue("itemId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		ToSectionID string `json:"to_section_id"`
		ToPosition  *int   `json:"to_position"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.ToPosition == nil {
		httpx.ValidationError(w, "to_section_id and to_position are required")
		return
	}
	toSectionID, err := httpx.ParseUUID(payload.ToSectionID)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var item models.GroceryItem
	if a.DB.Where("id = ?", itemID).First(&item).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Item not found")
		return
	}
	var target models.GrocerySection
	if a.DB.Where("id = ?", toSectionID).First(&target).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Target section not found")
		return
	}

	oldSectionID := item.SectionID
	item.SectionID = toSectionID
	item.Position = *payload.ToPosition
	if err := a.DB.Save(&item).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}

	reindex := func(sectionID uuid.UUID) {
		var items []models.GroceryItem
		a.DB.Where("section_id = ?", sectionID).Order("position ASC").Find(&items)
		for i := range items {
			if items[i].Position != i {
				a.DB.Model(&items[i]).Update("position", i)
			}
			if items[i].ID == item.ID {
				item.Position = i
			}
		}
	}
	reindex(oldSectionID)
	reindex(toSectionID)

	if oldSectionID != toSectionID {
		if err := upsertSectionDefault(a.DB, item.Name, target.Name); err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	a.DB.Where("id = ?", itemID).First(&item)
	a.broadcast("grocery.updated", J{
		"action":        "item-moved",
		"fromSectionId": oldSectionID.String(),
		"toSectionId":   item.SectionID.String(),
		"item":          a.groceryItemJSON(&item),
	}, r)
	httpx.WriteJSON(w, 200, a.groceryItemJSON(&item))
}

func (a *App) handleDeleteGroceryItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	itemID, err := httpx.ParseUUID(r.PathValue("itemId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var item models.GroceryItem
	if a.DB.Where("id = ?", itemID).First(&item).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Item not found")
		return
	}
	sectionID := item.SectionID
	// Tombstone before the row is deleted — the link rows are addressed by
	// collapse key, not a DB foreign key, so they would silently orphan once
	// the item is gone.
	a.recipeKeeperTombstone(item.Name, item.Checked)
	if err := a.DB.Delete(&item).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.broadcast("grocery.updated", J{
		"action": "item-deleted", "sectionId": sectionID.String(), "itemId": itemID.String(),
		"pushDetail": "removed “" + item.Name + "”",
	}, r)
	a.recipeKeeperKick()
	httpx.WriteJSON(w, 200, J{"status": "deleted"})
}

func (a *App) handleClearGroceryItems(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	mode := r.URL.Query().Get("mode")
	if mode != "checked" && mode != "all" {
		httpx.ValidationError(w, "mode must match ^(checked|all)$")
		return
	}
	if mode == "all" {
		// Every item in the list is about to go — tombstone them all before
		// the cascading section delete. A local-only clear would otherwise
		// resurrect on the next Recipe Keeper pull.
		if a.RecipeKeeper != nil {
			var items []models.GroceryItem
			a.DB.Find(&items)
			for _, item := range items {
				a.recipeKeeperTombstone(item.Name, item.Checked)
			}
		}
		if err := a.DB.Where("1 = 1").Delete(&models.GrocerySection{}).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	} else {
		if a.RecipeKeeper != nil {
			var items []models.GroceryItem
			a.DB.Where("checked = ?", true).Find(&items)
			for _, item := range items {
				a.recipeKeeperTombstone(item.Name, item.Checked)
			}
		}
		if err := a.DB.Where("checked = ?", true).Delete(&models.GroceryItem{}).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
		var sections []models.GrocerySection
		a.DB.Preload("Items").Find(&sections)
		for i := range sections {
			if len(sections[i].Items) == 0 {
				a.DB.Delete(&sections[i])
			}
		}
	}
	sections, err := a.loadGrocerySections()
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	action := "cleared-checked"
	if mode == "all" {
		action = "cleared-all"
	}
	a.broadcast("grocery.updated", J{"action": action}, r)
	a.recipeKeeperKick()
	httpx.WriteJSON(w, 200, grocerySectionsJSON(a.DB, sections))
}
