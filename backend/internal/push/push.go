// Package push implements Web Push notifications:
//
//   - VAPID key management (generated once, persisted in the vapid_keys table)
//   - dispatch to a set of users, gated on per-user notification preferences
//     (user_settings JSON) and pruning subscriptions the push service reports gone
//   - edit notifications for shared data (grocery/pantry/meals) and tracker
//     lists, with per-(scope, actor) suppression: the first edit notifies
//     immediately, then further edits are silent while they keep coming — the
//     30-minute quiet window resets on every edit, and only after a full quiet
//     window does the next edit notify again
//   - the periodic tracker due-task check
package push

import (
	"encoding/json"
	"io"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"gorm.io/gorm"

	"mealplanner/internal/models"
)

const (
	// EditSuppressWindow is how long editing must be quiet before another
	// edit notification is sent for the same (scope, actor).
	EditSuppressWindow = 30 * time.Minute
	// Batch timing: an editing burst is collected into ONE summary
	// notification, sent after BatchQuietDelay without further edits or
	// BatchMaxDelay after the first edit, whichever comes first.
	BatchQuietDelay = 2 * time.Minute
	BatchMaxDelay   = 5 * time.Minute
	// DueCheckInterval is how often the tracker due-task check runs. Kept
	// short so a configured daily-digest time is honored within minutes.
	DueCheckInterval = 5 * time.Minute
	// DueRepeatInterval: users who opt into repeat reminders get re-notified
	// about a still-due task at most this often.
	DueRepeatInterval = 24 * time.Hour
	// maxBatchDetails caps how many distinct detail phrases a batch keeps.
	maxBatchDetails = 6
)

// PrefKeys maps a notification category to its user_settings JSON key.
// Notifications are strictly opt-in: a missing key counts as DISABLED.
// Names must match the Settings interface in useSettings.ts.
var PrefKeys = map[string]string{
	"meals":    "notifyMealEdits",
	"pantry":   "notifyPantryEdits",
	"grocery":  "notifyGroceryEdits",
	"lists":    "notifyListEdits",
	"list-due": "notifyListsDue",
}

// EditEventCategories maps global SSE event types to edit-notification
// categories. Tracker events are handled separately (per-list audience).
var EditEventCategories = map[string]string{
	"notes.updated":   "meals",
	"pantry.updated":  "pantry",
	"grocery.updated": "grocery",
}

var editContent = map[string]struct{ title, verb string }{
	"meals":   {"Meal plan updated", "updated the meal plan"},
	"pantry":  {"Pantry updated", "updated the pantry"},
	"grocery": {"Grocery list updated", "updated the grocery list"},
}

// Notification is the JSON payload the service worker displays
// (frontend/public/push-sw.js).
type Notification struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Tag   string `json:"tag"`
	URL   string `json:"url"`
}

// editBatch collects one editing burst per (scope, actor) so a single
// summary notification covers it.
type editBatch struct {
	key        string
	category   string
	listID     string // tracker batches: enables per-list pref overrides
	title      string
	tag        string
	actorName  string
	excludeSub string
	generic    string          // fallback verb when no details were captured
	audience   map[string]bool // nil = all subscribed users, resolved at send
	details    []string        // distinct verb phrases, in arrival order
	total      int
	firstAt    time.Time
	lastAt     time.Time
}

// Service owns push state: the VAPID keypair cache, the edit batches and
// suppression clocks, and the injectable send/clock hooks tests use.
type Service struct {
	db      *gorm.DB
	subject string
	window  time.Duration // edit-suppression quiet window

	// BatchQuiet/BatchMax control summary timing; both zero = send
	// immediately (used by tests). Now, Sleep and Send are injectable.
	BatchQuiet time.Duration
	BatchMax   time.Duration
	Now        func() time.Time
	Sleep      func(time.Duration)
	Send       func(sub *models.PushSubscription, payload []byte) (int, error)
	// OnActivity (optional, wired by app.New) announces a freshly created
	// activity row to its audience over SSE, so bells update live.
	OnActivity func(row *models.ActivityLog, audience map[string]bool)

	keyMu   sync.Mutex
	private string
	public  string

	editMu   sync.Mutex
	lastEdit map[string]time.Time
	batches  map[string]*editBatch

	wg sync.WaitGroup
}

