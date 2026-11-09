package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
)

// node is the part of a tsnet.Server the sidecar uses. run only talks to this
// interface, so tests drive it with a fake and never start a real tsnet server.
type node interface {
	// Start brings the node up in the background. It does not wait for login.
	Start() error
	// Status is the LocalClient status without the peer list.
	Status(ctx context.Context) (*ipnstate.Status, error)
	// WhoIs is the LocalClient WhoIs.
	WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)
	// ListenTLS announces on the tailnet with a certificate for the node's name.
	// It blocks until the node is running.
	ListenTLS(network, addr string) (net.Listener, error)
	// Close stops the node.
	Close() error
}

// runOptions are the timings and the listen address; tests shorten them.
type runOptions struct {
	listenAddr        string
	previewListenAddr string
	pollInterval      time.Duration
	retryDelay        time.Duration
	shutdownTimeout   time.Duration
	logf              func(format string, args ...any)
}

func defaultRunOptions(stderr io.Writer) runOptions {
	logger := log.New(stderr, "", log.LstdFlags)
	return runOptions{
		listenAddr:        ":443",
		previewListenAddr: ":8443",
		pollInterval:      time.Second,
		retryDelay:        15 * time.Second,
		shutdownTimeout:   10 * time.Second,
		logf:              logger.Printf,
	}
}

// run starts the node and the HTTPS proxy, reports status through rep, and stops
// everything when ctx is done. It returns a non-nil error only when the node could
// not start; a clean shutdown returns nil.
func run(ctx context.Context, cfg config, n node, rep *Reporter, opts runOptions) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Start in the background: it can take a moment and Close must not run
	// concurrently with it.
	startDone := make(chan struct{})
	var startErr error
	go func() {
		defer close(startDone)
		startErr = n.Start()
	}()

	select {
	case <-startDone:
		if startErr != nil {
			rep.Status(errorEvent("could not start the Tailscale node: " + startErr.Error()))
			return startErr
		}
	case <-ctx.Done():
		// Shutdown during Start: wait for it (bounded), then close what it built.
		select {
		case <-startDone:
		case <-time.After(opts.shutdownTimeout):
			rep.Status(Event{Type: typeStopped})
			return nil
		}
		if startErr == nil {
			closeNode(n, opts.shutdownTimeout)
		}
		rep.Status(Event{Type: typeStopped})
		return nil
	}

	handler := newProxy(cfg.Target, n.WhoIs, opts.logf)
	previewHandler := newProxy(previewTarget(cfg.Target), n.WhoIs, opts.logf)

	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		statusLoop(ctx, n, rep, opts.pollInterval)
	}()
	go func() {
		defer wg.Done()
		serveLoop(ctx, n, handler, rep, opts, opts.listenAddr)
	}()
	go func() {
		defer wg.Done()
		serveLoop(ctx, n, previewHandler, rep, opts, opts.previewListenAddr)
	}()

	<-ctx.Done()

	loops := make(chan struct{})
	go func() { wg.Wait(); close(loops) }()
	select {
	case <-loops:
	case <-time.After(opts.shutdownTimeout):
	}
	closeNode(n, opts.shutdownTimeout)
	rep.Status(Event{Type: typeStopped})
	return nil
}

// closeNode closes n, giving up after timeout (Desktop kills the process tree anyway).
func closeNode(n node, timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		_ = n.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

// statusLoop polls the node status and reports every change until ctx is done.
func statusLoop(ctx context.Context, n node, rep *Reporter, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		pollStatus(ctx, n, rep)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func pollStatus(ctx context.Context, n node, rep *Reporter) {
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	st, err := n.Status(callCtx)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		rep.Status(errorEvent("could not read the Tailscale status: " + err.Error()))
		return
	}
	if ev, ok := eventFromStatus(st); ok {
		rep.Status(ev)
	}
}

// serveLoop serves handler over HTTPS on the tailnet until ctx is done. The
// listener cannot exist before the node is running and before the tailnet has
// MagicDNS and HTTPS certificates enabled, so a failure is reported and retried
// instead of ending the process: the user can fix it in the admin console.
func serveLoop(ctx context.Context, n node, handler http.Handler, rep *Reporter, opts runOptions, addr string) {
	for ctx.Err() == nil {
		ln, err := listenCtx(ctx, n, addr)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			rep.Error(addr, fmt.Sprintf("could not serve https on the tailnet %s: %v", addr, err))
			if !sleepCtx(ctx, opts.retryDelay) {
				return
			}
			continue
		}
		rep.Recovered(addr)

		err = serveOn(ctx, ln, handler)
		if ctx.Err() != nil {
			return
		}
		rep.Error(addr, fmt.Sprintf("the https server on %s stopped: %v", addr, err))
		if !sleepCtx(ctx, opts.retryDelay) {
			return
		}
	}
}

// listenCtx calls ListenTLS, which cannot be cancelled and blocks until the node
// is running (so, until the user logs in). On shutdown it returns at once; closing
// the node unblocks the stray call, and a listener it returns late is closed.
func listenCtx(ctx context.Context, n node, addr string) (net.Listener, error) {
	type result struct {
		ln  net.Listener
		err error
	}
	ch := make(chan result, 1)
	go func() {
		ln, err := n.ListenTLS("tcp", addr)
		ch <- result{ln, err}
	}()
	select {
	case res := <-ch:
		return res.ln, res.err
	case <-ctx.Done():
		go func() {
			if res := <-ch; res.ln != nil {
				_ = res.ln.Close()
			}
		}()
		return nil, ctx.Err()
	}
}

// serveOn serves handler on ln until ctx is done or the listener fails.
func serveOn(ctx context.Context, ln net.Listener, handler http.Handler) error {
	connections := &upgradedConnections{active: make(map[*upgradedConnection]struct{})}
	defer connections.close()
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			handler.ServeHTTP(&upgradeWriter{ResponseWriter: w, connections: connections}, r)
		}),
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          log.New(io.Discard, "", 0),
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	serveEnded := make(chan struct{})
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		select {
		case <-ctx.Done():
			// HTTP shutdown does not own hijacked connections; close those explicitly.
			connections.close()
			graceCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if err := srv.Shutdown(graceCtx); err != nil {
				_ = srv.Close()
			}
		case <-serveEnded:
		}
	}()
	err := srv.Serve(ln)
	close(serveEnded)
	<-shutdownDone
	_ = srv.Close()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// sleepCtx waits for d or for ctx to end. It reports whether the full time passed.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
