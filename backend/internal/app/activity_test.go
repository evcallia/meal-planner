package app

// Activity feed tests: entries record other users' edits with the same
// phrasing as push notifications, tracker rows respect list membership, and
// the seen marker round-trips.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"mealplanner/internal/models"
)

type activityResponse struct {
	Entries []struct {
		ID        string `json:"id"`
		At        string `json:"at"`
		ActorName string `json:"actor_name"`
		Category  string `json:"category"`
		Detail    string `json:"detail"`
		ListName  string `json:"list_name"`
	} `json:"entries"`
	LastSeen *string `json:"last_seen"`
}

func TestActivityFeedRecordsOtherUsersEdits(t *testing.T) {
	ta := newTestApp(t)
	cookieB := ta.LoginAs("wife-sub", "wife@example.com", "Wife")
	enableAllPrefsApp(t, ta, "wife-sub")

	// A adds a grocery item (via section create + item add).
	res := ta.POST("/api/grocery/sections", map[string]any{"name": "Produce"})
	if res.Status != 201 {
		t.Fatalf("create section: %d", res.Status)
	}
	var section struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &section)
	if res := ta.POST("/api/grocery/items", map[string]any{"section_id": section.ID, "name": "Milk"}); res.Status != 200 {
		t.Fatalf("add item: %d %s", res.Status, res.Body)
	}

	// B sees A's edits; A sees nothing (own edits are excluded).
	var feedB activityResponse
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieB).Body, &feedB)
	if len(feedB.Entries) != 2 {
		t.Fatalf("B should see 2 entries, got %+v", feedB.Entries)
	}
	// Newest first.
	if feedB.Entries[0].Detail != "added “Milk”" || feedB.Entries[0].Category != "grocery" {
		t.Fatalf("unexpected first entry %+v", feedB.Entries[0])
	}
	if feedB.Entries[0].ActorName != TestName {
		t.Fatalf("unexpected actor %q", feedB.Entries[0].ActorName)
	}
	if feedB.Entries[1].Detail != "added a “Produce” section" {
		t.Fatalf("unexpected second entry %+v", feedB.Entries[1])
	}

	var feedA activityResponse
	_ = json.Unmarshal(ta.GET("/api/activity").Body, &feedA)
	if len(feedA.Entries) != 0 {
		t.Fatalf("A must not see their own edits, got %+v", feedA.Entries)
	}
}

func TestActivityFeedSkipsReorders(t *testing.T) {
	ta := newTestApp(t)
	cookieB := ta.LoginAs("wife-sub", "wife@example.com", "Wife")
	enableAllPrefsApp(t, ta, "wife-sub")

	ta.POST("/api/grocery/sections", map[string]any{"name": "Produce"})
	ta.PATCH("/api/grocery/reorder-sections", map[string]any{"section_ids": []string{}})

	var feedB activityResponse
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieB).Body, &feedB)
	for _, e := range feedB.Entries {
		if e.Detail == "" {
			t.Fatalf("entry with empty detail: %+v", e)
		}
	}
	if len(feedB.Entries) != 1 {
		t.Fatalf("reorder must not create an entry, got %+v", feedB.Entries)
	}
}