// New builds the service. editWindow <= 0 means the default 30 minutes
// (override via PUSH_EDIT_WINDOW_MINUTES for testing). A shortened window
// scales the batch delays down with it so testing stays fast.
func New(db *gorm.DB, vapidSubject string, editWindow time.Duration) *Service {
	quiet, max := BatchQuietDelay, BatchMaxDelay
	if editWindow > 0 && editWindow < EditSuppressWindow {
		quiet, max = editWindow/3, editWindow
	}
	if editWindow <= 0 {
		editWindow = EditSuppressWindow
	}
	s := &Service{
		db:         db,
		subject:    vapidSubject,
		window:     editWindow,
		BatchQuiet: quiet,
		BatchMax:   max,
		Now:        models.NowUTC,
		Sleep:      time.Sleep,
		lastEdit:   map[string]time.Time{},
		batches:    map[string]*editBatch{},
	}
	s.Send = s.sendWebPush
	return s
}

// Flush waits for in-flight async notification goroutines (tests).
func (s *Service) Flush() { s.wg.Wait() }

// ---- VAPID keys ----

// VapidPublicKey returns the server's public key, generating and persisting
// the keypair on first use.
func (s *Service) VapidPublicKey() (string, error) {
	_, pub, err := s.ensureKeys()
	return pub, err
}

func (s *Service) ensureKeys() (string, string, error) {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	if s.private != "" {
		return s.private, s.public, nil
	}
	var row models.VapidKeyPair
	err := s.db.Where("id = ?", 1).First(&row).Error
	if err == gorm.ErrRecordNotFound {
		priv, pub, genErr := webpush.GenerateVAPIDKeys()
		if genErr != nil {
			return "", "", genErr
		}
		row = models.VapidKeyPair{ID: 1, PrivateKey: priv, PublicKey: pub}
		if err := s.db.Create(&row).Error; err != nil {
			return "", "", err
		}
	} else if err != nil {
		return "", "", err
	}
	s.private, s.public = row.PrivateKey, row.PublicKey
	return s.private, s.public, nil
}

// ---- delivery ----

// sendWebPush is the real Send implementation.
func (s *Service) sendWebPush(sub *models.PushSubscription, payload []byte) (int, error) {
	private, public, err := s.ensureKeys()
	if err != nil {
		return 0, err
	}
	resp, err := webpush.SendNotification(payload, &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys:     webpush.Keys{P256dh: sub.P256dh, Auth: sub.Auth},
	}, &webpush.Options{
		Subscriber:      normalizeSubject(s.subject),
		VAPIDPublicKey:  public,
		VAPIDPrivateKey: private,
		TTL:             3600,
	})
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		// Push services put the rejection reason in the body (e.g. Apple's
		// {"reason":"BadJwtToken"} vs "VapidPkHashMismatch") — log it, since
		// the status code alone doesn't say what to fix.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		log.Printf("push: %s responded %d: %s", shortEndpoint(sub.Endpoint), resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return resp.StatusCode, nil
}

// deliver sends one notification to one subscription, pruning it when the
// push service says it's gone (404/410). Best-effort — never returns an
// error, but failures are logged so misconfigurations (e.g. a VAPID subject
// Apple rejects) are visible in the server logs.
func (s *Service) deliver(sub *models.PushSubscription, payload []byte) {
	status, err := s.Send(sub, payload)
	if err != nil {
		log.Printf("push: send to %s (%s) failed: %v", sub.Sub, shortEndpoint(sub.Endpoint), err)
		return
	}
	if status == 404 || status == 410 {
		log.Printf("push: pruning gone subscription for %s (%s): status %d", sub.Sub, shortEndpoint(sub.Endpoint), status)
		s.db.Where("id = ?", sub.ID).Delete(&models.PushSubscription{})
		return
	}
	if status >= 400 {
		log.Printf("push: send to %s (%s) rejected: status %d", sub.Sub, shortEndpoint(sub.Endpoint), status)
	}
}

