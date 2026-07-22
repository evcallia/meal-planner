package app

// Tests for the /api/push endpoints and the push-notification hooks on the
// broadcast paths (shared-data edits + tracker edits).

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/google/uuid"

	"mealplanner/internal/models"
	"mealplanner/internal/push"
)

// capturePush replaces the App's push sender and records deliveries.
type capturePush struct {
	mu    sync.Mutex
	sends []struct {
		Sub     string
		Payload push.Notification
	}
}

func (c *capturePush) install(ta *testApp) {
	ta.App.Push.Send = func(sub *models.PushSubscription, payload []byte) (int, error) {
		c.mu.Lock()
		defer c.mu.Unlock()
		var n push.Notification
		_ = json.Unmarshal(payload, &n)
		c.sends = append(c.sends, struct {
			Sub     string
			Payload push.Notification
		}{sub.Sub, n})
		return 201, nil
	}
}

func (c *capturePush) all() []struct {
	Sub     string
	Payload push.Notification
} {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]struct {
		Sub     string
		Payload push.Notification
	}, len(c.sends))
	copy(out, c.sends)
	return out
}

func subscribePayload(endpoint string) map[string]any {
	return map[string]any{
		"endpoint": endpoint,
		"keys":     map[string]any{"p256dh": "key-p256dh", "auth": "key-auth"},
	}
}

