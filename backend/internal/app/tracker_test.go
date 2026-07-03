package app

// Port of backend/tests/test_tracker.py — Lists / tracker feature:
// privacy, sharing, tasks, and stats.

import (
	"encoding/json"
	"net/http"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"

	"mealplanner/internal/httpx"
	"mealplanner/internal/models"
)

// Second/third identities mirroring USER_A / USER_B in the Python tests.
// (The harness default user, TestSub, plays no role here; each test picks
// explicit cookies just as the Python tests override get_current_user.)
const (
	trSubA = "user-a"
	trSubB = "user-b"
)

func trLoginA(ta *testApp) *http.Cookie { return ta.LoginAs(trSubA, "alice@example.com", "Alice") }
func trLoginB(ta *testApp) *http.Cookie { return ta.LoginAs(trSubB, "bob@example.com", "Bob") }

// trCreateList creates a tracker list as the given user and returns its JSON.
func trCreateList(t *testing.T, ta *testApp, c *http.Cookie, name string) map[string]any {
	t.Helper()
	res := ta.do("POST", "/api/tracker/lists", map[string]any{"name": name}, c)
	if res.Status != 201 {
		t.Fatalf("create list %q: status = %d: %s", name, res.Status, res.Body)
	}
	return res.Obj()
}

// trCreateTask creates a task as the given user and returns its JSON.
func trCreateTask(t *testing.T, ta *testApp, c *http.Cookie, body map[string]any) map[string]any {
	t.Helper()
	res := ta.do("POST", "/api/tracker/tasks", body, c)
	if res.Status != 201 {
		t.Fatalf("create task: status = %d: %s", res.Status, res.Body)
	}
	return res.Obj()
}

// trLists is GET /api/tracker for the given user.
func trLists(t *testing.T, ta *testApp, c *http.Cookie) []any {
	t.Helper()
	res := ta.do("GET", "/api/tracker", nil, c)
	if res.Status != 200 {
		t.Fatalf("GET /api/tracker: status = %d: %s", res.Status, res.Body)
	}
	return res.List()
}

// trListIDs extracts the "id" field of each list.
func trListIDs(lists []any) []string {
	ids := make([]string, 0, len(lists))
	for _, l := range lists {
		ids = append(ids, l.(map[string]any)["id"].(string))
	}
	return ids
}

// trSharedWithHas reports whether shared_with contains the given sub.
func trSharedWithHas(list map[string]any, sub string) bool {
	shared, _ := list["shared_with"].([]any)
	for _, u := range shared {
		if u.(map[string]any)["sub"] == sub {
			return true
		}
	}
	return false
}

// trFirstTask returns lists[0].tasks[0] from GET /api/tracker.
func trFirstTask(t *testing.T, ta *testApp, c *http.Cookie) map[string]any {
	t.Helper()
	lists := trLists(t, ta, c)
	if len(lists) == 0 {
		t.Fatal("no lists returned")
	}
	tasks, _ := lists[0].(map[string]any)["tasks"].([]any)
	if len(tasks) == 0 {
		t.Fatal("no tasks returned")
	}
	return tasks[0].(map[string]any)
}

// trIso mirrors datetime.utcnow().isoformat() for request payloads.
func trIso(t time.Time) string { return httpx.FormatDateTime(t) }

func TestTrackerListsArePrivateByDefault(t *testing.T) {
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)

	body := trCreateList(t, ta, cookieA, "Chores")
	if body["is_owner"] != true {
		t.Fatalf("is_owner = %v, want true", body["is_owner"])
	}
	if shared, _ := body["shared_with"].([]any); len(shared) != 0 {
		t.Fatalf("shared_with = %v, want []", body["shared_with"])
	}

	// Bob cannot see Alice's private list.
	if lists := trLists(t, ta, cookieB); len(lists) != 0 {
		t.Fatalf("bob sees %d lists, want 0", len(lists))
	}
}

