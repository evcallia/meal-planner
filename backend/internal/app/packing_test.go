package app

// Travel / packing list endpoint tests. Mirrors tracker_test.go's shape:
// in-memory SQLite, signed cookies for two users, SSE collectors.

import (
	"encoding/json"
	"net/http"
	"testing"

	"mealplanner/internal/models"
)

type pkList struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	IsOwner    bool   `json:"is_owner"`
	Position   int    `json:"position"`
	SharedWith []struct {
		Sub string `json:"sub"`
	} `json:"shared_with"`
	Bags     []pkBag     `json:"bags"`
	Sections []pkSection `json:"sections"`
}

type pkBag struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

type pkSection struct {
	ID       string   `json:"id"`
	ListID   string   `json:"list_id"`
	Name     string   `json:"name"`
	Position int      `json:"position"`
	Items    []pkItem `json:"items"`
}

type pkItem struct {
	ID        string  `json:"id"`
	SectionID string  `json:"section_id"`
	Name      string  `json:"name"`
	Quantity  *string `json:"quantity"`
	Checked   bool    `json:"checked"`
	Position  int     `json:"position"`
	BagID     *string `json:"bag_id"`
}

func decodeInto[T any](t *testing.T, body []byte, dst *T) {
	t.Helper()
	if err := json.Unmarshal(body, dst); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
}

// createPackingList makes a list and returns it.
func createPackingList(t *testing.T, ta *testApp, name string) pkList {
	t.Helper()
	res := ta.POST("/api/packing/lists", map[string]any{"name": name})
	if res.Status != http.StatusCreated {
		t.Fatalf("create list: %d %s", res.Status, res.Body)
	}
	var lst pkList
	decodeInto(t, res.Body, &lst)
	return lst
}

func createPackingSection(t *testing.T, ta *testApp, listID, name string) pkSection {
	t.Helper()
	res := ta.POST("/api/packing/lists/"+listID+"/sections", map[string]any{"name": name})
	if res.Status != http.StatusCreated {
		t.Fatalf("create section: %d %s", res.Status, res.Body)
	}
	var sec pkSection
	decodeInto(t, res.Body, &sec)
	return sec
}

func addPackingItem(t *testing.T, ta *testApp, sectionID, name string, bagID *string) pkItem {
	t.Helper()
	body := map[string]any{"section_id": sectionID, "name": name}
	if bagID != nil {
		body["bag_id"] = *bagID
	}
	res := ta.POST("/api/packing/items", body)
	if res.Status != 200 {
		t.Fatalf("add item %q: %d %s", name, res.Status, res.Body)
	}
	var item pkItem
	decodeInto(t, res.Body, &item)
	return item
}

func getPackingLists(t *testing.T, ta *testApp, cookie *http.Cookie) []pkList {
	t.Helper()
	res := ta.do("GET", "/api/packing", nil, cookie)
	if res.Status != 200 {
		t.Fatalf("list packing: %d %s", res.Status, res.Body)
	}
	var lists []pkList
	decodeInto(t, res.Body, &lists)
	return lists
}

func TestPackingCreateListAndSubtree(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	if !lst.IsOwner || lst.Name != "Paris" {
		t.Fatalf("unexpected list: %+v", lst)
	}
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	bagRes := ta.POST("/api/packing/lists/"+lst.ID+"/bags", map[string]any{"name": "Carry On"})
	if bagRes.Status != http.StatusCreated {
		t.Fatalf("create bag: %d %s", bagRes.Status, bagRes.Body)
	}
	var bag pkBag
	decodeInto(t, bagRes.Body, &bag)
	addPackingItem(t, ta, sec.ID, "Socks", &bag.ID)

	lists := getPackingLists(t, ta, ta.Cookie)
	if len(lists) != 1 {
		t.Fatalf("want 1 list, got %d", len(lists))
	}
	got := lists[0]
	if len(got.Bags) != 1 || got.Bags[0].Name != "Carry On" {
		t.Fatalf("bags = %+v", got.Bags)
	}
	if len(got.Sections) != 1 || len(got.Sections[0].Items) != 1 {
		t.Fatalf("sections = %+v", got.Sections)
	}
	item := got.Sections[0].Items[0]
	if item.Name != "Socks" || item.BagID == nil || *item.BagID != bag.ID {
		t.Fatalf("item = %+v", item)
	}
}

