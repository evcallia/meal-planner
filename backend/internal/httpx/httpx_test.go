package httpx

// Contract tests for the helpers every handler relies on, locking in
// Python-parity details: datetime serialization matches datetime.isoformat()
// byte-for-byte (no "Z", microseconds only when nonzero), FastAPI-style error
// bodies, and DecodeBody's model_fields_set behavior.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFormatDateTimeNoZoneSuffix(t *testing.T) {
	ts := time.Date(2025, 6, 15, 12, 30, 45, 0, time.UTC)
	got := FormatDateTime(ts)
	want := "2025-06-15T12:30:45"
	if got != want {
		t.Fatalf("FormatDateTime = %q, want %q", got, want)
	}
	if strings.ContainsAny(got, "Z+") {
		t.Fatalf("datetime must be naive (no tz suffix): %q", got)
	}
}

func TestFormatDateTimeMicrosecondsOnlyWhenNonzero(t *testing.T) {
	// Nonzero microseconds: always 6 digits, like Python isoformat().
	ts := time.Date(2025, 6, 15, 12, 30, 45, 123456000, time.UTC)
	if got := FormatDateTime(ts); got != "2025-06-15T12:30:45.123456" {
		t.Fatalf("FormatDateTime = %q, want 2025-06-15T12:30:45.123456", got)
	}
	// Small values are zero-padded to 6 digits.
	ts = time.Date(2025, 6, 15, 12, 30, 45, 7000, time.UTC) // 7 microseconds
	if got := FormatDateTime(ts); got != "2025-06-15T12:30:45.000007" {
		t.Fatalf("FormatDateTime = %q, want 2025-06-15T12:30:45.000007", got)
	}
	// Zero microseconds: no fractional part at all.
	ts = time.Date(2025, 6, 15, 0, 0, 0, 0, time.UTC)
	if got := FormatDateTime(ts); strings.Contains(got, ".") {
		t.Fatalf("zero microseconds must omit fraction: %q", got)
	}
}

func TestFormatDateTimeConvertsToUTC(t *testing.T) {
	loc := time.FixedZone("EST", -5*3600)
	ts := time.Date(2025, 1, 1, 7, 0, 0, 0, loc) // 12:00 UTC
	if got := FormatDateTime(ts); got != "2025-01-01T12:00:00" {
		t.Fatalf("FormatDateTime = %q, want 2025-01-01T12:00:00", got)
	}
}

func TestFormatDateTimePtr(t *testing.T) {
	if got := FormatDateTimePtr(nil); got != nil {
		t.Fatalf("FormatDateTimePtr(nil) = %v, want nil", got)
	}
	ts := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)
	got := FormatDateTimePtr(&ts)
	if got == nil || *got != "2025-06-15T12:00:00" {
		t.Fatalf("FormatDateTimePtr = %v, want 2025-06-15T12:00:00", got)
	}
}

func TestFormatDate(t *testing.T) {
	ts := time.Date(2025, 3, 7, 23, 59, 0, 0, time.UTC)
	if got := FormatDate(ts); got != "2025-03-07" {
		t.Fatalf("FormatDate = %q, want 2025-03-07", got)
	}
}

func TestParseDate(t *testing.T) {
	d, err := ParseDate("2025-06-15")
	if err != nil {
		t.Fatalf("ParseDate: %v", err)
	}
	if d.Year() != 2025 || d.Month() != 6 || d.Day() != 15 {
		t.Fatalf("ParseDate = %v", d)
	}
	if _, err := ParseDate("not-a-date"); err == nil {
		t.Fatal("expected error for invalid date")
	}
}

func TestParseDateTimeAcceptedFormats(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"2025-06-15T12:30:45Z", "2025-06-15T12:30:45"},
		{"2025-06-15T12:30:45.123456Z", "2025-06-15T12:30:45.123456"},
		{"2025-06-15T07:30:45-05:00", "2025-06-15T12:30:45"}, // tz-aware → naive UTC
		{"2025-06-15T12:30:45", "2025-06-15T12:30:45"},
		{"2025-06-15T12:30:45.5", "2025-06-15T12:30:45.500000"},
		{"2025-06-15 12:30:45", "2025-06-15T12:30:45"},
		{"2025-06-15", "2025-06-15T00:00:00"},
	}
	for _, c := range cases {
		got, err := ParseDateTime(c.in)
		if err != nil {
			t.Fatalf("ParseDateTime(%q): %v", c.in, err)
		}
		if FormatDateTime(got) != c.want {
			t.Fatalf("ParseDateTime(%q) = %q, want %q", c.in, FormatDateTime(got), c.want)
		}
	}
	if _, err := ParseDateTime("yesterday"); err == nil {
		t.Fatal("expected error for garbage datetime")
	}
}

