package push

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"

	"mealplanner/internal/db"
	"mealplanner/internal/models"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	gdb, err := db.OpenSQLiteMemory()
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.CreateAll(gdb); err != nil {
		t.Fatalf("create_all: %v", err)
	}
	return gdb
}

// capture replaces Send and records every delivery.
type capture struct {
	mu    sync.Mutex
	sends []struct {
		Sub     string
		Payload Notification
	}
	status int
}

func (c *capture) fn(sub *models.PushSubscription, payload []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var n Notification
	_ = json.Unmarshal(payload, &n)
	c.sends = append(c.sends, struct {
		Sub     string
		Payload Notification
	}{sub.Sub, n})
	if c.status == 0 {
		return 201, nil
	}
	return c.status, nil
}

func (c *capture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.sends)
}

func newTestService(t *testing.T) (*Service, *capture) {
	t.Helper()
	s := New(testDB(t), "mailto:test@example.com", 0)
	// Immediate batch flush — batching timing has its own dedicated tests.
	s.BatchQuiet, s.BatchMax = 0, 0
	c := &capture{}
	s.Send = c.fn
	return s, c
}

func addSubscription(t *testing.T, s *Service, sub, endpoint string) {
	t.Helper()
	if err := s.db.Create(&models.PushSubscription{Sub: sub, Endpoint: endpoint, P256dh: "p", Auth: "a"}).Error; err != nil {
		t.Fatalf("create subscription: %v", err)
	}
}

// TestSuppressionSlidingWindow verifies the requested behavior exactly:
// first edit notifies; an edit 15 min later is suppressed but RESETS the
// window; an edit 29 min after that (44 min after the first) is still
// suppressed; an edit 31 min after the last is notified again.
func TestSuppressionSlidingWindow(t *testing.T) {
	s, c := newTestService(t)
	addSubscription(t, s, "other-user", "https://push.example.com/other")
	enableAllNotifyPrefs(t, s, "other-user")

	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	s.Now = func() time.Time { return now }
	edit := func() {
		s.QueueEdit("grocery.updated", "editor", "Evan", "")
		s.Flush()
	}

	edit()
	if c.count() != 1 {
		t.Fatalf("first edit should notify, got %d sends", c.count())
	}

	now = now.Add(15 * time.Minute)
	edit()
	if c.count() != 1 {
		t.Fatalf("edit inside window should be suppressed, got %d sends", c.count())
	}

	// 29 min after the last edit — the window reset, so still suppressed
	// even though 44 min have passed since the notification.
	now = now.Add(29 * time.Minute)
	edit()
	if c.count() != 1 {
		t.Fatalf("window must reset on every edit, got %d sends", c.count())
	}

	// 31 min of quiet since the last edit — notify again.
	now = now.Add(31 * time.Minute)
	edit()
	if c.count() != 2 {
		t.Fatalf("edit after a quiet window should notify, got %d sends", c.count())
	}
}

func TestSuppressionIsPerCategoryAndActor(t *testing.T) {
	s, c := newTestService(t)
	addSubscription(t, s, "other-user", "https://push.example.com/other")
	enableAllNotifyPrefs(t, s, "other-user")

	s.QueueEdit("grocery.updated", "editor", "Evan", "")
	s.QueueEdit("pantry.updated", "editor", "Evan", "")   // different category
	s.QueueEdit("grocery.updated", "editor2", "Sam", "")  // different actor
	s.QueueEdit("grocery.updated", "editor", "Evan", "")  // suppressed
	s.QueueEdit("meal-ideas.updated", "editor", "Ev", "") // unmapped event type
	s.Flush()

	// Three distinct (category, actor) keys notify other-user (the only
	// subscribed user); the repeat and the unmapped event send nothing.
	if c.count() != 3 {
		t.Fatalf("expected 3 sends, got %d", c.count())
	}
}

func TestEditExcludesActorAndRespectsPref(t *testing.T) {
	s, c := newTestService(t)
	addSubscription(t, s, "editor", "https://push.example.com/editor")
	addSubscription(t, s, "enabled", "https://push.example.com/enabled")
	enableAllNotifyPrefs(t, s, "enabled")
	addSubscription(t, s, "disabled", "https://push.example.com/disabled")
	s.db.Create(&models.UserSettings{Sub: "disabled", Settings: `{"notifyGroceryEdits": false}`, UpdatedAt: models.NowUTC()})

	s.QueueEdit("grocery.updated", "editor", "Evan", "")
	s.Flush()

	if c.count() != 1 {
		t.Fatalf("expected 1 send, got %d", c.count())
	}
	if c.sends[0].Sub != "enabled" {
		t.Fatalf("expected send to 'enabled', got %q", c.sends[0].Sub)
	}
	if c.sends[0].Payload.Body != "Evan updated the grocery list" {
		t.Fatalf("unexpected body %q", c.sends[0].Payload.Body)
	}
	if c.sends[0].Payload.Tag != "edit-grocery" {
		t.Fatalf("unexpected tag %q", c.sends[0].Payload.Tag)
	}
}

