package app

// Travel / packing lists — the tracker's private-until-shared multi-list model
// wrapped around the grocery tab's sectioned checklist. See docs/packing-lists.md.
//
// Two deliberate departures from grocery:
//   - "stores" are per-list **bags** (PackingBag), so two trips never share a
//     bag vocabulary;
//   - checking an item never touches its Position. Display order is
//     (checked, position), so checked items sink to the bottom of their own
//     section and unchecking drops them back where the user put them.

import (
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
	"mealplanner/internal/session"
)

// ----- serialization -----

func packingItemJSON(item *models.PackingItem) J {
	return J{
		"id":         item.ID.String(),
		"section_id": item.SectionID.String(),
		"name":       item.Name,
		"quantity":   strOrNil(item.Quantity),
		"checked":    item.Checked,
		"position":   item.Position,
		"bag_id":     uuidPtr(item.BagID),
		"updated_at": httpx.FormatDateTime(item.UpdatedAt),
	}
}

// sortPackingItems: unchecked first by position, then checked by position.
// Position is stable across check/uncheck, so unchecking restores the slot.
func sortPackingItems(items []models.PackingItem) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if a.Checked != b.Checked {
			return !a.Checked
		}
		return a.Position < b.Position
	})
}

func packingSectionJSON(section *models.PackingSection) J {
	sortPackingItems(section.Items)
	items := make([]J, 0, len(section.Items))
	for i := range section.Items {
		items = append(items, packingItemJSON(&section.Items[i]))
	}
	return J{
		"id":       section.ID.String(),
		"list_id":  section.ListID.String(),
		"name":     section.Name,
		"position": section.Position,
		"items":    items,
	}
}

func packingBagJSON(bag *models.PackingBag) J {
	return J{
		"id":       bag.ID.String(),
		"list_id":  bag.ListID.String(),
		"name":     bag.Name,
		"position": bag.Position,
	}
}

// packingUserPosition mirrors trackerUserPosition: each viewer arranges the
// list tabs for themselves.
func (a *App) packingUserPosition(listID uuid.UUID, sub string, fallback int) int {
	var row models.PackingListPosition
	if a.DB.Where("sub = ? AND list_id = ?", sub, listID).First(&row).Error == nil {
		return row.Position
	}
	return fallback
}

// packingListJSON is perspective-dependent (is_owner + position are per-viewer),
// so it must be rebuilt for each recipient of a full-list broadcast.
func (a *App) packingListJSON(lst *models.PackingList, currentSub string) J {
	sharedWith := []J{}
	for _, share := range lst.Shares {
		if share.LeftAt != nil {
			continue
		}
		var u models.User
		var email, name any = nil, nil
		if a.DB.Where("sub = ?", share.Sub).First(&u).Error == nil {
			email, name = strOrNil(u.Email), strOrNil(u.Name)
		}
		sharedWith = append(sharedWith, J{"sub": share.Sub, "email": email, "name": name})
	}

	sections := make([]models.PackingSection, len(lst.Sections))
	copy(sections, lst.Sections)
	sort.SliceStable(sections, func(i, j int) bool { return sections[i].Position < sections[j].Position })
	sectionJSON := make([]J, 0, len(sections))
	for i := range sections {
		sectionJSON = append(sectionJSON, packingSectionJSON(&sections[i]))
	}

	bags := make([]models.PackingBag, len(lst.Bags))
	copy(bags, lst.Bags)
	sort.SliceStable(bags, func(i, j int) bool { return bags[i].Position < bags[j].Position })
	bagJSON := make([]J, 0, len(bags))
	for i := range bags {
		bagJSON = append(bagJSON, packingBagJSON(&bags[i]))
	}

	ownerSub := lst.OwnerSub
	return J{
		"id":          lst.ID.String(),
		"name":        lst.Name,
		"icon":        strOrNil(lst.Icon),
		"color":       strOrNil(lst.Color),
		"position":    a.packingUserPosition(lst.ID, currentSub, lst.Position),
		"owner_sub":   lst.OwnerSub,
		"owner_name":  strOrNilPtr(a.trackerFullName(&ownerSub)),
		"is_owner":    lst.OwnerSub == currentSub,
		"shared_with": sharedWith,
		"bags":        bagJSON,
		"sections":    sectionJSON,
	}
}

// ----- access control & broadcasting -----

func packingAudience(lst *models.PackingList) map[string]bool {
	audience := map[string]bool{lst.OwnerSub: true}
	for _, share := range lst.Shares {
		if share.LeftAt == nil {
			audience[share.Sub] = true
		}
	}
	return audience
}

// packingPreload loads a list with everything needed to serialize it.
func (a *App) packingPreload() *gorm.DB {
	return a.DB.Preload("Sections").Preload("Sections.Items").Preload("Bags").Preload("Shares")
}

