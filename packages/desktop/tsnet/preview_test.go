package main

import (
	"bufio"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPreviewTargetUsesAdjacentIPv4Port(t *testing.T) {
	for _, tc := range []struct {
		main string
		want string
	}{
		{"http://127.0.0.1:7777", "http://127.0.0.1:7778"},
		{"http://localhost:7777", "http://127.0.0.1:7778"},
		{"http://localhost:1", "http://127.0.0.1:2"},
		{"http://localhost:65534", "http://127.0.0.1:65535"},
		{"http://localhost:65535", "http://127.0.0.1:65534"},
	} {
		t.Run(tc.main, func(t *testing.T) {
			target, err := validateTarget(tc.main)
			if err != nil {
				t.Fatal(err)
			}
			if got := previewTarget(target).String(); got != tc.want {
				t.Fatalf("preview target = %q, want %q", got, tc.want)
			}
			if target.String() != tc.main {
				t.Fatal("deriving the preview gateway changed the main daemon target")
			}
		})
	}
}

// adjacentListeners reserves both local backend ports together. Only these test
// fixtures use OS listeners; production frontends still use node.ListenTLS.
func adjacentListeners(t *testing.T) (net.Listener, net.Listener) {
	t.Helper()
	for range 100 {
		main, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		u := &url.URL{Scheme: "http", Host: main.Addr().String()}
		preview, err := net.Listen("tcp4", previewTarget(u).Host)
		if err == nil {
			t.Cleanup(func() { _ = main.Close(); _ = preview.Close() })
			return main, preview
		}
		_ = main.Close()
	}
	t.Fatal("could not reserve adjacent loopback backend ports")
	return nil, nil
}

type frontendListener struct {
	port string
	ln   net.Listener
}

func receiveFrontend(t *testing.T, listeners <-chan frontendListener) frontendListener {
	t.Helper()
	select {
	case frontend := <-listeners:
		return frontend
	case <-time.After(5 * time.Second):
		t.Fatal("tailnet listener did not start")
		return frontendListener{}
	}
}

func TestRunRoutesPrivateTLSOriginsAndClosesUpgradedConnections(t *testing.T) {
	main, preview := adjacentListeners(t)
	upgrades := make(chan seen, 2)
	closedUpgrades := make(chan string, 2)
	backend := func(name string, ln net.Listener) {
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := seen{Host: r.Host, URI: r.RequestURI, Header: r.Header.Clone()}
			if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
				w.Header().Set("X-Test-Backend", name)
				_ = json.NewEncoder(w).Encode(got)
				return
			}
			upgrades <- got
			conn, rw, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Errorf("backend hijack: %v", err)
				return
			}
			defer conn.Close()
			defer func() { closedUpgrades <- name }()
			_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
			_ = rw.Flush()
			scanner := bufio.NewScanner(rw)
			for scanner.Scan() {
				_, _ = fmt.Fprintf(conn, "%s:%s\n", name, scanner.Text())
			}
		}))
		_ = srv.Listener.Close()
		srv.Listener = ln
		srv.Start()
		t.Cleanup(srv.Close)
	}
	backend("main", main)
	backend("preview", preview)

	// Both frontends use the same TLS certificate, as they do on one tsnet node.
	certificate := httptest.NewTLSServer(http.NotFoundHandler())
	t.Cleanup(certificate.Close)
	client := certificate.Client()
	client.Timeout = 5 * time.Second
	defer client.CloseIdleConnections()
	serverTLS := certificate.TLS.Clone()
	clientTLS := client.Transport.(*http.Transport).TLSClientConfig.Clone()
	n := newFakeNode()
	listeners := make(chan frontendListener, 2)
	n.listenFn = func(addr string, _ int) (net.Listener, error) {
		if addr != ":443" && addr != ":8443" {
			return nil, errors.New("unexpected tailnet port " + addr)
		}
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err == nil {
			ln = tls.NewListener(ln, serverTLS)
			listeners <- frontendListener{port: addr, ln: ln}
		}
		return ln, err
	}
	// Exercise localhost main targets while the gateway listens only on IPv4.
	target := &url.URL{Scheme: "http", Host: "localhost:" + strconv.Itoa(main.Addr().(*net.TCPAddr).Port)}
	h := startRun(t, n, target)
	frontends := []frontendListener{receiveFrontend(t, listeners), receiveFrontend(t, listeners)}
	var upgradedClients []net.Conn
	for _, frontend := range frontends {
		name, host := "main", "nanachi-pc.tail1234.ts.net"
		if frontend.port == ":8443" {
			name, host = "preview", host+":8443"
		}
		req, err := http.NewRequest(http.MethodGet, "https://"+frontend.ln.Addr().String()+"/assets/app.js?version=2", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		for key, value := range spoofed {
			req.Header.Set(key, value)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var got seen
		err = json.NewDecoder(resp.Body).Decode(&got)
		_ = resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK || resp.Header.Get("X-Test-Backend") != name {
			t.Fatalf("%s route: status %d, backend %q, decode %v", frontend.port, resp.StatusCode, resp.Header.Get("X-Test-Backend"), err)
		}
		assertFrontendIdentity(t, got, host)
		if got.URI != "/assets/app.js?version=2" {
			t.Fatalf("%s URI = %q", name, got.URI)
		}

		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", frontend.ln.Addr().String(), clientTLS)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		_, err = fmt.Fprintf(conn, "GET /hmr HTTP/1.1\r\nHost: %s\r\nOrigin: https://%s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nTailscale-User-Login: attacker@example.com\r\nX-Forwarded-Host: evil.example\r\n\r\n", host, host)
		if err != nil {
			t.Fatal(err)
		}
		reader := bufio.NewReader(conn)
		upgrade, err := http.ReadResponse(reader, nil)
		if err != nil {
			t.Fatal(err)
		}
		if upgrade.StatusCode != http.StatusSwitchingProtocols {
			t.Fatalf("%s upgrade status = %d", name, upgrade.StatusCode)
		}
		if _, err := io.WriteString(conn, "reload\n"); err != nil {
			t.Fatal(err)
		}
		if echo, err := reader.ReadString('\n'); err != nil || echo != name+":reload\n" {
			t.Fatalf("%s upgrade echo = %q, err %v", name, echo, err)
		}
		select {
		case got := <-upgrades:
			assertFrontendIdentity(t, got, host)
			if got.Header.Get("Origin") != "https://"+host {
				t.Fatal("WebSocket Origin changed")
			}
		case <-time.After(5 * time.Second):
			t.Fatal("backend did not receive upgrade")
		}
		// Keep both upgrades alive across run's cancellation.
		upgradedClients = append(upgradedClients, conn)
	}
	if err := h.stop(t); err != nil {
		t.Fatal(err)
	}
	for range frontends {
		select {
		case <-closedUpgrades:
		case <-time.After(3 * time.Second):
			t.Fatal("shutdown left a backend upgrade open")
		}
	}
	for _, conn := range upgradedClients {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var one [1]byte
		if _, err := conn.Read(one[:]); err == nil {
			t.Error("shutdown left a frontend upgrade readable")
		} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
			t.Error("shutdown left a frontend upgrade open")
		}
	}
	for _, frontend := range frontends {
		conn, err := net.DialTimeout("tcp", frontend.ln.Addr().String(), time.Second)
		if err == nil {
			_ = conn.Close()
			t.Errorf("%s listener survived shutdown", frontend.port)
		}
	}
}