// normalizeSubject prepares the VAPID subject for webpush-go, which itself
// prepends "mailto:" to anything that isn't an https URL. Passing a value
// that already has the scheme produced "mailto:mailto:…" in the JWT sub
// claim — Mozilla shrugs, but Apple rejects the send with 403 BadJwtToken.
func normalizeSubject(subject string) string {
	if subject == "" {
		subject = "admin@localhost"
	}
	return strings.TrimPrefix(subject, "mailto:")
}

// shortEndpoint trims a push endpoint to its host for logs.
func shortEndpoint(endpoint string) string {
	trimmed := strings.TrimPrefix(strings.TrimPrefix(endpoint, "https://"), "http://")
	if i := strings.IndexByte(trimmed, '/'); i > 0 {
		return trimmed[:i]
	}
	return trimmed
}

// NotifyPrefs is one user's parsed notification preferences, shared between
// push gating and the activity feed (which must mirror what would alert).
type NotifyPrefs struct {
	settings map[string]any
}

// LoadNotifyPrefs reads a user's settings JSON once; a missing row or broken
// JSON yields everything-DISABLED defaults (notifications are opt-in).
func LoadNotifyPrefs(db *gorm.DB, sub string) NotifyPrefs {
	var row models.UserSettings
	if err := db.Where("sub = ?", sub).First(&row).Error; err != nil {
		return NotifyPrefs{}
	}
	return ParseNotifyPrefs(row.Settings)
}

// ParseNotifyPrefs builds prefs from a raw settings JSON blob.
func ParseNotifyPrefs(raw string) NotifyPrefs {
	var settings map[string]any
	if json.Unmarshal([]byte(raw), &settings) != nil {
		return NotifyPrefs{}
	}
	return NotifyPrefs{settings: settings}
}

// DueDigestEnabled: this user wants ONE daily summary of everything due at a
// configured local time, instead of alerts as tasks become due.
func (p NotifyPrefs) DueDigestEnabled() bool {
	if p.settings == nil {
		return false
	}
	v, ok := p.settings["notifyListsDueDigest"].(bool)
	return ok && v
}

// DueDigestClock parses the configured "HH:MM" (default 08:00).
func (p NotifyPrefs) DueDigestClock() (hour, minute int) {
	hour, minute = 8, 0
	if p.settings == nil {
		return
	}
	raw, _ := p.settings["notifyListsDueDigestTime"].(string)
	parts := strings.Split(raw, ":")
	if len(parts) != 2 {
		return
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return
	}
	return h, m
}

// Location resolves the user's IANA timezone (recorded by the client when
// digest settings are saved); UTC when missing or unknown.
func (p NotifyPrefs) Location() *time.Location {
	if p.settings != nil {
		if name, ok := p.settings["notifyTimeZone"].(string); ok && name != "" {
			if loc, err := time.LoadLocation(name); err == nil {
				return loc
			}
		}
	}
	return time.UTC
}

// Enabled reports whether the category would notify this user. The hierarchy
// only narrows: the GLOBAL toggle is a hard kill-switch (strictly opt-in —
// missing/false disables everything below it); the per-list layer
// (settings.listNotifyOverrides[listID].{edits,due}) defaults ON and can only
// mute its list; the per-task layer (DueTaskEnabled) likewise.
func (p NotifyPrefs) Enabled(category, listID string) bool {
	if p.settings == nil {
		return false
	}
	if v, ok := p.settings[PrefKeys[category]].(bool); !ok || !v {
		return false
	}
	if listID != "" {
		field := ""
		switch category {
		case "lists":
			field = "edits"
		case "list-due":
			field = "due"
		}
		if field != "" {
			if overrides, ok := p.settings["listNotifyOverrides"].(map[string]any); ok {
				if o, ok := overrides[listID].(map[string]any); ok {
					if v, ok := o[field].(bool); ok && !v {
						return false
					}
				}
			}
		}
	}
	return true
}

// DueRepeatEnabled: opt-in daily re-reminders while a task stays due.
func (p NotifyPrefs) DueRepeatEnabled() bool {
	if p.settings == nil {
		return false
	}
	v, ok := p.settings["notifyListsDueRepeat"].(bool)
	return ok && v
}

