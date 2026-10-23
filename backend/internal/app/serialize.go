package app

import (
	"sort"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/recipekeeper"
)

// J is a JSON object under construction.
type J = map[string]any

// parseUUIDList validates a reorder payload up front (pydantic parity: a
// missing field or any invalid UUID is a 422 with zero DB writes).
func parseUUIDList(raw []string) ([]uuid.UUID, error) {
	if raw == nil {
		return nil, httpx.NewHTTPError(422, "Field required")
	}
	ids := make([]uuid.UUID, 0, len(raw))
	for _, r := range raw {
		id, err := httpx.ParseUUID(r)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func uuidPtr(id *uuid.UUID) any {
	if id == nil {
		return nil
	}
	return id.String()
}

func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// sortGroceryItems mirrors the Python key: unchecked first by position,
// checked last by most-recently-updated.
func sortGroceryItems(items []models.GroceryItem) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Checked != b.Checked {
			return !a.Checked
		}
		if !a.Checked {
			return a.Position < b.Position
		}
		return a.UpdatedAt.After(b.UpdatedAt)
	})
}

// groceryItemJSON serializes one item. recipes must never be nil in the
// output — the frontend maps over the "recipes" array unconditionally, so a
// null there would crash it.
func groceryItemJSON(item *models.GroceryItem, recipes []recipekeeper.RecipeRef) J {
	if recipes == nil {
		recipes = []recipekeeper.RecipeRef{}
	}
	return J{
		"id":              item.ID.String(),
		"section_id":      item.SectionID.String(),
		"name":            item.Name,
		"quantity":        strOrNil(item.Quantity),
		"checked":         item.Checked,
		"position":        item.Position,
		"global_position": item.GlobalPosition,
		"store_id":        uuidPtr(item.StoreID),
		"recipes":         recipes,
		"updated_at":      httpx.FormatDateTime(item.UpdatedAt),
	}
}

// grocerySectionJSON serializes one section. refsByKey is the whole
// response's recipe-attribution map (see recipeRefsByKey) — passed in rather
// than queried per item to avoid an N+1 over a ~200-item list.
func grocerySectionJSON(section *models.GrocerySection, refsByKey map[string][]recipekeeper.RecipeRef) J {
	sortGroceryItems(section.Items)
	items := make([]J, 0, len(section.Items))
	for i := range section.Items {
		it := &section.Items[i]
		items = append(items, groceryItemJSON(it, refsByKey[recipekeeper.RowKey(it.Name, it.Checked)]))
	}
	return J{
		"id":       section.ID.String(),
		"name":     section.Name,
		"position": section.Position,
		"items":    items,
	}
}

// recipeRefsByKey loads recipe attributions for a whole response in two
// queries rather than one per item. Keyed by collapse key, matching how
// RecipeKeeperLink addresses grocery rows (see models.RecipeKeeperLink).
func recipeRefsByKey(db *gorm.DB) map[string][]recipekeeper.RecipeRef {
	out := map[string][]recipekeeper.RecipeRef{}
	var links []models.RecipeKeeperLink
	if err := db.Order("rk_position asc").
		Find(&links, "rk_recipe_id IS NOT NULL").Error; err != nil {
		return out
	}
	var recipes []models.RecipeKeeperRecipe
	db.Find(&recipes)
	titles := make(map[string]string, len(recipes))
	for _, rec := range recipes {
		titles[rec.RKRecipeID] = rec.Title
	}
	// idx records each recipe's index within out[rowKey] the first time it's
	// seen for that row, so later links for the same (row, recipe) pair —
	// Recipe Keeper stores one link per recipe-ingredient occurrence, e.g. an
	// item added to a recipe several times — increment that ref's Count
	// instead of appending a duplicate.
	idx := map[string]int{}
	for _, link := range links {
		id := *link.RKRecipeID
		title, ok := titles[id]
		if !ok {
			continue
		}
		rowKey := recipekeeper.RowKey(link.MPName, link.MPChecked)
		dedupeKey := rowKey + "|" + id
		if i, seen := idx[dedupeKey]; seen {
			out[rowKey][i].Count++
			continue
		}
		idx[dedupeKey] = len(out[rowKey])
		out[rowKey] = append(out[rowKey], recipekeeper.RecipeRef{ID: id, Title: title, Count: 1})
	}
	return out
}