// packingGetList loads a list and enforces access (mirrors trackerGetList).
func (a *App) packingGetList(listID uuid.UUID, sub string, ownerOnly bool) (*models.PackingList, error) {
	var lst models.PackingList
	err := a.packingPreload().Where("id = ?", listID).First(&lst).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, httpx.NewHTTPError(http.StatusNotFound, "List not found")
	}
	if err != nil {
		return nil, err
	}
	hasShare := false
	for _, s := range lst.Shares {
		if s.Sub == sub && s.LeftAt == nil {
			hasShare = true
		}
	}
	if lst.OwnerSub != sub && !hasShare {
		return nil, httpx.NewHTTPError(http.StatusForbidden, "No access to this list")
	}
	if ownerOnly && lst.OwnerSub != sub {
		return nil, httpx.NewHTTPError(http.StatusForbidden, "Only the owner can do this")
	}
	return &lst, nil
}

func (a *App) packingGetSection(sectionID uuid.UUID, sub string) (*models.PackingSection, *models.PackingList, error) {
	var section models.PackingSection
	err := a.DB.Where("id = ?", sectionID).First(&section).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil, httpx.NewHTTPError(http.StatusNotFound, "Section not found")
	}
	if err != nil {
		return nil, nil, err
	}
	lst, lerr := a.packingGetList(section.ListID, sub, false)
	if lerr != nil {
		return nil, nil, lerr
	}
	return &section, lst, nil
}

func (a *App) packingGetItem(itemID uuid.UUID, sub string) (*models.PackingItem, *models.PackingSection, *models.PackingList, error) {
	var item models.PackingItem
	err := a.DB.Where("id = ?", itemID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil, nil, httpx.NewHTTPError(http.StatusNotFound, "Item not found")
	}
	if err != nil {
		return nil, nil, nil, err
	}
	section, lst, serr := a.packingGetSection(item.SectionID, sub)
	if serr != nil {
		return nil, nil, nil, serr
	}
	return &item, section, lst, nil
}

func (a *App) packingGetBag(bagID uuid.UUID, sub string) (*models.PackingBag, *models.PackingList, error) {
	var bag models.PackingBag
	err := a.DB.Where("id = ?", bagID).First(&bag).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil, httpx.NewHTTPError(http.StatusNotFound, "Bag not found")
	}
	if err != nil {
		return nil, nil, err
	}
	lst, lerr := a.packingGetList(bag.ListID, sub, false)
	if lerr != nil {
		return nil, nil, lerr
	}
	return &bag, lst, nil
}

// packingBroadcast sends one identical payload to every member of the list's
// audience. A "pushDetail" entry customizes the notification phrasing and is
// stripped before the payload goes on the wire (same contract as tracker).
func (a *App) packingBroadcast(lst *models.PackingList, action string, extra J, r *http.Request, extraSubs ...string) {
	detail, _ := extra["pushDetail"].(string)
	delete(extra, "pushDetail")
	payload := J{"action": action, "listId": lst.ID.String()}
	for k, v := range extra {
		payload[k] = v
	}
	audience := packingAudience(lst)
	for _, sub := range extraSubs {
		audience[sub] = true
	}
	for sub := range audience {
		a.Broadcaster.BroadcastToUser(sub, "packing.updated", payload, httpx.SourceID(r))
	}
	a.queuePackingEditPush(lst, action, detail, r)
}

// packingBroadcastList sends the FULL list, recomputed per recipient so a
// shared user never receives the owner's perspective.
func (a *App) packingBroadcastList(lst *models.PackingList, action, detail string, r *http.Request, extraSubs ...string) {
	audience := packingAudience(lst)
	for _, sub := range extraSubs {
		audience[sub] = true
	}
	for sub := range audience {
		a.Broadcaster.BroadcastToUser(sub, "packing.updated",
			J{"action": action, "listId": lst.ID.String(), "list": a.packingListJSON(lst, sub)}, httpx.SourceID(r))
	}
	if detail == "" {
		switch action {
		case "list-added":
			detail = "created “" + lst.Name + "”"
		case "list-deleted":
			detail = "deleted “" + lst.Name + "”"
		}
	}
	a.queuePackingEditPush(lst, action, detail, r)
}

// queuePackingEditPush notifies the list's audience except the actor.
// Reorders are cosmetic, so they never notify.
func (a *App) queuePackingEditPush(lst *models.PackingList, action, detail string, r *http.Request) {
	if strings.Contains(action, "reorder") {
		return
	}
	actor := session.UserFrom(a.Sessions.Get(r))
	if actor == nil {
		return
	}
	audience := packingAudience(lst)
	a.Push.QueueListEdit("travel", lst.ID.String(), lst.Name, audience, actor.Sub, displayName(actor), detail)
	a.logActivityScoped("travel", detail, actor, &activityScope{
		id: lst.ID.String(), name: lst.Name, audience: audience,
	})
}

// packingMemberName is a member's display name for notification phrasing.
func (a *App) packingMemberName(sub string) string { return a.trackerMemberName(sub) }