func TestActivityFeedTrackerVisibilityAndDeletionSurvival(t *testing.T) {
	ta := newTestApp(t)
	cookieMember := ta.LoginAs("member-sub", "member@example.com", "Member")
	enableAllPrefsApp(t, ta, "member-sub")
	cookieOutsider := ta.LoginAs("outsider-sub", "outsider@example.com", "Outsider")
	enableAllPrefsApp(t, ta, "outsider-sub")

	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Home"})
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)
	listID, _ := uuid.Parse(lst.ID)
	ta.App.DB.Create(&models.TrackerShare{ListID: listID, Sub: "member-sub"})

	res = ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Water plants"})
	var task struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &task)
	if res := ta.POST("/api/tracker/tasks/"+task.ID+"/logs", map[string]any{}); res.Status != 201 {
		t.Fatalf("log status %d", res.Status)
	}

	var feedMember, feedOutsider activityResponse
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieMember).Body, &feedMember)
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieOutsider).Body, &feedOutsider)

	// Member sees the task-add and completion (list creation predates their
	// share, and its audience snapshot was owner-only).
	if len(feedMember.Entries) != 2 {
		t.Fatalf("member should see 2 entries, got %+v", feedMember.Entries)
	}
	if feedMember.Entries[0].Detail != "completed “Water plants”" || feedMember.Entries[0].ListName != "Home" {
		t.Fatalf("unexpected entry %+v", feedMember.Entries[0])
	}
	if len(feedOutsider.Entries) != 0 {
		t.Fatalf("outsider must see nothing, got %+v", feedOutsider.Entries)
	}

	// Deleting the list keeps existing entries visible to the old audience.
	if res := ta.DELETE("/api/tracker/lists/" + lst.ID); res.Status != 204 {
		t.Fatalf("delete list status %d", res.Status)
	}
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieMember).Body, &feedMember)
	if len(feedMember.Entries) != 3 { // + the deletion entry
		t.Fatalf("member should still see entries after deletion, got %+v", feedMember.Entries)
	}
	if feedMember.Entries[0].Detail != "deleted “Home”" {
		t.Fatalf("unexpected newest entry %+v", feedMember.Entries[0])
	}
}

func TestActivitySeenMarker(t *testing.T) {
	ta := newTestApp(t)

	var feed activityResponse
	_ = json.Unmarshal(ta.GET("/api/activity").Body, &feed)
	if feed.LastSeen != nil {
		t.Fatalf("expected null last_seen initially, got %v", *feed.LastSeen)
	}

	res := ta.POST("/api/activity/seen", nil)
	if res.Status != 200 {
		t.Fatalf("mark seen status %d", res.Status)
	}
	var marked struct {
		SeenAt string `json:"seen_at"`
	}
	_ = json.Unmarshal(res.Body, &marked)
	if marked.SeenAt == "" {
		t.Fatal("seen_at missing")
	}

	_ = json.Unmarshal(ta.GET("/api/activity").Body, &feed)
	if feed.LastSeen == nil || *feed.LastSeen != marked.SeenAt {
		t.Fatalf("last_seen %v, want %q", feed.LastSeen, marked.SeenAt)
	}

	// Marking again moves the marker forward (upsert path).
	if res := ta.POST("/api/activity/seen", nil); res.Status != 200 {
		t.Fatalf("second mark seen status %d", res.Status)
	}
}

// The feed mirrors notification preferences: entries a user's settings would
// never alert them about don't appear (and so don't count toward the badge).
func TestActivityFeedRespectsNotificationPrefs(t *testing.T) {
	ta := newTestApp(t)
	cookieB := ta.LoginAs("wife-sub", "wife@example.com", "Wife")

	// B has meal notifications off, grocery on.
	ta.App.DB.Create(&models.UserSettings{
		Sub:       "wife-sub",
		Settings:  `{"notifyMealEdits": false, "notifyGroceryEdits": true}`,
		UpdatedAt: models.NowUTC(),
	})

	// A edits meals and grocery.
	if res := ta.PUT("/api/days/2026-07-20/notes", map[string]any{"notes": "<p>Tacos</p>"}); res.Status >= 400 {
		t.Fatalf("notes status %d: %s", res.Status, res.Body)
	}
	ta.POST("/api/grocery/sections", map[string]any{"name": "Produce"})

	var feedB activityResponse
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieB).Body, &feedB)
	if len(feedB.Entries) != 1 || feedB.Entries[0].Category != "grocery" {
		t.Fatalf("meal entry must be filtered out, got %+v", feedB.Entries)
	}

	// Toggling the pref back on re-includes history (read-time evaluation).
	ta.App.DB.Model(&models.UserSettings{}).Where("sub = ?", "wife-sub").
		Update("settings", `{"notifyMealEdits": true, "notifyGroceryEdits": true}`)
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieB).Body, &feedB)
	if len(feedB.Entries) != 2 {
		t.Fatalf("meal entry should reappear after re-enabling, got %+v", feedB.Entries)
	}
}