func TestTrackerEditNotifiesAudienceOnly(t *testing.T) {
	s, c := newTestService(t)
	addSubscription(t, s, "member", "https://push.example.com/member")
	enableAllNotifyPrefs(t, s, "member")
	addSubscription(t, s, "outsider", "https://push.example.com/outsider")
	enableAllNotifyPrefs(t, s, "outsider")

	audience := map[string]bool{"owner": true, "member": true}
	s.QueueTrackerEdit("list-1", "Plants", audience, "owner", "Evan", "")
	s.Flush()

	if c.count() != 1 {
		t.Fatalf("expected 1 send, got %d", c.count())
	}
	if c.sends[0].Sub != "member" {
		t.Fatalf("expected send to 'member', got %q", c.sends[0].Sub)
	}
	if c.sends[0].Payload.Title != "Plants" {
		t.Fatalf("unexpected title %q", c.sends[0].Payload.Title)
	}
}

func TestGoneSubscriptionIsPruned(t *testing.T) {
	s, c := newTestService(t)
	c.status = 410
	addSubscription(t, s, "user-a", "https://push.example.com/gone")
	enableAllNotifyPrefs(t, s, "user-a")

	s.SendToUsers(map[string]bool{"user-a": true}, "grocery", Notification{Title: "t"}, "", "")

	var count int64
	s.db.Model(&models.PushSubscription{}).Count(&count)
	if count != 0 {
		t.Fatalf("410 subscription should be pruned, %d rows remain", count)
	}
}

func TestTransientErrorKeepsSubscription(t *testing.T) {
	s, c := newTestService(t)
	c.status = 500
	addSubscription(t, s, "user-a", "https://push.example.com/flaky")
	enableAllNotifyPrefs(t, s, "user-a")

	s.SendToUsers(map[string]bool{"user-a": true}, "grocery", Notification{Title: "t"}, "", "")

	var count int64
	s.db.Model(&models.PushSubscription{}).Count(&count)
	if count != 1 {
		t.Fatalf("500 should keep the subscription, %d rows remain", count)
	}
}

// ---- due-task checks ----

func makeList(t *testing.T, s *Service, owner string) *models.TrackerList {
	t.Helper()
	lst := models.TrackerList{OwnerSub: owner, Name: "Plants"}
	if err := s.db.Create(&lst).Error; err != nil {
		t.Fatalf("create list: %v", err)
	}
	return &lst
}

func makeTask(t *testing.T, s *Service, lst *models.TrackerList, name string, target *int, lastDoneDaysAgo *int) *models.TrackerTask {
	t.Helper()
	task := models.TrackerTask{ListID: lst.ID, Name: name, TargetIntervalDays: target}
	if err := s.db.Create(&task).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}
	if lastDoneDaysAgo != nil {
		log := models.TrackerLog{TaskID: task.ID, DoneAt: models.NowUTC().Add(-time.Duration(*lastDoneDaysAgo) * 24 * time.Hour)}
		if err := s.db.Create(&log).Error; err != nil {
			t.Fatalf("create log: %v", err)
		}
	}
	return &task
}

func intPtr(v int) *int { return &v }

func TestDueTaskNotifiesAudienceOnce(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	task := makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	s.db.Create(&models.TrackerShare{ListID: lst.ID, Sub: "member"})
	addSubscription(t, s, "owner", "https://push.example.com/o")
	enableAllNotifyPrefs(t, s, "owner")
	addSubscription(t, s, "member", "https://push.example.com/m")
	enableAllNotifyPrefs(t, s, "member")

	if sent := s.CheckDueTasks(models.NowUTC()); sent != 2 {
		t.Fatalf("expected 2 sends, got %d", sent)
	}
	if c.sends[0].Payload.Title != "Plants" {
		t.Fatalf("unexpected title %q", c.sends[0].Payload.Title)
	}

	var reloaded models.TrackerTask
	s.db.First(&reloaded, "id = ?", task.ID)
	if reloaded.DueNotifiedAt == nil {
		t.Fatal("due_notified_at not set")
	}

	// Same cycle — no re-notification.
	if sent := s.CheckDueTasks(models.NowUTC()); sent != 0 {
		t.Fatalf("expected no re-notification, got %d", sent)
	}
}

