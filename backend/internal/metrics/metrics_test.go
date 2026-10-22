package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// durationCount reads how many observations the duration histogram holds for
// a kind. The collectors are package-level (promauto registers them into the
// default registry at init), so every assertion here is a DELTA — tests must
// not depend on each other's counts or on running order.
func durationCount(t *testing.T, kind string) uint64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != "mealplanner_recipekeeper_sync_duration_seconds" {
			continue
		}
		for _, m := range f.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetName() == "kind" && l.GetValue() == kind {
					return m.GetHistogram().GetSampleCount()
				}
			}
		}
	}
	return 0
}

func TestRecordSyncCountsAttemptsByReasonAndResult(t *testing.T) {
	before := testutil.ToFloat64(syncTotal.WithLabelValues("grocery", "client_connect", "success"))
	beforeAdded := testutil.ToFloat64(syncItems.WithLabelValues("added"))
	beforeDur := durationCount(t, "grocery")

	RecordSync(Sync{Kind: "grocery", Reason: "client_connect", Result: "success",
		Ran: true, OK: true, Duration: 2 * time.Second, Added: 3, Updated: 1})

	if got := testutil.ToFloat64(syncTotal.WithLabelValues("grocery", "client_connect", "success")) - before; got != 1 {
		t.Errorf("sync_total{client_connect,success} rose by %v, want 1", got)
	}
	if got := testutil.ToFloat64(syncItems.WithLabelValues("added")) - beforeAdded; got != 3 {
		t.Errorf("items_total{added} rose by %v, want 3", got)
	}
	if got := durationCount(t, "grocery") - beforeDur; got != 1 {
		t.Errorf("duration observations rose by %d, want 1", got)
	}
	if testutil.ToFloat64(lastSuccess.WithLabelValues("grocery")) == 0 {
		t.Error("last_success_timestamp_seconds was never set")
	}
}

// A floored, coalesced or skipped attempt is real — someone asked for a sync —
// but no drain ran, so it must not land in the duration histogram or move the
// item counters. Otherwise a reconnect storm would look like a flood of
// instant syncs and drag the latency percentiles to zero.
func TestRecordSyncAttemptsThatNeverRanAddNoDuration(t *testing.T) {
	for _, result := range []string{"floored", "coalesced", "skipped"} {
		before := testutil.ToFloat64(syncTotal.WithLabelValues("grocery", "client_connect", result))
		beforeDur := durationCount(t, "grocery")
		beforeAdded := testutil.ToFloat64(syncItems.WithLabelValues("added"))

		RecordSync(Sync{Kind: "grocery", Reason: "client_connect", Result: result,
			Added: 5, Updated: 5, Deleted: 5})

		if got := testutil.ToFloat64(syncTotal.WithLabelValues("grocery", "client_connect", result)) - before; got != 1 {
			t.Errorf("result=%s: sync_total rose by %v, want 1 — the attempt must still be counted", result, got)
		}
		if got := durationCount(t, "grocery") - beforeDur; got != 0 {
			t.Errorf("result=%s: duration observations rose by %d, want 0", result, got)
		}
		if got := testutil.ToFloat64(syncItems.WithLabelValues("added")) - beforeAdded; got != 0 {
			t.Errorf("result=%s: items_total{added} rose by %v, want 0", result, got)
		}
	}
}

// An error DID run (it just failed), so its duration is real signal — but it
// has no successful item counts and must not advance last_success.
func TestRecordSyncErrorKeepsDurationButNotSuccess(t *testing.T) {
	lastSuccess.WithLabelValues("recipes").Set(0)
	beforeDur := durationCount(t, "recipes")

	RecordSync(Sync{Kind: "recipes", Reason: "startup", Result: "error",
		Ran: true, Duration: 3 * time.Second})

	if got := durationCount(t, "recipes") - beforeDur; got != 1 {
		t.Errorf("duration observations rose by %d, want 1 — a failed sync still consumed that time", got)
	}
	if got := testutil.ToFloat64(lastSuccess.WithLabelValues("recipes")); got != 0 {
		t.Errorf("last_success was set to %v by a FAILED sync", got)
	}
}

func TestHandlerServesTheCollectors(t *testing.T) {
	RecordSync(Sync{Kind: "grocery", Reason: "manual", Result: "success",
		Ran: true, OK: true, Duration: time.Second, Added: 1})
	SSEConnected()
	defer SSEDisconnected()

	rec := httptest.NewRecorder()
	Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	// The names Prometheus will scrape. Renaming one silently breaks every
	// dashboard and alert built on it, so they are pinned here.
	for _, want := range []string{
		"mealplanner_recipekeeper_sync_total",
		"mealplanner_recipekeeper_sync_duration_seconds",
		"mealplanner_recipekeeper_items_total",
		"mealplanner_recipekeeper_last_success_timestamp_seconds",
		"mealplanner_sse_subscribers",
		`reason="manual"`,
		`result="success"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics body is missing %q", want)
		}
	}
}
