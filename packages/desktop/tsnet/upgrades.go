package main

import (
	"bufio"
	"net"
	"net/http"
	"sync"
)

// upgradedConnections owns connections that http.Server no longer tracks after
// hijacking. A naturally closed upgrade removes itself rather than accumulating
// until the sidecar shuts down.
type upgradedConnections struct {
	mu     sync.Mutex
	active map[*upgradedConnection]struct{}
	closed bool
}

func (c *upgradedConnections) track(conn net.Conn) net.Conn {
	tracked := &upgradedConnection{Conn: conn, owner: c}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		_ = tracked.Close()
		return tracked
	}
	c.active[tracked] = struct{}{}
	c.mu.Unlock()
	return tracked
}

func (c *upgradedConnections) close() {
	c.mu.Lock()
	c.closed = true
	active := c.active
	c.active = nil
	c.mu.Unlock()
	for conn := range active {
		_ = conn.Close()
	}
}

type upgradedConnection struct {
	net.Conn
	owner *upgradedConnections
	once  sync.Once
	err   error
}

func (c *upgradedConnection) Close() error {
	c.once.Do(func() {
		c.err = c.Conn.Close()
		c.owner.mu.Lock()
		delete(c.owner.active, c)
		c.owner.mu.Unlock()
	})
	return c.err
}

type upgradeWriter struct {
	http.ResponseWriter
	connections *upgradedConnections
}

// Unwrap preserves ResponseController's flushing and deadline support.
func (w *upgradeWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *upgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	return w.connections.track(conn), rw, nil
}
