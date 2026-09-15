// backend/internal/recipekeeper/transport.go
package recipekeeper

import (
	"net/http"
	"time"
)

// idleConnTimeout is kept comfortably below the ~60s poll interval so a
// pooled connection is discarded before Azure can close it out from under
// us. See NewTransport. A var, not a const, so tests can shrink it rather
// than sleeping 30s to exercise eviction.
var idleConnTimeout = 30 * time.Second

// NewTransport builds a dedicated *http.Transport for the Recipe Keeper API.
// It is cloned from http.DefaultTransport (keeping proxy support, HTTP/2,
// and sensible dial/TLS handshake timeouts) rather than built from scratch.
//
// Dedicated transport: with a 60s poll interval, a pooled connection can be
// closed by the server while idle. Go only retries idempotent/bodyless
// requests on a stale connection, and POST /token has a body — so it hangs
// "awaiting headers" until the client timeout. A short IdleConnTimeout
// discards the connection before it can go stale. Verified live.
//
// ResponseHeaderTimeout is set above notifyTimeout (itself already required
// to exceed the /api/syncnotification long-poll's ~60s hold) because this
// same transport backs the Notify long-poll — a shorter value here would cut
// the doorbell off mid-hold. It still guards /token and /api/sync against a
// connection that dialed fine but then never answers.
func NewTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.IdleConnTimeout = idleConnTimeout
	t.ResponseHeaderTimeout = notifyTimeout + 10*time.Second
	return t
}
