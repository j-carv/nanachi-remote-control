package main

// These tests drive run with a fake node. No tsnet.Server is ever created or
// started here: that would register a device in a real tailnet.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
)

// syncBuffer is a bytes.Buffer that run goroutines and the test can share.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) Lines() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return lines(&b.buf)
}

// types is the sequence of event types written so far.
func (b *syncBuffer) types(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, line := range b.Lines() {
		var ev struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("line %q is not JSON: %v", line, err)
		}
		out = append(out, ev.Type)
	}
	return out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func waitForTypes(t *testing.T, out *syncBuffer, want ...string) {
	t.Helper()
	waitFor(t, "events "+strings.Join(want, ","), func() bool {
		return strings.Join(out.types(t), ",") == strings.Join(want, ",")
	})
}

type fakeNode struct {
	startErr      error
	startGate     chan struct{} // when set, Start blocks until it is closed
	startReturned chan struct{}

	statusFn func(call int) (*ipnstate.Status, error)
	listenFn func(call int) (net.Listener, error)

	statusCalls atomic.Int32
	listenCalls atomic.Int32
	startCalls  atomic.Int32

	closed         chan struct{}
	closeOnce      sync.Once
	closedEarly    atomic.Bool // Close ran before Start returned
	closeWasCalled atomic.Bool
}

func newFakeNode() *fakeNode {
	return &fakeNode{startReturned: make(chan struct{}), closed: make(chan struct{})}
}

func (f *fakeNode) Start() error {
	f.startCalls.Add(1)
	defer close(f.startReturned)
	if f.startGate != nil {
		<-f.startGate
	}
	return f.startErr
}

func (f *fakeNode) Status(context.Context) (*ipnstate.Status, error) {
	call := int(f.statusCalls.Add(1))
	if f.statusFn == nil {
		return runningStatus(), nil
	}
	return f.statusFn(call)
}

func (f *fakeNode) WhoIs(context.Context, string) (*apitype.WhoIsResponse, error) {
	return userNode("ana@example.com", "Ana", ""), nil
}

func (f *fakeNode) ListenTLS(network, addr string) (net.Listener, error) {
	call := int(f.listenCalls.Add(1))
	if network != "tcp" {
		return nil, errors.New("unexpected network " + network)
	}
	if f.listenFn == nil {
		return net.Listen("tcp", "127.0.0.1:0")
	}
	return f.listenFn(call)
}

func (f *fakeNode) Close() error {
	f.closeWasCalled.Store(true)
	select {
	case <-f.startReturned:
	default:
		f.closedEarly.Store(true)
	}
	f.closeOnce.Do(func() { close(f.closed) })
	return nil
}

func testOptions() runOptions {
	return runOptions{
		listenAddr:      ":443",
		pollInterval:    3 * time.Millisecond,
		retryDelay:      5 * time.Millisecond,
		shutdownTimeout: 3 * time.Second,
		logf:            func(string, ...any) {},
	}
}

type runHandle struct {
	cancel context.CancelFunc
	done   chan error
	out    *syncBuffer
}

func startRun(t *testing.T, n node, target *url.URL) *runHandle {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	h := &runHandle{cancel: cancel, done: make(chan error, 1), out: &syncBuffer{}}
	cfg := config{StateDir: absDir(t), Hostname: "nanachi-test", Target: target}
	go func() { h.done <- run(ctx, cfg, n, NewReporter(h.out), testOptions()) }()
	t.Cleanup(cancel)
	return h
}

// stop cancels the run and waits for it to return.
func (h *runHandle) stop(t *testing.T) error {
	t.Helper()
	h.cancel()
	select {
	case err := <-h.done:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("run did not return after cancel")
		return nil
	}
}

func TestRunReportsLoginThenRunningAndServesThroughTheProxy(t *testing.T) {
	n := newFakeNode()
	listeners := make(chan net.Listener, 1)
	n.listenFn = func(int) (net.Listener, error) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err == nil {
			listeners <- ln
		}
		return ln, err
	}
	n.statusFn = func(call int) (*ipnstate.Status, error) {
		switch {
		case call <= 2:
			return status("NeedsLogin", nil), nil // control has not answered with a URL yet
		case call <= 4:
			return status("NeedsLogin", func(st *ipnstate.Status) { st.AuthURL = "https://login.tailscale.com/a/abc" }), nil
		default:
			return runningStatus(), nil
		}
	}
	h := startRun(t, n, newBackend(t))

	waitForTypes(t, h.out, "needs_login", "running")
	lines := h.out.Lines()
	if want := `{"type":"needs_login","authUrl":"https://login.tailscale.com/a/abc"}`; lines[0] != want {
		t.Errorf("first line = %s, want %s", lines[0], want)
	}
	if want := `{"type":"running","dnsName":"nanachi-pc.tail1234.ts.net","tailnet":"ana@example.com","ips":["100.64.0.1","fd7a:115c:a1e0::1"]}`; lines[1] != want {
		t.Errorf("second line = %s, want %s", lines[1], want)
	}

	// The listener is live and proxies to the daemon with the identity from WhoIs.
	ln := <-listeners
	req, err := http.NewRequest(http.MethodGet, "http://"+ln.Addr().String()+"/api/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Tailscale-User-Login", "admin@evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	var got seen
	if err := json.Unmarshal(body, &got); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, body %q, err %v", resp.StatusCode, body, err)
	}
	if v := got.Header.Get("Tailscale-User-Login"); v != "ana@example.com" || got.URI != "/api/health" {
		t.Errorf("backend saw login %q and URI %q", v, got.URI)
	}

	if err := h.stop(t); err != nil {
		t.Fatalf("run = %v, want nil after a clean shutdown", err)
	}
	if !n.closeWasCalled.Load() {
		t.Error("the node was not closed")
	}
	waitForTypes(t, h.out, "needs_login", "running", "stopped")
	if _, err := http.Get("http://" + ln.Addr().String() + "/"); err == nil {
		t.Error("the listener still accepts connections after shutdown")
	}
}