func TestTrackerShareGrantsAccessWithNonOwnerPerspective(t *testing.T) {
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)
	listID := trCreateList(t, ta, cookieA, "House")["id"].(string)

	res := ta.do("POST", "/api/tracker/lists/"+listID+"/shares", map[string]any{"sub": trSubB}, cookieA)
	if res.Status != 200 {
		t.Fatalf("share status = %d: %s", res.Status, res.Body)
	}
	if !trSharedWithHas(res.Obj(), trSubB) {
		t.Fatalf("shared_with missing user-b: %v", res.Obj()["shared_with"])
	}

	lists := trLists(t, ta, cookieB)
	if len(lists) != 1 {
		t.Fatalf("bob sees %d lists, want 1", len(lists))
	}
	bobList := lists[0].(map[string]any)
	if bobList["id"] != listID {
		t.Fatalf("id = %v, want %s", bobList["id"], listID)
	}
	if bobList["is_owner"] != false {
		t.Fatalf("is_owner = %v, want false", bobList["is_owner"])
	}

	// Non-owner cannot delete the list or manage shares.
	if res := ta.do("DELETE", "/api/tracker/lists/"+listID, nil, cookieB); res.Status != 403 {
		t.Fatalf("delete as member: status = %d, want 403", res.Status)
	}
	if res := ta.do("POST", "/api/tracker/lists/"+listID+"/shares", map[string]any{"sub": "user-c"}, cookieB); res.Status != 403 {
		t.Fatalf("share as member: status = %d, want 403", res.Status)
	}

	// ...but can collaborate on tasks.
	if res := ta.do("POST", "/api/tracker/tasks", map[string]any{"list_id": listID, "name": "Vacuum"}, cookieB); res.Status != 201 {
		t.Fatalf("member add task: status = %d: %s", res.Status, res.Body)
	}
}

func TestTrackerUnshareRevokesAccess(t *testing.T) {
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)
	listID := trCreateList(t, ta, cookieA, "House")["id"].(string)
	ta.do("POST", "/api/tracker/lists/"+listID+"/shares", map[string]any{"sub": trSubB}, cookieA)

	if len(trLists(t, ta, cookieB)) != 1 {
		t.Fatal("bob should see the shared list")
	}

	if res := ta.do("DELETE", "/api/tracker/lists/"+listID+"/shares/"+trSubB, nil, cookieA); res.Status != 200 {
		t.Fatalf("unshare status = %d: %s", res.Status, res.Body)
	}

	if lists := trLists(t, ta, cookieB); len(lists) != 0 {
		t.Fatalf("bob sees %d lists after unshare, want 0", len(lists))
	}
}

func TestTrackerSharedMemberCanLeaveAndBeReadded(t *testing.T) {
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)
	listID := trCreateList(t, ta, cookieA, "House")["id"].(string)
	ta.do("POST", "/api/tracker/lists/"+listID+"/shares", map[string]any{"sub": trSubB}, cookieA)

	// Bob sees it, then leaves.
	if len(trLists(t, ta, cookieB)) != 1 {
		t.Fatal("bob should see the shared list")
	}
	if res := ta.do("POST", "/api/tracker/lists/"+listID+"/leave", nil, cookieB); res.Status != 204 {
		t.Fatalf("leave status = %d: %s", res.Status, res.Body)
	}
	if lists := trLists(t, ta, cookieB); len(lists) != 0 {
		t.Fatalf("bob sees %d lists after leaving, want 0", len(lists))
	}
	// Leaving is idempotent.
	if res := ta.do("POST", "/api/tracker/lists/"+listID+"/leave", nil, cookieB); res.Status != 204 {
		t.Fatalf("second leave status = %d, want 204", res.Status)
	}

	// The list still exists for its owner.
	ownerView := trLists(t, ta, cookieA)
	if len(ownerView) != 1 {
		t.Fatalf("owner sees %d lists, want 1", len(ownerView))
	}
	if shared, _ := ownerView[0].(map[string]any)["shared_with"].([]any); len(shared) != 0 {
		t.Fatalf("shared_with = %v, want []", shared)
	}

	// Owner can re-add Bob.
	if res := ta.do("POST", "/api/tracker/lists/"+listID+"/shares", map[string]any{"sub": trSubB}, cookieA); res.Status != 200 {
		t.Fatalf("re-share status = %d: %s", res.Status, res.Body)
	}
	if len(trLists(t, ta, cookieB)) != 1 {
		t.Fatal("bob should see the list again after re-share")
	}
}