func TestPushPublicKey(t *testing.T) {
	ta := newTestApp(t)
	res := ta.GET("/api/push/public-key")
	if res.Status != 200 {
		t.Fatalf("status %d", res.Status)
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(res.Body, &body); err != nil || body.Key == "" {
		t.Fatalf("bad body %s err=%v", res.Body, err)
	}
	// Stable across calls, persisted in the DB.
	res2 := ta.GET("/api/push/public-key")
	var body2 struct {
		Key string `json:"key"`
	}
	_ = json.Unmarshal(res2.Body, &body2)
	if body2.Key != body.Key {
		t.Fatalf("key changed between calls")
	}
	var row models.VapidKeyPair
	if err := ta.App.DB.First(&row, "id = ?", 1).Error; err != nil || row.PublicKey != body.Key {
		t.Fatalf("key not persisted: %v", err)
	}
}

func TestPushPublicKeyRequiresAuth(t *testing.T) {
	ta := newTestApp(t)
	if res := ta.Anon("GET", "/api/push/public-key", nil); res.Status != 401 {
		t.Fatalf("expected 401, got %d", res.Status)
	}
}

func TestPushSubscribeUpsertAndDelete(t *testing.T) {
	ta := newTestApp(t)

	if res := ta.POST("/api/push/subscriptions", subscribePayload("https://push.example.com/ep1")); res.Status != 201 {
		t.Fatalf("subscribe status %d: %s", res.Status, res.Body)
	}
	var row models.PushSubscription
	if err := ta.App.DB.First(&row).Error; err != nil {
		t.Fatalf("row: %v", err)
	}
	if row.Sub != TestSub || row.P256dh != "key-p256dh" || row.Auth != "key-auth" {
		t.Fatalf("unexpected row %+v", row)
	}

	// Re-subscribing the same endpoint updates in place.
	updated := subscribePayload("https://push.example.com/ep1")
	updated["keys"] = map[string]any{"p256dh": "new-p", "auth": "new-a"}
	if res := ta.POST("/api/push/subscriptions", updated); res.Status != 201 {
		t.Fatalf("upsert status %d", res.Status)
	}
	var count int64
	ta.App.DB.Model(&models.PushSubscription{}).Count(&count)
	if count != 1 {
		t.Fatalf("expected 1 row after upsert, got %d", count)
	}

	// Delete is idempotent and scoped to the caller's own subscriptions.
	del := map[string]any{"endpoint": "https://push.example.com/ep1"}
	if res := ta.do("DELETE", "/api/push/subscriptions", del, ta.Cookie); res.Status != 204 {
		t.Fatalf("delete status %d", res.Status)
	}
	if res := ta.do("DELETE", "/api/push/subscriptions", del, ta.Cookie); res.Status != 204 {
		t.Fatalf("repeat delete status %d", res.Status)
	}
	ta.App.DB.Model(&models.PushSubscription{}).Count(&count)
	if count != 0 {
		t.Fatalf("expected 0 rows, got %d", count)
	}
}

func TestPushDeleteOnlyOwnSubscription(t *testing.T) {
	ta := newTestApp(t)
	ta.App.DB.Create(&models.PushSubscription{Sub: "someone-else", Endpoint: "https://push.example.com/other", P256dh: "p", Auth: "a"})
	res := ta.do("DELETE", "/api/push/subscriptions", map[string]any{"endpoint": "https://push.example.com/other"}, ta.Cookie)
	if res.Status != 204 {
		t.Fatalf("status %d", res.Status)
	}
	var count int64
	ta.App.DB.Model(&models.PushSubscription{}).Count(&count)
	if count != 1 {
		t.Fatalf("someone else's subscription was deleted")
	}
}

// TestGroceryEditNotifiesOtherUsers covers the full path: an authenticated
// mutation → broadcast hook → push to the other subscribed user, excluding
// the editor's own device, with follow-up edits suppressed.
func TestGroceryEditNotifiesOtherUsers(t *testing.T) {
	ta := newTestApp(t)
	c := &capturePush{}
	c.install(ta)
	ta.App.DB.Create(&models.PushSubscription{Sub: TestSub, Endpoint: "https://push.example.com/mine", P256dh: "p", Auth: "a"})
	ta.App.DB.Create(&models.PushSubscription{Sub: "other-user", Endpoint: "https://push.example.com/other", P256dh: "p", Auth: "a"})
	enableAllPrefsApp(t, ta, "other-user")

	if res := ta.POST("/api/grocery/sections", map[string]any{"name": "Produce"}); res.Status != 201 {
		t.Fatalf("create section status %d", res.Status)
	}
	ta.App.Push.Flush()

	sends := c.all()
	if len(sends) != 1 {
		t.Fatalf("expected 1 send, got %d: %+v", len(sends), sends)
	}
	if sends[0].Sub != "other-user" {
		t.Fatalf("editor must not be notified, got send to %q", sends[0].Sub)
	}
	if sends[0].Payload.Body != TestName+" added a “Produce” section" {
		t.Fatalf("unexpected body %q", sends[0].Payload.Body)
	}

	// Immediate second edit — suppressed.
	if res := ta.POST("/api/grocery/sections", map[string]any{"name": "Dairy"}); res.Status != 201 {
		t.Fatalf("second create status %d", res.Status)
	}
	ta.App.Push.Flush()
	if len(c.all()) != 1 {
		t.Fatalf("second edit within the window must be suppressed")
	}
}

// TestTrackerEditNotifiesListAudience: a task mutation notifies the list's
// shared members but not outsiders, and reorders never notify.
func TestTrackerEditNotifiesListAudience(t *testing.T) {
	ta := newTestApp(t)
	c := &capturePush{}
	c.install(ta)
	ta.App.DB.Create(&models.PushSubscription{Sub: "member-sub", Endpoint: "https://push.example.com/member", P256dh: "p", Auth: "a"})
	enableAllPrefsApp(t, ta, "member-sub")
	ta.App.DB.Create(&models.PushSubscription{Sub: "outsider-sub", Endpoint: "https://push.example.com/outsider", P256dh: "p", Auth: "a"})
	enableAllPrefsApp(t, ta, "outsider-sub")

	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Plants"})
	if res.Status != 201 {
		t.Fatalf("create list status %d", res.Status)
	}
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)
	listID, err := uuid.Parse(lst.ID)
	if err != nil {
		t.Fatalf("list id %q: %v", lst.ID, err)
	}
	ta.App.DB.Create(&models.TrackerShare{ListID: listID, Sub: "member-sub"})

	// Fresh push service: clears suppression state from the list creation.
	ta.App.Push = push.New(ta.App.DB, "", 0)
	ta.App.Push.BatchQuiet, ta.App.Push.BatchMax = 0, 0
	c.install(ta)

	if res := ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Water"}); res.Status != 201 {
		t.Fatalf("create task status %d: %s", res.Status, res.Body)
	}
	ta.App.Push.Flush()

	sends := c.all()
	if len(sends) != 1 {
		t.Fatalf("expected 1 send, got %d: %+v", len(sends), sends)
	}
	if sends[0].Sub != "member-sub" {
		t.Fatalf("expected send to member, got %q", sends[0].Sub)
	}
	if sends[0].Payload.Title != "Plants" {
		t.Fatalf("unexpected title %q", sends[0].Payload.Title)
	}
	if sends[0].Payload.Body != TestName+" added “Water”" {
		t.Fatalf("body should name the task, got %q", sends[0].Payload.Body)
	}

	// Reorders are cosmetic — never notify, even with a fresh window.
	ta.App.Push = push.New(ta.App.DB, "", 0)
	ta.App.Push.BatchQuiet, ta.App.Push.BatchMax = 0, 0
	c2 := &capturePush{}
	c2.install(ta)
	res = ta.PATCH("/api/tracker/lists/"+lst.ID+"/reorder-tasks", map[string]any{"task_ids": []string{}})
	if res.Status >= 400 {
		t.Fatalf("reorder status %d: %s", res.Status, res.Body)
	}
	ta.App.Push.Flush()
	if len(c2.all()) != 0 {
		t.Fatalf("reorder must not notify, got %+v", c2.all())
	}
}

