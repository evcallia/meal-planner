package app

// Postgres-dialect integration test: the SQLite suite can't prove that
// AutoMigrate DDL, uuid columns, and timestamp scanning work on the real
// production database. This spins up an embedded Postgres and runs a
// cross-section of real flows through the full HTTP handler.
//
// Requires network access on first run (downloads Postgres binaries);
// skipped when unavailable or when -short is set.

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"

	"mealplanner/internal/db"
	appdb "mealplanner/internal/db"
	"mealplanner/internal/ical"
	"mealplanner/internal/models"
)

func freePort(t *testing.T) uint32 {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("no free port: %v", err)
	}
	defer l.Close()
	return uint32(l.Addr().(*net.TCPAddr).Port)
}

func TestPostgresIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("short mode")
	}
	port := freePort(t)
	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Port(port).
		Username("test").Password("test").Database("mealplanner_test").
		StartTimeout(90 * time.Second))
	if err := pg.Start(); err != nil {
		t.Skipf("embedded postgres unavailable: %v", err)
	}
	defer pg.Stop()

	settings := testSettings()
	settings.PostgresHost = "127.0.0.1"
	settings.PostgresPort = int(port)
	settings.PostgresDB = "mealplanner_test"
	settings.PostgresUser = "test"
	settings.PostgresPassword = "test"

	gdb, err := appdb.Open(settings)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}

	// Full startup path on the postgres dialect.
	if err := db.CreateAll(gdb); err != nil {
		t.Fatalf("create_all on postgres: %v", err)
	}
	if err := db.RunMigrations(gdb); err != nil {
		t.Fatalf("migrations on postgres: %v", err)
	}
	db.CleanupOldData(gdb, 365)

	a := New(settings, gdb)
	a.Calendar.FetchCalDAVEvents = func(start, end time.Time) []ical.EventWithSource { return nil }
	a.Calendar.FetchHolidaysRaw = func() ([]byte, error) { return nil, fmt.Errorf("no network") }
	a.Calendar.ListCalendarsFn = func() ([]ical.Calendar, error) { return nil, nil }
	ta := &testApp{t: t, App: a, h: a.Handler()}
	ta.Cookie = ta.LoginAs(TestSub, TestEmail, TestName)

	// Idempotent second startup (server restart against an existing DB).
	if err := db.CreateAll(gdb); err != nil {
		t.Fatalf("create_all rerun: %v", err)
	}
	if err := db.RunMigrations(gdb); err != nil {
		t.Fatalf("migrations rerun: %v", err)
	}

	t.Run("grocery flow", func(t *testing.T) {
		sec := ta.POST("/api/grocery/sections", map[string]any{"name": "Produce"})
		if sec.Status != 201 {
			t.Fatalf("create section: %d %s", sec.Status, sec.Body)
		}
		secID := sec.Obj()["id"].(string)
		item := ta.POST("/api/grocery/items", map[string]any{
			"section_id": secID, "name": "Avocado", "quantity": "3",
		})
		if item.Status != 200 {
			t.Fatalf("add item: %d %s", item.Status, item.Body)
		}
		itemID := item.Obj()["id"].(string)
		upd := ta.PATCH("/api/grocery/items/"+itemID, map[string]any{"checked": true})
		if upd.Status != 200 || upd.Obj()["checked"] != true {
			t.Fatalf("toggle: %d %s", upd.Status, upd.Body)
		}
		list := ta.GET("/api/grocery")
		if list.Status != 200 || len(list.List()) != 1 {
			t.Fatalf("list: %d %s", list.Status, list.Body)
		}
		// item_defaults section memory persisted (lowercased name).
		defaults := ta.GET("/api/grocery/item-defaults")
		if len(defaults.List()) != 1 {
			t.Fatalf("defaults: %s", defaults.Body)
		}
	})

	t.Run("meal notes with itemized carry", func(t *testing.T) {
		put := ta.PUT("/api/days/2026-07-02/notes", map[string]any{
			"notes": "<div>Tacos</div><div>Salad</div>",
		})
		if put.Status != 200 {
			t.Fatalf("put notes: %d %s", put.Status, put.Body)
		}
		toggle := ta.PATCH("/api/days/2026-07-02/items/0", map[string]any{"itemized": true})
		if toggle.Status != 200 {
			t.Fatalf("toggle: %d %s", toggle.Status, toggle.Body)
		}
		put2 := ta.PUT("/api/days/2026-07-02/notes", map[string]any{
			"notes": "<div>Burgers</div><div>Tacos</div><div>Salad</div>",
		})
		if put2.Status != 200 {
			t.Fatalf("put notes 2: %d %s", put2.Status, put2.Body)
		}
		days := ta.GET("/api/days?start_date=2026-07-02&end_date=2026-07-02")
		note := days.List()[0].(map[string]any)["meal_note"].(map[string]any)
		items := note["items"].([]any)
		if len(items) != 3 {
			t.Fatalf("items = %v", items)
		}
		// "Tacos" moved to line 1 and kept its itemized flag.
		if items[1].(map[string]any)["itemized"] != true {
			t.Fatalf("itemized state not carried: %v", items)
		}
	})

	t.Run("tracker sharing across users", func(t *testing.T) {
		gdb.Create(&models.User{Sub: "friend-1", Email: strPtr("friend@example.com"), Name: strPtr("Friend One")})

		lst := ta.POST("/api/tracker/lists", map[string]any{"name": "Chores", "icon": "🧹"})
		if lst.Status != 201 {
			t.Fatalf("create list: %d %s", lst.Status, lst.Body)
		}
		listID := lst.Obj()["id"].(string)

		share := ta.POST("/api/tracker/lists/"+listID+"/shares", map[string]any{"email": "friend@example.com"})
		if share.Status != 200 {
			t.Fatalf("share: %d %s", share.Status, share.Body)
		}

		task := ta.POST("/api/tracker/tasks", map[string]any{"list_id": listID, "name": "Vacuum", "target_interval_days": 7})
		if task.Status != 201 {
			t.Fatalf("task: %d %s", task.Status, task.Body)
		}
		taskID := task.Obj()["id"].(string)

		logResp := ta.POST("/api/tracker/tasks/"+taskID+"/logs", map[string]any{"done_at": "2026-06-30T12:00:00Z"})
		if logResp.Status != 201 {
			t.Fatalf("log: %d %s", logResp.Status, logResp.Body)
		}

		friendCookie := ta.LoginAs("friend-1", "friend@example.com", "Friend One")
		friendView := ta.do("GET", "/api/tracker", nil, friendCookie)
		lists := friendView.List()
		if len(lists) != 1 {
			t.Fatalf("friend lists: %s", friendView.Body)
		}
		fl := lists[0].(map[string]any)
		if fl["is_owner"] != false {
			t.Fatal("friend must not be owner")
		}
		tasks := fl["tasks"].([]any)
		if len(tasks) != 1 || tasks[0].(map[string]any)["total_count"] != float64(1) {
			t.Fatalf("friend tasks: %v", tasks)
		}
	})

	t.Run("settings json column", func(t *testing.T) {
		put := ta.PUT("/api/settings", map[string]any{
			"settings":   map[string]any{"darkMode": true, "holidayColor": "red"},
			"updated_at": "2026-07-01T10:00:00Z",
		})
		if put.Status != 200 {
			t.Fatalf("put settings: %d %s", put.Status, put.Body)
		}
		get := ta.GET("/api/settings")
		s := get.Obj()["settings"].(map[string]any)
		if s["darkMode"] != true || s["holidayColor"] != "red" {
			t.Fatalf("settings roundtrip: %s", get.Body)
		}
	})

	t.Run("calendar hidden events", func(t *testing.T) {
		hide := ta.POST("/api/calendar/hidden", map[string]any{
			"event_uid": "ev-1", "calendar_name": "Family", "title": "Dentist",
			"start_time": "2026-07-10T09:00:00", "all_day": false,
		})
		if hide.Status != 200 {
			t.Fatalf("hide: %d %s", hide.Status, hide.Body)
		}
		hiddenID := hide.Obj()["id"].(string)
		unhide := ta.DELETE("/api/calendar/hidden/" + hiddenID)
		if unhide.Status != 200 || unhide.Obj()["status"] != "ok" {
			t.Fatalf("unhide: %d %s", unhide.Status, unhide.Body)
		}
	})

	t.Run("sse stream over postgres-backed app", func(t *testing.T) {
		srv := httptest.NewServer(ta.h)
		defer srv.Close()
		c := openStream(t, srv, ta.Cookie)
		defer c.close()
		if f := c.next(t); f["type"] != "ready" {
			t.Fatalf("ready = %v", f)
		}
		req, _ := http.NewRequest("POST", srv.URL+"/api/stores", nil)
		_ = req
		store := ta.POST("/api/stores", map[string]any{"name": "trader joe's"})
		if store.Status != 200 || store.Obj()["name"] != "Trader Joe's" {
			t.Fatalf("store: %d %s", store.Status, store.Body)
		}
		frame := c.next(t)
		if frame["type"] != "stores.updated" {
			t.Fatalf("frame = %v", frame)
		}
	})
}

func strPtr(s string) *string { return &s }