// ----- list endpoints -----

func (a *App) handlePackingListLists(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	sub := user.Sub
	var owned []models.PackingList
	if err := a.packingPreload().Where("owner_sub = ?", sub).Find(&owned).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	var shares []models.PackingShare
	a.DB.Where("sub = ? AND left_at IS NULL", sub).Find(&shares)
	var shared []models.PackingList
	if len(shares) > 0 {
		ids := make([]uuid.UUID, 0, len(shares))
		for _, s := range shares {
			ids = append(ids, s.ListID)
		}
		a.packingPreload().Where("id IN ?", ids).Find(&shared)
	}
	var positions []models.PackingListPosition
	a.DB.Where("sub = ?", sub).Find(&positions)
	userPos := map[uuid.UUID]int{}
	for _, p := range positions {
		userPos[p.ListID] = p.Position
	}

	lists := append(owned, shared...)
	sort.SliceStable(lists, func(i, j int) bool {
		pi, pj := lists[i].Position, lists[j].Position
		if v, ok := userPos[lists[i].ID]; ok {
			pi = v
		}
		if v, ok := userPos[lists[j].ID]; ok {
			pj = v
		}
		if pi != pj {
			return pi < pj
		}
		return lists[i].Position < lists[j].Position
	})

	out := make([]J, 0, len(lists))
	for i := range lists {
		out = append(out, a.packingListJSON(&lists[i], sub))
	}
	httpx.WriteJSON(w, 200, out)
}