func TestDueTaskRenotifiesAfterNewCycle(t *testing.T) {
	s, _ := newTestService(t)
	lst := makeList(t, s, "owner")
	task := makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	addSubscription(t, s, "owner", "https://push.example.com/o")
	enableAllNotifyPrefs(t, s, "owner")

	if sent := s.CheckDueTasks(models.NowUTC()); sent != 1 {
		t.Fatalf("first check should notify, got %d", sent)
	}

	// Completed now — resets the cycle; 8 days later it's overdue again.
	s.db.Create(&models.TrackerLog{TaskID: task.ID, DoneAt: models.NowUTC()})
	if sent := s.CheckDueTasks(models.NowUTC()); sent != 0 {
		t.Fatalf("freshly done task should not notify, got %d", sent)
	}
	if sent := s.CheckDueTasks(models.NowUTC().Add(8 * 24 * time.Hour)); sent != 1 {
		t.Fatalf("new overdue cycle should re-notify, got %d", sent)
	}
}

func TestDueSkipsFreshNoTargetArchivedOffSeasonSnoozed(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	addSubscription(t, s, "owner", "https://push.example.com/o")
	enableAllNotifyPrefs(t, s, "owner")

	makeTask(t, s, lst, "Fresh", intPtr(7), intPtr(1))
	makeTask(t, s, lst, "NoTarget", nil, intPtr(100))
	makeTask(t, s, lst, "NeverDone", intPtr(7), nil) // never done + target → due

	archived := makeTask(t, s, lst, "Archived", intPtr(7), intPtr(30))
	s.db.Model(archived).UpdateColumn("archived", true)

	otherMonth := int(models.NowUTC().Month())%12 + 1
	offSeason := makeTask(t, s, lst, "OffSeason", intPtr(7), intPtr(30))
	s.db.Model(offSeason).UpdateColumns(map[string]any{
		"season_start_month": otherMonth, "season_end_month": otherMonth,
	})

	snoozed := makeTask(t, s, lst, "Snoozed", intPtr(7), intPtr(30))
	s.db.Model(snoozed).UpdateColumn("snooze_until", models.NowUTC().Add(-24*time.Hour))

	if sent := s.CheckDueTasks(models.NowUTC()); sent != 1 {
		t.Fatalf("expected 1 send, got %d", sent)
	}
	body := c.sends[0].Payload.Body
	if body != "“NeverDone” is due" {
		t.Fatalf("unexpected body %q", body)
	}
}

func TestDueRespectsListsDuePref(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	addSubscription(t, s, "owner", "https://push.example.com/o")
	s.db.Create(&models.UserSettings{Sub: "owner", Settings: `{"notifyListsDue": false}`, UpdatedAt: models.NowUTC()})

	if sent := s.CheckDueTasks(models.NowUTC()); sent != 0 {
		t.Fatalf("expected 0 sends, got %d", sent)
	}
	if c.count() != 0 {
		t.Fatalf("no deliveries expected, got %d", c.count())
	}
}

func TestDueAggregatesPerList(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	for _, name := range []string{"A", "B", "C", "D", "E"} {
		makeTask(t, s, lst, name, intPtr(7), intPtr(10))
	}
	addSubscription(t, s, "owner", "https://push.example.com/o")
	enableAllNotifyPrefs(t, s, "owner")

	if sent := s.CheckDueTasks(models.NowUTC()); sent != 1 {
		t.Fatalf("expected one aggregated notification, got %d", sent)
	}
	body := c.sends[0].Payload.Body
	if !strings.HasPrefix(body, "5 tasks are due: ") || !strings.HasSuffix(body, " and 2 more") {
		t.Fatalf("unexpected body %q", body)
	}
}

func TestVapidKeysPersistAndAreStable(t *testing.T) {
	s, _ := newTestService(t)
	pub1, err := s.VapidPublicKey()
	if err != nil || pub1 == "" {
		t.Fatalf("public key: %q err=%v", pub1, err)
	}
	// A second service over the same DB loads the same key.
	s2 := New(s.db, "", 0)
	pub2, err := s2.VapidPublicKey()
	if err != nil || pub2 != pub1 {
		t.Fatalf("key not stable: %q vs %q err=%v", pub1, pub2, err)
	}
}

