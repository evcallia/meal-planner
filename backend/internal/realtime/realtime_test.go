package realtime

// Port of backend/tests/test_realtime.py (broadcaster unit tests).
//
// Semantic mapping from the Python asyncio implementation:
//   - queue.get() returning None (sentinel)  ->  the Done channel being closed
//     (Go signals shutdown out-of-band instead of enqueueing a sentinel).
//   - EventBroadcaster(max_queue_size=N)     ->  fixed maxQueueSize (100);
//     the queue-full test fills the real buffer instead.
//
// Skipped:
//   - test_publish_removes_dead_queues / test_publish_handles_put_exception:
//     asyncio-queue failure injection; Go channel sends cannot fail, so there
//     is no dead-queue removal path to test.
//   - test_shutdown_event_exists: folded into the close tests (Done channel).

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeFrame(t *testing.T, msg string) map[string]any {
	t.Helper()
	if !strings.HasPrefix(msg, "data: ") {
		t.Fatalf("frame %q missing data: prefix", msg)
	}
	if !strings.HasSuffix(msg, "\n\n") {
		t.Fatalf("frame %q missing trailing blank line", msg)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(strings.TrimSpace(msg[len("data: "):])), &v); err != nil {
		t.Fatalf("frame %q is not valid JSON: %v", msg, err)
	}
	return v
}

func recv(t *testing.T, s *Subscriber) string {
	t.Helper()
	select {
	case msg := <-s.Ch:
		return msg
	default:
		t.Fatal("no message queued")
		return ""
	}
}

func isDone(b *Broadcaster) bool {
	select {
	case <-b.Done:
		return true
	default:
		return false
	}
}

// test_publish_enqueues_message
func TestPublishEnqueuesMessage(t *testing.T) {
	b := NewBroadcaster()
	s := b.Subscribe("")

	b.Publish(map[string]any{"type": "test", "payload": map[string]any{"value": 1}})

	payload := decodeFrame(t, recv(t, s))
	if payload["type"] != "test" {
		t.Fatalf("type = %v", payload["type"])
	}
	inner, _ := payload["payload"].(map[string]any)
	if inner["value"] != float64(1) {
		t.Fatalf("payload = %v", payload["payload"])
	}

	b.Unsubscribe(s)
}

// test_format_sse
func TestFormatSSE(t *testing.T) {
	result := formatSSE(map[string]any{"type": "test", "payload": map[string]any{"value": 123}})
	// Compact JSON (Go marshals maps with sorted keys, no separators padding).
	want := `data: {"payload":{"value":123},"type":"test"}` + "\n\n"
	if result != want {
		t.Fatalf("formatSSE = %q, want %q", result, want)
	}
	payload := decodeFrame(t, result)
	if payload["type"] != "test" {
		t.Fatalf("type = %v", payload["type"])
	}
}

// test_publish_to_multiple_subscribers
func TestPublishToMultipleSubscribers(t *testing.T) {
	b := NewBroadcaster()
	s1 := b.Subscribe("")
	s2 := b.Subscribe("")

	b.Publish(map[string]any{"type": "test", "payload": map[string]any{}})

	msg1 := recv(t, s1)
	msg2 := recv(t, s2)
	if msg1 == "" || msg2 == "" || msg1 != msg2 {
		t.Fatalf("msg1 = %q, msg2 = %q; want identical non-empty frames", msg1, msg2)
	}

	b.Unsubscribe(s1)
	b.Unsubscribe(s2)
}

// PublishToUser filtering (per-user SSE; the Go counterpart of
// publish_to_user in realtime.py).
func TestPublishToUserFiltering(t *testing.T) {
	b := NewBroadcaster()
	alice := b.Subscribe("alice")
	bob := b.Subscribe("bob")

	b.PublishToUser("alice", map[string]any{"type": "settings.updated", "payload": map[string]any{}})

	if len(alice.Ch) != 1 {
		t.Fatalf("alice queued = %d, want 1", len(alice.Ch))
	}
	if len(bob.Ch) != 0 {
		t.Fatalf("bob queued = %d, want 0", len(bob.Ch))
	}
	payload := decodeFrame(t, recv(t, alice))
	if payload["type"] != "settings.updated" {
		t.Fatalf("type = %v", payload["type"])
	}
}

// test_unsubscribe_removes_queue
func TestUnsubscribeRemovesQueue(t *testing.T) {
	b := NewBroadcaster()
	s := b.Subscribe("")

	b.mu.Lock()
	_, present := b.subs[s]
	b.mu.Unlock()
	if !present {
		t.Fatal("subscriber not registered after Subscribe")
	}

	b.Unsubscribe(s)

	b.mu.Lock()
	_, present = b.subs[s]
	b.mu.Unlock()
	if present {
		t.Fatal("subscriber still registered after Unsubscribe")
	}
}

