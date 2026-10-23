// Package metrics exposes the app's Prometheus collectors and the handler
// that serves them.
//
// It is deliberately a leaf: it imports nothing from this app and takes only
// primitives, so the packages it measures never import Prometheus. Wiring
// happens in cmd/server (see the ObserveSync hook on recipekeeper.Service) —
// the same "plain func value, not an import either way" approach that keeps
// realtime and recipekeeper independent of each other.
//
// Served on its OWN listener (see cmd/server), never on the public API port:
// Traefik routes only that port, so metrics stay reachable from the Docker
// network — where Prometheus lives — and from nowhere else. That is the whole
// reason there is no auth on this handler.
package metrics

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Sync is one Recipe Keeper sync attempt: any call that asked for a sync,
// whether or not work happened — telling "nobody asked" apart from "someone
// asked and nothing ran" is the whole point of the reason/result pair.
//
// Kind, Reason and Result are label values and are NOT interpreted here: the
// producer owns that vocabulary (see recipekeeper's Reason*/Result*
// constants). Ran and OK carry the semantics instead, so this package never
// has to agree with anyone about what a particular string means.
type Sync struct {
	Kind   string // which sync loop: grocery or recipes
	Reason string // what asked for it: poll_connected, client_connect, manual, …
	Result string // what came of it: success, error, skipped, coalesced, floored
	// Ran is true when a drain actually executed. A skipped, coalesced or
	// floored attempt is counted but contributes no duration observation, so
	// the histogram stays a measure of real work — otherwise a reconnect
	// storm would read as a flood of instant syncs and drag every latency
	// percentile to zero.
	Ran bool
	// OK is true when that drain succeeded. Only then do the item counters
	// and the last-success gauge move.
	OK                      bool
	Duration                time.Duration
	Added, Updated, Deleted int
}

var (
	syncTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "mealplanner",
		Subsystem: "recipekeeper",
		Name:      "sync_total",
		Help:      "Recipe Keeper sync attempts by what asked for them (reason) and what came of it (result).",
	}, []string{"kind", "reason", "result"})

	syncDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "mealplanner",
		Subsystem: "recipekeeper",
		Name:      "sync_duration_seconds",
		Help:      "Wall-clock duration of Recipe Keeper syncs that actually ran.",
		// A steady-state no-change sync is a single ~0.3s round trip; a full
		// first drain measured 14s; the backstop timeouts are 5 min (grocery)
		// and 30 min (recipes). Default buckets stop at 10s and would hide
		// every one of the slow cases that matter.
		Buckets: []float64{0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 60, 120, 300},
	}, []string{"kind"})

	syncItems = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "mealplanner",
		Subsystem: "recipekeeper",
		Name:      "items_total",
		Help:      "Grocery items changed by an inbound Recipe Keeper sync, by direction of the change.",
	}, []string{"direction"})

	lastSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "mealplanner",
		Subsystem: "recipekeeper",
		Name:      "last_success_timestamp_seconds",
		Help:      "Unix time of the last successful Recipe Keeper sync. Alert on time() - this.",
	}, []string{"kind"})

	sseSubscribers = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: "mealplanner",
		Subsystem: "sse",
		Name:      "subscribers",
		Help:      "Currently connected SSE clients. Drives the Recipe Keeper poll cadence, so it explains the sync rate.",
	})
)

// RecordSync records one sync attempt.
func RecordSync(sy Sync) {
	syncTotal.WithLabelValues(sy.Kind, sy.Reason, sy.Result).Inc()
	if !sy.Ran {
		return
	}
	syncDuration.WithLabelValues(sy.Kind).Observe(sy.Duration.Seconds())
	if !sy.OK {
		return
	}
	lastSuccess.WithLabelValues(sy.Kind).Set(float64(time.Now().Unix()))
	for direction, n := range map[string]int{"added": sy.Added, "updated": sy.Updated, "deleted": sy.Deleted} {
		if n > 0 {
			syncItems.WithLabelValues(direction).Add(float64(n))
		}
	}
}

// SSEConnected and SSEDisconnected track the subscriber gauge. They are
// called from the SSE handler rather than from realtime.Broadcaster so the
// gauge counts real clients, not the in-process subscribers test harnesses
// create.
func SSEConnected()    { sseSubscribers.Inc() }
func SSEDisconnected() { sseSubscribers.Dec() }

// Handler serves the default registry, which also carries the Go runtime and
// process collectors client_golang registers for us.
func Handler() http.Handler { return promhttp.Handler() }