// webpush-go prepends "mailto:" itself — a subject that already carries the
// scheme must be stripped or Apple rejects the JWT (403 BadJwtToken).
func TestNormalizeSubject(t *testing.T) {
	cases := map[string]string{
		"mailto:me@example.com": "me@example.com",
		"me@example.com":        "me@example.com",
		"https://example.com":   "https://example.com",
		"":                      "admin@localhost",
	}
	for in, want := range cases {
		if got := normalizeSubject(in); got != want {
			t.Errorf("normalizeSubject(%q) = %q, want %q", in, got, want)
		}
	}
}

// ---- batching ----

// batchClock wires a fake clock into Now/Sleep: Sleep blocks until release,
// then advances the clock by the requested duration.
type batchClock struct {
	mu      sync.Mutex
	now     time.Time
	release chan struct{}
}

func installBatchClock(s *Service) *batchClock {
	c := &batchClock{
		now:     time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC),
		release: make(chan struct{}),
	}
	s.Now = func() time.Time {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.now
	}
	s.Sleep = func(d time.Duration) {
		<-c.release
		c.mu.Lock()
		c.now = c.now.Add(d)
		c.mu.Unlock()
	}
	return c
}

// A burst of edits becomes one summary notification with deduped details,
// sent after the quiet delay.
func TestBatchSummarizesBurst(t *testing.T) {
	s, c := newTestService(t)
	s.BatchQuiet, s.BatchMax = 2*time.Minute, 10*time.Minute
	clock := installBatchClock(s)
	addSubscription(t, s, "other-user", "https://push.example.com/other")
	enableAllNotifyPrefs(t, s, "other-user")

	s.QueueEdit("grocery.updated", "editor", "Evan", "added “Milk”")
	s.QueueEdit("grocery.updated", "editor", "Evan", "added “Eggs”")
	s.QueueEdit("grocery.updated", "editor", "Evan", "added “Eggs”") // dup — deduped, still counted
	s.QueueEdit("grocery.updated", "editor", "Evan", "updated “Cheese”")
	s.QueueEdit("grocery.updated", "editor", "Evan", "added “Butter”")

	close(clock.release) // let the batch goroutine reach the quiet deadline
	s.Flush()

	if c.count() != 1 {
		t.Fatalf("burst must produce exactly one notification, got %d", c.count())
	}
	want := "Evan made 5 edits: added “Milk”, added “Eggs”, updated “Cheese”, …"
	if c.sends[0].Payload.Body != want {
		t.Fatalf("body = %q, want %q", c.sends[0].Payload.Body, want)
	}
}

// A single edit still reads like the immediate notification did.
func TestBatchSingleEditBody(t *testing.T) {
	s, c := newTestService(t)
	s.BatchQuiet, s.BatchMax = 2*time.Minute, 10*time.Minute
	clock := installBatchClock(s)
	addSubscription(t, s, "other-user", "https://push.example.com/other")
	enableAllNotifyPrefs(t, s, "other-user")

	s.QueueEdit("grocery.updated", "editor", "Evan", "added “Milk”")
	close(clock.release)
	s.Flush()

	if c.count() != 1 || c.sends[0].Payload.Body != "Evan added “Milk”" {
		t.Fatalf("unexpected sends %+v", c.sends)
	}
}

// Nonstop editing can't defer the summary past BatchMax.
func TestBatchMaxCapsDelay(t *testing.T) {
	s, c := newTestService(t)
	s.BatchQuiet, s.BatchMax = 2*time.Minute, 10*time.Minute
	addSubscription(t, s, "other-user", "https://push.example.com/other")
	enableAllNotifyPrefs(t, s, "other-user")

	var mu sync.Mutex
	start := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	now := start
	s.Now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return now
	}
	// Each wake advances the clock to the deadline, then "keeps editing"
	// (which pushes the quiet deadline out) until the max cap is reached.
	s.Sleep = func(d time.Duration) {
		mu.Lock()
		now = now.Add(d)
		cur := now
		mu.Unlock()
		if cur.Before(start.Add(10 * time.Minute)) {
			s.QueueEdit("grocery.updated", "editor", "Evan", "")
		}
	}

	s.QueueEdit("grocery.updated", "editor", "Evan", "")
	s.Flush()

	if c.count() != 1 {
		t.Fatalf("expected exactly one capped summary, got %d", c.count())
	}
	if c.sends[0].Payload.Body != "Evan made 5 edits" {
		t.Fatalf("unexpected body %q", c.sends[0].Payload.Body)
	}
}