// Checking an item must leave its position alone: it sorts to the bottom of
// its section while checked and returns to its exact slot when unchecked.
func TestPackingCheckedItemsKeepPosition(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Dolomites")
	sec := createPackingSection(t, ta, lst.ID, "Gear")
	a := addPackingItem(t, ta, sec.ID, "Boots", nil)
	b := addPackingItem(t, ta, sec.ID, "Poles", nil)
	c := addPackingItem(t, ta, sec.ID, "Helmet", nil)
	if a.Position != 0 || b.Position != 1 || c.Position != 2 {
		t.Fatalf("positions = %d %d %d", a.Position, b.Position, c.Position)
	}

	if res := ta.PATCH("/api/packing/items/"+a.ID, map[string]any{"checked": true}); res.Status != 200 {
		t.Fatalf("check: %d %s", res.Status, res.Body)
	}

	names := func() []string {
		lists := getPackingLists(t, ta, ta.Cookie)
		out := []string{}
		for _, i := range lists[0].Sections[0].Items {
			out = append(out, i.Name)
		}
		return out
	}
	if got := names(); got[0] != "Poles" || got[1] != "Helmet" || got[2] != "Boots" {
		t.Fatalf("checked item did not sink to the bottom: %v", got)
	}
	// Position untouched in the DB.
	var stored models.PackingItem
	ta.App.DB.Where("id = ?", a.ID).First(&stored)
	if stored.Position != 0 {
		t.Fatalf("position mutated on check: %d", stored.Position)
	}

	if res := ta.PATCH("/api/packing/items/"+a.ID, map[string]any{"checked": false}); res.Status != 200 {
		t.Fatalf("uncheck: %d %s", res.Status, res.Body)
	}
	if got := names(); got[0] != "Boots" || got[1] != "Poles" || got[2] != "Helmet" {
		t.Fatalf("unchecking did not restore order: %v", got)
	}
}

func TestPackingCheckAllAndUncheckAll(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	s1 := createPackingSection(t, ta, lst.ID, "Clothes")
	s2 := createPackingSection(t, ta, lst.ID, "Tech")
	addPackingItem(t, ta, s1.ID, "Socks", nil)
	addPackingItem(t, ta, s2.ID, "Charger", nil)

	res := ta.POST("/api/packing/lists/"+lst.ID+"/check-all", map[string]any{"checked": true})
	if res.Status != 200 {
		t.Fatalf("check-all: %d %s", res.Status, res.Body)
	}
	var after pkList
	decodeInto(t, res.Body, &after)
	for _, s := range after.Sections {
		for _, i := range s.Items {
			if !i.Checked {
				t.Fatalf("item %q not checked", i.Name)
			}
		}
	}

	res = ta.POST("/api/packing/lists/"+lst.ID+"/check-all", map[string]any{"checked": false})
	if res.Status != 200 {
		t.Fatalf("uncheck-all: %d %s", res.Status, res.Body)
	}
	decodeInto(t, res.Body, &after)
	for _, s := range after.Sections {
		for _, i := range s.Items {
			if i.Checked {
				t.Fatalf("item %q still checked", i.Name)
			}
		}
	}

	// A missing `checked` must 422 rather than defaulting to false.
	if res := ta.POST("/api/packing/lists/"+lst.ID+"/check-all", map[string]any{}); res.Status != 422 {
		t.Fatalf("missing checked: %d", res.Status)
	}
}