func TestTrackerMemberCanRejoinAfterLeaving(t *testing.T) {
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)
	listID := trCreateList(t, ta, cookieA, "House")["id"].(string)
	ta.do("POST", "/api/tracker/lists/"+listID+"/shares", map[string]any{"sub": trSubB}, cookieA)

	ta.do("POST", "/api/tracker/lists/"+listID+"/leave", nil, cookieB)
	if lists := trLists(t, ta, cookieB); len(lists) != 0 {
		t.Fatalf("bob sees %d lists after leaving, want 0", len(lists))
	}
	// Undo the leave.
	res := ta.do("POST", "/api/tracker/lists/"+listID+"/rejoin", nil, cookieB)
	if res.Status != 200 {
		t.Fatalf("rejoin status = %d: %s", res.Status, res.Body)
	}
	if res.Obj()["id"] != listID {
		t.Fatalf("rejoin id = %v, want %s", res.Obj()["id"], listID)
	}
	found := false
	for _, id := range trListIDs(trLists(t, ta, cookieB)) {
		if id == listID {
			found = true
		}
	}
	if !found {
		t.Fatal("bob's lists missing the rejoined list")
	}
}

func TestTrackerCannotRejoinAListNeverShared(t *testing.T) {
	// Rejoin must never grant access to a list the user was never a member of.
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)
	listID := trCreateList(t, ta, cookieA, "Private")["id"].(string)

	if res := ta.do("POST", "/api/tracker/lists/"+listID+"/rejoin", nil, cookieB); res.Status != 403 {
		t.Fatalf("rejoin status = %d, want 403: %s", res.Status, res.Body)
	}
	if lists := trLists(t, ta, cookieB); len(lists) != 0 {
		t.Fatalf("bob sees %d lists, want 0", len(lists))
	}
}

func TestTrackerOwnerCannotLeaveOwnList(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Mine")["id"].(string)

	if res := ta.do("POST", "/api/tracker/lists/"+listID+"/leave", nil, cookieA); res.Status != 400 {
		t.Fatalf("owner leave status = %d, want 400: %s", res.Status, res.Body)
	}
	if len(trLists(t, ta, cookieA)) != 1 {
		t.Fatal("owner should still see the list")
	}
}

func TestTrackerNoAccessToForeignListIs403(t *testing.T) {
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)
	listID := trCreateList(t, ta, cookieA, "Secret")["id"].(string)

	res := ta.do("POST", "/api/tracker/tasks", map[string]any{"list_id": listID, "name": "x"}, cookieB)
	if res.Status != 403 {
		t.Fatalf("status = %d, want 403: %s", res.Status, res.Body)
	}
}

func TestTrackerTasksLogsAndRecencyStats(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Plants")["id"].(string)
	task := trCreateTask(t, ta, cookieA, map[string]any{
		"list_id": listID, "name": "Water", "target_interval_days": 7,
	})
	tid := task["id"].(string)
	if task["total_count"] != float64(0) {
		t.Fatalf("total_count = %v, want 0", task["total_count"])
	}
	if task["last_done_at"] != nil {
		t.Fatalf("last_done_at = %v, want nil", task["last_done_at"])
	}

	d1 := trIso(time.Now().UTC().Add(-4 * 24 * time.Hour))
	d2 := trIso(time.Now().UTC())
	ta.do("POST", "/api/tracker/tasks/"+tid+"/logs", map[string]any{"done_at": d1}, cookieA)
	if res := ta.do("POST", "/api/tracker/tasks/"+tid+"/logs", map[string]any{"done_at": d2}, cookieA); res.Status != 201 {
		t.Fatalf("add log status = %d: %s", res.Status, res.Body)
	}

	got := trFirstTask(t, ta, cookieA)
	if got["total_count"] != float64(2) {
		t.Fatalf("total_count = %v, want 2", got["total_count"])
	}
	if got["last_done_at"] == nil {
		t.Fatal("last_done_at is nil, want set")
	}
	avg, ok := got["avg_interval_days"].(float64)
	if !ok || avg < 3 || avg > 5 {
		t.Fatalf("avg_interval_days = %v, want 3..5", got["avg_interval_days"])
	}

	logsRes := ta.do("GET", "/api/tracker/tasks/"+tid+"/logs", nil, cookieA)
	logs := logsRes.List()
	if len(logs) != 2 {
		t.Fatalf("logs = %d, want 2", len(logs))
	}
	logID := logs[0].(map[string]any)["id"].(string)
	if res := ta.do("DELETE", "/api/tracker/logs/"+logID, nil, cookieA); res.Status != 204 {
		t.Fatalf("delete log status = %d: %s", res.Status, res.Body)
	}
	got = trFirstTask(t, ta, cookieA)
	if got["total_count"] != float64(1) {
		t.Fatalf("total_count after delete = %v, want 1", got["total_count"])
	}
}