// TestPushTestEndpoint: sends only to the caller's own devices, bypassing
// preference gating, and reports per-device delivery results.
func TestPushTestEndpoint(t *testing.T) {
	ta := newTestApp(t)
	c := &capturePush{}
	c.install(ta)
	ta.App.DB.Create(&models.PushSubscription{Sub: TestSub, Endpoint: "https://push.example.com/mine", P256dh: "p", Auth: "a"})
	ta.App.DB.Create(&models.PushSubscription{Sub: "other-user", Endpoint: "https://push.example.com/other", P256dh: "p", Auth: "a"})
	// Even with every category disabled, the test notification must deliver.
	ta.App.DB.Create(&models.UserSettings{
		Sub:      TestSub,
		Settings: `{"notifyGroceryEdits":false,"notifyMealEdits":false,"notifyPantryEdits":false,"notifyListEdits":false,"notifyListsDue":false}`,
	})

	res := ta.POST("/api/push/test", nil)
	if res.Status != 200 {
		t.Fatalf("status %d: %s", res.Status, res.Body)
	}
	var body struct {
		Sent    int `json:"sent"`
		Results []struct {
			Endpoint string `json:"endpoint"`
			Status   int    `json:"status"`
		} `json:"results"`
	}
	if err := json.Unmarshal(res.Body, &body); err != nil {
		t.Fatalf("parse body: %v (%s)", err, res.Body)
	}
	if body.Sent != 1 || len(body.Results) != 1 {
		t.Fatalf("expected exactly the caller's device, got %s", res.Body)
	}
	if body.Results[0].Status != 201 {
		t.Fatalf("expected delivery status in results, got %+v", body.Results[0])
	}
	sends := c.all()
	if len(sends) != 1 || sends[0].Sub != TestSub {
		t.Fatalf("test push must go only to the caller, got %+v", sends)
	}
	if sends[0].Payload.Title != "Test notification" {
		t.Fatalf("unexpected payload %+v", sends[0].Payload)
	}
}