func TestPackingListIsPrivateUntilShared(t *testing.T) {
	ta := newTestApp(t)
	other := ta.LoginAs("other-sub", "other@example.com", "Other Person")
	ta.App.DB.Create(&models.User{Sub: "other-sub", Email: ptr("other@example.com"), Name: ptr("Other Person")})

	lst := createPackingList(t, ta, "Paris")

	if lists := getPackingLists(t, ta, other); len(lists) != 0 {
		t.Fatalf("other user sees %d lists before sharing", len(lists))
	}
	if res := ta.do("PATCH", "/api/packing/lists/"+lst.ID, map[string]any{"name": "Hijacked"}, other); res.Status != 403 {
		t.Fatalf("non-member update: %d", res.Status)
	}

	if res := ta.POST("/api/packing/lists/"+lst.ID+"/shares", map[string]any{"sub": "other-sub"}); res.Status != 200 {
		t.Fatalf("share: %d %s", res.Status, res.Body)
	}
	shared := getPackingLists(t, ta, other)
	if len(shared) != 1 || shared[0].IsOwner {
		t.Fatalf("shared perspective wrong: %+v", shared)
	}
	// Shared users collaborate but cannot delete or re-share.
	if res := ta.do("DELETE", "/api/packing/lists/"+lst.ID, nil, other); res.Status != 403 {
		t.Fatalf("shared user delete: %d", res.Status)
	}
	if res := ta.do("POST", "/api/packing/lists/"+lst.ID+"/shares", map[string]any{"sub": "third"}, other); res.Status != 403 {
		t.Fatalf("shared user re-share: %d", res.Status)
	}
	if res := ta.do("POST", "/api/packing/lists/"+lst.ID+"/sections", map[string]any{"name": "Clothes"}, other); res.Status != 201 {
		t.Fatalf("shared user add section: %d %s", res.Status, res.Body)
	}
}

// Packing events go only to the list's audience — never the global broadcast.
func TestPackingBroadcastsOnlyToAudience(t *testing.T) {
	ta := newTestApp(t)
	ta.App.DB.Create(&models.User{Sub: "wife-sub", Email: ptr("wife@example.com"), Name: ptr("Wife")})
	lst := createPackingList(t, ta, "Paris")
	ta.POST("/api/packing/lists/"+lst.ID+"/shares", map[string]any{"sub": "wife-sub"})

	member := ta.Collect("wife-sub")
	stranger := ta.Collect("stranger-sub")
	createPackingSection(t, ta, lst.ID, "Clothes")

	if member.LastPayload("packing.updated") == nil {
		t.Fatal("member got no packing.updated event")
	}
	if len(stranger.Events()) != 0 {
		t.Fatal("stranger received a packing event")
	}
}

func TestPackingBagDeleteClearsAssignment(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	bagRes := ta.POST("/api/packing/lists/"+lst.ID+"/bags", map[string]any{"name": "Carry On"})
	var bag pkBag
	decodeInto(t, bagRes.Body, &bag)
	item := addPackingItem(t, ta, sec.ID, "Socks", &bag.ID)

	if res := ta.DELETE("/api/packing/bags/" + bag.ID); res.Status != 204 {
		t.Fatalf("delete bag: %d %s", res.Status, res.Body)
	}
	var stored models.PackingItem
	ta.App.DB.Where("id = ?", item.ID).First(&stored)
	if stored.BagID != nil {
		t.Fatalf("bag_id not cleared: %v", stored.BagID)
	}
	// Idempotent.
	if res := ta.DELETE("/api/packing/bags/" + bag.ID); res.Status != 204 {
		t.Fatalf("second delete: %d", res.Status)
	}
}

// Bag creates are idempotent by name so a replayed offline queue entry can't
// spawn duplicates.
func TestPackingBagCreateIsIdempotentByName(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	first := ta.POST("/api/packing/lists/"+lst.ID+"/bags", map[string]any{"name": "Carry On"})
	second := ta.POST("/api/packing/lists/"+lst.ID+"/bags", map[string]any{"name": "carry on"})
	var a, b pkBag
	decodeInto(t, first.Body, &a)
	decodeInto(t, second.Body, &b)
	if a.ID != b.ID {
		t.Fatalf("duplicate bag created: %s vs %s", a.ID, b.ID)
	}
}