func TestActivityFeedRespectsPerListOverride(t *testing.T) {
	ta := newTestApp(t)
	cookieB := ta.LoginAs("member-sub", "member@example.com", "Member")

	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Home"})
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)
	listID, _ := uuid.Parse(lst.ID)
	ta.App.DB.Create(&models.TrackerShare{ListID: listID, Sub: "member-sub"})

	// Member muted edits for this specific list.
	ta.App.DB.Create(&models.UserSettings{
		Sub:       "member-sub",
		Settings:  `{"notifyListEdits": true, "listNotifyOverrides": {"` + lst.ID + `": {"edits": false}}}`,
		UpdatedAt: models.NowUTC(),
	})

	if res := ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Water"}); res.Status != 201 {
		t.Fatalf("task status %d", res.Status)
	}

	var feed activityResponse
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieB).Body, &feed)
	if len(feed.Entries) != 0 {
		t.Fatalf("muted list's entries must be hidden, got %+v", feed.Entries)
	}
}

// A brand-new user (no settings row) sees an empty feed — the bell only
// surfaces what their explicit notification choices would alert them to.
func TestActivityFeedEmptyByDefault(t *testing.T) {
	ta := newTestApp(t)
	cookieFresh := ta.LoginAs("fresh-sub", "fresh@example.com", "Fresh")

	ta.POST("/api/grocery/sections", map[string]any{"name": "Produce"})

	var feed activityResponse
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieFresh).Body, &feed)
	if len(feed.Entries) != 0 {
		t.Fatalf("fresh user's feed must be empty by default, got %+v", feed.Entries)
	}
}

// Due reminders land in the feed: one actor-less entry per newly-due task,
// audience-scoped, honoring the cascade including per-task mutes, and never
// duplicated by repeat checks.
func TestActivityFeedDueEntries(t *testing.T) {
	ta := newTestApp(t)
	cookieMember := ta.LoginAs("member-sub", "member@example.com", "Member")

	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Plants"})
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)
	listID, _ := uuid.Parse(lst.ID)
	ta.App.DB.Create(&models.TrackerShare{ListID: listID, Sub: "member-sub"})

	res = ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Water plants", "target_interval_days": 7})
	var task struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &task)

	// Member has list reminders on; also mute a second task to prove filtering.
	res = ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Muted task", "target_interval_days": 7})
	var muted struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &muted)
	ta.App.DB.Create(&models.UserSettings{
		Sub:       "member-sub",
		Settings:  `{"notifyListEdits":false,"notifyListsDue":true,"taskNotifyOverrides":{"` + muted.ID + `":{"due":false}}}`,
		UpdatedAt: models.NowUTC(),
	})

	// Both tasks are never-done-with-target → due on the first check.
	ta.App.Push.CheckDueTasks(models.NowUTC())
	// Repeat check must not duplicate entries.
	ta.App.Push.CheckDueTasks(models.NowUTC().Add(48 * time.Hour))

	var feed activityResponse
	_ = json.Unmarshal(ta.do("GET", "/api/activity", nil, cookieMember).Body, &feed)
	if len(feed.Entries) != 1 {
		t.Fatalf("member should see exactly the unmuted due entry, got %+v", feed.Entries)
	}
	e := feed.Entries[0]
	if e.Category != "list-due" || e.Detail != "“Water plants” is due" || e.ListName != "Plants" || e.ActorName != "" {
		t.Fatalf("unexpected due entry %+v", e)
	}

	// The owner sees nothing: their default prefs have list reminders off.
	_ = json.Unmarshal(ta.GET("/api/activity").Body, &feed)
	if len(feed.Entries) != 0 {
		t.Fatalf("owner with reminders off must not see due entries, got %+v", feed.Entries)
	}
}

