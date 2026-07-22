// Command server is the Go port of the FastAPI meal-planner backend.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
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
	settings := config.Load(".env")
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