// A bag from another list must not be assignable.
func TestPackingItemRejectsForeignBag(t *testing.T) {
	ta := newTestApp(t)
	one := createPackingList(t, ta, "Paris")
	two := createPackingList(t, ta, "Dolomites")
	sec := createPackingSection(t, ta, one.ID, "Clothes")
	bagRes := ta.POST("/api/packing/lists/"+two.ID+"/bags", map[string]any{"name": "Ski Bag"})
	var bag pkBag
	decodeInto(t, bagRes.Body, &bag)

	res := ta.POST("/api/packing/items", map[string]any{
		"section_id": sec.ID, "name": "Socks", "bag_id": bag.ID,
	})
	if res.Status != 404 {
		t.Fatalf("foreign bag accepted: %d %s", res.Status, res.Body)
	}
}

func TestPackingDeleteSectionIsIdempotent(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	addPackingItem(t, ta, sec.ID, "Socks", nil)

	// Non-empty is fine — the section takes its items with it.
	if res := ta.DELETE("/api/packing/sections/" + sec.ID); res.Status != 204 {
		t.Fatalf("delete section: %d %s", res.Status, res.Body)
	}
	if res := ta.DELETE("/api/packing/sections/" + sec.ID); res.Status != 204 {
		t.Fatalf("second delete: %d", res.Status)
	}
}

// A section exists only to group items: deleting it takes them along, and one
// emptied by a delete or a move disappears on its own.
func TestPackingDeleteSectionTakesItsItems(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	keep := createPackingSection(t, ta, lst.ID, "Tech")
	addPackingItem(t, ta, sec.ID, "Socks", nil)
	addPackingItem(t, ta, sec.ID, "Shirt", nil)
	addPackingItem(t, ta, keep.ID, "Charger", nil)

	if res := ta.DELETE("/api/packing/sections/" + sec.ID); res.Status != 204 {
		t.Fatalf("delete section with items: %d %s", res.Status, res.Body)
	}
	lists := getPackingLists(t, ta, ta.Cookie)
	if len(lists[0].Sections) != 1 || lists[0].Sections[0].ID != keep.ID {
		t.Fatalf("sections = %+v", lists[0].Sections)
	}
	var orphans int64
	ta.App.DB.Model(&models.PackingItem{}).Where("section_id = ?", sec.ID).Count(&orphans)
	if orphans != 0 {
		t.Fatalf("items outlived their section: %d", orphans)
	}
	if len(lists[0].Sections[0].Items) != 1 {
		t.Fatalf("other section damaged: %+v", lists[0].Sections[0].Items)
	}
}

func TestPackingSectionVanishesWhenLastItemDeleted(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	a := addPackingItem(t, ta, sec.ID, "Socks", nil)
	b := addPackingItem(t, ta, sec.ID, "Shirt", nil)

	ta.DELETE("/api/packing/items/" + a.ID)
	lists := getPackingLists(t, ta, ta.Cookie)
	if len(lists[0].Sections) != 1 {
		t.Fatalf("section removed too early: %+v", lists[0].Sections)
	}

	ta.DELETE("/api/packing/items/" + b.ID)
	lists = getPackingLists(t, ta, ta.Cookie)
	if len(lists[0].Sections) != 0 {
		t.Fatalf("emptied section survived: %+v", lists[0].Sections)
	}
}

func TestPackingSectionVanishesWhenLastItemMovedOut(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	from := createPackingSection(t, ta, lst.ID, "Clothes")
	to := createPackingSection(t, ta, lst.ID, "Tech")
	item := addPackingItem(t, ta, from.ID, "Socks", nil)
	addPackingItem(t, ta, to.ID, "Charger", nil)

	res := ta.PATCH("/api/packing/items/"+item.ID+"/move",
		map[string]any{"to_section_id": to.ID, "to_position": 0})
	if res.Status != 200 {
		t.Fatalf("move: %d %s", res.Status, res.Body)
	}
	lists := getPackingLists(t, ta, ta.Cookie)
	if len(lists[0].Sections) != 1 || lists[0].Sections[0].ID != to.ID {
		t.Fatalf("source section survived the move: %+v", lists[0].Sections)
	}
	if len(lists[0].Sections[0].Items) != 2 {
		t.Fatalf("target section = %+v", lists[0].Sections[0].Items)
	}
}