func TestJSONTimeNullAndValue(t *testing.T) {
	var jt JSONTime
	if err := jt.UnmarshalJSON([]byte("null")); err != nil {
		t.Fatalf("null: %v", err)
	}
	if jt.Valid || jt.Ptr() != nil {
		t.Fatal("null must produce invalid JSONTime with nil Ptr")
	}
	if err := jt.UnmarshalJSON([]byte(`"2025-06-15T12:00:00Z"`)); err != nil {
		t.Fatalf("value: %v", err)
	}
	if !jt.Valid || jt.Ptr() == nil {
		t.Fatal("valid datetime must set Valid")
	}
	if err := jt.UnmarshalJSON([]byte(`"garbage"`)); err == nil {
		t.Fatal("expected error for invalid datetime string")
	}
	if err := jt.UnmarshalJSON([]byte(`123`)); err == nil {
		t.Fatal("expected error for non-string JSON")
	}
}

func TestParseUUIDReturns422Error(t *testing.T) {
	if _, err := ParseUUID("123e4567-e89b-12d3-a456-426614174000"); err != nil {
		t.Fatalf("valid uuid rejected: %v", err)
	}
	_, err := ParseUUID("not-a-uuid")
	he, ok := err.(*HTTPError)
	if !ok {
		t.Fatalf("expected *HTTPError, got %T", err)
	}
	if he.Status != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", he.Status)
	}
}

func TestDetailShape(t *testing.T) {
	rec := httptest.NewRecorder()
	Detail(rec, 404, "Not Found")
	if rec.Code != 404 {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q", ct)
	}
	if body := strings.TrimSpace(rec.Body.String()); body != `{"detail":"Not Found"}` {
		t.Fatalf("body = %q", body)
	}
}

func TestWriteErrorHTTPErrorAndFallback(t *testing.T) {
	rec := httptest.NewRecorder()
	WriteError(rec, NewHTTPError(403, "No access"))
	if rec.Code != 403 || !strings.Contains(rec.Body.String(), "No access") {
		t.Fatalf("status = %d body = %q", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	WriteError(rec, http.ErrBodyNotAllowed) // arbitrary non-HTTPError
	if rec.Code != 500 || !strings.Contains(rec.Body.String(), "Internal Server Error") {
		t.Fatalf("status = %d body = %q", rec.Code, rec.Body.String())
	}
}

func TestDecodeBodyTracksPresentFields(t *testing.T) {
	var dst struct {
		Name     *string `json:"name"`
		Quantity *string `json:"quantity"`
	}
	req := httptest.NewRequest("POST", "/", strings.NewReader(`{"name":"Milk","quantity":null}`))
	present, err := DecodeBody(req, &dst)
	if err != nil {
		t.Fatalf("DecodeBody: %v", err)
	}
	// quantity was present-but-null: present set includes it, pointer stays nil.
	if !present["name"] || !present["quantity"] {
		t.Fatalf("present = %v, want name and quantity", present)
	}
	if present["other"] {
		t.Fatal("absent field must not be present")
	}
	if dst.Name == nil || *dst.Name != "Milk" || dst.Quantity != nil {
		t.Fatalf("decoded = %+v", dst)
	}

	req = httptest.NewRequest("POST", "/", strings.NewReader(`not json`))
	if _, err := DecodeBody(req, &dst); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestSourceIDHeader(t *testing.T) {
	req := httptest.NewRequest("POST", "/", nil)
	if SourceID(req) != "" {
		t.Fatal("missing header must yield empty source id")
	}
	req.Header.Set("x-source-id", "tab-42")
	if SourceID(req) != "tab-42" {
		t.Fatalf("SourceID = %q", SourceID(req))
	}
}