// TestPushTestEndpointNoDevices: zero subscriptions is reported, not an error
// — it's the "this device never registered" diagnostic.
func TestPushTestEndpointNoDevices(t *testing.T) {
	ta := newTestApp(t)
	res := ta.POST("/api/push/test", nil)
	if res.Status != 200 {
		t.Fatalf("status %d", res.Status)
	}
	var body struct {
		Sent int `json:"sent"`
	}
	_ = json.Unmarshal(res.Body, &body)
	if body.Sent != 0 {
		t.Fatalf("expected sent=0, got %s", res.Body)
	}
}

// editPushDetail turns SSE payloads into specific notification phrasing, and
// filters cosmetic reorders out entirely.
func TestEditPushDetail(t *testing.T) {
	cases := []struct {
		event   string
		payload J
		detail  string
		notify  bool
	}{
		{"grocery.updated", J{"action": "item-added", "item": J{"name": "Milk"}}, "added “Milk”", true},
		{"grocery.updated", J{"action": "item-updated", "item": J{"name": "Milk"}}, "updated “Milk”", true},
		{"grocery.updated", J{"action": "cleared-checked"}, "cleared the checked items", true},
		{"grocery.updated", J{"action": "section-reordered"}, "", false},
		{"grocery.updated", J{"action": "items-reordered"}, "", false},
		{"grocery.updated", J{"action": "replaced"}, "", true}, // generic fallback
		{"pantry.updated", J{"action": "item-added", "item": J{"name": "Flour"}}, "added “Flour”", true},
		{"pantry.updated", J{"action": "cleared-all"}, "cleared the pantry", true},
		{"notes.updated", J{"date": "2026-07-16"}, "updated meals for Thu, Jul 16", true},
	}
	for _, tc := range cases {
		detail, notify := editPushDetail(tc.event, tc.payload)
		if detail != tc.detail || notify != tc.notify {
			t.Errorf("editPushDetail(%s, %v) = (%q, %v), want (%q, %v)",
				tc.event, tc.payload, detail, notify, tc.detail, tc.notify)
		}
	}
}

// TestTrackerCompletionNotificationBody: marking a task done produces
// "completed “X”" for the other members.
func TestTrackerCompletionNotificationBody(t *testing.T) {
	ta := newTestApp(t)
	ta.App.DB.Create(&models.PushSubscription{Sub: "member-sub", Endpoint: "https://push.example.com/member", P256dh: "p", Auth: "a"})
	enableAllPrefsApp(t, ta, "member-sub")

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

	// Fresh service so the task-add didn't arm the suppression window.
	ta.App.Push = push.New(ta.App.DB, "", 0)
	ta.App.Push.BatchQuiet, ta.App.Push.BatchMax = 0, 0
	c := &capturePush{}
	c.install(ta)

	if res := ta.POST("/api/tracker/tasks/"+task.ID+"/logs", map[string]any{}); res.Status != 201 {
		t.Fatalf("add log status %d: %s", res.Status, res.Body)
	}
	ta.App.Push.Flush()

	sends := c.all()
	if len(sends) != 1 {
		t.Fatalf("expected 1 send, got %+v", sends)
	}
	if sends[0].Payload.Title != "Home" || sends[0].Payload.Body != TestName+" completed “Water plants”" {
		t.Fatalf("unexpected notification %q / %q", sends[0].Payload.Title, sends[0].Payload.Body)
	}
}