// A section created empty is left alone — quick-add makes one before the first
// item lands, and pruning it there would delete the section out from under it.
func TestPackingEmptySectionIsNotAutoPruned(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	other := createPackingSection(t, ta, lst.ID, "Tech")
	item := addPackingItem(t, ta, other.ID, "Charger", nil)

	ta.DELETE("/api/packing/items/" + item.ID)
	lists := getPackingLists(t, ta, ta.Cookie)
	ids := map[string]bool{}
	for _, s := range lists[0].Sections {
		ids[s.ID] = true
	}
	if !ids[sec.ID] {
		t.Fatalf("never-filled section was pruned: %+v", lists[0].Sections)
	}
	if ids[other.ID] {
		t.Fatalf("emptied section survived: %+v", lists[0].Sections)
	}
}

// The audience needs the section-deleted event too, or their view keeps a
// header with nothing under it.
func TestPackingPruneBroadcastsSectionDeleted(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	item := addPackingItem(t, ta, sec.ID, "Socks", nil)

	c := ta.Collect(TestSub)
	ta.DELETE("/api/packing/items/" + item.ID)

	var sawItem, sawSection bool
	for _, e := range c.Events() {
		if e["type"] != "packing.updated" {
			continue
		}
		p, _ := e["payload"].(map[string]any)
		switch p["action"] {
		case "item-deleted":
			sawItem = true
		case "section-deleted":
			sawSection = true
			if p["sectionId"] != sec.ID {
				t.Fatalf("wrong section pruned: %v", p["sectionId"])
			}
		}
	}
	if !sawItem || !sawSection {
		t.Fatalf("events: item-deleted=%v section-deleted=%v", sawItem, sawSection)
	}
}

func TestPackingMoveItemBetweenSections(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	s1 := createPackingSection(t, ta, lst.ID, "Clothes")
	s2 := createPackingSection(t, ta, lst.ID, "Tech")
	item := addPackingItem(t, ta, s1.ID, "Socks", nil)
	addPackingItem(t, ta, s2.ID, "Charger", nil)

	res := ta.PATCH("/api/packing/items/"+item.ID+"/move", map[string]any{
		"to_section_id": s2.ID, "to_position": 0,
	})
	if res.Status != 200 {
		t.Fatalf("move: %d %s", res.Status, res.Body)
	}
	lists := getPackingLists(t, ta, ta.Cookie)
	var tech pkSection
	for _, s := range lists[0].Sections {
		if s.ID == s2.ID {
			tech = s
		}
	}
	if len(tech.Items) != 2 || tech.Items[0].Name != "Socks" || tech.Items[1].Name != "Charger" {
		t.Fatalf("target section = %+v", tech.Items)
	}
	// to_position is required (no silent move to 0).
	if res := ta.PATCH("/api/packing/items/"+item.ID+"/move", map[string]any{"to_section_id": s1.ID}); res.Status != 422 {
		t.Fatalf("missing to_position: %d", res.Status)
	}
}

func TestPackingReorderItemsAndSections(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	s1 := createPackingSection(t, ta, lst.ID, "Clothes")
	s2 := createPackingSection(t, ta, lst.ID, "Tech")
	a := addPackingItem(t, ta, s1.ID, "Socks", nil)
	b := addPackingItem(t, ta, s1.ID, "Shirt", nil)

	if res := ta.PATCH("/api/packing/sections/"+s1.ID+"/reorder-items",
		map[string]any{"item_ids": []string{b.ID, a.ID}}); res.Status != 200 {
		t.Fatalf("reorder items: %d %s", res.Status, res.Body)
	}
	if res := ta.PATCH("/api/packing/lists/"+lst.ID+"/reorder-sections",
		map[string]any{"section_ids": []string{s2.ID, s1.ID}}); res.Status != 200 {
		t.Fatalf("reorder sections: %d %s", res.Status, res.Body)
	}
	lists := getPackingLists(t, ta, ta.Cookie)
	if lists[0].Sections[0].ID != s2.ID {
		t.Fatalf("sections not reordered: %+v", lists[0].Sections)
	}
	clothes := lists[0].Sections[1]
	if clothes.Items[0].Name != "Shirt" {
		t.Fatalf("items not reordered: %+v", clothes.Items)
	}
}