// Per-list overrides in settings.listNotifyOverrides beat the global toggles
// for both edit notifications and due reminders.
func TestPerListNotifyOverrides(t *testing.T) {
	s, c := newTestService(t)
	addSubscription(t, s, "member", "https://push.example.com/member")

	// Global edits ON, but this list overridden OFF.
	s.db.Create(&models.UserSettings{
		Sub:       "member",
		Settings:  `{"notifyListEdits": true, "listNotifyOverrides": {"list-1": {"edits": false}}}`,
		UpdatedAt: models.NowUTC(),
	})
	audience := map[string]bool{"owner": true, "member": true}
	s.QueueTrackerEdit("list-1", "Plants", audience, "owner", "Evan", "")
	s.Flush()
	if c.count() != 0 {
		t.Fatalf("override=false must block the edit notification, got %d", c.count())
	}

	// A different list has no override — global applies.
	s.QueueTrackerEdit("list-2", "Home", audience, "owner", "Evan", "")
	s.Flush()
	if c.count() != 1 {
		t.Fatalf("un-overridden list should follow the global toggle, got %d", c.count())
	}
}

// The global toggle is a hard kill-switch: an explicit per-list true cannot
// re-enable a category the user turned off in Settings.
func TestListToggleCannotOverrideGlobalOff(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	addSubscription(t, s, "owner", "https://push.example.com/o")

	// Global due reminders OFF; list explicitly ON — still silent.
	s.db.Create(&models.UserSettings{
		Sub:       "owner",
		Settings:  `{"notifyListsDue": false, "listNotifyOverrides": {"` + lst.ID.String() + `": {"due": true}}}`,
		UpdatedAt: models.NowUTC(),
	})
	if sent := s.CheckDueTasks(models.NowUTC()); sent != 0 {
		t.Fatalf("global off is a hard kill, got %d", sent)
	}
	if c.count() != 0 {
		t.Fatalf("expected 0 deliveries, got %d", c.count())
	}
}

func TestPerListDueOverrideOff(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	addSubscription(t, s, "owner", "https://push.example.com/o")

	s.db.Create(&models.UserSettings{
		Sub:       "owner",
		Settings:  `{"notifyListsDue": true, "listNotifyOverrides": {"` + lst.ID.String() + `": {"due": false}}}`,
		UpdatedAt: models.NowUTC(),
	})
	if sent := s.CheckDueTasks(models.NowUTC()); sent != 0 {
		t.Fatalf("override=false must block the due reminder, got %d", sent)
	}
	if c.count() != 0 {
		t.Fatalf("expected 0 deliveries, got %d", c.count())
	}
}

// enableAllNotifyPrefs opts a user into every notification category —
// notifications are opt-in, so test recipients must enable them explicitly.
func enableAllNotifyPrefs(t *testing.T, s *Service, sub string) {
	t.Helper()
	settings := `{"notifyMealEdits":true,"notifyPantryEdits":true,"notifyGroceryEdits":true,"notifyListEdits":true,"notifyListsDue":true}`
	if err := s.db.Create(&models.UserSettings{Sub: sub, Settings: settings, UpdatedAt: models.NowUTC()}).Error; err != nil {
		t.Fatalf("enable prefs: %v", err)
	}
}

// Notifications are strictly opt-in: a user with no settings row (or a row
// without the category key) gets nothing.
func TestNotificationsAreOptIn(t *testing.T) {
	s, c := newTestService(t)
	addSubscription(t, s, "fresh-user", "https://push.example.com/fresh")

	s.QueueEdit("grocery.updated", "editor", "Evan", "")
	s.Flush()
	if c.count() != 0 {
		t.Fatalf("fresh user must not be notified by default, got %d", c.count())
	}

	// A settings row without the key is still off.
	s.db.Create(&models.UserSettings{Sub: "fresh-user", Settings: `{"showHolidays": true}`, UpdatedAt: models.NowUTC()})
	s.QueueEdit("pantry.updated", "editor", "Evan", "")
	s.Flush()
	if c.count() != 0 {
		t.Fatalf("missing category key must mean disabled, got %d", c.count())
	}
}