func TestTrackerShareByUnknownEmailIs404(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Y")["id"].(string)

	res := ta.do("POST", "/api/tracker/lists/"+listID+"/shares", map[string]any{"email": "ghost@example.com"}, cookieA)
	if res.Status != 404 {
		t.Fatalf("status = %d, want 404: %s", res.Status, res.Body)
	}
}

func TestTrackerSeasonalFieldsRoundtrip(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Yard")["id"].(string)
	task := trCreateTask(t, ta, cookieA, map[string]any{
		"list_id": listID, "name": "Mow lawn", "target_interval_days": 7,
		"season_start_month": 4, "season_end_month": 10,
	})
	if task["season_start_month"] != float64(4) {
		t.Fatalf("season_start_month = %v, want 4", task["season_start_month"])
	}
	if task["season_end_month"] != float64(10) {
		t.Fatalf("season_end_month = %v, want 10", task["season_end_month"])
	}

	// Clearing the season back to all-year.
	res := ta.do("PATCH", "/api/tracker/tasks/"+task["id"].(string), map[string]any{
		"season_start_month": nil, "season_end_month": nil,
	}, cookieA)
	if res.Status != 200 {
		t.Fatalf("patch status = %d: %s", res.Status, res.Body)
	}
	updated := res.Obj()
	if updated["season_start_month"] != nil {
		t.Fatalf("season_start_month = %v, want nil", updated["season_start_month"])
	}
	if updated["season_end_month"] != nil {
		t.Fatalf("season_end_month = %v, want nil", updated["season_end_month"])
	}

	// Out-of-range months are rejected.
	bad := ta.do("POST", "/api/tracker/tasks", map[string]any{
		"list_id": listID, "name": "Bad", "season_start_month": 13,
	}, cookieA)
	if bad.Status != 422 {
		t.Fatalf("out-of-range month status = %d, want 422: %s", bad.Status, bad.Body)
	}
}

func TestTrackerSkipLogsADeletableSkipEntry(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Skips")["id"].(string)
	tid := trCreateTask(t, ta, cookieA, map[string]any{
		"list_id": listID, "name": "t", "target_interval_days": 7,
	})["id"].(string)

	res := ta.do("POST", "/api/tracker/tasks/"+tid+"/skip", nil, cookieA)
	if res.Status != 200 {
		t.Fatalf("skip status = %d: %s", res.Status, res.Body)
	}
	body := res.Obj()
	if body["total_count"] != float64(0) { // a skip is not a completion
		t.Fatalf("total_count = %v, want 0", body["total_count"])
	}
	if body["last_event_at"] == nil { // ...but it resets recency
		t.Fatal("last_event_at is nil, want set")
	}

	logs := ta.do("GET", "/api/tracker/tasks/"+tid+"/logs", nil, cookieA).List()
	if len(logs) != 1 {
		t.Fatalf("logs = %d, want 1", len(logs))
	}
	if logs[0].(map[string]any)["kind"] != "skip" {
		t.Fatalf("kind = %v, want skip", logs[0].(map[string]any)["kind"])
	}

	// Undo a skip = delete the skip log.
	logID := logs[0].(map[string]any)["id"].(string)
	if res := ta.do("DELETE", "/api/tracker/logs/"+logID, nil, cookieA); res.Status != 204 {
		t.Fatalf("delete log status = %d: %s", res.Status, res.Body)
	}
	got := trFirstTask(t, ta, cookieA)
	if got["last_event_at"] != nil {
		t.Fatalf("last_event_at = %v, want nil", got["last_event_at"])
	}
	if got["total_count"] != float64(0) {
		t.Fatalf("total_count = %v, want 0", got["total_count"])
	}
}

