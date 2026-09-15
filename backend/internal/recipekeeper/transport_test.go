// backend/internal/recipekeeper/transport_test.go
package recipekeeper

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// blackholeConn simulates Azure silently abandoning a pooled connection: the
// first request/response on it succeeds normally (so the connection is
// returned to the client's idle pool as reusable), but any further request
// sent on that SAME connection gets no response and no close — exactly the
// "visible in /proc/net/tcp, nothing ever answers" state from the live
// incident, which a plain closed-connection (EOF/RST) test can't reproduce
// because Go already recovers gracefully from an explicit close.
func blackholeConn(conn net.Conn, stop <-chan struct{}) {
	br := bufio.NewReader(conn)
	first := true
	for {
		req, err := http.ReadRequest(br)
		if err != nil {
			conn.Close()
			return
		}
		io.Copy(io.Discard, req.Body)
		req.Body.Close()
		if !first {
			<-stop // never respond, never close — a true black hole
			conn.Close()
			return
		}
		first = false
		io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n")
	}
}

// alwaysRespondConn answers every request normally; it stands in for a fresh
// connection dialed after the stale one was discarded.
func alwaysRespondConn(conn net.Conn) {
	br := bufio.NewReader(conn)
	for {
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		io.Copy(io.Discard, req.Body)
		req.Body.Close()
		io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n")
	}
}

// TestTransportSurvivesSilentlyDeadPooledConnection regresses the sync-
// wedging production bug directly: with the pooled connection from the
// first request gone silent (no FIN/RST, just nothing back — what Azure
// does after an idle gap), a second, body-carrying request must not reuse
// it and hang. It must age out of the pool via IdleConnTimeout and dial
// fresh instead. The short client timeout means a regression (no
// IdleConnTimeout, request wedges on the dead connection) fails this test
// fast rather than stalling the suite — and reproduces the exact "context
// deadline exceeded ... awaiting headers" error from the incident.
func TestTransportSurvivesSilentlyDeadPooledConnection(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })

	var connCount int32
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			if atomic.AddInt32(&connCount, 1) == 1 {
				go blackholeConn(conn, stop)
			} else {
				go alwaysRespondConn(conn)
			}
		}
	}()

	// Production uses a 30s IdleConnTimeout against a 60s poll interval;
	// shrink the package var here purely so the test doesn't need to sleep
	// 30s — this still exercises NewTransport's own wiring (unlike setting
	// the field on its return value would), so removing the IdleConnTimeout
	// line from NewTransport fails this test, not just the value-check one.
	origIdle := idleConnTimeout
	idleConnTimeout = 20 * time.Millisecond
	t.Cleanup(func() { idleConnTimeout = origIdle })

	client := &http.Client{Transport: NewTransport(), Timeout: 500 * time.Millisecond}

	url := "http://" + ln.Addr().String() + "/"
	post := func() error {
		req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, url, bytes.NewReader([]byte(`{"a":1}`)))
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		return nil
	}

	if err := post(); err != nil {
		t.Fatalf("first request: %v", err)
	}

	// Give the transport's IdleConnTimeout time to age out the now-silent
	// pooled connection before the second request is issued.
	time.Sleep(100 * time.Millisecond)

	if err := post(); err != nil {
		t.Fatalf("second request (pooled connection went silent): %v", err)
	}
	if connCount != 2 {
		t.Fatalf("connCount = %d, want 2 (second request must dial a fresh connection, not reuse the dead one)", connCount)
	}
}

// TestNewTransportIsDedicatedWithShortIdleConnTimeout guards the actual fix:
// the Recipe Keeper clients must not share http.DefaultTransport (which is
// also used elsewhere in the process, e.g. for long-polling), and must
// discard idle pooled connections comfortably before the 60s poll interval
// could let the server close one out from under us.
func TestNewTransportIsDedicatedWithShortIdleConnTimeout(t *testing.T) {
	tr := NewTransport()
	if dt, ok := http.DefaultTransport.(*http.Transport); ok && tr == dt {
		t.Fatal("NewTransport must not return the shared http.DefaultTransport instance")
	}
	if tr.IdleConnTimeout <= 0 || tr.IdleConnTimeout > 30*time.Second {
		t.Fatalf("IdleConnTimeout = %v, want (0, 30s]", tr.IdleConnTimeout)
	}
	// The same transport backs the /api/syncnotification long-poll (see
	// NewClient), so ResponseHeaderTimeout must never be shorter than the
	// poll's own timeout budget or it would cut the ~60s hold short.
	if tr.ResponseHeaderTimeout != 0 && tr.ResponseHeaderTimeout <= notifyTimeout {
		t.Fatalf("ResponseHeaderTimeout = %v must exceed notifyTimeout %v, or the long-poll would be cut short",
			tr.ResponseHeaderTimeout, notifyTimeout)
	}
}

// TestNewClientUsesDedicatedTransportByDefault covers the NewClient(...,
// nil) path so callers who don't explicitly wire a shared transport (e.g.
// existing tests) still get the fix rather than silently falling back to
// http.DefaultTransport.
func TestNewClientUsesDedicatedTransportByDefault(t *testing.T) {
	c := NewClient("https://example.invalid", &Authenticator{}, Headers{}, nil)
	tr, ok := c.HTTP.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Client.HTTP.Transport = %T, want *http.Transport", c.HTTP.Transport)
	}
	if dt, ok := http.DefaultTransport.(*http.Transport); ok && tr == dt {
		t.Fatal("NewClient must not fall back to the shared http.DefaultTransport")
	}
	if tr.IdleConnTimeout <= 0 || tr.IdleConnTimeout > 30*time.Second {
		t.Fatalf("IdleConnTimeout = %v, want (0, 30s]", tr.IdleConnTimeout)
	}
}

// TestNewClientSharesProvidedTransport covers the main.go wiring: passing
// the same *http.Transport used for the Authenticator's client must be
// honored as-is, not replaced.
func TestNewClientSharesProvidedTransport(t *testing.T) {
	shared := NewTransport()
	c := NewClient("https://example.invalid", &Authenticator{}, Headers{}, shared)
	if c.HTTP.Transport.(*http.Transport) != shared {
		t.Fatal("NewClient must use the provided transport instance, not build a new one")
	}
}
