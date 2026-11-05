package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

// seen is what the fake daemon reports back about the request it received.
type seen struct {
	Method string      `json:"method"`
	Host   string      `json:"host"`
	URI    string      `json:"uri"`
	Body   string      `json:"body"`
	Header http.Header `json:"header"`
}

// newBackend starts a fake daemon that answers with a JSON description of the
// request it got.
func newBackend(t *testing.T) *url.URL {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(seen{
			Method: r.Method,
			Host:   r.Host,
			URI:    r.RequestURI,
			Body:   string(body),
			Header: r.Header,
		})
	}))
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// fakeWhoIs returns a WhoIsFunc with a fixed answer that records the addresses it was asked about.
type fakeWhoIs struct {
	resp *apitype.WhoIsResponse
	err  error

	mu    sync.Mutex
	calls []string
}

func (f *fakeWhoIs) lookup(_ context.Context, remoteAddr string) (*apitype.WhoIsResponse, error) {
	f.mu.Lock()
	f.calls = append(f.calls, remoteAddr)
	f.mu.Unlock()
	return f.resp, f.err
}

func (f *fakeWhoIs) addresses() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func userNode(login, display, pic string) *apitype.WhoIsResponse {
	return &apitype.WhoIsResponse{
		Node:        &tailcfg.Node{ID: 1, User: 7},
		UserProfile: &tailcfg.UserProfile{ID: 7, LoginName: login, DisplayName: display, ProfilePicURL: pic},
	}
}

func taggedNode() *apitype.WhoIsResponse {
	return &apitype.WhoIsResponse{
		// A tagged node is owned by the tag; control still reports a profile for the
		// node's creator or a synthetic one. Either way no identity may be sent.
		Node:        &tailcfg.Node{ID: 2, User: 8, Tags: []string{"tag:server"}},
		UserProfile: &tailcfg.UserProfile{ID: 8, LoginName: "tagged-devices", DisplayName: "Tagged Devices"},
	}
}

// spoofed are the headers a hostile peer might send to impersonate someone.
var spoofed = map[string]string{
	"Tailscale-User-Login":       "admin@evil.example",
	"Tailscale-User-Name":        "Evil Admin",
	"Tailscale-User-Profile-Pic": "https://evil.example/pic.png",
	"Tailscale-Headers-Info":     "https://evil.example/info",
	"Tailscale-Funnel-Request":   "?1",
	"Tailscale-App-Capabilities": `{"evil":[{}]}`,
	"X-Forwarded-For":            "6.6.6.6",
	"X-Forwarded-Host":           "evil.example",
	"X-Forwarded-Proto":          "gopher",
	"Forwarded":                  "for=6.6.6.6;host=evil.example",
}

// do sends a request through the proxy handler and decodes what the backend saw.
func do(t *testing.T, h http.Handler, req *http.Request) (seen, *httptest.ResponseRecorder) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var got seen
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode backend echo: %v (body %q)", err, rec.Body.String())
		}
	}
	return got, rec
}

func spoofedRequest(t *testing.T, method, target string, body io.Reader) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	req.Host = "nanachi-pc.tail1234.ts.net"
	req.RemoteAddr = "100.64.0.7:51234"
	req.TLS = &tls.ConnectionState{}
	for k, v := range spoofed {
		req.Header.Set(k, v)
	}
	return req
}

func logRecorder() (func(string, ...any), func() []string) {
	var mu sync.Mutex
	var lines []string
	return func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, fmt.Sprintf(format, args...))
		}, func() []string {
			mu.Lock()
			defer mu.Unlock()
			return append([]string(nil), lines...)
		}
}