// DueTaskEnabled: the per-list/global gate decides whether due reminders are
// on at all; the per-task entry can only MUTE within that. An explicit task
// true cannot override a disabled list — the UI disables the task toggle in
// that state, and the server enforces the same rule.
func (p NotifyPrefs) DueTaskEnabled(listID, taskID string) bool {
	if !p.Enabled("list-due", listID) {
		return false
	}
	if p.settings != nil && taskID != "" {
		if overrides, ok := p.settings["taskNotifyOverrides"].(map[string]any); ok {
			if o, ok := overrides[taskID].(map[string]any); ok {
				if v, ok := o["due"].(bool); ok {
					return v
				}
			}
		}
	}
	return true
}

// prefEnabled reads the category's toggle from the user's settings JSON.
func (s *Service) prefEnabled(sub, category, listID string) bool {
	return LoadNotifyPrefs(s.db, sub).Enabled(category, listID)
}

// SendToUsers pushes the notification to every device of every user in subs
// that has the category enabled, excluding excludeSub. listID enables
// per-list preference overrides for tracker categories (empty otherwise).
// Returns the number of messages attempted.
func (s *Service) SendToUsers(subs map[string]bool, category string, n Notification, excludeSub, listID string) int {
	payload, err := json.Marshal(n)
	if err != nil {
		return 0
	}
	sent := 0
	for sub := range subs {
		if sub == "" || sub == excludeSub {
			continue
		}
		if !s.prefEnabled(sub, category, listID) {
			continue
		}
		sent += s.sendToUserDevices(sub, payload)
	}
	return sent
}

// sendToUserDevices pushes an already-gated payload to every device of one
// user. Preference checks are the caller's responsibility.
func (s *Service) sendToUserDevices(sub string, payload []byte) int {
	var rows []models.PushSubscription
	if err := s.db.Where("sub = ?", sub).Find(&rows).Error; err != nil {
		return 0
	}
	for i := range rows {
		s.deliver(&rows[i], payload)
	}
	return len(rows)
}

// ---- edit notifications with sliding suppression ----

// enqueueBatch is the single entry point for edit notifications: it joins an
// in-flight batch, or (when the scope+actor has been quiet for a full window)
// starts one, or suppresses. Every edit stamps the last-edit clock, so
// continued editing keeps pushing the next notification out.
func (s *Service) enqueueBatch(seed editBatch, detail string) {
	now := s.Now()
	s.editMu.Lock()
	if b, ok := s.batches[seed.key]; ok {
		// Burst in progress — fold this edit into the pending summary.
		b.total++
		b.lastAt = now
		if detail != "" && len(b.details) < maxBatchDetails && !containsString(b.details, detail) {
			b.details = append(b.details, detail)
		}
		for sub := range seed.audience {
			b.audience[sub] = true
		}
		s.editMu.Unlock()
		return
	}
	last, seen := s.lastEdit[seed.key]
	s.lastEdit[seed.key] = now
	if len(s.lastEdit) > 4096 {
		for k, t := range s.lastEdit {
			if now.Sub(t) >= s.window {
				delete(s.lastEdit, k)
			}
		}
	}
	if seen && now.Sub(last) < s.window {
		log.Printf("push: suppressed %s (last edit %s ago, window %s)", seed.key, now.Sub(last).Round(time.Second), s.window)
		s.editMu.Unlock()
		return
	}
	b := seed
	b.total = 1
	b.firstAt, b.lastAt = now, now
	if detail != "" {
		b.details = []string{detail}
	}
	s.batches[b.key] = &b
	s.editMu.Unlock()
	s.wg.Add(1)
	go s.runBatch(&b)
}

// runBatch waits for the burst to settle (BatchQuiet without further edits,
// capped at BatchMax from the first edit), then sends one summary.
func (s *Service) runBatch(b *editBatch) {
	defer s.wg.Done()
	for {
		s.editMu.Lock()
		deadline := b.lastAt.Add(s.BatchQuiet)
		if cap := b.firstAt.Add(s.BatchMax); cap.Before(deadline) {
			deadline = cap
		}
		now := s.Now()
		if !now.Before(deadline) {
			delete(s.batches, b.key)
			// Arm the sliding suppression from the burst's last edit.
			s.lastEdit[b.key] = b.lastAt
			n := b.compose()
			audience, category, exclude, listID, total := b.audience, b.category, b.excludeSub, b.listID, b.total
			s.editMu.Unlock()
			if audience == nil {
				audience = s.allSubscribedUsers()
			}
			sent := s.SendToUsers(audience, category, n, exclude, listID)
			log.Printf("push: %s → %d message(s) summarizing %d edit(s)", b.key, sent, total)
			return
		}
		wait := deadline.Sub(now)
		s.editMu.Unlock()
		s.Sleep(wait)
	}
}

