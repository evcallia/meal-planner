// Command devpg runs a throwaway embedded Postgres for local development on
// machines without Docker. Data lives under ~/.embedded-postgres-go and is
// wiped on each start unless -keep is set.
//
//	go run ./cmd/devpg -port 5433
//	POSTGRES_HOST=localhost POSTGRES_PORT=5433 POSTGRES_USER=dev \
//	  POSTGRES_PASSWORD=dev POSTGRES_DB=mealplanner go run ./cmd/server
package main

import (
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
)

func main() {
	port := flag.Uint("port", 5433, "port to listen on")
	keep := flag.Bool("keep", false, "keep existing data directory")
	flag.Parse()

	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".embedded-postgres-go", "devpg-data")
	if !*keep {
		_ = os.RemoveAll(dataDir)
	}

	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Port(uint32(*port)).
		Username("dev").Password("dev").Database("mealplanner").
		DataPath(dataDir).
		StartTimeout(90 * time.Second))
	if err := pg.Start(); err != nil {
		log.Fatalf("start embedded postgres: %v", err)
	}
	log.Printf("embedded postgres running on 127.0.0.1:%d (user=dev password=dev db=mealplanner)", *port)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Println("stopping...")
	if err := pg.Stop(); err != nil {
		log.Fatalf("stop: %v", err)
	}
}