func TestTrackerCompletionCanBeAttributedToAnotherUser(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Who")["id"].(string)
	tid := trCreateTask(t, ta, cookieA, map[string]any{"list_id": listID, "name": "t"})["id"].(string)

	res := ta.do("POST", "/api/tracker/tasks/"+tid+"/logs", map[string]any{"created_by_sub": trSubB}, cookieA)
	if res.Status != 201 {
		t.Fatalf("add log status = %d: %s", res.Status, res.Body)
	}
	if res.Obj()["created_by_sub"] != trSubB {
		t.Fatalf("created_by_sub = %v, want %s", res.Obj()["created_by_sub"], trSubB)
	}
	logs := ta.do("GET", "/api/tracker/tasks/"+tid+"/logs", nil, cookieA).List()
	if logs[0].(map[string]any)["created_by_sub"] != trSubB {
		t.Fatalf("stored created_by_sub = %v, want %s", logs[0].(map[string]any)["created_by_sub"], trSubB)
	}
}

func TestTrackerSeasonDayRangeRoundtrip(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Yard")["id"].(string)
	task := trCreateTask(t, ta, cookieA, map[string]any{
		"list_id": listID, "name": "Mow",
		"season_start_month": 3, "season_start_day": 15,
		"season_end_month": 10, "season_end_day": 31,
	})
	if task["season_start_day"] != float64(15) {
		t.Fatalf("season_start_day = %v, want 15", task["season_start_day"])
	}
	if task["season_end_day"] != float64(31) {
		t.Fatalf("season_end_day = %v, want 31", task["season_end_day"])
	}
	bad := ta.do("POST", "/api/tracker/tasks", map[string]any{
		"list_id": listID, "name": "Bad", "season_start_day": 40,
	}, cookieA)
	if bad.Status != 422 {
		t.Fatalf("out-of-range day status = %d, want 422: %s", bad.Status, bad.Body)
	}
}

func TestTrackerListOrderIsPerUser(t *testing.T) {
	// Alice owns two lists and shares both with Bob.
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)
	l1 := trCreateList(t, ta, cookieA, "One")["id"].(string)
	l2 := trCreateList(t, ta, cookieA, "Two")["id"].(string)
	ta.do("POST", "/api/tracker/lists/"+l1+"/shares", map[string]any{"sub": trSubB}, cookieA)
	ta.do("POST", "/api/tracker/lists/"+l2+"/shares", map[string]any{"sub": trSubB}, cookieA)

	assertOrder := func(c *http.Cookie, want []string, label string) {
		t.Helper()
		got := trListIDs(trLists(t, ta, c))
		if len(got) != len(want) {
			t.Fatalf("%s: got %v, want %v", label, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s: got %v, want %v", label, got, want)
			}
		}
	}

	// Alice reorders to [Two, One].
	if res := ta.do("PATCH", "/api/tracker/reorder-lists", map[string]any{"list_ids": []string{l2, l1}}, cookieA); res.Status != 200 {
		t.Fatalf("reorder status = %d: %s", res.Status, res.Body)
	}
	assertOrder(cookieA, []string{l2, l1}, "alice after her reorder")

	// Bob's order is unaffected by Alice's reorder.
	assertOrder(cookieB, []string{l1, l2}, "bob after alice's reorder")

	// Bob reorders for himself; Alice's order stays put.
	if res := ta.do("PATCH", "/api/tracker/reorder-lists", map[string]any{"list_ids": []string{l2, l1}}, cookieB); res.Status != 200 {
		t.Fatalf("bob reorder status = %d: %s", res.Status, res.Body)
	}
	assertOrder(cookieB, []string{l2, l1}, "bob after his reorder")
	assertOrder(cookieA, []string{l2, l1}, "alice after bob's reorder")
}

