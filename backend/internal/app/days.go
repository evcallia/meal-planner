package app

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/ical"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
	"mealplanner/internal/textutil"
)

func boolQuery(r *http.Request, name string, def bool) (bool, error) {
	raw := strings.ToLower(r.URL.Query().Get(name))
	switch raw {
	case "":
		return def, nil
	case "1", "true", "yes", "on", "t", "y":
		return true, nil
	case "0", "false", "no", "off", "f", "n":
		return false, nil
	}
	return def, httpx.NewHTTPError(http.StatusUnprocessableEntity, "Invalid boolean: "+name)
}

// maxDayRange caps day-iteration endpoints (~10 years). The frontend asks
// for ~10 weeks; an unbounded range is a multi-hundred-MB response.
const maxDayRange = 3660

func rangeTooLarge(start, end time.Time) bool {
	return end.Sub(start) > maxDayRange*24*time.Hour
}

func dateQuery(r *http.Request, name string) (time.Time, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return time.Time{}, httpx.NewHTTPError(http.StatusUnprocessableEntity, "Field required: "+name)
	}
	t, err := httpx.ParseDate(raw)
	if err != nil {
		return time.Time{}, httpx.NewHTTPError(http.StatusUnprocessableEntity, "Invalid date: "+name)
	}
	return t, nil
}

func (a *App) handleGetDays(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	startDate, err := dateQuery(r, "start_date")
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	endDate, err := dateQuery(r, "end_date")
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	if rangeTooLarge(startDate, endDate) {
		httpx.ValidationError(w, "Date range too large")
		return
	}
	includeEvents, err := boolQuery(r, "include_events", false)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	includeHolidays, err := boolQuery(r, "include_holidays", true)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}

	var notes []models.MealNote
	if err := a.DB.Preload("Items").
		Where("date >= ? AND date <= ?", startDate, endDate).Find(&notes).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	notesByDate := map[string]*models.MealNote{}
	for i := range notes {
		notesByDate[httpx.FormatDate(notes[i].Date)] = &notes[i]
	}

	var events []ical.Event
	if includeEvents {
		events = a.Calendar.FetchICalEvents(startDate, endDate, false, includeHolidays)
	}

	days := []J{}
	for current := startDate; !current.After(endDate); current = current.AddDate(0, 0, 1) {
		dayEvents := []ical.Event{}
		if includeEvents {
			dayEvents = ical.GetEventsForDate(events, current)
		}
		var mealNote any
		if note := notesByDate[httpx.FormatDate(current)]; note != nil {
			mealNote = mealNoteJSON(note)
		}
		days = append(days, J{
			"date":      httpx.FormatDate(current),
			"events":    dayEvents,
			"meal_note": mealNote,
		})
	}
	httpx.WriteJSON(w, 200, days)
}

func (a *App) handleGetEvents(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	startDate, err := dateQuery(r, "start_date")
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	endDate, err := dateQuery(r, "end_date")
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	if rangeTooLarge(startDate, endDate) {
		httpx.ValidationError(w, "Date range too large")
		return
	}
	includeHidden, err := boolQuery(r, "include_hidden", false)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	includeHolidays, err := boolQuery(r, "include_holidays", true)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}

	events := a.Calendar.FetchICalEvents(startDate, endDate, includeHidden, includeHolidays)

	eventsByDate := map[string][]ical.Event{}
	for current := startDate; !current.After(endDate); current = current.AddDate(0, 0, 1) {
		dayEvents := ical.GetEventsForDate(events, current)
		if len(dayEvents) > 0 {
			eventsByDate[httpx.FormatDate(current)] = dayEvents
		}
	}
	httpx.WriteJSON(w, 200, eventsByDate)
}

func datePath(r *http.Request) (time.Time, error) {
	t, err := httpx.ParseDate(r.PathValue("date"))
	if err != nil {
		return time.Time{}, httpx.NewHTTPError(http.StatusUnprocessableEntity, "Invalid date")
	}
	return t, nil
}