// Deleting an item names it in the notification (the SSE payload only
// carries the id, so the handler passes the name via pushDetail).
func TestDeleteNotificationsNameTheItem(t *testing.T) {
	ta := newTestApp(t)
	c := &capturePush{}
	c.install(ta)
	ta.App.DB.Create(&models.PushSubscription{Sub: "other-user", Endpoint: "https://push.example.com/other", P256dh: "p", Auth: "a"})
	enableAllPrefsApp(t, ta, "other-user")

	section := models.PantrySection{Name: "Fridge"}
	ta.App.DB.Create(&section)
	item := models.PantryItem{SectionID: section.ID, Name: "Chicken", Quantity: 1}
	ta.App.DB.Create(&item)

	if res := ta.DELETE("/api/pantry/items/" + item.ID.String()); res.Status != 200 {
		t.Fatalf("delete status %d", res.Status)
	}
	ta.App.Push.Flush()

	sends := c.all()
	if len(sends) != 1 {
		t.Fatalf("expected 1 send, got %+v", sends)
	}
	if sends[0].Payload.Body != TestName+" removed “Chicken”" {
		t.Fatalf("body should name the item, got %q", sends[0].Payload.Body)
	}

	// Section delete names the section too (fresh window).
	ta.App.Push = push.New(ta.App.DB, "", 0)
	ta.App.Push.BatchQuiet, ta.App.Push.BatchMax = 0, 0
	c2 := &capturePush{}
	c2.install(ta)
	if res := ta.DELETE("/api/pantry/sections/" + section.ID.String()); res.Status >= 400 {
		t.Fatalf("delete section status %d", res.Status)
	}
	ta.App.Push.Flush()
	sends = c2.all()
	if len(sends) != 1 || sends[0].Payload.Body != TestName+" removed the “Fridge” section" {
		t.Fatalf("unexpected section-delete sends %+v", sends)
	}
}

// freshCapture resets the push service (clearing suppression) and installs a
// new capture, so consecutive assertions in one test see distinct sends.
func freshCapture(ta *testApp) *capturePush {
	ta.App.Push = push.New(ta.App.DB, "", 0)
	ta.App.Push.BatchQuiet, ta.App.Push.BatchMax = 0, 0
	c := &capturePush{}
	c.install(ta)
	return c
}

func lastBody(t *testing.T, c *capturePush) string {
	t.Helper()
	sends := c.all()
	if len(sends) == 0 {
		t.Fatal("expected a send")
	}
	return sends[len(sends)-1].Payload.Body
}

// The six specific phrasings: check-off, rename, pantry quantity, replace
// counts, tracker membership, task archive.
func TestSpecificEditPhrasings(t *testing.T) {
	ta := newTestApp(t)
	ta.App.DB.Create(&models.PushSubscription{Sub: "other-user", Endpoint: "https://push.example.com/other", P256dh: "p", Auth: "a"})
	enableAllPrefsApp(t, ta, "other-user")

	// Grocery item to work with
	section := models.GrocerySection{Name: "Produce"}
	ta.App.DB.Create(&section)
	item := models.GroceryItem{SectionID: section.ID, Name: "Milk"}
	ta.App.DB.Create(&item)

	// 1. Check off / uncheck
	c := freshCapture(ta)
	ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"checked": true})
	ta.App.Push.Flush()
	if b := lastBody(t, c); b != TestName+" checked off “Milk”" {
		t.Fatalf("check body %q", b)
	}
	c = freshCapture(ta)
	ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"checked": false})
	ta.App.Push.Flush()
	if b := lastBody(t, c); b != TestName+" unchecked “Milk”" {
		t.Fatalf("uncheck body %q", b)
	}

	// 2. Rename shows old and new
	c = freshCapture(ta)
	ta.PATCH("/api/grocery/items/"+item.ID.String(), map[string]any{"name": "Oat Milk"})
	ta.App.Push.Flush()
	if b := lastBody(t, c); b != TestName+" renamed “Milk” to “Oat Milk”" {
		t.Fatalf("rename body %q", b)
	}

	// 3. Pantry quantity
	pSection := models.PantrySection{Name: "Dry Goods"}
	ta.App.DB.Create(&pSection)
	pItem := models.PantryItem{SectionID: pSection.ID, Name: "Flour", Quantity: 1}
	ta.App.DB.Create(&pItem)
	c = freshCapture(ta)
	ta.PUT("/api/pantry/items/"+pItem.ID.String(), map[string]any{"quantity": 3})
	ta.App.Push.Flush()
	if b := lastBody(t, c); b != TestName+" set “Flour” to 3" {
		t.Fatalf("quantity body %q", b)
	}

	// 4. Replace includes counts
	c = freshCapture(ta)
	ta.PUT("/api/grocery", map[string]any{"sections": []map[string]any{
		{"name": "A", "items": []map[string]any{{"name": "One"}, {"name": "Two"}}},
	}})
	ta.App.Push.Flush()
	if b := lastBody(t, c); b != TestName+" replaced the grocery list (1 section, 2 items)" {
		t.Fatalf("replace body %q", b)
	}
}

