package app

// SSE endpoint tests for GET /api/stream (routers/realtime.py counterpart).
// The Python suite only unit-tested the broadcaster (see
// internal/realtime/realtime_test.go); these exercise the HTTP endpoint over
// a real server since SSE needs true streaming.

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStreamRequiresAuth(t *testing.T) {
	ta := newTestApp(t)
	resp := ta.Anon("GET", "/api/stream", nil)
	if resp.Status != 401 {
		t.Fatalf("status = %d, want 401: %s", resp.Status, resp.Body)
	}
}

// sseClient reads "data: ..." frames from a live stream in a goroutine so the
// test can time out instead of hanging.
type sseClient struct {
	resp   *http.Response
	frames chan map[string]any
	closed chan struct{}
}

func openStream(t *testing.T, srv *httptest.Server, cookie *http.Cookie) *sseClient {
	t.Helper()
	req, err := http.NewRequest("GET", srv.URL+"/api/stream", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.AddCookie(cookie)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("connect stream: %v", err)
	}
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("status = %d, want 200: %s", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}

	c := &sseClient{resp: resp, frames: make(chan map[string]any, 16), closed: make(chan struct{})}
	go func() {
		defer close(c.closed)
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue // ping comments, blank separators
			}
			var v map[string]any
			if json.Unmarshal([]byte(line[len("data: "):]), &v) == nil {
				c.frames <- v
			}
		}
	}()
	return c
}

// close must run before httptest.Server.Close — Close blocks until all
// outstanding requests finish, and an SSE stream only finishes once the
// client hangs up. Defer AFTER the server-close defer (LIFO).
func (c *sseClient) close() {
	c.resp.Body.Close()
	select {
	case <-c.closed:
	case <-time.After(5 * time.Second):
	}
}

func (c *sseClient) next(t *testing.T) map[string]any {
	t.Helper()
	select {
	case f := <-c.frames:
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for SSE frame")
		return nil
	}
}

func TestStreamReadyAndDeliversEvents(t *testing.T) {
	ta := newTestApp(t)
	srv := httptest.NewServer(ta.App.Handler())
	defer srv.Close()

	c := openStream(t, srv, ta.Cookie)
	defer c.close()

	// First frame is the ready event.
	ready := c.next(t)
	if ready["type"] != "ready" {
		t.Fatalf("first frame = %v, want type ready", ready)
	}

	// A global broadcast reaches the connected client.
	ta.App.Broadcaster.BroadcastEvent("grocery.updated", map[string]any{"action": "item-added"}, "src-1")
	frame := c.next(t)
	if frame["type"] != "grocery.updated" {
		t.Fatalf("frame = %v, want type grocery.updated", frame)
	}
	payload, _ := frame["payload"].(map[string]any)
	if payload["action"] != "item-added" {
		t.Fatalf("payload = %v", frame["payload"])
	}
	if frame["source_id"] != "src-1" {
		t.Fatalf("source_id = %v, want src-1", frame["source_id"])
	}
}

// Per-user events only reach streams whose session matches the target sub.
func TestStreamPerUserFiltering(t *testing.T) {
	ta := newTestApp(t)
	srv := httptest.NewServer(ta.App.Handler())
	defer srv.Close()

	mine := openStream(t, srv, ta.Cookie)
	defer mine.close()
	other := openStream(t, srv, ta.LoginAs("other-user", "other@example.com", "Other"))
	defer other.close()
	if f := mine.next(t); f["type"] != "ready" {
		t.Fatalf("ready frame = %v", f)
	}
	if f := other.next(t); f["type"] != "ready" {
		t.Fatalf("ready frame = %v", f)
	}

	ta.App.Broadcaster.BroadcastToUser(TestSub, "settings.updated", map[string]any{"k": "v"}, "")

	frame := mine.next(t)
	if frame["type"] != "settings.updated" {
		t.Fatalf("frame = %v, want settings.updated", frame)
	}
	// The other user's stream stays quiet.
	select {
	case f := <-other.frames:
		t.Fatalf("other user received %v", f)
	case <-time.After(200 * time.Millisecond):
	}
}

// Broadcaster.Close() (app shutdown) ends open streams promptly.
func TestStreamEndsOnBroadcasterClose(t *testing.T) {
	ta := newTestApp(t)
	srv := httptest.NewServer(ta.App.Handler())
	defer srv.Close()

	c := openStream(t, srv, ta.Cookie)
	defer c.close()
	if f := c.next(t); f["type"] != "ready" {
		t.Fatalf("ready frame = %v", f)
	}

	ta.App.Broadcaster.Close()

	select {
	case <-c.closed:
		// Stream ended (reader goroutine saw EOF).
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not end after broadcaster close")
	}
}