func (a *App) handleUpdateNotes(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	date, err := datePath(r)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Notes *string `json:"notes"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.Notes == nil {
		httpx.ValidationError(w, "notes is required")
		return
	}

	var note models.MealNote
	dbErr := a.DB.Preload("Items").Where("date = ?", date).First(&note).Error
	oldNotes := ""
	isNew := false
	if dbErr == gorm.ErrRecordNotFound {
		note = models.MealNote{Date: date, Notes: *payload.Notes}
		isNew = true
	} else if dbErr != nil {
		httpx.WriteError(w, dbErr)
		return
	} else {
		oldNotes = note.Notes
		note.Notes = *payload.Notes
	}

	oldLines := []string{}
	if oldNotes != "" {
		oldLines = textutil.SplitNoteLines(oldNotes)
	}
	newLines := []string{}
	if *payload.Notes != "" {
		newLines = textutil.SplitNoteLines(*payload.Notes)
	}
	oldItemized := map[int]bool{}
	for _, item := range note.Items {
		oldItemized[item.LineIndex] = item.Itemized
	}
	itemizedByIndex := textutil.CarryItemizedState(oldLines, newLines, oldItemized)

	err = a.DB.Transaction(func(tx *gorm.DB) error {
		if isNew {
			if err := tx.Create(&note).Error; err != nil {
				return err
			}
		} else {
			if oldNotes != note.Notes {
				if err := tx.Model(&note).Select("notes", "updated_at").Updates(map[string]any{
					"notes": note.Notes, "updated_at": models.NowUTC(),
				}).Error; err != nil {
					return err
				}
			}
			if err := tx.Where("meal_note_id = ?", note.ID).Delete(&models.MealItem{}).Error; err != nil {
				return err
			}
		}
		for i := 0; i < len(newLines); i++ {
			item := models.MealItem{MealNoteID: note.ID, LineIndex: i, Itemized: itemizedByIndex[i]}
			if err := tx.Create(&item).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		httpx.WriteError(w, err)
		return
	}

	a.DB.Preload("Items").Where("id = ?", note.ID).First(&note)
	schema := mealNoteJSON(&note)
	a.broadcast("notes.updated", J{"date": httpx.FormatDate(date), "meal_note": schema}, r)
	httpx.WriteJSON(w, 200, schema)
}

func (a *App) handleToggleItem(w http.ResponseWriter, r *http.Request, _ *session.UserInfo) {
	date, err := datePath(r)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	lineIndex, err := strconv.Atoi(r.PathValue("lineIndex"))
	if err != nil {
		httpx.ValidationError(w, "Invalid line index")
		return
	}
	var payload struct {
		Itemized *bool `json:"itemized"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.Itemized == nil {
		httpx.ValidationError(w, "itemized is required")
		return
	}

	var note models.MealNote
	if a.DB.Where("date = ?", date).First(&note).Error == gorm.ErrRecordNotFound {
		note = models.MealNote{Date: date, Notes: ""}
		if err := a.DB.Create(&note).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}

	var item models.MealItem
	err = a.DB.Where("meal_note_id = ? AND line_index = ?", note.ID, lineIndex).First(&item).Error
	if err == gorm.ErrRecordNotFound {
		item = models.MealItem{MealNoteID: note.ID, LineIndex: lineIndex, Itemized: *payload.Itemized}
		if err := a.DB.Create(&item).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	} else if err != nil {
		httpx.WriteError(w, err)
		return
	} else {
		if err := a.DB.Model(&item).Update("itemized", *payload.Itemized).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
		item.Itemized = *payload.Itemized
	}

	a.broadcast("item.updated", J{
		"date": httpx.FormatDate(date), "line_index": item.LineIndex, "itemized": item.Itemized,
	}, r)
	httpx.WriteJSON(w, 200, J{"line_index": item.LineIndex, "itemized": item.Itemized})
}
