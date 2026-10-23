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
	// Connected receives a value every time Subscribe adds a subscriber —
	// every one, not just the 0→1 transition. The Recipe Keeper sync service
	// uses it to pull in changes made in the Recipe Keeper app the moment
	// someone opens Meal Planner, and a household has more than one client:
	// while this fired only on 0→1, a second phone opening the app took the
	// count 1→2 and refreshed nothing, so the person who opened it waited out
	// the poll interval staring at a list that was already stale on the
	// server. Redundant signals are cheap — the observer floors how often it
	// acts on them, and TriggerGrocerySync single-flights besides.
	//
	// This is the ONLY coupling point from realtime to anything that cares
	// about subscriber presence (see cmd/server/main.go) — a plain channel,
	// never an import, so realtime stays ignorant of who's listening and
	// must not import recipekeeper. Buffered 1 and sent non-blockingly: a
	// missed send just means the observer notices on its next timer tick
	// instead of instantly, never a stuck goroutine or a blocked Subscribe.
	Connected chan struct{}
}

func NewBroadcaster() *Broadcaster {
	return &Broadcaster{
		subs:      map[*Subscriber]struct{}{},
		Done:      make(chan struct{}),
		Connected: make(chan struct{}, 1),
	}
}

// Count reports the current number of active subscribers.
func (b *Broadcaster) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.subs)
}

func (b *Broadcaster) Subscribe(sub string) *Subscriber {
	s := &Subscriber{Ch: make(chan string, maxQueueSize), sub: sub}
	b.mu.Lock()
	subscribed := false
	if !b.closed {
		subscribed = true
		b.subs[s] = struct{}{}
	}
	b.mu.Unlock()
	if subscribed {
		select {
		case b.Connected <- struct{}{}:
		default:
		}
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
