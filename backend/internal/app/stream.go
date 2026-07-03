package app

import (
	"net/http"
	"time"

	"mealplanner/internal/session"
)

// handleStream is the SSE endpoint (routers/realtime.py): a ready event, then
// queued messages, with a ping comment every 15s and prompt shutdown.
func (a *App) handleStream(w http.ResponseWriter, r *http.Request, user *session.UserInfo) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	sub := a.Broadcaster.Subscribe(user.Sub)
	defer a.Broadcaster.Unsubscribe(sub)

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(200)

	if _, err := w.Write([]byte(`data: {"type":"ready","payload":{}}` + "\n\n")); err != nil {
		return
	}
	flusher.Flush()

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-a.Broadcaster.Done:
			// Deliver anything already queued before ending the stream
			// (the Python generator drains the queue up to the sentinel).
			for {
				select {
				case msg := <-sub.Ch:
					if _, err := w.Write([]byte(msg)); err != nil {
						return
					}
					flusher.Flush()
				default:
					return
				}
			}
		case msg := <-sub.Ch:
			if _, err := w.Write([]byte(msg)); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
