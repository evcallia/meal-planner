// Command server is the Go port of the FastAPI meal-planner backend.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	// Embed the timezone database so TZID resolution in iCal parsing works
	// even on images without /usr/share/zoneinfo.
	_ "time/tzdata"

	"mealplanner/internal/app"
	"mealplanner/internal/config"
	"mealplanner/internal/db"
	"mealplanner/internal/ical"
	"mealplanner/internal/recipekeeper"
)

// recipeKeeperBaseURL is the fixed Recipe Keeper API host (docs/recipe-keeper-api.md).
const recipeKeeperBaseURL = "https://recipekeeper.azurewebsites.net"

func main() {
	setPassword := flag.String("set-password", "",
		"create/update a password login for this username (password read from the PASSWORD env var or stdin), then exit")
	setEmail := flag.String("set-email", "",
		"update the directory email for the user whose current email is this value; the new email is the next argument (usage: -set-email old@x.com new@x.com), then exit")
	flag.Parse()

	settings := config.Load(".env")
	if *setPassword != "" {
		runSetPassword(settings, *setPassword)
		return
	}
	if *setEmail != "" {
		runSetEmail(settings, *setEmail)
		return
	}
	if err := settings.ValidateSecurity(); err != nil {
		log.Fatalf("security validation failed: %v", err)
	}

	// Calendar times are stored as naive wall clocks in the household's zone,
	// so that zone has to be right or every foreign-timezone event is off by
	// its offset. Logged because getting it wrong is invisible until someone
	// notices a meeting at the wrong hour.
	if settings.CalendarTimeZone != "" {
		loc, err := time.LoadLocation(settings.CalendarTimeZone)
		if err != nil {
			log.Printf("[Calendar] CALENDAR_TIMEZONE %q is not a known zone (%v) — falling back to %s",
				settings.CalendarTimeZone, err, ical.EventZone())
		} else {
			ical.SetEventZone(loc)
		}
	}
	log.Printf("[Calendar] event times render in %s", ical.EventZone())

	gormDB, err := db.Open(settings)
	if err != nil {
		log.Fatalf("database connection failed: %v", err)
	}

	// Startup mirrors the FastAPI lifespan: create tables, migrate, clean up.
	if err := db.CreateAll(gormDB); err != nil {
		log.Fatalf("create_all failed: %v", err)
	}
	if err := db.RunMigrations(gormDB); err != nil {
		log.Fatalf("migrations failed: %v", err)
	}
	db.CleanupOldData(gormDB, settings.MealHistoryRetentionDays)

	application := app.New(settings, gormDB)
	application.Calendar.InitializeCache()

	// Web Push: generate/load the VAPID keypair and start the periodic
	// tracker due-task notification check.
	if _, err := application.Push.VapidPublicKey(); err != nil {
		log.Printf("web push disabled: VAPID key setup failed: %v", err)
	} else {
		subject := settings.VapidSubject
		if subject == "" {
			subject = "UNSET — set VAPID_SUBJECT, Apple rejects the default"
		}
		log.Printf("web push ready (VAPID subject: %s, edit window: %dm)", subject, settings.PushEditWindowMinutes)
	}
	go application.Push.RunDueLoop(application.Broadcaster.Done)

	// Recipe Keeper: pulls the shopping list (and, in the background, recipe
	// titles for attribution) from the Recipe Keeper app. Entirely
	// best-effort — the loop backs off and records LastError on failure,
	// never anything that could break the rest of Meal Planner.
	var cancelRecipeKeeper context.CancelFunc
	if settings.RecipeKeeperEnabled {
		var missingCreds []string
		if settings.RecipeKeeperUsername == "" {
			missingCreds = append(missingCreds, "RECIPE_KEEPER_USERNAME")
		}
		if settings.RecipeKeeperPassword == "" {
			missingCreds = append(missingCreds, "RECIPE_KEEPER_PASSWORD")
		}
		rkHeaders := recipekeeper.DefaultHeaders(recipekeeper.DeviceID(gormDB), settings.RecipeKeeperReceiptID)
		rkAuth := &recipekeeper.Authenticator{
			BaseURL:  recipeKeeperBaseURL,
			Username: settings.RecipeKeeperUsername,
			Password: settings.RecipeKeeperPassword,
			HTTP:     &http.Client{Timeout: 30 * time.Second},
			Hdr:      rkHeaders,
		}
		rkService := &recipekeeper.Service{
			Client: recipekeeper.NewClient(recipeKeeperBaseURL, rkAuth, rkHeaders),
			// No list id here: it's a GUID that lives only inside Recipe
			// Keeper's own API, so nobody can supply it ahead of time. The
			// Reconciler starts unselected; SyncOnce refreshes it from
			// recipe_keeper_state (see state.go) on every cycle, and skips
			// the cycle entirely until PUT /api/recipe-keeper/list sets one.
			Rec: &recipekeeper.Reconciler{DB: gormDB},
			DB:  gormDB,
			OnChange: func(recipekeeper.Changes) {
				// The sync loop has no *http.Request to hang a broadcast off
				// of (unlike application.broadcast), so it publishes directly
				// with a synthetic, stable source id. The payload deliberately
				// carries NO "action" key: building real item-added/updated/
				// deleted deltas needs the app package's serializers, and
				// importing app from recipekeeper would be a circular import.
				// Every frontend hook (and the cache warmer) already falls
				// back to a full API refetch when action is undefined — the
				// documented "legacy event" path — which is exactly what
				// should happen here. A later task can upgrade this to
				// per-item deltas once serialization is reachable from this
				// package.
				application.Broadcaster.BroadcastEvent("grocery.updated",
					map[string]any{"source": "recipe-keeper"},
					"recipe-keeper")
			},
		}
		rkService.PollInterval = recipekeeper.ResolvePollInterval(settings.RecipeKeeperPollSeconds)
		// Exposed on App so /api/recipe-keeper/status and /sync can reach it;
		// nil (the zero value) on App when the integration isn't configured.
		application.RecipeKeeper = rkService
		if len(missingCreds) > 0 {
			log.Printf("recipe keeper: %s not set — sync loop not started", strings.Join(missingCreds, " and "))
		} else {
			if recipekeeper.SelectedListID(gormDB) == "" {
				log.Printf("recipe keeper: no shopping list selected yet — call GET /api/recipe-keeper/lists to see available lists, then PUT /api/recipe-keeper/list to choose one; the sync loop is starting now and will pick it up automatically once you do, no restart needed")
			}
			log.Printf("recipe keeper: polling every %s", rkService.PollInterval)
			var rkCtx context.Context
			rkCtx, cancelRecipeKeeper = context.WithCancel(context.Background())
			go rkService.Run(rkCtx)
		}
	}

	addr := ":8000"
	if v := os.Getenv("PORT"); v != "" {
		addr = ":" + v
	}
	server := &http.Server{
		Addr:    addr,
		Handler: application.Handler(),
		// No ReadTimeout/WriteTimeout: they would kill long-lived SSE
		// streams. Header + idle timeouts cover slow-client abuse.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-shutdown
		log.Println("shutting down...")
		// Unblock SSE streams first so Shutdown doesn't wait on them.
		application.Broadcaster.Close()
		application.Calendar.Shutdown()
		if cancelRecipeKeeper != nil {
			cancelRecipeKeeper()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()

	log.Printf("meal-planner backend (Go) listening on %s", addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

// runSetPassword handles `server -set-password <username>`: upserts a
// user_credentials row (linking to an existing directory user by email) so
// the account can sign in with username/password.
func runSetPassword(settings *config.Settings, username string) {
	password := os.Getenv("PASSWORD")
	if password == "" {
		fmt.Fprintf(os.Stderr, "Password for %s: ", username)
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil {
			log.Fatalf("read password: %v", err)
		}
		password = strings.TrimRight(line, "\r\n")
	}
	if len(password) < 8 {
		log.Fatal("password must be at least 8 characters")
	}
	if len(password) > 72 {
		log.Fatal("password must be at most 72 characters (bcrypt limit)")
	}
	gormDB, err := db.Open(settings)
	if err != nil {
		log.Fatalf("database connection failed: %v", err)
	}
	if err := db.CreateAll(gormDB); err != nil {
		log.Fatalf("create_all failed: %v", err)
	}
	sub, err := app.SetPasswordCredential(gormDB, username, password)
	if err != nil {
		log.Fatalf("set password failed: %v", err)
	}
	fmt.Printf("password set for %s (sub %s)\n", strings.ToLower(strings.TrimSpace(username)), sub)
}

// runSetEmail handles `server -set-email <old> <new>`: the escape hatch for
// a user who changed provider AND email before any login could record an
// identity alias (docs/auth.md).
func runSetEmail(settings *config.Settings, oldEmail string) {
	if flag.NArg() != 1 {
		log.Fatal("usage: server -set-email old@example.com new@example.com")
	}
	newEmail := flag.Arg(0)
	gormDB, err := db.Open(settings)
	if err != nil {
		log.Fatalf("database connection failed: %v", err)
	}
	if err := db.CreateAll(gormDB); err != nil {
		log.Fatalf("create_all failed: %v", err)
	}
	sub, err := app.SetUserEmail(gormDB, oldEmail, newEmail)
	if err != nil {
		log.Fatalf("set email failed: %v", err)
	}
	fmt.Printf("email updated %s -> %s (sub %s)\n", oldEmail, newEmail, sub)
}