// Live feed events: every logged entry is announced over SSE with the full
// rendered entry, scoped like the feed itself.
func TestActivityAddedSSE(t *testing.T) {
	ta := newTestApp(t)

	// Global category: broadcast to all sessions, actor_sub lets clients
	// self-exclude.
	collector := ta.Collect("wife-sub")
	ta.POST("/api/grocery/sections", map[string]any{"name": "Produce"})
	payload := collector.LastPayload("activity.added")
	if payload == nil {
		t.Fatal("expected activity.added event")
	}
	if payload["actor_sub"] != TestSub {
		t.Fatalf("actor_sub = %v", payload["actor_sub"])
	}
	entry, _ := payload["entry"].(map[string]any)
	if entry == nil || entry["detail"] != "added a “Produce” section" || entry["category"] != "grocery" {
		t.Fatalf("unexpected entry %v", entry)
	}
	if entry["id"] == "" || entry["at"] == "" {
		t.Fatalf("entry missing id/at: %v", entry)
	}

	// Tracker category: audience-only, actor excluded server-side.
	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Home"})
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)
	listID, _ := uuid.Parse(lst.ID)
	ta.App.DB.Create(&models.TrackerShare{ListID: listID, Sub: "member-sub"})

	memberCollector := ta.Collect("member-sub")
	outsiderCollector := ta.Collect("outsider-sub")
	actorCollector := ta.Collect(TestSub)
	ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Water"})

	memberPayload := memberCollector.LastPayload("activity.added")
	if memberPayload == nil {
		t.Fatal("member should receive the tracker activity event")
	}
	memberEntry, _ := memberPayload["entry"].(map[string]any)
	if memberEntry["detail"] != "added “Water”" || memberEntry["list_id"] != lst.ID {
		t.Fatalf("unexpected tracker entry %v", memberEntry)
	}
	if outsiderCollector.LastPayload("activity.added") != nil {
		t.Fatal("outsider must not receive tracker activity events")
	}
	if actorCollector.LastPayload("activity.added") != nil {
		t.Fatal("the actor must not receive their own tracker activity event")
	}
}

// Due entries are announced live to the audience with no actor.
func TestActivityAddedSSEForDue(t *testing.T) {
	ta := newTestApp(t)
	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Plants"})
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)
	listID, _ := uuid.Parse(lst.ID)
	ta.App.DB.Create(&models.TrackerShare{ListID: listID, Sub: "member-sub"})
	ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Water plants", "target_interval_days": 7})

	collector := ta.Collect("member-sub")
	ta.App.Push.CheckDueTasks(models.NowUTC())

	payload := collector.LastPayload("activity.added")
	if payload == nil {
		t.Fatal("expected live due activity event")
	}
	if payload["actor_sub"] != "" {
		t.Fatalf("due events have no actor, got %v", payload["actor_sub"])
	}
	entry, _ := payload["entry"].(map[string]any)
	if entry["detail"] != "“Water plants” is due" || entry["category"] != "list-due" || entry["task_id"] == "" {
		t.Fatalf("unexpected due entry %v", entry)
	}
}

// Deleting a task/list prunes its notification overrides from EVERY user's
// settings (bumping updated_at + broadcasting settings.updated so clients
// adopt the pruned blob); unrelated settings and rows stay untouched.
// Restores reissue ids, so nothing an undo could reclaim is lost.
func TestDeletePrunesNotifyOverrides(t *testing.T) {
	ta := newTestApp(t)

	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Home"})
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)
	res = ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Water"})
	var task struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &task)

	oldTime := models.NowUTC().Add(-time.Hour)
	mine := `{"notifyListsDue":true,"listNotifyOverrides":{"` + lst.ID + `":{"due":false},"other-list":{"edits":false}},` +
		`"taskNotifyOverrides":{"` + task.ID + `":{"due":false},"other-task":{"due":false}},"textScaleStandard":1.05}`
	ta.App.DB.Create(&models.UserSettings{Sub: TestSub, Settings: mine, UpdatedAt: oldTime})
	ta.App.DB.Create(&models.UserSettings{Sub: "untouched-sub", Settings: `{"notifyListsDue":true}`, UpdatedAt: oldTime})

	collector := ta.Collect(TestSub)

	// Task delete → only that task's override goes.
	if res := ta.DELETE("/api/tracker/tasks/" + task.ID); res.Status != 204 {
		t.Fatalf("delete task status %d", res.Status)
	}
	var row models.UserSettings
	ta.App.DB.Where("sub = ?", TestSub).First(&row)
	if strings.Contains(row.Settings, task.ID) {
		t.Fatalf("task override should be pruned: %s", row.Settings)
	}
	for _, keep := range []string{"other-task", "other-list", lst.ID, "1.05"} {
		if !strings.Contains(row.Settings, keep) {
			t.Fatalf("unrelated key %q lost: %s", keep, row.Settings)
		}
	}
	if !row.UpdatedAt.After(oldTime) {
		t.Fatal("updated_at must bump so clients adopt the pruned blob")
	}
	if collector.LastPayload("settings.updated") == nil {
		t.Fatal("settings.updated must broadcast after a prune")
	}

	// List delete → list override goes too.
	if res := ta.DELETE("/api/tracker/lists/" + lst.ID); res.Status != 204 {
		t.Fatalf("delete list status %d", res.Status)
	}
	ta.App.DB.Where("sub = ?", TestSub).First(&row)
	if strings.Contains(row.Settings, lst.ID) {
		t.Fatalf("list override should be pruned: %s", row.Settings)
	}
	if !strings.Contains(row.Settings, "other-list") || !strings.Contains(row.Settings, "other-task") {
		t.Fatalf("unrelated overrides lost: %s", row.Settings)
	}

	// A user whose settings never referenced the entities is left alone.
	var other models.UserSettings
	ta.App.DB.Where("sub = ?", "untouched-sub").First(&other)
	if !other.UpdatedAt.Equal(oldTime) {
		t.Fatal("settings without matching overrides must not be rewritten")
	}
}