func TestRunReportsServingErrorsAndRecovers(t *testing.T) {
	n := newFakeNode()
	gate := make(chan struct{}) // hold ListenTLS until the first running event is out
	n.listenFn = func(call int) (net.Listener, error) {
		<-gate
		if call <= 2 {
			return nil, errors.New("tsnet: you must enable HTTPS in the admin panel to proceed. See https://tailscale.com/s/https")
		}
		return net.Listen("tcp", "127.0.0.1:0")
	}
	h := startRun(t, n, newBackend(t))

	waitForTypes(t, h.out, "running")
	close(gate)
	// Two failed attempts (same message, written once), then the listener comes up
	// and the running state is repeated so the error is superseded.
	waitForTypes(t, h.out, "running", "error", "running")
	if lines := h.out.Lines(); !strings.Contains(lines[1], "enable HTTPS") {
		t.Errorf("error line = %s, want the HTTPS requirement", lines[1])
	}
	if n.listenCalls.Load() < 3 {
		t.Errorf("ListenTLS called %d times, want a retry after each failure", n.listenCalls.Load())
	}

	if err := h.stop(t); err != nil {
		t.Fatal(err)
	}
	waitForTypes(t, h.out, "running", "error", "running", "stopped")
}

func TestRunReportsStatusErrorsOnceAndRecovers(t *testing.T) {
	n := newFakeNode()
	n.statusFn = func(call int) (*ipnstate.Status, error) {
		if call <= 4 {
			return nil, errors.New("localapi unavailable")
		}
		return runningStatus(), nil
	}
	h := startRun(t, n, newBackend(t))

	waitForTypes(t, h.out, "error", "running")
	if lines := h.out.Lines(); !strings.Contains(lines[0], "could not read the Tailscale status") {
		t.Errorf("error line = %s", lines[0])
	}
	_ = h.stop(t)
}

func TestRunReturnsTheStartError(t *testing.T) {
	n := newFakeNode()
	n.startErr = errors.New("mkdir state: access denied")
	h := startRun(t, n, newBackend(t))

	select {
	case err := <-h.done:
		if !errors.Is(err, n.startErr) {
			t.Fatalf("run = %v, want the start error", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run did not return after Start failed")
	}
	waitForTypes(t, h.out, "error")
	if line := h.out.Lines()[0]; !strings.Contains(line, "access denied") {
		t.Errorf("error line = %s", line)
	}
	if n.listenCalls.Load() != 0 || n.statusCalls.Load() != 0 {
		t.Error("nothing may run after a failed start")
	}
}

func TestRunShutsDownPromptlyWhileWaitingForLogin(t *testing.T) {
	n := newFakeNode()
	// Like the real ListenTLS: it cannot be cancelled, it blocks until the node is
	// running, and it only returns (with an error) once the node is closed.
	n.listenFn = func(int) (net.Listener, error) {
		<-n.closed
		return nil, errors.New("tsnet: Up: context canceled")
	}
	n.statusFn = func(int) (*ipnstate.Status, error) {
		return status("NeedsLogin", func(st *ipnstate.Status) { st.AuthURL = "https://login.tailscale.com/a/abc" }), nil
	}
	h := startRun(t, n, newBackend(t))
	waitForTypes(t, h.out, "needs_login")
	waitFor(t, "ListenTLS to block", func() bool { return n.listenCalls.Load() == 1 })

	began := time.Now()
	if err := h.stop(t); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took > 2*time.Second {
		t.Errorf("shutdown took %v, a pending login must not delay it", took)
	}
	if !n.closeWasCalled.Load() {
		t.Error("the node was not closed")
	}
	waitForTypes(t, h.out, "needs_login", "stopped")
}

func TestRunNeverClosesTheNodeWhileStartIsRunning(t *testing.T) {
	n := newFakeNode()
	n.startGate = make(chan struct{})
	h := startRun(t, n, newBackend(t))
	waitFor(t, "Start to be called", func() bool { return n.startCalls.Load() == 1 })

	h.cancel() // shutdown arrives while Start is still in flight
	select {
	case <-h.done:
		t.Fatal("run returned while Start was still running")
	case <-time.After(50 * time.Millisecond):
	}
	close(n.startGate)

	select {
	case err := <-h.done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run did not return after Start finished")
	}
	if !n.closeWasCalled.Load() {
		t.Error("what Start built was not closed")
	}
	if n.closedEarly.Load() {
		t.Error("Close ran concurrently with Start; tsnet forbids that")
	}
	waitForTypes(t, h.out, "stopped")
	if n.statusCalls.Load() != 0 || n.listenCalls.Load() != 0 {
		t.Error("nothing may be served or polled once shutdown has begun")
	}
}

func TestRunRepeatedIdenticalStatusIsWrittenOnce(t *testing.T) {
	n := newFakeNode()
	h := startRun(t, n, newBackend(t))
	waitForTypes(t, h.out, "running")
	waitFor(t, "several polls", func() bool { return n.statusCalls.Load() >= 10 })
	if got := h.out.types(t); len(got) != 1 {
		t.Errorf("events = %v, want a single running line however often the status is polled", got)
	}
	_ = h.stop(t)
}