func TestProxySetsIdentityFromWhoIsAndReplacesSpoofedHeaders(t *testing.T) {
	who := &fakeWhoIs{resp: userNode("ana@example.com", "Ana Souza", "https://pics.example/ana.png")}
	logf, _ := logRecorder()
	h := newProxy(newBackend(t), who.lookup, logf)

	got, rec := do(t, h, spoofedRequest(t, http.MethodGet, "/api/sessions?limit=5", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	want := map[string]string{
		"Tailscale-User-Login":       "ana@example.com",
		"Tailscale-User-Name":        "Ana Souza",
		"Tailscale-User-Profile-Pic": "https://pics.example/ana.png",
		"Tailscale-Headers-Info":     "https://tailscale.com/s/serve-headers",
	}
	for name, value := range want {
		if values := got.Header.Values(name); len(values) != 1 || values[0] != value {
			t.Errorf("%s = %q, want exactly %q", name, values, value)
		}
	}
	for _, name := range []string{"Tailscale-Funnel-Request", "Tailscale-App-Capabilities", "Forwarded"} {
		if values := got.Header.Values(name); len(values) != 0 {
			t.Errorf("%s = %q, want it removed", name, values)
		}
	}
	if calls := who.addresses(); len(calls) != 1 || calls[0] != "100.64.0.7:51234" {
		t.Errorf("whois asked about %q, want the connection's remote address once", calls)
	}
	if got.URI != "/api/sessions?limit=5" {
		t.Errorf("backend URI = %q, want path and query kept", got.URI)
	}
}

func TestProxyEncodesNonASCIIIdentityLikeTailscaleServe(t *testing.T) {
	who := &fakeWhoIs{resp: userNode("joão@example.com", "João Carvalho", "")}
	logf, _ := logRecorder()
	h := newProxy(newBackend(t), who.lookup, logf)

	got, _ := do(t, h, spoofedRequest(t, http.MethodGet, "/", nil))

	dec := new(mime.WordDecoder)
	for header, want := range map[string]string{
		"Tailscale-User-Login": "joão@example.com",
		"Tailscale-User-Name":  "João Carvalho",
	} {
		raw := got.Header.Get(header)
		if !strings.HasPrefix(raw, "=?utf-8?q?") {
			t.Errorf("%s = %q, want an RFC 2047 Q-encoded word", header, raw)
		}
		decoded, err := dec.DecodeHeader(raw)
		if err != nil || decoded != want {
			t.Errorf("%s decodes to %q (err %v), want %q", header, decoded, err, want)
		}
	}
}

func TestProxyForwardedHeadersComeFromTheConnection(t *testing.T) {
	who := &fakeWhoIs{resp: userNode("ana@example.com", "Ana", "")}
	logf, _ := logRecorder()
	h := newProxy(newBackend(t), who.lookup, logf)

	t.Run("tls", func(t *testing.T) {
		got, _ := do(t, h, spoofedRequest(t, http.MethodGet, "/", nil))
		if v := got.Header.Values("X-Forwarded-For"); len(v) != 1 || v[0] != "100.64.0.7" {
			t.Errorf("X-Forwarded-For = %q, want only the peer IP (no port, spoofed value dropped)", v)
		}
		if v := got.Header.Values("X-Forwarded-Host"); len(v) != 1 || v[0] != "nanachi-pc.tail1234.ts.net" {
			t.Errorf("X-Forwarded-Host = %q, want the Host the peer asked for", v)
		}
		if v := got.Header.Values("X-Forwarded-Proto"); len(v) != 1 || v[0] != "https" {
			t.Errorf("X-Forwarded-Proto = %q, want https", v)
		}
		if got.Host != "nanachi-pc.tail1234.ts.net" {
			t.Errorf("backend Host = %q, want the peer's Host kept (the daemon's host check wants the ts.net name)", got.Host)
		}
	})

	t.Run("plain connection is not labelled https", func(t *testing.T) {
		req := spoofedRequest(t, http.MethodGet, "/", nil)
		req.TLS = nil
		got, _ := do(t, h, req)
		if v := got.Header.Get("X-Forwarded-Proto"); v != "http" {
			t.Errorf("X-Forwarded-Proto = %q, want http", v)
		}
	})

	t.Run("ipv6 peer", func(t *testing.T) {
		req := spoofedRequest(t, http.MethodGet, "/", nil)
		req.RemoteAddr = "[fd7a:115c:a1e0::1]:4444"
		got, _ := do(t, h, req)
		if v := got.Header.Get("X-Forwarded-For"); v != "fd7a:115c:a1e0::1" {
			t.Errorf("X-Forwarded-For = %q, want the bare IPv6 address", v)
		}
	})
}

func TestProxyTaggedNodeGetsNoIdentityHeaders(t *testing.T) {
	who := &fakeWhoIs{resp: taggedNode()}
	logf, _ := logRecorder()
	h := newProxy(newBackend(t), who.lookup, logf)

	got, rec := do(t, h, spoofedRequest(t, http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want the request proxied", rec.Code)
	}
	assertNoIdentityHeaders(t, got.Header)
}

func TestProxyWhoIsFailureProxiesWithoutIdentityHeaders(t *testing.T) {
	cases := map[string]*fakeWhoIs{
		"error":            {err: errors.New("peer not found")},
		"timeout":          {err: context.DeadlineExceeded},
		"empty response":   {resp: &apitype.WhoIsResponse{}},
		"no user profile":  {resp: &apitype.WhoIsResponse{Node: &tailcfg.Node{ID: 3}}},
		"no node":          {resp: &apitype.WhoIsResponse{UserProfile: &tailcfg.UserProfile{LoginName: "ana@example.com"}}},
		"blank login name": {resp: userNode("", "Ana", "")},
	}
	for name, who := range cases {
		t.Run(name, func(t *testing.T) {
			logf, logged := logRecorder()
			h := newProxy(newBackend(t), who.lookup, logf)

			got, rec := do(t, h, spoofedRequest(t, http.MethodGet, "/api/health", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want the request proxied anyway", rec.Code)
			}
			assertNoIdentityHeaders(t, got.Header)
			if who.err != nil && len(logged()) == 0 {
				t.Error("a failed lookup should be logged")
			}
		})
	}
}

func TestProxyKeepsMethodAndBody(t *testing.T) {
	who := &fakeWhoIs{resp: userNode("ana@example.com", "Ana", "")}
	logf, _ := logRecorder()
	h := newProxy(newBackend(t), who.lookup, logf)

	got, _ := do(t, h, spoofedRequest(t, http.MethodPost, "/api/pair", strings.NewReader(`{"code":"123456"}`)))
	if got.Method != http.MethodPost || got.Body != `{"code":"123456"}` {
		t.Errorf("backend saw %s with body %q, want the POST body kept", got.Method, got.Body)
	}
}

func TestProxyReturns502WhenTheDaemonIsDown(t *testing.T) {
	// Grab a free port and close it so nothing listens there.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	target := &url.URL{Scheme: "http", Host: ln.Addr().String()}
	_ = ln.Close()

	who := &fakeWhoIs{resp: userNode("ana@example.com", "Ana", "")}
	logf, logged := logRecorder()
	h := newProxy(target, who.lookup, logf)

	_, rec := do(t, h, spoofedRequest(t, http.MethodGet, "/", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if body := strings.TrimSpace(rec.Body.String()); body != "bad gateway" {
		t.Errorf("body = %q, want a generic message with no connection details", body)
	}
	if len(logged()) == 0 {
		t.Error("the proxy error should be logged")
	}
}

func assertNoIdentityHeaders(t *testing.T, h http.Header) {
	t.Helper()
	for _, name := range []string{
		"Tailscale-User-Login", "Tailscale-User-Name", "Tailscale-User-Profile-Pic",
		"Tailscale-Headers-Info", "Tailscale-Funnel-Request", "Tailscale-App-Capabilities",
	} {
		if v := h.Values(name); len(v) != 0 {
			t.Errorf("%s = %q, want it absent (spoofed values must not survive)", name, v)
		}
	}
}

// TestProxyPassesWebSocketUpgrade runs a real upgrade through the proxy to a fake
// daemon that echoes frames. The WebSocket framing is irrelevant to the proxy, so
// the test speaks a line protocol after the 101.
func TestProxyPassesWebSocketUpgrade(t *testing.T) {
	type upgrade struct {
		header http.Header
		host   string
	}
	upgrades := make(chan upgrade, 1)

	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "upgrade required", http.StatusUpgradeRequired)
			return
		}
		upgrades <- upgrade{header: r.Header.Clone(), host: r.Host}
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("backend hijack: %v", err)
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = rw.Flush()
		sc := bufio.NewScanner(rw)
		for sc.Scan() {
			_, _ = fmt.Fprintf(conn, "echo:%s\n", sc.Text())
		}
	}))
	defer backend.Close()
	target, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}

	who := &fakeWhoIs{resp: userNode("ana@example.com", "Ana", "")}
	logf, _ := logRecorder()
	front := httptest.NewServer(newProxy(target, who.lookup, logf))
	defer front.Close()

	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(front.URL, "http://"), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	const handshake = "GET /ws?token=abc HTTP/1.1\r\n" +
		"Host: nanachi-pc.tail1234.ts.net\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
		"Sec-WebSocket-Version: 13\r\n" +
		"Origin: https://nanachi-pc.tail1234.ts.net\r\n" +
		"Tailscale-User-Login: admin@evil.example\r\n" +
		"X-Forwarded-For: 6.6.6.6\r\n\r\n"
	if _, err := io.WriteString(conn, handshake); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("status = %d, want 101", resp.StatusCode)
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
		t.Errorf("Upgrade = %q, want websocket", resp.Header.Get("Upgrade"))
	}

	// Bytes flow both ways after the upgrade.
	for _, msg := range []string{"hello", "second message"} {
		if _, err := io.WriteString(conn, msg+"\n"); err != nil {
			t.Fatal(err)
		}
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read echo: %v", err)
		}
		if want := "echo:" + msg + "\n"; line != want {
			t.Errorf("echo = %q, want %q", line, want)
		}
	}

	select {
	case got := <-upgrades:
		if v := got.header.Get("Tailscale-User-Login"); v != "ana@example.com" {
			t.Errorf("upgrade Tailscale-User-Login = %q, want the WhoIs login, not the spoofed one", v)
		}
		if v := got.header.Get("X-Forwarded-For"); v != "127.0.0.1" {
			t.Errorf("upgrade X-Forwarded-For = %q, want the real peer IP", v)
		}
		if v := got.header.Get("X-Forwarded-Host"); v != "nanachi-pc.tail1234.ts.net" {
			t.Errorf("upgrade X-Forwarded-Host = %q", v)
		}
		if got.host != "nanachi-pc.tail1234.ts.net" {
			t.Errorf("upgrade Host = %q, want the peer's Host", got.host)
		}
		if v := got.header.Get("Origin"); v != "https://nanachi-pc.tail1234.ts.net" {
			t.Errorf("upgrade Origin = %q, want it passed through for the daemon's own check", v)
		}
	default:
		t.Fatal("the backend never saw the upgrade request")
	}
}