// recipeRefsForKey resolves attribution for ONE grocery row. The bulk
// recipeRefsByKey loads every link for a whole-list response; single-row
// mutation endpoints (add/update/move item, rename/create section) use this
// instead so their cost scales with what they actually return, not with the
// size of the Recipe Keeper cache — a full-table scan on the hottest
// endpoints in the app grows with total recipes/links regardless of how much
// of that data is relevant to the one row being serialized.
//
// Ordering matches the bulk path (rk_position asc) so the same item lists its
// recipes in the same order regardless of which endpoint returned it.
func recipeRefsForKey(db *gorm.DB, name string, checked bool) []recipekeeper.RecipeRef {
	out := []recipekeeper.RecipeRef{}
	var links []models.RecipeKeeperLink
	if err := db.Where("mp_name = ? AND mp_checked = ? AND rk_recipe_id IS NOT NULL",
		recipekeeper.NormalizeName(name), checked).
		Order("rk_position asc").Find(&links).Error; err != nil || len(links) == 0 {
		return out
	}
	ids := make([]string, 0, len(links))
	seenID := map[string]bool{}
	for _, link := range links {
		id := *link.RKRecipeID
		if !seenID[id] {
			seenID[id] = true
			ids = append(ids, id)
		}
	}
	var recipes []models.RecipeKeeperRecipe
	db.Where("rk_recipe_id IN ?", ids).Find(&recipes)
	titles := make(map[string]string, len(recipes))
	for _, rec := range recipes {
		titles[rec.RKRecipeID] = rec.Title
	}
	// idx mirrors recipeRefsByKey: the first link for a recipe appends a ref,
	// every later link for that same recipe increments its Count.
	idx := map[string]int{}
	for _, link := range links {
		id := *link.RKRecipeID
		title, ok := titles[id]
		if !ok {
			continue
		}
		if i, seen := idx[id]; seen {
			out[i].Count++
			continue
		}
		idx[id] = len(out)
		out = append(out, recipekeeper.RecipeRef{ID: id, Title: title, Count: 1})
	}
	return out
}

func pantryItemJSON(item *models.PantryItem) J {
	return J{
		"id":         item.ID.String(),
		"section_id": item.SectionID.String(),
		"name":       item.Name,
		"quantity":   item.Quantity,
		"position":   item.Position,
		"updated_at": httpx.FormatDateTime(item.UpdatedAt),
	}
}

func pantrySectionJSON(section *models.PantrySection) J {
	sort.SliceStable(section.Items, func(i, j int) bool {
		return section.Items[i].Position < section.Items[j].Position
	})
	items := make([]J, 0, len(section.Items))
	for i := range section.Items {
		items = append(items, pantryItemJSON(&section.Items[i]))
	}
	return J{
		"id":       section.ID.String(),
		"name":     section.Name,
		"position": section.Position,
		"items":    items,
	}
}

func storeJSON(s *models.Store) J {
	return J{"id": s.ID.String(), "name": s.Name, "position": s.Position}
}

func itemDefaultJSON(d *models.ItemDefault) J {
	return J{
		"item_name":    d.ItemName,
		"store_id":     uuidPtr(d.StoreID),
		"section_name": strOrNil(d.SectionName),
	}
}

func mealIdeaJSON(idea *models.MealIdea) J {
	return J{
		"id":         idea.ID.String(),
		"title":      idea.Title,
		"updated_at": httpx.FormatDateTime(idea.UpdatedAt),
	}
}

func mealNoteJSON(note *models.MealNote) J {
	sort.SliceStable(note.Items, func(i, j int) bool {
		return note.Items[i].LineIndex < note.Items[j].LineIndex
	})
	items := make([]J, 0, len(note.Items))
	for _, item := range note.Items {
		items = append(items, J{"line_index": item.LineIndex, "itemized": item.Itemized})
	}
	return J{
		"id":         note.ID.String(),
		"date":       httpx.FormatDate(note.Date),
		"notes":      note.Notes,
		"items":      items,
		"updated_at": httpx.FormatDateTime(note.UpdatedAt),
	}
}

func hiddenEventJSON(h *models.HiddenCalendarEvent) J {
	return J{
		"id":            h.ID.String(),
		"event_uid":     h.EventUID,
		"event_date":    httpx.FormatDate(h.EventDate),
		"calendar_name": h.CalendarName,
		"title":         h.Title,
		"start_time":    httpx.FormatDateTime(h.StartTime),
		"end_time":      httpx.FormatDateTimePtr(h.EndTime),
		"all_day":       h.AllDay,
	}
}
