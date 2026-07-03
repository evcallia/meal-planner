// Package realtime mirrors backend/app/realtime.py: an SSE broadcaster with
// per-subscriber queues optionally tagged with a user's OIDC sub.
package realtime

import (
	"encoding/json"
	"sync"
)

// formatSSE renders a payload as an SSE data frame (compact JSON).
func formatSSE(payload any) string {
	b, _ := json.Marshal(payload)
	return "data: " + string(b) + "\n\n"
}

const maxQueueSize = 100

type Subscriber struct {
	Ch  chan string
	sub string
}

type Broadcaster struct {
	mu     sync.Mutex
	subs   map[*Subscriber]struct{}
	closed bool
	// Done is closed on shutdown so SSE handlers can unblock promptly.
	Done chan struct{}
}

func NewBroadcaster() *Broadcaster {
	return &Broadcaster{subs: map[*Subscriber]struct{}{}, Done: make(chan struct{})}
}

func (b *Broadcaster) Subscribe(sub string) *Subscriber {
	s := &Subscriber{Ch: make(chan string, maxQueueSize), sub: sub}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.closed {
		b.subs[s] = struct{}{}
	}
	return s
}

func (b *Broadcaster) Unsubscribe(s *Subscriber) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.subs, s)
}

// send drops the oldest queued message when the buffer is full (matching the
// Python QueueFull handling) so slow clients never block publishers.
func send(s *Subscriber, msg string) {
	select {
	case s.Ch <- msg:
	default:
		select {
		case <-s.Ch:
		default:
		}
		select {
		case s.Ch <- msg:
		default:
		}
	}
}

func (b *Broadcaster) publish(msg string, filter func(*Subscriber) bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	for s := range b.subs {
		if filter == nil || filter(s) {
			send(s, msg)
		}
	}
}

// Publish broadcasts to ALL subscribers (shared data: grocery/pantry/calendar).
func (b *Broadcaster) Publish(payload any) {
	b.publish(formatSSE(payload), nil)
}

// PublishToUser broadcasts only to subscribers tagged with sub.
func (b *Broadcaster) PublishToUser(sub string, payload any) {
	b.publish(formatSSE(payload), func(s *Subscriber) bool { return s.sub == sub })
}

// Close signals shutdown to all subscribers.
func (b *Broadcaster) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	close(b.Done)
}

// event assembles the standard {type, payload, source_id?} message.
func event(eventType string, payload any, sourceID string) map[string]any {
	msg := map[string]any{"type": eventType, "payload": payload}
	if sourceID != "" {
		msg["source_id"] = sourceID
	}
	return msg
}

// BroadcastEvent mirrors realtime.broadcast_event.
func (b *Broadcaster) BroadcastEvent(eventType string, payload any, sourceID string) {
	b.Publish(event(eventType, payload, sourceID))
}

// BroadcastToUser mirrors realtime.broadcast_to_user.
func (b *Broadcaster) BroadcastToUser(sub, eventType string, payload any, sourceID string) {
	b.PublishToUser(sub, event(eventType, payload, sourceID))
}