func assertFrontendIdentity(t *testing.T, got seen, host string) {
	t.Helper()
	for key, want := range map[string]string{
		"Tailscale-User-Login": "ana@example.com",
		"X-Forwarded-Host":     host,
		"X-Forwarded-Proto":    "https",
		"X-Forwarded-For":      "127.0.0.1",
	} {
		if value := got.Header.Get(key); value != want {
			t.Errorf("%s = %q, want %q", key, value, want)
		}
	}
	if got.Host != host {
		t.Errorf("Host = %q, want %q", got.Host, host)
	}
	for _, key := range []string{"Forwarded", headerFunnel, headerAppCaps} {
		if got.Header.Get(key) != "" {
			t.Errorf("spoofed %s survived", key)
		}
	}
}

func TestRunRetriesEachListenerWithoutInterruptingTheOther(t *testing.T) {
	for _, failing := range []string{":443", ":8443"} {
		t.Run(failing, func(t *testing.T) {
			main, preview := adjacentListeners(t)
			for _, ln := range []net.Listener{main, preview} {
				backend := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(http.StatusNoContent)
				}))
				_ = backend.Listener.Close()
				backend.Listener = ln
				backend.Start()
				t.Cleanup(backend.Close)
			}
			n := newFakeNode()
			gate := make(chan struct{})
			var recovered atomic.Bool
			var failedAttempts atomic.Int32
			listeners := make(chan frontendListener, 4)
			n.listenFn = func(addr string, _ int) (net.Listener, error) {
				<-gate
				if addr == failing && !recovered.Load() {
					failedAttempts.Add(1)
					return nil, errors.New("synthetic bind failure")
				}
				ln, err := net.Listen("tcp4", "127.0.0.1:0")
				if err == nil {
					listeners <- frontendListener{port: addr, ln: ln}
				}
				return ln, err
			}
			h := startRun(t, n, &url.URL{Scheme: "http", Host: main.Addr().String()})
			waitForTypes(t, h.out, "running")
			close(gate)
			healthy := receiveFrontend(t, listeners)
			if healthy.port == failing {
				t.Fatal("failing listener unexpectedly started")
			}
			waitFor(t, "independent retries", func() bool { return failedAttempts.Load() >= 3 })
			waitForTypes(t, h.out, "running", "error")
			if !strings.Contains(h.out.Lines()[1], failing) {
				t.Fatal("listener error did not identify its port")
			}
			client := &http.Client{Timeout: 5 * time.Second}
			defer client.CloseIdleConnections()
			resp, err := client.Get("http://" + healthy.ln.Addr().String() + "/")
			if err != nil {
				t.Fatalf("healthy listener interrupted: %v", err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusNoContent {
				t.Fatalf("healthy listener returned %d", resp.StatusCode)
			}

			// Restart the healthy listener while its sibling is still failing.
			// Its Recovered call must not erase the outstanding sibling failure.
			_ = healthy.ln.Close()
			restarted := receiveFrontend(t, listeners)
			if restarted.port != healthy.port {
				t.Fatal("the wrong listener restarted")
			}
			waitFor(t, "remaining listener error", func() bool {
				lines := h.out.Lines()
				return len(lines) >= 4 && strings.Contains(lines[len(lines)-1], failing) && !strings.Contains(lines[len(lines)-1], "server on "+healthy.port)
			})
			for _, typ := range h.out.types(t)[1:] {
				if typ != typeError {
					t.Fatal("healthy listener recovery hid a sibling error")
				}
			}
			recovered.Store(true)
			fixed := receiveFrontend(t, listeners)
			if fixed.port != failing {
				t.Fatal("the failing listener did not retry independently")
			}
			waitFor(t, "full recovery", func() bool {
				types := h.out.types(t)
				return types[len(types)-1] == typeRunning
			})
			if err := h.stop(t); err != nil {
				t.Fatal(err)
			}
		})
	}
}