// A user who LEFT a list keeps their overrides (rejoin preserves intent) —
// but when the list is DELETED, their orphans are pruned too, because the
// prune scans every settings row, not just the current audience.
func TestDeletePrunesOverridesOfDepartedMembers(t *testing.T) {
	ta := newTestApp(t)
	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Home"})
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)
	listID, _ := uuid.Parse(lst.ID)
	ta.App.DB.Create(&models.TrackerShare{ListID: listID, Sub: "departed-sub"})
	ta.App.DB.Create(&models.UserSettings{
		Sub:       "departed-sub",
		Settings:  `{"notifyListEdits":true,"listNotifyOverrides":{"` + lst.ID + `":{"edits":false}}}`,
		UpdatedAt: models.NowUTC(),
	})

	// Member leaves — overrides intentionally survive (same id on rejoin).
	departedCookie := ta.LoginAs("departed-sub", "d@example.com", "Departed")
	if res := ta.do("POST", "/api/tracker/lists/"+lst.ID+"/leave", nil, departedCookie); res.Status >= 400 {
		t.Fatalf("leave status %d", res.Status)
	}
	var row models.UserSettings
	ta.App.DB.Where("sub = ?", "departed-sub").First(&row)
	if !strings.Contains(row.Settings, lst.ID) {
		t.Fatal("leaving must keep overrides")
	}

	// Owner deletes the list — now the departed member's orphans go too.
	if res := ta.DELETE("/api/tracker/lists/" + lst.ID); res.Status != 204 {
		t.Fatalf("delete status %d", res.Status)
	}
	ta.App.DB.Where("sub = ?", "departed-sub").First(&row)
	if strings.Contains(row.Settings, lst.ID) {
		t.Fatalf("departed member's overrides must be pruned on delete: %s", row.Settings)
	}
}

// Deleting a store prunes its id from users' grocery chip-filter arrays.
func TestDeleteStorePrunesFilterSettings(t *testing.T) {
	ta := newTestApp(t)
	res := ta.POST("/api/stores", map[string]any{"name": "Costco"})
	var store struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &store)

	ta.App.DB.Create(&models.UserSettings{
		Sub: "wife-sub",
		Settings: `{"grocerySelectedStoreIds":["` + store.ID + `","other-store"],` +
			`"groceryExcludedStoreIds":["` + store.ID + `"]}`,
		UpdatedAt: models.NowUTC(),
	})

	if res := ta.DELETE("/api/stores/" + store.ID); res.Status != 200 {
		t.Fatalf("delete store status %d", res.Status)
	}
	var row models.UserSettings
	ta.App.DB.Where("sub = ?", "wife-sub").First(&row)
	if strings.Contains(row.Settings, store.ID) {
		t.Fatalf("store id must be pruned from filters: %s", row.Settings)
	}
	if !strings.Contains(row.Settings, "other-store") {
		t.Fatalf("unrelated filter entries must survive: %s", row.Settings)
	}
}