// Repeat reminders: opt-in users are re-notified about a still-due task once
// per 24h; everyone else stays once-per-cycle.
func TestDueRepeatReminders(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	s.db.Create(&models.TrackerShare{ListID: lst.ID, Sub: "member"})
	addSubscription(t, s, "owner", "https://push.example.com/o")
	addSubscription(t, s, "member", "https://push.example.com/m")
	// Owner opted into repeats; member did not.
	s.db.Create(&models.UserSettings{Sub: "owner", Settings: `{"notifyListsDue":true,"notifyListsDueRepeat":true}`, UpdatedAt: models.NowUTC()})
	s.db.Create(&models.UserSettings{Sub: "member", Settings: `{"notifyListsDue":true}`, UpdatedAt: models.NowUTC()})

	start := models.NowUTC()
	if sent := s.CheckDueTasks(start); sent != 2 {
		t.Fatalf("first cycle notifies both, got %d", sent)
	}
	if sent := s.CheckDueTasks(start.Add(2 * time.Hour)); sent != 0 {
		t.Fatalf("within 24h nobody re-notifies, got %d", sent)
	}
	c.mu.Lock()
	c.sends = nil
	c.mu.Unlock()
	if sent := s.CheckDueTasks(start.Add(25 * time.Hour)); sent != 1 {
		t.Fatalf("after 24h only the repeat opt-in re-notifies, got %d", sent)
	}
	if c.sends[0].Sub != "owner" {
		t.Fatalf("repeat should go to owner, got %q", c.sends[0].Sub)
	}
	// The repeat bumped the clock: quiet again until another 24h passes.
	if sent := s.CheckDueTasks(start.Add(26 * time.Hour)); sent != 0 {
		t.Fatalf("repeat must be at most once per 24h, got %d", sent)
	}
	if sent := s.CheckDueTasks(start.Add(50 * time.Hour)); sent != 1 {
		t.Fatalf("next day repeats again, got %d", sent)
	}
}

// Without any repeat opt-in the notified-at clock is not advanced by the
// repeat path — enabling the setting later triggers on the next check.
func TestDueRepeatActivatesForExistingOverdue(t *testing.T) {
	s, _ := newTestService(t)
	lst := makeList(t, s, "owner")
	makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	addSubscription(t, s, "owner", "https://push.example.com/o")
	s.db.Create(&models.UserSettings{Sub: "owner", Settings: `{"notifyListsDue":true}`, UpdatedAt: models.NowUTC()})

	start := models.NowUTC()
	if sent := s.CheckDueTasks(start); sent != 1 {
		t.Fatalf("first cycle, got %d", sent)
	}
	if sent := s.CheckDueTasks(start.Add(30 * time.Hour)); sent != 0 {
		t.Fatalf("no repeat opt-in → no repeat, got %d", sent)
	}
	// Owner turns repeats on afterwards.
	s.db.Model(&models.UserSettings{}).Where("sub = ?", "owner").
		Update("settings", `{"notifyListsDue":true,"notifyListsDueRepeat":true}`)
	if sent := s.CheckDueTasks(start.Add(31 * time.Hour)); sent != 1 {
		t.Fatalf("newly enabled repeat should fire, got %d", sent)
	}
}

