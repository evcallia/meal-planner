package app

import (
	"sort"

	"github.com/google/uuid"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
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

func groceryItemJSON(item *models.GroceryItem) J {
	return J{
		"id":         item.ID.String(),
		"section_id": item.SectionID.String(),
		"name":       item.Name,
		"quantity":   strOrNil(item.Quantity),
		"checked":    item.Checked,
		"position":   item.Position,
		"store_id":   uuidPtr(item.StoreID),
		"updated_at": httpx.FormatDateTime(item.UpdatedAt),
	}
}

func grocerySectionJSON(section *models.GrocerySection) J {
	sortGroceryItems(section.Items)
	items := make([]J, 0, len(section.Items))
	for i := range section.Items {
		items = append(items, groceryItemJSON(&section.Items[i]))
	}
	return J{
		"id":       section.ID.String(),
		"name":     section.Name,
		"position": section.Position,
		"items":    items,
	}
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