// Reordering items must not bump updated_at (it drives nothing here, but the
// grocery equivalent guards the same invariant and the queue replays these).
func TestPackingReorderKeepsUpdatedAt(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	a := addPackingItem(t, ta, sec.ID, "Socks", nil)
	b := addPackingItem(t, ta, sec.ID, "Shirt", nil)

	var before models.PackingItem
	ta.App.DB.Where("id = ?", a.ID).First(&before)
	ta.PATCH("/api/packing/sections/"+sec.ID+"/reorder-items", map[string]any{"item_ids": []string{b.ID, a.ID}})
	var after models.PackingItem
	ta.App.DB.Where("id = ?", a.ID).First(&after)
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("updated_at changed on reorder: %v -> %v", before.UpdatedAt, after.UpdatedAt)
	}
}

func TestPackingRestoreList(t *testing.T) {
	ta := newTestApp(t)
	res := ta.POST("/api/packing/lists/restore", map[string]any{
		"name":  "Paris",
		"color": "blue",
		"bags":  []map[string]any{{"name": "Carry On", "position": 0}},
		"sections": []map[string]any{{
			"name": "Clothes", "position": 0,
			"items": []map[string]any{
				{"name": "Socks", "position": 0, "bag_name": "Carry On", "checked": true},
				{"name": "Shirt", "position": 1},
			},
		}},
	})
	if res.Status != http.StatusCreated {
		t.Fatalf("restore: %d %s", res.Status, res.Body)
	}
	var lst pkList
	decodeInto(t, res.Body, &lst)
	if len(lst.Bags) != 1 || len(lst.Sections) != 1 || len(lst.Sections[0].Items) != 2 {
		t.Fatalf("restored shape wrong: %+v", lst)
	}
	// Checked item sorts last; its bag reference was rebound to the new bag id.
	items := lst.Sections[0].Items
	if items[0].Name != "Shirt" || items[1].Name != "Socks" || !items[1].Checked {
		t.Fatalf("restored items = %+v", items)
	}
	if items[1].BagID == nil || *items[1].BagID != lst.Bags[0].ID {
		t.Fatalf("bag not rebound: %+v", items[1])
	}
}

func TestPackingLeaveAndRejoin(t *testing.T) {
	ta := newTestApp(t)
	other := ta.LoginAs("other-sub", "other@example.com", "Other")
	ta.App.DB.Create(&models.User{Sub: "other-sub", Email: ptr("other@example.com"), Name: ptr("Other")})
	lst := createPackingList(t, ta, "Paris")
	ta.POST("/api/packing/lists/"+lst.ID+"/shares", map[string]any{"sub": "other-sub"})

	if res := ta.do("POST", "/api/packing/lists/"+lst.ID+"/leave", nil, other); res.Status != 204 {
		t.Fatalf("leave: %d %s", res.Status, res.Body)
	}
	if lists := getPackingLists(t, ta, other); len(lists) != 0 {
		t.Fatalf("still visible after leaving: %d", len(lists))
	}
	if res := ta.do("POST", "/api/packing/lists/"+lst.ID+"/rejoin", nil, other); res.Status != 200 {
		t.Fatalf("rejoin: %d %s", res.Status, res.Body)
	}
	if lists := getPackingLists(t, ta, other); len(lists) != 1 {
		t.Fatalf("not visible after rejoin: %d", len(lists))
	}
	// The owner can never leave their own list.
	if res := ta.POST("/api/packing/lists/"+lst.ID+"/leave", nil); res.Status != 400 {
		t.Fatalf("owner leave: %d", res.Status)
	}
}