func TestTrackerRestoreListRebuildsTasksLogsSharesAndPosition(t *testing.T) {
	ta := newTestApp(t)
	cookieA, cookieB := trLoginA(ta), trLoginB(ta)

	// Mirror the undo flow: A, B, C exist; B is deleted, then restored into its slot.
	trCreateList(t, ta, cookieA, "A")
	bid := trCreateList(t, ta, cookieA, "B")["id"].(string)
	trCreateList(t, ta, cookieA, "C")
	if res := ta.do("DELETE", "/api/tracker/lists/"+bid, nil, cookieA); res.Status != 204 {
		t.Fatalf("delete status = %d: %s", res.Status, res.Body)
	}

	d1 := trIso(time.Now().UTC().Add(-5 * 24 * time.Hour))
	d2 := trIso(time.Now().UTC())
	restored := ta.do("POST", "/api/tracker/lists/restore", map[string]any{
		"name":       "B",
		"color":      "rose",
		"position":   1, // original slot, now vacated
		"share_subs": []string{trSubB},
		"tasks": []map[string]any{{
			"name":                 "Water",
			"target_interval_days": 7,
			"position":             0,
			"logs": []map[string]any{
				{"done_at": d1, "kind": "done"},
				{"done_at": d2, "kind": "done"},
				{"done_at": d2, "kind": "skip"},
			},
		}},
	}, cookieA)
	if restored.Status != 201 {
		t.Fatalf("restore status = %d: %s", restored.Status, restored.Body)
	}
	body := restored.Obj()
	if body["name"] != "B" {
		t.Fatalf("name = %v, want B", body["name"])
	}
	if body["position"] != float64(1) {
		t.Fatalf("position = %v, want 1", body["position"])
	}
	if body["is_owner"] != true {
		t.Fatalf("is_owner = %v, want true", body["is_owner"])
	}
	if !trSharedWithHas(body, trSubB) {
		t.Fatalf("shared_with missing user-b: %v", body["shared_with"])
	}
	tasks, _ := body["tasks"].([]any)
	if len(tasks) != 1 {
		t.Fatalf("tasks = %d, want 1", len(tasks))
	}
	task := tasks[0].(map[string]any)
	if task["total_count"] != float64(2) { // skip doesn't count as a completion
		t.Fatalf("total_count = %v, want 2", task["total_count"])
	}
	if task["avg_interval_days"] == nil {
		t.Fatal("avg_interval_days is nil, want set")
	}

	// Restored list reappears in its original slot for the owner, not at the end.
	names := []string{}
	for _, l := range trLists(t, ta, cookieA) {
		names = append(names, l.(map[string]any)["name"].(string))
	}
	if len(names) != 3 || names[0] != "A" || names[1] != "B" || names[2] != "C" {
		t.Fatalf("owner order = %v, want [A B C]", names)
	}

	// Logs (incl. the skip) were recreated.
	logs := ta.do("GET", "/api/tracker/tasks/"+task["id"].(string)+"/logs", nil, cookieA).List()
	if len(logs) != 3 {
		t.Fatalf("logs = %d, want 3", len(logs))
	}
	skips := 0
	for _, l := range logs {
		if l.(map[string]any)["kind"] == "skip" {
			skips++
		}
	}
	if skips != 1 {
		t.Fatalf("skip logs = %d, want 1", skips)
	}

	// The collaborator can see the restored list.
	found := false
	for _, id := range trListIDs(trLists(t, ta, cookieB)) {
		if id == body["id"] {
			found = true
		}
	}
	if !found {
		t.Fatal("bob's lists missing the restored list")
	}
}

