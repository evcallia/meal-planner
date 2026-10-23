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

// responseHeaderTimeout bounds how long the client waits for response
// headers on any request over this transport (/token, /api/sync). It used
// to be pinned to a since-removed long-poll's own timeout budget plus a
// margin (see docs/recipe-keeper-api.md for the removed doorbell's
// protocol) — that requirement is gone, but the same headroom is still the
// right call: this must stay comfortably above any single request this
// transport is allowed to run long (a cold Recipe pull's individual pages
// included), not just an arbitrary short value.
const responseHeaderTimeout = 100 * time.Second

// NewTransport builds a dedicated *http.Transport for the Recipe Keeper API.
// It is cloned from http.DefaultTransport (keeping proxy support, HTTP/2,
// and sensible dial/TLS handshake timeouts) rather than built from scratch.
//
// Dedicated transport: with polling as frequent as every 30s-60s, a pooled
// connection can be closed by the server while idle. Go only retries
// idempotent/bodyless requests on a stale connection, and POST /token has a
// body — so it hangs "awaiting headers" until the client timeout. A short
// IdleConnTimeout discards the connection before it can go stale. Verified
// live.
func NewTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.IdleConnTimeout = idleConnTimeout
	t.ResponseHeaderTimeout = responseHeaderTimeout
	return t
}