// List order is per-user: reordering for one member must not move the tabs for
// anyone else.
func TestPackingReorderListsIsPerUser(t *testing.T) {
	ta := newTestApp(t)
	other := ta.LoginAs("other-sub", "other@example.com", "Other")
	ta.App.DB.Create(&models.User{Sub: "other-sub", Email: ptr("other@example.com"), Name: ptr("Other")})
	one := createPackingList(t, ta, "Paris")
	two := createPackingList(t, ta, "Dolomites")
	for _, l := range []pkList{one, two} {
		ta.POST("/api/packing/lists/"+l.ID+"/shares", map[string]any{"sub": "other-sub"})
	}

	if res := ta.do("PATCH", "/api/packing/reorder-lists",
		map[string]any{"list_ids": []string{two.ID, one.ID}}, other); res.Status != 200 {
		t.Fatalf("reorder: %d %s", res.Status, res.Body)
	}
	if got := getPackingLists(t, ta, other); got[0].ID != two.ID {
		t.Fatalf("other's order not applied: %+v", got)
	}
	if got := getPackingLists(t, ta, ta.Cookie); got[0].ID != one.ID {
		t.Fatalf("owner's order changed: %+v", got)
	}
}

// The activity feed / push gate must recognise the new "travel" category and
// keep tracker-list overrides from leaking across features.
func TestPackingActivityFeedRespectsTravelPref(t *testing.T) {
	ta := newTestApp(t)
	viewer := ta.LoginAs("wife-sub", "wife@example.com", "Wife")
	ta.App.DB.Create(&models.User{Sub: "wife-sub", Email: ptr("wife@example.com"), Name: ptr("Wife")})
	lst := createPackingList(t, ta, "Paris")
	ta.POST("/api/packing/lists/"+lst.ID+"/shares", map[string]any{"sub": "wife-sub"})
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	addPackingItem(t, ta, sec.ID, "Socks", nil)

	feed := func() []map[string]any {
		res := ta.do("GET", "/api/activity", nil, viewer)
		var body struct {
			Entries []map[string]any `json:"entries"`
		}
		decodeInto(t, res.Body, &body)
		return body.Entries
	}

	// Opt-in by default off → nothing in the feed.
	if got := feed(); len(got) != 0 {
		t.Fatalf("feed leaked with prefs off: %+v", got)
	}

	ta.App.DB.Create(&models.UserSettings{
		Sub: "wife-sub", Settings: `{"notifyTravelEdits":true}`, UpdatedAt: models.NowUTC(),
	})
	entries := feed()
	if len(entries) == 0 {
		t.Fatal("feed empty with notifyTravelEdits on")
	}
	for _, e := range entries {
		if e["category"] != "travel" {
			t.Fatalf("unexpected category: %+v", e)
		}
		if e["list_name"] != "Paris" {
			t.Fatalf("missing list name: %+v", e)
		}
	}

	// A per-list mute suppresses them again.
	ta.App.DB.Model(&models.UserSettings{}).Where("sub = ?", "wife-sub").
		Update("settings", `{"notifyTravelEdits":true,"listNotifyOverrides":{"`+lst.ID+`":{"edits":false}}}`)
	if got := feed(); len(got) != 0 {
		t.Fatalf("per-list mute ignored: %+v", got)
	}
}

func TestPackingDeleteListIsOwnerOnlyAndIdempotent(t *testing.T) {
	ta := newTestApp(t)
	lst := createPackingList(t, ta, "Paris")
	sec := createPackingSection(t, ta, lst.ID, "Clothes")
	addPackingItem(t, ta, sec.ID, "Socks", nil)

	if res := ta.DELETE("/api/packing/lists/" + lst.ID); res.Status != 204 {
		t.Fatalf("delete: %d %s", res.Status, res.Body)
	}
	// Cascade: sections and items go with it.
	var sections, items int64
	ta.App.DB.Model(&models.PackingSection{}).Count(&sections)
	ta.App.DB.Model(&models.PackingItem{}).Count(&items)
	if sections != 0 || items != 0 {
		t.Fatalf("cascade failed: %d sections, %d items", sections, items)
	}
	if res := ta.DELETE("/api/packing/lists/" + lst.ID); res.Status != 204 {
		t.Fatalf("second delete: %d", res.Status)
	}
}

func ptr[T any](v T) *T { return &v }
