package recipekeeper

import "testing"

// TestEpochWatermarkNotDotNetMinValue guards against reverting epochWatermark
// to .NET's DateTime.MinValue ("0001-01-01T00:00:00Z"). The live Recipe
// Keeper API returns HTTP 500 "An unhandled exception occurred" for that
// value (almost certainly a timezone-conversion underflow on their side) —
// verified against the real API, not reproducible with our test doubles,
// which accept any watermark. Only live traffic catches this, so this test
// exists purely to stop the constant being "tidied" back.
func TestEpochWatermarkNotDotNetMinValue(t *testing.T) {
	if epochWatermark == "0001-01-01T00:00:00Z" {
		t.Fatalf("epochWatermark must not be .NET's DateTime.MinValue %q: the live API returns 500 for it", epochWatermark)
	}
	if len(epochWatermark) >= 5 && epochWatermark[:5] == "0001-" {
		t.Fatalf("epochWatermark must not start with %q: the live API 500s on year-0001 watermarks", "0001-")
	}
}