// compose builds the summary notification. Single edit reads like before
// (“Evan added ‘Milk’”); a burst becomes “Evan made 6 edits: …”.
// Caller holds editMu.
func (b *editBatch) compose() Notification {
	var body string
	switch {
	case b.total == 1 && len(b.details) > 0:
		body = b.actorName + " " + b.details[0]
	case b.total == 1:
		body = b.actorName + " " + b.generic
	case len(b.details) == 0:
		body = b.actorName + " made " + strconv.Itoa(b.total) + " edits"
	default:
		shown := b.details
		suffix := ""
		if len(shown) > 3 {
			shown = shown[:3]
			suffix = ", …"
		}
		body = b.actorName + " made " + strconv.Itoa(b.total) + " edits: " + strings.Join(shown, ", ") + suffix
	}
	return Notification{Title: b.title, Body: body, Tag: b.tag, URL: "/"}
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// QueueEdit fans a shared-data edit (grocery/pantry/meals) out to every
// subscribed user except the actor, batched into a per-burst summary.
// eventType is the SSE event type; unmapped types are ignored. detail is an
// action-specific verb phrase (e.g. `added “Milk”`); empty falls back to a
// generic verb.
func (s *Service) QueueEdit(eventType, actorSub, actorName, detail string) {
	category, ok := EditEventCategories[eventType]
	if !ok || actorSub == "" {
		return
	}
	content := editContent[category]
	s.enqueueBatch(editBatch{
		key:        category + "|" + actorSub,
		category:   category,
		title:      content.title,
		tag:        "edit-" + category,
		actorName:  actorName,
		excludeSub: actorSub,
		generic:    content.verb,
		audience:   nil, // resolved to all subscribed users at send time
	}, detail)
}

// TestResult reports one device's delivery outcome for the test endpoint.
type TestResult struct {
	Endpoint string `json:"endpoint"`
	Status   int    `json:"status,omitempty"`
	Error    string `json:"error,omitempty"`
}

// SendTestNotification pushes a test message to every device of ONE user
// (the caller), bypassing suppression and preference gating, and returns
// per-device results so delivery problems are visible in the UI.
func (s *Service) SendTestNotification(sub string) []TestResult {
	payload, _ := json.Marshal(Notification{
		Title: "Test notification",
		Body:  "Push notifications are working on this device",
		Tag:   "test",
		URL:   "/",
	})
	var rows []models.PushSubscription
	s.db.Where("sub = ?", sub).Find(&rows)
	results := make([]TestResult, 0, len(rows))
	for i := range rows {
		res := TestResult{Endpoint: shortEndpoint(rows[i].Endpoint)}
		status, err := s.Send(&rows[i], payload)
		if err != nil {
			res.Error = err.Error()
		} else {
			res.Status = status
			if status == 404 || status == 410 {
				s.db.Where("id = ?", rows[i].ID).Delete(&models.PushSubscription{})
			}
		}
		results = append(results, res)
	}
	return results
}

// QueueTrackerEdit fans a tracker-list edit out to the list's audience
// (owner + active shares) except the actor, batched per list + actor.
// detail is an action-specific verb phrase (e.g. `completed “Water plants”`);
// empty falls back to a generic one. The list name is the title.
func (s *Service) QueueTrackerEdit(listID, listName string, audience map[string]bool, actorSub, actorName, detail string) {
	if actorSub == "" {
		return
	}
	// Copy the audience — the caller's map must not race with the batch.
	subs := make(map[string]bool, len(audience))
	for k, v := range audience {
		subs[k] = v
	}
	s.enqueueBatch(editBatch{
		key:        "lists:" + listID + "|" + actorSub,
		category:   "lists",
		listID:     listID,
		title:      listName,
		tag:        "edit-lists-" + listID,
		actorName:  actorName,
		excludeSub: actorSub,
		generic:    "updated “" + listName + "”",
		audience:   subs,
	}, detail)
}

// allSubscribedUsers returns the distinct subs holding push subscriptions.
func (s *Service) allSubscribedUsers() map[string]bool {
	var subs []string
	s.db.Model(&models.PushSubscription{}).Distinct("sub").Pluck("sub", &subs)
	out := make(map[string]bool, len(subs))
	for _, sub := range subs {
		out[sub] = true
	}
	return out
}

// ---- tracker due-task notifications ----

// inSeason mirrors inSeason() in frontend utils/recency.ts (inclusive,
// wrapping year-end; null month bounds = all year).
func inSeason(task *models.TrackerTask, now time.Time) bool {
	if task.SeasonStartMonth == nil || task.SeasonEndMonth == nil {
		return true
	}
	ord := func(month int, day *int, fallback int) int {
		d := fallback
		if day != nil && *day != 0 {
			d = *day
		}
		return month*100 + d
	}
	cur := int(now.Month())*100 + now.Day()
	start := ord(*task.SeasonStartMonth, task.SeasonStartDay, 1)
	end := ord(*task.SeasonEndMonth, task.SeasonEndDay, 31)
	if start <= end {
		return cur >= start && cur <= end
	}
	return cur >= start || cur <= end
}

// dueBaseline mirrors the frontend recency baseline: the latest log of any
// kind (done or skip), pushed forward by an active snooze. Nil = never done.
func dueBaseline(task *models.TrackerTask) *time.Time {
	var last *time.Time
	for i := range task.Logs {
		t := task.Logs[i].DoneAt
		if last == nil || t.After(*last) {
			last = &t
		}
	}
	if task.SnoozeUntil != nil && (last == nil || task.SnoozeUntil.After(*last)) {
		return task.SnoozeUntil
	}
	return last
}

// CheckDueTasks finds due tasks and notifies each audience member, honoring
// their per-task mutes. Users in DIGEST mode get nothing here — they receive
// one daily summary of everything due at their configured local time
// (sendDueDigests). Everyone else: a task notifies once per overdue cycle
// (due_notified_at resets with the recency baseline), and repeat opt-ins are
// re-notified about still-due tasks once per DueRepeatInterval.
func (s *Service) CheckDueTasks(now time.Time) int {
	var lists []models.TrackerList
	if err := s.db.Preload("Tasks.Logs").Preload("Shares").Find(&lists).Error; err != nil {
		log.Printf("due-task check: load lists: %v", err)
		return 0
	}
	sent := 0
	prefsCache := map[string]NotifyPrefs{}
	prefsFor := func(sub string) NotifyPrefs {
		if p, ok := prefsCache[sub]; ok {
			return p
		}
		p := LoadNotifyPrefs(s.db, sub)
		prefsCache[sub] = p
		return p
	}

	type dueCandidate struct {
		task  *models.TrackerTask
		dueAt time.Time // zero = due since forever (never done with a target)
	}
	type dueList struct {
		lst      *models.TrackerList
		listID   string
		audience map[string]bool
		all      []dueCandidate // due now or in the future (digest applies a horizon)
	}
	var dues []dueList

	for i := range lists {
		lst := &lists[i]
		// Split due tasks into "newly due this cycle" (notifies everyone) and
		// "still due, last notified ≥24h ago" (notifies repeat opt-ins only);
		// `all` collects both plus already-notified tasks for digests.
		var newlyDue, repeatDue []*models.TrackerTask
		var candidates []dueCandidate
		for j := range lst.Tasks {
			task := &lst.Tasks[j]
			if task.Archived || task.TargetIntervalDays == nil || *task.TargetIntervalDays <= 0 {
				continue
			}
			if !inSeason(task, now) {
				continue
			}
			baseline := dueBaseline(task)
			var dueAt time.Time
			currentlyDue := true
			if baseline != nil {
				dueAt = baseline.Add(time.Duration(*task.TargetIntervalDays) * 24 * time.Hour)
				currentlyDue = !now.Before(dueAt)
			}
			candidates = append(candidates, dueCandidate{task: task, dueAt: dueAt})
			if !currentlyDue {
				continue // digests may look ahead; immediate alerts wait for the moment
			}
			switch {
			case task.DueNotifiedAt == nil || (baseline != nil && task.DueNotifiedAt.Before(*baseline)):
				newlyDue = append(newlyDue, task)
			case now.Sub(*task.DueNotifiedAt) >= DueRepeatInterval:
				repeatDue = append(repeatDue, task)
			}
		}
		if len(candidates) == 0 {
			continue
		}

		listID := lst.ID.String()
		audience := map[string]bool{lst.OwnerSub: true}
		for _, share := range lst.Shares {
			if share.LeftAt == nil {
				audience[share.Sub] = true
			}
		}
		dues = append(dues, dueList{lst: lst, listID: listID, audience: audience, all: candidates})

		if len(newlyDue)+len(repeatDue) > 0 {
			repeatUsed := false
			for sub := range audience {
				prefs := prefsFor(sub)
				if prefs.DueDigestEnabled() {
					continue // digest users get the daily summary instead
				}
				var mine []*models.TrackerTask
				for _, task := range newlyDue {
					if prefs.DueTaskEnabled(listID, task.ID.String()) {
						mine = append(mine, task)
					}
				}
				if prefs.DueRepeatEnabled() && len(repeatDue) > 0 {
					repeatUsed = true
					for _, task := range repeatDue {
						if prefs.DueTaskEnabled(listID, task.ID.String()) {
							mine = append(mine, task)
						}
					}
				}
				if len(mine) == 0 {
					continue
				}
				payload, err := json.Marshal(dueNotification(lst, mine))
				if err != nil {
					continue
				}
				sent += s.sendToUserDevices(sub, payload)
			}

			// Newly-due tasks also land in the activity feed (once per overdue
			// cycle, never for daily repeats): actor-less rows, audience-scoped
			// like tracker edits, filtered per-viewer at read time by the same
			// preference cascade (including per-task mutes via TaskID).
			audienceSnapshot := ""
			for sub := range audience {
				audienceSnapshot += "|" + sub
			}
			audienceSnapshot += "|"
			for _, task := range newlyDue {
				row := models.ActivityLog{
					At:       now,
					Category: "list-due",
					Detail:   "“" + task.Name + "” is due",
					ListName: lst.Name,
					ListID:   listID,
					TaskID:   task.ID.String(),
					Audience: audienceSnapshot,
				}
				if err := s.db.Create(&row).Error; err != nil {
					log.Printf("due-task check: activity log failed: %v", err)
					continue
				}
				if s.OnActivity != nil {
					s.OnActivity(&row, audience)
				}
			}

			// UpdateColumn skips the BeforeUpdate hook so UpdatedAt (which clients
			// render as "last edited") stays untouched. Repeat timestamps only
			// advance when a repeat opt-in existed, so enabling the setting later
			// still triggers on the next check.
			for _, task := range newlyDue {
				s.db.Model(&models.TrackerTask{}).Where("id = ?", task.ID).
					UpdateColumn("due_notified_at", now)
			}
			if repeatUsed {
				for _, task := range repeatDue {
					s.db.Model(&models.TrackerTask{}).Where("id = ?", task.ID).
						UpdateColumn("due_notified_at", now)
				}
			}
		}
	}

	// Daily digests: one summary per user of everything due by the end of
	// THEIR local day (horizon) — an 8am digest includes a task that only
	// crosses its threshold at 9am. Per-list/per-task mutes apply the same.
	sent += s.sendDueDigests(now, func(sub string, horizon time.Time) []digestItem {
		var items []digestItem
		prefs := prefsFor(sub)
		for _, d := range dues {
			if !d.audience[sub] {
				continue
			}
			for _, c := range d.all {
				if !c.dueAt.IsZero() && !c.dueAt.Before(horizon) {
					continue // due tomorrow or later
				}
				if prefs.DueTaskEnabled(d.listID, c.task.ID.String()) {
					items = append(items, digestItem{taskName: c.task.Name, listName: d.lst.Name})
				}
			}
		}
		return items
	})
	return sent
}

type digestItem struct {
	taskName string
	listName string
}

// sendDueDigests delivers each digest-enabled user's daily summary once per
// LOCAL day, at or after their configured time. The sent-marker is written
// even when nothing is due, so the day is evaluated exactly once.
func (s *Service) sendDueDigests(now time.Time, itemsFor func(sub string, horizon time.Time) []digestItem) int {
	var rows []models.UserSettings
	if err := s.db.Find(&rows).Error; err != nil {
		return 0
	}
	sent := 0
	for i := range rows {
		sub := rows[i].Sub
		prefs := ParseNotifyPrefs(rows[i].Settings)
		if !prefs.DueDigestEnabled() {
			continue
		}
		loc := prefs.Location()
		nowLocal := now.In(loc)
		hour, minute := prefs.DueDigestClock()
		target := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), hour, minute, 0, 0, loc)
		if nowLocal.Before(target) {
			continue
		}
		if loc == time.UTC {
			// Not fatal, but almost never what the user meant — the client
			// records an IANA zone when digest settings are saved.
			log.Printf("push: due digest for %s: no timezone recorded, evaluating %02d:%02d as UTC", sub, hour, minute)
		}
		var last models.DueDigest
		if err := s.db.Where("sub = ?", sub).First(&last).Error; err == nil {
			lastLocal := last.SentAt.UTC().In(loc)
			ly, lm, ld := lastLocal.Date()
			ny, nm, nd := nowLocal.Date()
			if ly == ny && lm == nm && ld == nd {
				continue // already handled today
			}
			s.db.Model(&models.DueDigest{}).Where("sub = ?", sub).UpdateColumn("sent_at", now)
		} else {
			s.db.Create(&models.DueDigest{Sub: sub, SentAt: now})
		}
		startOfDay := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc)
		items := itemsFor(sub, startOfDay.AddDate(0, 0, 1))
		if len(items) == 0 {
			log.Printf("push: due digest for %s: nothing due today (day marked handled)", sub)
			continue
		}
		payload, err := json.Marshal(digestNotification(items))
		if err != nil {
			continue
		}
		n := s.sendToUserDevices(sub, payload)
		sent += n
		log.Printf("push: due digest for %s → %d message(s), %d task(s)", sub, n, len(items))
	}
	return sent
}