// Per-task mutes remove a task from that user's due notifications entirely.
func TestDuePerTaskMute(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	muted := makeTask(t, s, lst, "Muted", intPtr(7), intPtr(10))
	makeTask(t, s, lst, "Loud", intPtr(7), intPtr(10))
	s.db.Create(&models.TrackerShare{ListID: lst.ID, Sub: "member"})
	addSubscription(t, s, "owner", "https://push.example.com/o")
	addSubscription(t, s, "member", "https://push.example.com/m")
	// Owner muted one task; member gets both.
	s.db.Create(&models.UserSettings{
		Sub:       "owner",
		Settings:  `{"notifyListsDue":true,"taskNotifyOverrides":{"` + muted.ID.String() + `":{"due":false}}}`,
		UpdatedAt: models.NowUTC(),
	})
	s.db.Create(&models.UserSettings{Sub: "member", Settings: `{"notifyListsDue":true}`, UpdatedAt: models.NowUTC()})

	if sent := s.CheckDueTasks(models.NowUTC()); sent != 2 {
		t.Fatalf("both members notified, got %d", sent)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, send := range c.sends {
		if send.Sub == "owner" {
			if send.Payload.Body != "“Loud” is due" {
				t.Fatalf("owner must only hear about the unmuted task, got %q", send.Payload.Body)
			}
		}
		if send.Sub == "member" {
			if !strings.HasPrefix(send.Payload.Body, "2 tasks are due:") {
				t.Fatalf("member should hear about both, got %q", send.Payload.Body)
			}
		}
	}
}

// The task-level toggle is a mute, not an override: with list reminders off
// (globally or for the list), an explicit per-task true still sends nothing.
func TestTaskToggleCannotOverrideDisabledListReminders(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	task := makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	addSubscription(t, s, "owner", "https://push.example.com/o")
	s.db.Create(&models.UserSettings{
		Sub:       "owner",
		Settings:  `{"notifyListsDue":false,"taskNotifyOverrides":{"` + task.ID.String() + `":{"due":true}}}`,
		UpdatedAt: models.NowUTC(),
	})

	if sent := s.CheckDueTasks(models.NowUTC()); sent != 0 {
		t.Fatalf("disabled list reminders must win over the task toggle, got %d", sent)
	}
	if c.count() != 0 {
		t.Fatalf("no deliveries expected, got %d", c.count())
	}
}

// Daily digest: replaces as-it-happens due alerts with one summary at the
// user's configured local time, once per local day, timezone-aware.
func TestDueDigest(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	makeTask(t, s, lst, "Water", intPtr(7), intPtr(10))
	makeTask(t, s, lst, "Fertilize", intPtr(7), intPtr(10))
	s.db.Create(&models.TrackerShare{ListID: lst.ID, Sub: "member"})
	addSubscription(t, s, "owner", "https://push.example.com/o")
	addSubscription(t, s, "member", "https://push.example.com/m")
	// Owner: digest at 08:00 New York time. Member: normal immediate alerts.
	s.db.Create(&models.UserSettings{
		Sub:       "owner",
		Settings:  `{"notifyListsDue":true,"notifyListsDueDigest":true,"notifyListsDueDigestTime":"08:00","notifyTimeZone":"America/New_York"}`,
		UpdatedAt: models.NowUTC(),
	})
	s.db.Create(&models.UserSettings{Sub: "member", Settings: `{"notifyListsDue":true}`, UpdatedAt: models.NowUTC()})

	// 06:00 New York (10:00 UTC in July, EDT): member notified immediately,
	// owner silent (digest pending).
	at6 := time.Date(2026, 7, 18, 10, 0, 0, 0, time.UTC)
	if sent := s.CheckDueTasks(at6); sent != 1 {
		t.Fatalf("only the immediate-mode member notifies, got %d", sent)
	}
	if c.sends[0].Sub != "member" {
		t.Fatalf("expected member, got %q", c.sends[0].Sub)
	}

	// 08:03 New York: owner's digest fires with everything due.
	c.mu.Lock()
	c.sends = nil
	c.mu.Unlock()
	at8 := time.Date(2026, 7, 18, 12, 3, 0, 0, time.UTC)
	if sent := s.CheckDueTasks(at8); sent != 1 {
		t.Fatalf("digest should send once, got %d", sent)
	}
	if c.sends[0].Sub != "owner" || c.sends[0].Payload.Title != "Due today" {
		t.Fatalf("unexpected digest %+v", c.sends[0])
	}
	if c.sends[0].Payload.Body != "2 tasks are due: Water (Plants), Fertilize (Plants)" {
		t.Fatalf("unexpected digest body %q", c.sends[0].Payload.Body)
	}

	// Later the same local day: nothing more.
	if sent := s.CheckDueTasks(at8.Add(4 * time.Hour)); sent != 0 {
		t.Fatalf("digest is once per day, got %d", sent)
	}

	// Next local day after 08:00: still-due tasks digest again.
	c.mu.Lock()
	c.sends = nil
	c.mu.Unlock()
	nextDay := at8.Add(24 * time.Hour)
	sent := s.CheckDueTasks(nextDay)
	// (member may get a repeat? member has no repeat pref → only digest)
	if sent != 1 || c.sends[0].Sub != "owner" {
		t.Fatalf("next day digests again for owner only, got sent=%d %+v", sent, c.sends)
	}
}

// Before the configured time nothing is sent; per-task mutes shape the digest.
func TestDueDigestTimeGateAndMutes(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	makeTask(t, s, lst, "Loud", intPtr(7), intPtr(10))
	muted := makeTask(t, s, lst, "Muted", intPtr(7), intPtr(10))
	addSubscription(t, s, "owner", "https://push.example.com/o")
	s.db.Create(&models.UserSettings{
		Sub: "owner",
		Settings: `{"notifyListsDue":true,"notifyListsDueDigest":true,"notifyListsDueDigestTime":"20:00",` +
			`"taskNotifyOverrides":{"` + muted.ID.String() + `":{"due":false}}}`,
		UpdatedAt: models.NowUTC(),
	})

	morning := time.Date(2026, 7, 18, 9, 0, 0, 0, time.UTC)
	if sent := s.CheckDueTasks(morning); sent != 0 {
		t.Fatalf("before the configured time nothing sends, got %d", sent)
	}
	evening := time.Date(2026, 7, 18, 20, 4, 0, 0, time.UTC)
	if sent := s.CheckDueTasks(evening); sent != 1 {
		t.Fatalf("digest at configured time, got %d", sent)
	}
	if c.sends[0].Payload.Body != "“Loud” is due (Plants)" {
		t.Fatalf("muted task must be excluded, got %q", c.sends[0].Payload.Body)
	}
}

// An empty due-set day is marked handled without sending anything.
func TestDueDigestQuietDay(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	makeTask(t, s, lst, "Fresh", intPtr(7), intPtr(1)) // not due
	addSubscription(t, s, "owner", "https://push.example.com/o")
	s.db.Create(&models.UserSettings{
		Sub:       "owner",
		Settings:  `{"notifyListsDue":true,"notifyListsDueDigest":true,"notifyListsDueDigestTime":"08:00"}`,
		UpdatedAt: models.NowUTC(),
	})

	at := time.Date(2026, 7, 18, 9, 0, 0, 0, time.UTC)
	if sent := s.CheckDueTasks(at); sent != 0 {
		t.Fatalf("nothing due → no digest, got %d", sent)
	}
	if c.count() != 0 {
		t.Fatalf("no deliveries expected, got %d", c.count())
	}
	var marker models.DueDigest
	if err := s.db.Where("sub = ?", "owner").First(&marker).Error; err != nil {
		t.Fatal("quiet day must still be marked handled")
	}
}

// The digest covers the whole LOCAL day: a task crossing its threshold after
// the digest time is included; tasks due tomorrow are not. Immediate-mode
// users still only hear about tasks at the moment they actually become due.
func TestDueDigestIncludesLaterToday(t *testing.T) {
	s, c := newTestService(t)
	lst := makeList(t, s, "owner")
	s.db.Create(&models.TrackerShare{ListID: lst.ID, Sub: "member"})
	addSubscription(t, s, "owner", "https://push.example.com/o")
	addSubscription(t, s, "member", "https://push.example.com/m")

	// Digest at 08:00 UTC; check runs 08:03.
	at8 := time.Date(2026, 7, 19, 8, 3, 0, 0, time.UTC)

	// "Later": 7-day target, last done 7 days ago at 10:00 → due 10:00 today.
	later := models.TrackerTask{ListID: lst.ID, Name: "Later", TargetIntervalDays: intPtr(7)}
	s.db.Create(&later)
	s.db.Create(&models.TrackerLog{TaskID: later.ID, DoneAt: time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)})
	// "Tomorrow": due 10:00 tomorrow.
	tomorrow := models.TrackerTask{ListID: lst.ID, Name: "Tomorrow", TargetIntervalDays: intPtr(7)}
	s.db.Create(&tomorrow)
	s.db.Create(&models.TrackerLog{TaskID: tomorrow.ID, DoneAt: time.Date(2026, 7, 13, 10, 0, 0, 0, time.UTC)})
	// "MutedLater": also due later today, but owner muted it.
	mutedLater := models.TrackerTask{ListID: lst.ID, Name: "MutedLater", TargetIntervalDays: intPtr(7)}
	s.db.Create(&mutedLater)
	s.db.Create(&models.TrackerLog{TaskID: mutedLater.ID, DoneAt: time.Date(2026, 7, 12, 11, 0, 0, 0, time.UTC)})

	s.db.Create(&models.UserSettings{
		Sub: "owner",
		Settings: `{"notifyListsDue":true,"notifyListsDueDigest":true,"notifyListsDueDigestTime":"08:00",` +
			`"taskNotifyOverrides":{"` + mutedLater.ID.String() + `":{"due":false}}}`,
		UpdatedAt: models.NowUTC(),
	})
	s.db.Create(&models.UserSettings{Sub: "member", Settings: `{"notifyListsDue":true}`, UpdatedAt: models.NowUTC()})

	if sent := s.CheckDueTasks(at8); sent != 1 {
		t.Fatalf("only the owner's digest should send (nothing is due YET for the member), got %d", sent)
	}
	if c.sends[0].Sub != "owner" || c.sends[0].Payload.Body != "“Later” is due (Plants)" {
		t.Fatalf("digest should include exactly the unmuted later-today task, got %+v", c.sends[0].Payload)
	}

	// At 10:05 "Later" has actually become due — the immediate-mode member is
	// notified now; the digest user is not re-notified.
	c.mu.Lock()
	c.sends = nil
	c.mu.Unlock()
	at10 := time.Date(2026, 7, 19, 10, 5, 0, 0, time.UTC)
	if sent := s.CheckDueTasks(at10); sent != 1 {
		t.Fatalf("member alerted when the task actually becomes due, got %d", sent)
	}
	if c.sends[0].Sub != "member" || c.sends[0].Payload.Body != "“Later” is due" {
		t.Fatalf("unexpected immediate alert %+v", c.sends[0])
	}
}