// test_publish_handles_queue_full: filling the buffer drops the oldest message.
func TestPublishHandlesQueueFull(t *testing.T) {
	b := NewBroadcaster()
	s := b.Subscribe("")

	// Fill the buffer (msg-0 .. msg-99), then publish one more.
	for i := 0; i <= maxQueueSize; i++ {
		b.Publish(map[string]any{"type": "msg", "payload": map[string]any{"i": i}})
	}

	if len(s.Ch) != maxQueueSize {
		t.Fatalf("queued = %d, want %d", len(s.Ch), maxQueueSize)
	}
	// msg-0 was dropped; the first message received is msg-1, and the newest
	// (msg-100) is still delivered last.
	first := decodeFrame(t, recv(t, s))
	if got := first["payload"].(map[string]any)["i"]; got != float64(1) {
		t.Fatalf("first message i = %v, want 1 (oldest dropped)", got)
	}
	var last map[string]any
	for len(s.Ch) > 0 {
		last = decodeFrame(t, recv(t, s))
	}
	if got := last["payload"].(map[string]any)["i"]; got != float64(maxQueueSize) {
		t.Fatalf("last message i = %v, want %d", got, maxQueueSize)
	}
}

// test_publish_after_close_does_nothing
func TestPublishAfterCloseDoesNothing(t *testing.T) {
	b := NewBroadcaster()
	s := b.Subscribe("")

	b.Close()
	b.Publish(map[string]any{"type": "test", "payload": map[string]any{}})

	if len(s.Ch) != 0 {
		t.Fatalf("queued = %d after close, want 0", len(s.Ch))
	}
	if !isDone(b) {
		t.Fatal("Done not closed after Close")
	}
}

// test_close_idempotent
func TestCloseIdempotent(t *testing.T) {
	b := NewBroadcaster()
	b.Subscribe("")

	b.Close()
	b.Close() // must not panic (double-close of Done)

	if !isDone(b) {
		t.Fatal("Done not closed")
	}
}

// test_close_inserts_sentinel_even_when_queue_full: shutdown reaches
// subscribers whose buffers are full (Done is out-of-band, never blocked).
func TestCloseSignalsDoneEvenWhenQueueFull(t *testing.T) {
	b := NewBroadcaster()
	s := b.Subscribe("")
	for i := 0; i < maxQueueSize; i++ {
		s.Ch <- "data: {\"type\":\"stale\"}\n\n"
	}

	b.Close()

	if !isDone(b) {
		t.Fatal("Done not closed while subscriber queue full")
	}
}

// test_subscribe_after_close_returns_sentinel /
// test_subscribe_after_close_exception_handling: subscribing after close
// yields a usable subscriber that immediately observes shutdown and never
// receives messages.
func TestSubscribeAfterClose(t *testing.T) {
	b := NewBroadcaster()
	b.Close()

	s := b.Subscribe("")
	if s == nil || s.Ch == nil {
		t.Fatal("Subscribe after close returned unusable subscriber")
	}
	if !isDone(b) {
		t.Fatal("Done not closed (the sentinel equivalent)")
	}
	b.Publish(map[string]any{"type": "test", "payload": map[string]any{}})
	if len(s.Ch) != 0 {
		t.Fatalf("queued = %d, want 0 (closed broadcaster must not deliver)", len(s.Ch))
	}
}

// test_broadcast_event_helper
func TestBroadcastEventHelper(t *testing.T) {
	b := NewBroadcaster()
	s := b.Subscribe("")

	b.BroadcastEvent("test.event", map[string]any{"data": "value"}, "")

	msg := decodeFrame(t, recv(t, s))
	if msg["type"] != "test.event" {
		t.Fatalf("type = %v", msg["type"])
	}
	inner, _ := msg["payload"].(map[string]any)
	if inner["data"] != "value" {
		t.Fatalf("payload = %v", msg["payload"])
	}
	if _, ok := msg["source_id"]; ok {
		t.Fatalf("source_id present without source: %v", msg)
	}

	// With a source id, the field is included.
	b.BroadcastEvent("test.event", map[string]any{}, "tab-1")
	msg = decodeFrame(t, recv(t, s))
	if msg["source_id"] != "tab-1" {
		t.Fatalf("source_id = %v, want tab-1", msg["source_id"])
	}

	// BroadcastToUser assembles the same envelope, filtered by sub.
	tagged := b.Subscribe("user-a")
	b.BroadcastToUser("user-a", "settings.updated", map[string]any{"k": "v"}, "src")
	if len(s.Ch) != 0 {
		t.Fatal("untagged subscriber received user-scoped event")
	}
	msg = decodeFrame(t, recv(t, tagged))
	if msg["type"] != "settings.updated" || msg["source_id"] != "src" {
		t.Fatalf("user event = %v", msg)
	}
}