func TestTrackerTaskPayloadEmbedsRecentLogsCappedAtFive(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Plants")["id"].(string)
	tid := trCreateTask(t, ta, cookieA, map[string]any{"list_id": listID, "name": "Water"})["id"].(string)

	// Seven completions on distinct days; only the latest 5 should be embedded.
	now := time.Now().UTC()
	for i := 0; i < 7; i++ {
		done := trIso(now.Add(-time.Duration(i) * 24 * time.Hour))
		if res := ta.do("POST", "/api/tracker/tasks/"+tid+"/logs", map[string]any{"done_at": done}, cookieA); res.Status != 201 {
			t.Fatalf("add log %d: status = %d: %s", i, res.Status, res.Body)
		}
	}

	task := trFirstTask(t, ta, cookieA)
	if task["total_count"] != float64(7) {
		t.Fatalf("total_count = %v, want 7", task["total_count"])
	}
	recent, _ := task["recent_logs"].([]any)
	if len(recent) != 5 {
		t.Fatalf("recent_logs = %d, want 5", len(recent))
	}
	// Newest first, and strictly descending by done_at.
	times := make([]string, 0, len(recent))
	for _, l := range recent {
		times = append(times, l.(map[string]any)["done_at"].(string))
	}
	if !sort.SliceIsSorted(times, func(i, j int) bool { return times[i] > times[j] }) {
		t.Fatalf("recent_logs not newest-first: %v", times)
	}
}

func TestTrackerLogPayloadIsSSESerializableAndStoredNaive(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "L")["id"].(string)
	tid := trCreateTask(t, ta, cookieA, map[string]any{"list_id": listID, "name": "T"})["id"].(string)

	// A naive log and a tz-aware one (exactly like the frontend's toISOString()).
	if res := ta.do("POST", "/api/tracker/tasks/"+tid+"/logs",
		map[string]any{"done_at": trIso(time.Now().UTC())}, cookieA); res.Status != 201 {
		t.Fatalf("naive log status = %d: %s", res.Status, res.Body)
	}
	if res := ta.do("POST", "/api/tracker/tasks/"+tid+"/logs",
		map[string]any{"done_at": "2026-06-18T03:00:00.000Z"}, cookieA); res.Status != 201 {
		t.Fatalf("tz-aware log status = %d: %s", res.Status, res.Body)
	}

	var task models.TrackerTask
	if err := ta.App.DB.Where("id = ?", uuid.MustParse(tid)).First(&task).Error; err != nil {
		t.Fatalf("load task: %v", err)
	}
	data := ta.App.trackerTaskJSON(&task)
	// SSE encodes this dict with json.Marshal — embedded recent_logs must be
	// JSON-serializable strings (no raw datetimes), or every broadcast 500s.
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("task payload not JSON-serializable: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("round-trip: %v", err)
	}
	recent, _ := decoded["recent_logs"].([]any)
	if len(recent) == 0 {
		t.Fatal("recent_logs is empty")
	}
	if _, ok := recent[0].(map[string]any)["done_at"].(string); !ok {
		t.Fatalf("recent_logs[0].done_at = %T, want string", recent[0].(map[string]any)["done_at"])
	}
	// Stored values are naive UTC — the tz-aware "Z" input was normalized to
	// UTC wall time (Go's analogue of "no tz-aware value leaks in").
	var stored []models.TrackerLog
	ta.App.DB.Where("task_id = ?", uuid.MustParse(tid)).Find(&stored)
	if len(stored) != 2 {
		t.Fatalf("stored logs = %d, want 2", len(stored))
	}
	want := time.Date(2026, 6, 18, 3, 0, 0, 0, time.UTC)
	foundZ := false
	for _, l := range stored {
		if l.DoneAt.UTC().Equal(want) {
			foundZ = true
		}
	}
	if !foundZ {
		t.Fatalf("tz-aware log not stored as %v; stored: %v, %v", want, stored[0].DoneAt, stored[1].DoneAt)
	}
}

func TestTrackerDeleteTaskIsIdempotent(t *testing.T) {
	ta := newTestApp(t)
	cookieA := trLoginA(ta)
	listID := trCreateList(t, ta, cookieA, "Z")["id"].(string)
	tid := trCreateTask(t, ta, cookieA, map[string]any{"list_id": listID, "name": "t"})["id"].(string)

	if res := ta.do("DELETE", "/api/tracker/tasks/"+tid, nil, cookieA); res.Status != 204 {
		t.Fatalf("first delete status = %d: %s", res.Status, res.Body)
	}
	if res := ta.do("DELETE", "/api/tracker/tasks/"+tid, nil, cookieA); res.Status != 204 {
		t.Fatalf("second delete status = %d: %s", res.Status, res.Body)
	}
}