func TestTrackerMembershipPhrasings(t *testing.T) {
	ta := newTestApp(t)
	ta.App.DB.Create(&models.PushSubscription{Sub: "member-sub", Endpoint: "https://push.example.com/member", P256dh: "p", Auth: "a"})
	enableAllPrefsApp(t, ta, "member-sub")
	memberName := "Sarah"
	ta.App.DB.Create(&models.User{Sub: "member-sub", Name: &memberName})

	res := ta.POST("/api/tracker/lists", map[string]any{"name": "Home"})
	var lst struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &lst)

	// Share by sub — the new member is notified with specific phrasing
	c := freshCapture(ta)
	if res := ta.POST("/api/tracker/lists/"+lst.ID+"/shares", map[string]any{"sub": "member-sub"}); res.Status >= 400 {
		t.Fatalf("share status %d: %s", res.Status, res.Body)
	}
	ta.App.Push.Flush()
	if b := lastBody(t, c); b != TestName+" shared the list with Sarah" {
		t.Fatalf("share body %q", b)
	}

	// Rename the list
	c = freshCapture(ta)
	ta.PATCH("/api/tracker/lists/"+lst.ID, map[string]any{"name": "Casa"})
	ta.App.Push.Flush()
	if b := lastBody(t, c); b != TestName+" renamed “Home” to “Casa”" {
		t.Fatalf("rename body %q", b)
	}

	// Archive a task
	res = ta.POST("/api/tracker/tasks", map[string]any{"list_id": lst.ID, "name": "Water"})
	var task struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(res.Body, &task)
	c = freshCapture(ta)
	ta.PATCH("/api/tracker/tasks/"+task.ID, map[string]any{"archived": true})
	ta.App.Push.Flush()
	if b := lastBody(t, c); b != TestName+" archived “Water”" {
		t.Fatalf("archive body %q", b)
	}

	// Member leaves — owner subscribed now, member acts
	ta.App.DB.Create(&models.PushSubscription{Sub: TestSub, Endpoint: "https://push.example.com/owner", P256dh: "p", Auth: "a"})
	enableAllPrefsApp(t, ta, TestSub)
	memberCookie := ta.LoginAs("member-sub", "sarah@example.com", "Sarah Smith")
	c = freshCapture(ta)
	if res := ta.do("POST", "/api/tracker/lists/"+lst.ID+"/leave", nil, memberCookie); res.Status >= 400 {
		t.Fatalf("leave status %d", res.Status)
	}
	ta.App.Push.Flush()
	sends := c.all()
	found := false
	for _, s := range sends {
		if s.Sub == TestSub && s.Payload.Body == "Sarah Smith left the list" {
			found = true
		}
	}
	if !found {
		t.Fatalf("owner should see the leave, got %+v", sends)
	}
}

// enableAllPrefsApp opts a user into every notification category —
// notifications (and the activity feed) are opt-in.
func enableAllPrefsApp(t *testing.T, ta *testApp, sub string) {
	t.Helper()
	settings := `{"notifyMealEdits":true,"notifyPantryEdits":true,"notifyGroceryEdits":true,"notifyListEdits":true,"notifyListsDue":true}`
	if err := ta.App.DB.Create(&models.UserSettings{Sub: sub, Settings: settings, UpdatedAt: models.NowUTC()}).Error; err != nil {
		t.Fatalf("enable prefs: %v", err)
	}
}