func (a *App) handlePackingCreateList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		Name  string  `json:"name"`
		Icon  *string `json:"icon"`
		Color *string `json:"color"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	var count int64
	a.DB.Model(&models.PackingList{}).Where("owner_sub = ?", user.Sub).Count(&count)
	lst := models.PackingList{
		OwnerSub: user.Sub,
		Name:     strings.TrimSpace(payload.Name),
		Icon:     payload.Icon,
		Color:    payload.Color,
		Position: int(count),
	}
	if err := a.DB.Create(&lst).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.packingPreload().Where("id = ?", lst.ID).First(&lst)
	data := a.packingListJSON(&lst, user.Sub)
	a.packingBroadcastList(&lst, "list-added", "", r)
	httpx.WriteJSON(w, http.StatusCreated, data)
}

// handlePackingRestoreList recreates a whole deleted list (undo of a delete
// that already reached the server). Items reference their bag by NAME so the
// payload survives the reissued ids.
func (a *App) handlePackingRestoreList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		Name      string   `json:"name"`
		Icon      *string  `json:"icon"`
		Color     *string  `json:"color"`
		Position  *int     `json:"position"`
		ShareSubs []string `json:"share_subs"`
		Bags      []struct {
			Name     string `json:"name"`
			Position int    `json:"position"`
		} `json:"bags"`
		Sections []struct {
			Name     string `json:"name"`
			Position int    `json:"position"`
			Items    []struct {
				Name     string  `json:"name"`
				Quantity *string `json:"quantity"`
				Checked  bool    `json:"checked"`
				Position int     `json:"position"`
				BagName  *string `json:"bag_name"`
			} `json:"items"`
		} `json:"sections"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	sub := user.Sub
	var count int64
	a.DB.Model(&models.PackingList{}).Where("owner_sub = ?", sub).Count(&count)
	position := int(count)
	if payload.Position != nil {
		position = *payload.Position
	}
	lst := models.PackingList{
		OwnerSub: sub, Name: strings.TrimSpace(payload.Name),
		Icon: payload.Icon, Color: payload.Color, Position: position,
	}
	err := a.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&lst).Error; err != nil {
			return err
		}
		// Pin the owner's personal position so their other devices agree.
		if err := tx.Create(&models.PackingListPosition{Sub: sub, ListID: lst.ID, Position: position}).Error; err != nil {
			return err
		}
		for _, shareSub := range payload.ShareSubs {
			if shareSub != "" && shareSub != sub {
				if err := tx.Create(&models.PackingShare{ListID: lst.ID, Sub: shareSub}).Error; err != nil {
					return err
				}
			}
		}
		bagByName := map[string]uuid.UUID{}
		for _, b := range payload.Bags {
			bag := models.PackingBag{ListID: lst.ID, Name: strings.TrimSpace(b.Name), Position: b.Position}
			if err := tx.Create(&bag).Error; err != nil {
				return err
			}
			bagByName[strings.ToLower(bag.Name)] = bag.ID
		}
		for _, s := range payload.Sections {
			section := models.PackingSection{ListID: lst.ID, Name: strings.TrimSpace(s.Name), Position: s.Position}
			if err := tx.Create(&section).Error; err != nil {
				return err
			}
			for _, it := range s.Items {
				var bagID *uuid.UUID
				if it.BagName != nil {
					if id, ok := bagByName[strings.ToLower(strings.TrimSpace(*it.BagName))]; ok {
						bagID = &id
					}
				}
				item := models.PackingItem{
					SectionID: section.ID, Name: strings.TrimSpace(it.Name), Quantity: it.Quantity,
					Checked: it.Checked, Position: it.Position, BagID: bagID,
				}
				if err := tx.Create(&item).Error; err != nil {
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
	a.packingPreload().Where("id = ?", lst.ID).First(&lst)
	data := a.packingListJSON(&lst, sub)
	a.packingBroadcastList(&lst, "list-added", "", r)
	httpx.WriteJSON(w, http.StatusCreated, data)
}

func (a *App) handlePackingUpdateList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name  *string `json:"name"`
		Icon  *string `json:"icon"`
		Color *string `json:"color"`
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
	lst, lerr := a.packingGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	oldName := lst.Name
	updates := map[string]any{}
	if payload.Name != nil {
		lst.Name = strings.TrimSpace(*payload.Name)
		updates["name"] = lst.Name
	}
	if present["icon"] {
		lst.Icon = payload.Icon
		updates["icon"] = payload.Icon
	}
	if present["color"] {
		lst.Color = payload.Color
		updates["color"] = payload.Color
	}
	if len(updates) > 0 {
		updates["updated_at"] = models.NowUTC()
		if err := a.DB.Model(&models.PackingList{}).Where("id = ?", lst.ID).Updates(updates).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	detail := ""
	if payload.Name != nil && lst.Name != oldName {
		detail = "renamed “" + oldName + "” to “" + lst.Name + "”"
	}
	data := a.packingListJSON(lst, user.Sub)
	a.packingBroadcastList(lst, "list-updated", detail, r)
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handlePackingDeleteList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var lst models.PackingList
	if a.DB.Preload("Shares").Where("id = ?", listID).First(&lst).Error != nil {
		w.WriteHeader(http.StatusNoContent) // idempotent
		return
	}
	if lst.OwnerSub != user.Sub {
		httpx.Detail(w, http.StatusForbidden, "Only the owner can delete this list")
		return
	}
	audience := packingAudience(&lst)
	if err := a.DB.Delete(&lst).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	payload := J{"action": "list-deleted", "listId": listID.String()}
	for member := range audience {
		a.Broadcaster.BroadcastToUser(member, "packing.updated", payload, httpx.SourceID(r))
	}
	a.queuePackingEditPush(&lst, "list-deleted", "deleted “"+lst.Name+"”", r)
	a.pruneNotifyOverrides([]string{listID.String()}, nil, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handlePackingReorderLists(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		ListIDs []string `json:"list_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	sub := user.Sub
	ids, err := parseUUIDList(payload.ListIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		var lst models.PackingList
		if a.DB.Where("id = ?", id).First(&lst).Error != nil {
			continue
		}
		hasAccess := lst.OwnerSub == sub
		if !hasAccess {
			var share models.PackingShare
			hasAccess = a.DB.Where("list_id = ? AND sub = ?", lst.ID, sub).First(&share).Error == nil
		}
		if !hasAccess {
			continue
		}
		var row models.PackingListPosition
		if a.DB.Where("sub = ? AND list_id = ?", sub, lst.ID).First(&row).Error == nil {
			a.DB.Model(&models.PackingListPosition{}).
				Where("sub = ? AND list_id = ?", sub, lst.ID).Update("position", i)
		} else {
			a.DB.Create(&models.PackingListPosition{Sub: sub, ListID: lst.ID, Position: i})
		}
		a.Broadcaster.BroadcastToUser(sub, "packing.updated",
			J{"action": "list-reordered", "listId": lst.ID.String(), "position": i}, httpx.SourceID(r))
	}
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

// ----- sharing -----

func (a *App) handlePackingAddShare(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Email *string `json:"email"`
		Sub   *string `json:"sub"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	lst, lerr := a.packingGetList(listID, user.Sub, true)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	targetSub := ""
	if payload.Sub != nil {
		targetSub = *payload.Sub
	}
	if targetSub == "" && payload.Email != nil && *payload.Email != "" {
		var u models.User
		if a.DB.Where("LOWER(email) = ?", strings.ToLower(strings.TrimSpace(*payload.Email))).First(&u).Error != nil {
			httpx.Detail(w, http.StatusNotFound, "No user with that email has signed in yet")
			return
		}
		targetSub = u.Sub
	}
	if targetSub == "" {
		httpx.Detail(w, http.StatusBadRequest, "Provide an email or sub to share with")
		return
	}
	if targetSub == lst.OwnerSub {
		httpx.Detail(w, http.StatusBadRequest, "You already own this list")
		return
	}

	var existing models.PackingShare
	serr := a.DB.Where("list_id = ? AND sub = ?", listID, targetSub).First(&existing).Error
	if errors.Is(serr, gorm.ErrRecordNotFound) {
		if err := a.DB.Create(&models.PackingShare{ListID: listID, Sub: targetSub}).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	} else if serr == nil && existing.LeftAt != nil {
		if err := a.DB.Model(&existing).Update("left_at", nil).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	lst, lerr = a.packingGetList(listID, user.Sub, true)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	data := a.packingListJSON(lst, user.Sub)
	a.packingBroadcastList(lst, "list-shared", "shared the list with "+a.packingMemberName(targetSub), r, targetSub)
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handlePackingRemoveShare(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	shareSub := r.PathValue("shareSub")
	lst, lerr := a.packingGetList(listID, user.Sub, true)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	audienceBefore := packingAudience(lst)
	var share models.PackingShare
	if a.DB.Where("list_id = ? AND sub = ?", listID, shareSub).First(&share).Error == nil {
		if err := a.DB.Delete(&share).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
		lst, lerr = a.packingGetList(listID, user.Sub, true)
		if lerr != nil {
			httpx.WriteError(w, lerr)
			return
		}
	}
	data := a.packingListJSON(lst, user.Sub)
	a.packingBroadcastList(lst, "list-updated", "removed "+a.packingMemberName(shareSub)+" from the list", r)
	if audienceBefore[shareSub] {
		a.Broadcaster.BroadcastToUser(shareSub, "packing.updated",
			J{"action": "list-deleted", "listId": listID.String()}, httpx.SourceID(r))
	}
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handlePackingLeaveList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	sub := user.Sub
	var lst models.PackingList
	if a.DB.Preload("Shares").Where("id = ?", listID).First(&lst).Error != nil {
		w.WriteHeader(http.StatusNoContent) // idempotent
		return
	}
	if lst.OwnerSub == sub {
		httpx.Detail(w, http.StatusBadRequest, "The owner can't leave their own list")
		return
	}
	var share models.PackingShare
	if a.DB.Where("list_id = ? AND sub = ?", listID, sub).First(&share).Error != nil || share.LeftAt != nil {
		w.WriteHeader(http.StatusNoContent) // not an active member — idempotent
		return
	}
	now := models.NowUTC()
	if err := a.DB.Model(&share).Update("left_at", now).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.packingPreload().Where("id = ?", listID).First(&lst)
	a.packingBroadcastList(&lst, "list-updated", "left the list", r)
	a.Broadcaster.BroadcastToUser(sub, "packing.updated",
		J{"action": "list-deleted", "listId": listID.String()}, httpx.SourceID(r))
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handlePackingRejoinList(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	sub := user.Sub
	var lst models.PackingList
	if a.packingPreload().Where("id = ?", listID).First(&lst).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "List not found")
		return
	}
	var share models.PackingShare
	if a.DB.Where("list_id = ? AND sub = ?", listID, sub).First(&share).Error != nil {
		httpx.Detail(w, http.StatusForbidden, "You were not a member of this list")
		return
	}
	if share.LeftAt != nil {
		if err := a.DB.Model(&share).Update("left_at", nil).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
		a.packingPreload().Where("id = ?", listID).First(&lst)
	}
	data := a.packingListJSON(&lst, sub)
	a.packingBroadcastList(&lst, "list-shared", "rejoined the list", r, sub)
	httpx.WriteJSON(w, 200, data)
}

// ----- sections -----

func (a *App) handlePackingCreateSection(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name     string `json:"name"`
		Position *int   `json:"position"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	lst, lerr := a.packingGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	position := len(lst.Sections)
	if payload.Position != nil {
		position = *payload.Position
	}
	section := models.PackingSection{ListID: listID, Name: strings.TrimSpace(payload.Name), Position: position}
	if err := a.DB.Create(&section).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	section.Items = []models.PackingItem{}
	data := packingSectionJSON(&section)
	a.packingBroadcast(lst, "section-added", J{
		"section": data, "pushDetail": "added the “" + section.Name + "” section",
	}, r)
	httpx.WriteJSON(w, http.StatusCreated, data)
}

func (a *App) handlePackingUpdateSection(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
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
	section, lst, serr := a.packingGetSection(sectionID, user.Sub)
	if serr != nil {
		httpx.WriteError(w, serr)
		return
	}
	oldName := section.Name
	section.Name = strings.TrimSpace(payload.Name)
	if err := a.DB.Model(&models.PackingSection{}).Where("id = ?", section.ID).
		Update("name", section.Name).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.DB.Where("section_id = ?", section.ID).Find(&section.Items)
	a.packingBroadcast(lst, "section-renamed", J{
		"sectionId": section.ID.String(), "name": section.Name,
		"pushDetail": "renamed the “" + oldName + "” section to “" + section.Name + "”",
	}, r)
	httpx.WriteJSON(w, 200, packingSectionJSON(section))
}

func (a *App) handlePackingDeleteSection(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	sectionID, err := httpx.ParseUUID(r.PathValue("sectionId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	section, lst, serr := a.packingGetSection(sectionID, user.Sub)
	if serr != nil {
		// Already gone → idempotent; a real permission problem still surfaces.
		if he, ok := serr.(*httpx.HTTPError); ok && he.Status == http.StatusNotFound {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		httpx.WriteError(w, serr)
		return
	}
	var itemCount int64
	a.DB.Model(&models.PackingItem{}).Where("section_id = ?", sectionID).Count(&itemCount)
	if itemCount > 0 {
		httpx.Detail(w, http.StatusBadRequest, "Cannot delete section with items")
		return
	}
	if err := a.DB.Delete(&models.PackingSection{}, "id = ?", sectionID).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.packingBroadcast(lst, "section-deleted", J{
		"sectionId": sectionID.String(),
		"pushDetail": "removed the “" + section.Name + "” section",
	}, r)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handlePackingReorderSections(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		SectionIDs []string `json:"section_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	lst, lerr := a.packingGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	ids, err := parseUUIDList(payload.SectionIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		a.DB.Model(&models.PackingSection{}).
			Where("id = ? AND list_id = ?", id, listID).Update("position", i)
	}
	var sections []models.PackingSection
	a.DB.Where("list_id = ?", listID).Order("position ASC").Find(&sections)
	positions := make([]J, 0, len(sections))
	for _, s := range sections {
		positions = append(positions, J{"id": s.ID.String(), "position": s.Position})
	}
	a.packingBroadcast(lst, "sections-reordered", J{"sections": positions}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

func (a *App) handlePackingReorderItems(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
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
	section, lst, serr := a.packingGetSection(sectionID, user.Sub)
	if serr != nil {
		httpx.WriteError(w, serr)
		return
	}
	ids, err := parseUUIDList(payload.ItemIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		a.DB.Model(&models.PackingItem{}).
			Where("id = ? AND section_id = ?", id, section.ID).UpdateColumn("position", i)
	}
	var items []models.PackingItem
	a.DB.Where("section_id = ?", sectionID).Order("position ASC").Find(&items)
	positions := make([]J, 0, len(items))
	for _, item := range items {
		positions = append(positions, J{"id": item.ID.String(), "position": item.Position})
	}
	a.packingBroadcast(lst, "items-reordered", J{
		"sectionId": sectionID.String(), "items": positions,
	}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}

// ----- items -----

func (a *App) handlePackingAddItem(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	var payload struct {
		SectionID string  `json:"section_id"`
		Name      string  `json:"name"`
		Quantity  *string `json:"quantity"`
		BagID     *string `json:"bag_id"`
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
	section, lst, serr := a.packingGetSection(sectionID, user.Sub)
	if serr != nil {
		httpx.WriteError(w, serr)
		return
	}
	bagID, berr := a.packingResolveBag(payload.BagID, lst.ID)
	if berr != nil {
		httpx.WriteError(w, berr)
		return
	}
	var maxPos struct{ Position int }
	nextPos := 0
	if a.DB.Model(&models.PackingItem{}).Where("section_id = ?", sectionID).
		Order("position DESC").Limit(1).Scan(&maxPos).RowsAffected > 0 {
		nextPos = maxPos.Position + 1
	}
	item := models.PackingItem{
		SectionID: section.ID, Name: strings.TrimSpace(payload.Name),
		Quantity: payload.Quantity, Position: nextPos, BagID: bagID,
	}
	if err := a.DB.Create(&item).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	data := packingItemJSON(&item)
	a.packingBroadcast(lst, "item-added", J{
		"sectionId": section.ID.String(), "item": data,
		"pushDetail": "added “" + item.Name + "”",
	}, r)
	httpx.WriteJSON(w, 200, data)
}

// packingResolveBag validates that a bag id (if any) belongs to this list.
func (a *App) packingResolveBag(raw *string, listID uuid.UUID) (*uuid.UUID, error) {
	if raw == nil || *raw == "" {
		return nil, nil
	}
	id, err := uuid.Parse(*raw)
	if err != nil {
		return nil, httpx.NewHTTPError(http.StatusUnprocessableEntity, "Input should be a valid UUID")
	}
	var bag models.PackingBag
	if a.DB.Where("id = ? AND list_id = ?", id, listID).First(&bag).Error != nil {
		return nil, httpx.NewHTTPError(http.StatusNotFound, "Bag not found")
	}
	return &id, nil
}

func (a *App) handlePackingUpdateItem(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	itemID, err := httpx.ParseUUID(r.PathValue("itemId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name     *string `json:"name"`
		Quantity *string `json:"quantity"`
		Checked  *bool   `json:"checked"`
		BagID    *string `json:"bag_id"`
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
	item, _, lst, ierr := a.packingGetItem(itemID, user.Sub)
	if ierr != nil {
		httpx.WriteError(w, ierr)
		return
	}
	oldName := item.Name
	// Targeted column writes: concurrent PATCHes of disjoint fields must not
	// clobber each other, and a no-op must not bump updated_at.
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
	}
	if present["quantity"] {
		var newQuantity *string
		if payload.Quantity != nil && *payload.Quantity != "" {
			newQuantity = payload.Quantity
		}
		if (newQuantity == nil) != (item.Quantity == nil) ||
			(newQuantity != nil && *newQuantity != *item.Quantity) {
			item.Quantity = newQuantity
			updates["quantity"] = newQuantity
		}
	}
	if present["bag_id"] {
		bagID, berr := a.packingResolveBag(payload.BagID, lst.ID)
		if berr != nil {
			httpx.WriteError(w, berr)
			return
		}
		if (bagID == nil) != (item.BagID == nil) || (bagID != nil && *bagID != *item.BagID) {
			item.BagID = bagID
			updates["bag_id"] = bagID
		}
	}
	if len(updates) > 0 {
		updates["updated_at"] = models.NowUTC()
		if err := a.DB.Model(&models.PackingItem{}).Where("id = ?", itemID).Updates(updates).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	a.DB.Where("id = ?", itemID).First(item)
	extra := J{"sectionId": item.SectionID.String(), "item": packingItemJSON(item)}
	if _, ok := updates["checked"]; ok {
		verb := "unpacked"
		if item.Checked {
			verb = "packed"
		}
		extra["pushDetail"] = verb + " “" + item.Name + "”"
	} else if _, ok := updates["name"]; ok {
		extra["pushDetail"] = "renamed “" + oldName + "” to “" + item.Name + "”"
	} else {
		extra["pushDetail"] = "updated “" + item.Name + "”"
	}
	a.packingBroadcast(lst, "item-updated", extra, r)
	httpx.WriteJSON(w, 200, packingItemJSON(item))
}

func (a *App) handlePackingMoveItem(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
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
	item, _, lst, ierr := a.packingGetItem(itemID, user.Sub)
	if ierr != nil {
		httpx.WriteError(w, ierr)
		return
	}
	var target models.PackingSection
	if a.DB.Where("id = ? AND list_id = ?", toSectionID, lst.ID).First(&target).Error != nil {
		httpx.Detail(w, http.StatusNotFound, "Target section not found")
		return
	}

	oldSectionID := item.SectionID
	item.SectionID = toSectionID
	item.Position = *payload.ToPosition
	if err := a.DB.Model(&models.PackingItem{}).Where("id = ?", item.ID).Updates(map[string]any{
		"section_id": toSectionID, "position": item.Position, "updated_at": models.NowUTC(),
	}).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}

	reindex := func(sectionID uuid.UUID) {
		var items []models.PackingItem
		a.DB.Where("section_id = ?", sectionID).Order("position ASC").Find(&items)
		for i := range items {
			if items[i].Position != i {
				a.DB.Model(&models.PackingItem{}).Where("id = ?", items[i].ID).UpdateColumn("position", i)
			}
		}
	}
	reindex(oldSectionID)
	reindex(toSectionID)

	a.DB.Where("id = ?", itemID).First(item)
	a.packingBroadcast(lst, "item-moved", J{
		"fromSectionId": oldSectionID.String(),
		"toSectionId":   item.SectionID.String(),
		"item":          packingItemJSON(item),
		"pushDetail":    "moved “" + item.Name + "” to “" + target.Name + "”",
	}, r)
	httpx.WriteJSON(w, 200, packingItemJSON(item))
}

func (a *App) handlePackingDeleteItem(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	itemID, err := httpx.ParseUUID(r.PathValue("itemId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	item, _, lst, ierr := a.packingGetItem(itemID, user.Sub)
	if ierr != nil {
		if he, ok := ierr.(*httpx.HTTPError); ok && he.Status == http.StatusNotFound {
			httpx.WriteJSON(w, 200, J{"status": "deleted"}) // idempotent
			return
		}
		httpx.WriteError(w, ierr)
		return
	}
	sectionID := item.SectionID
	if err := a.DB.Delete(&models.PackingItem{}, "id = ?", itemID).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.packingBroadcast(lst, "item-deleted", J{
		"sectionId": sectionID.String(), "itemId": itemID.String(),
		"pushDetail": "removed “" + item.Name + "”",
	}, r)
	httpx.WriteJSON(w, 200, J{"status": "deleted"})
}

// handlePackingCheckAll flips every item in the list at once ("Check all" /
// "Uncheck all"). Positions are untouched, so unchecking restores the exact
// arrangement the user had.
func (a *App) handlePackingCheckAll(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Checked *bool `json:"checked"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.Checked == nil {
		httpx.ValidationError(w, "checked is required")
		return
	}
	lst, lerr := a.packingGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	var sectionIDs []string
	a.DB.Model(&models.PackingSection{}).Where("list_id = ?", listID).Pluck("id", &sectionIDs)
	if len(sectionIDs) > 0 {
		if err := a.DB.Model(&models.PackingItem{}).
			Where("section_id IN ? AND checked <> ?", sectionIDs, *payload.Checked).
			Updates(map[string]any{"checked": *payload.Checked, "updated_at": models.NowUTC()}).Error; err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	lst, lerr = a.packingGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	detail := "unpacked everything in “" + lst.Name + "”"
	if *payload.Checked {
		detail = "packed everything in “" + lst.Name + "”"
	}
	a.packingBroadcastList(lst, "checked-all", detail, r)
	httpx.WriteJSON(w, 200, a.packingListJSON(lst, user.Sub))
}

// ----- bags -----

func (a *App) handlePackingCreateBag(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name     string `json:"name"`
		Position *int   `json:"position"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	lst, lerr := a.packingGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	name := strings.TrimSpace(payload.Name)
	// Bag names are unique per list — a duplicate returns the existing bag so
	// the offline queue can replay a create idempotently.
	var existing models.PackingBag
	if a.DB.Where("list_id = ? AND LOWER(name) = ?", listID, strings.ToLower(name)).
		First(&existing).Error == nil {
		httpx.WriteJSON(w, http.StatusCreated, packingBagJSON(&existing))
		return
	}
	position := len(lst.Bags)
	if payload.Position != nil {
		position = *payload.Position
	}
	bag := models.PackingBag{ListID: listID, Name: name, Position: position}
	if err := a.DB.Create(&bag).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	data := packingBagJSON(&bag)
	a.packingBroadcast(lst, "bag-added", J{
		"bag": data, "pushDetail": "added the “" + bag.Name + "” bag",
	}, r)
	httpx.WriteJSON(w, http.StatusCreated, data)
}

func (a *App) handlePackingUpdateBag(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	bagID, err := httpx.ParseUUID(r.PathValue("bagId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		Name *string `json:"name"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil || payload.Name == nil || strings.TrimSpace(*payload.Name) == "" {
		httpx.ValidationError(w, "name is required")
		return
	}
	bag, lst, berr := a.packingGetBag(bagID, user.Sub)
	if berr != nil {
		httpx.WriteError(w, berr)
		return
	}
	oldName := bag.Name
	bag.Name = strings.TrimSpace(*payload.Name)
	if err := a.DB.Model(&models.PackingBag{}).Where("id = ?", bagID).Update("name", bag.Name).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	data := packingBagJSON(bag)
	a.packingBroadcast(lst, "bag-updated", J{
		"bag": data, "pushDetail": "renamed the “" + oldName + "” bag to “" + bag.Name + "”",
	}, r)
	httpx.WriteJSON(w, 200, data)
}

func (a *App) handlePackingDeleteBag(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	bagID, err := httpx.ParseUUID(r.PathValue("bagId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	bag, lst, berr := a.packingGetBag(bagID, user.Sub)
	if berr != nil {
		if he, ok := berr.(*httpx.HTTPError); ok && he.Status == http.StatusNotFound {
			w.WriteHeader(http.StatusNoContent) // idempotent
			return
		}
		httpx.WriteError(w, berr)
		return
	}
	// Items keep their place; they just lose the bag assignment.
	var sectionIDs []string
	a.DB.Model(&models.PackingSection{}).Where("list_id = ?", lst.ID).Pluck("id", &sectionIDs)
	if len(sectionIDs) > 0 {
		a.DB.Model(&models.PackingItem{}).
			Where("section_id IN ? AND bag_id = ?", sectionIDs, bagID).
			UpdateColumn("bag_id", nil)
	}
	if err := a.DB.Delete(&models.PackingBag{}, "id = ?", bagID).Error; err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.packingBroadcast(lst, "bag-deleted", J{
		"bagId": bagID.String(), "pushDetail": "removed the “" + bag.Name + "” bag",
	}, r)
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handlePackingReorderBags(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	listID, err := httpx.ParseUUID(r.PathValue("listId"))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var payload struct {
		BagIDs []string `json:"bag_ids"`
	}
	if _, err := httpx.DecodeBody(r, &payload); err != nil {
		httpx.ValidationError(w, "Invalid request body")
		return
	}
	lst, lerr := a.packingGetList(listID, user.Sub, false)
	if lerr != nil {
		httpx.WriteError(w, lerr)
		return
	}
	ids, err := parseUUIDList(payload.BagIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for i, id := range ids {
		a.DB.Model(&models.PackingBag{}).
			Where("id = ? AND list_id = ?", id, listID).Update("position", i)
	}
	var bags []models.PackingBag
	a.DB.Where("list_id = ?", listID).Order("position ASC").Find(&bags)
	positions := make([]J, 0, len(bags))
	for _, b := range bags {
		positions = append(positions, J{"id": b.ID.String(), "position": b.Position})
	}
	a.packingBroadcast(lst, "bags-reordered", J{"bags": positions}, r)
	httpx.WriteJSON(w, 200, J{"status": "ok"})
}
