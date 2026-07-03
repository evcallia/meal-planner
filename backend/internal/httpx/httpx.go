// Package httpx holds small helpers shared by all handlers: JSON responses in
// FastAPI's shapes ({"detail": ...} errors), request decoding that tracks which
// fields were present (Python's model_fields_set), and datetime formatting that
// matches Python's isoformat() output byte-for-byte.
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// WriteJSON writes v as JSON with the given status code.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Detail mirrors FastAPI's HTTPException response body.
func Detail(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, map[string]string{"detail": msg})
}

// ValidationError mirrors FastAPI's 422 for request validation failures.
func ValidationError(w http.ResponseWriter, msg string) {
	Detail(w, http.StatusUnprocessableEntity, msg)
}

// HTTPError lets handler helpers abort with a status + detail (like raising
// fastapi.HTTPException).
type HTTPError struct {
	Status int
	Msg    string
}

func (e *HTTPError) Error() string { return fmt.Sprintf("%d: %s", e.Status, e.Msg) }

func NewHTTPError(status int, msg string) *HTTPError { return &HTTPError{Status: status, Msg: msg} }

// WriteError writes an *HTTPError if err is one, else a 500.
func WriteError(w http.ResponseWriter, err error) {
	var he *HTTPError
	if errors.As(err, &he) {
		Detail(w, he.Status, he.Msg)
		return
	}
	Detail(w, http.StatusInternalServerError, "Internal Server Error")
}

// DecodeBody decodes the request body into dst and returns the set of
// top-level JSON keys that were present (Python's model_fields_set).
func DecodeBody(r *http.Request, dst any) (map[string]bool, error) {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&raw); err != nil {
		return nil, err
	}
	present := make(map[string]bool, len(raw))
	buf, _ := json.Marshal(raw)
	if err := json.Unmarshal(buf, dst); err != nil {
		return nil, err
	}
	for k := range raw {
		present[k] = true
	}
	return present, nil
}

// ---- datetime formatting (Python isoformat parity) ----

// FormatDateTime renders a naive-UTC datetime exactly like Python's
// datetime.isoformat(): no timezone suffix, microseconds only when nonzero.
func FormatDateTime(t time.Time) string {
	t = t.UTC()
	s := t.Format("2006-01-02T15:04:05")
	if us := t.Nanosecond() / 1000; us != 0 {
		s += fmt.Sprintf(".%06d", us)
	}
	return s
}

// FormatDateTimePtr is FormatDateTime for nullable columns.
func FormatDateTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := FormatDateTime(*t)
	return &s
}

// FormatDate renders a date column as YYYY-MM-DD.
func FormatDate(t time.Time) string { return t.UTC().Format("2006-01-02") }

// ParseDate parses YYYY-MM-DD into a midnight-UTC time.Time.
func ParseDate(s string) (time.Time, error) {
	return time.Parse("2006-01-02", s)
}

// ParseDateTime accepts the formats clients send: RFC3339 with or without
// fractional seconds / "Z", and naive ISO strings. Result is naive UTC
// (tz-aware inputs are converted, mirroring tracker._naive_utc).
func ParseDateTime(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid datetime: %q", s)
}

// JSONTime is a nullable datetime accepted in request bodies.
type JSONTime struct {
	Time  time.Time
	Valid bool
}

func (jt *JSONTime) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		jt.Valid = false
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	t, err := ParseDateTime(s)
	if err != nil {
		return err
	}
	jt.Time = t
	jt.Valid = true
	return nil
}

// Ptr returns the parsed time or nil.
func (jt *JSONTime) Ptr() *time.Time {
	if !jt.Valid {
		return nil
	}
	t := jt.Time
	return &t
}

// ParseUUID parses a path/body UUID, returning a FastAPI-style 422 error on failure.
func ParseUUID(s string) (uuid.UUID, error) {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil, NewHTTPError(http.StatusUnprocessableEntity, "Input should be a valid UUID")
	}
	return id, nil
}

// SourceID extracts the x-source-id header used to tag SSE events.
func SourceID(r *http.Request) string { return r.Header.Get("x-source-id") }