// digestNotification composes the daily summary across lists.
func digestNotification(items []digestItem) Notification {
	label := func(it digestItem) string { return it.taskName + " (" + it.listName + ")" }
	var body string
	if len(items) == 1 {
		body = "“" + items[0].taskName + "” is due (" + items[0].listName + ")"
	} else {
		shown := make([]string, 0, 4)
		for _, it := range items[:min(4, len(items))] {
			shown = append(shown, label(it))
		}
		body = strconv.Itoa(len(items)) + " tasks are due: " + strings.Join(shown, ", ")
		if len(items) > 4 {
			body += " and " + strconv.Itoa(len(items)-4) + " more"
		}
	}
	return Notification{Title: "Due today", Body: body, Tag: "due-digest", URL: "/"}
}

// dueNotification composes the per-list summary body for a user's due tasks.
func dueNotification(lst *models.TrackerList, due []*models.TrackerTask) Notification {
	var body string
	if len(due) == 1 {
		body = "“" + due[0].Name + "” is due"
	} else {
		names := make([]string, 0, 3)
		for _, t := range due[:min(3, len(due))] {
			names = append(names, t.Name)
		}
		body = strconv.Itoa(len(due)) + " tasks are due: " + strings.Join(names, ", ")
		if len(due) > 3 {
			body += " and " + strconv.Itoa(len(due)-3) + " more"
		}
	}
	return Notification{
		Title: lst.Name,
		Body:  body,
		Tag:   "due-" + lst.ID.String(),
		URL:   "/",
	}
}

// RunDueLoop checks for due tasks periodically until stop is closed.
func (s *Service) RunDueLoop(stop <-chan struct{}) {
	ticker := time.NewTicker(DueCheckInterval)
	defer ticker.Stop()
	for {
		s.CheckDueTasks(s.Now())
		select {
		case <-ticker.C:
		case <-stop:
			return
		}
	}
}
