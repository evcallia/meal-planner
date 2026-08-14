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
)

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
