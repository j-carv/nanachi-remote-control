package main

import (
	"context"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
	"unicode/utf8"

	"tailscale.com/client/tailscale/apitype"
)

// WhoIsFunc resolves the Tailscale identity of a peer from the remote address of
// its connection. It has the shape of the LocalClient's WhoIs, so the proxy can be
// tested without a tsnet server.
type WhoIsFunc func(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)

// whoIsTimeout bounds the identity lookup for one request.
const whoIsTimeout = 5 * time.Second

// Headers that `tailscale serve` owns. Every one of them is deleted from the
// incoming request, whatever the peer sent, before the real values are set.
const (
	headerUserLogin  = "Tailscale-User-Login"
	headerUserName   = "Tailscale-User-Name"
	headerUserPic    = "Tailscale-User-Profile-Pic"
	headerInfo       = "Tailscale-Headers-Info"
	headerFunnel     = "Tailscale-Funnel-Request"
	headerAppCaps    = "Tailscale-App-Capabilities"
	headersInfoValue = "https://tailscale.com/s/serve-headers"
)

// newProxy returns the reverse proxy that sits in front of the daemon. It
// reproduces what `tailscale serve` sends to its backend:
//
//   - Host is kept as the peer sent it (the daemon's anti DNS rebinding check wants
//     the `<name>.<tailnet>.ts.net` name, and the WebSocket Origin check compares
//     against X-Forwarded-Host).
//   - X-Forwarded-For (peer IP), X-Forwarded-Host and X-Forwarded-Proto are set from
//     the connection; any value the peer sent is dropped (httputil.ReverseProxy
//     removes them before Rewrite runs, and Rewrite sets them again).
//   - Tailscale-User-Login, -Name and -Profile-Pic are deleted and then set from
//     WhoIs. A tagged node has no user, so it gets no identity headers.
//
// If WhoIs fails the request is still proxied, without identity headers. That is
// what `tailscale serve` does for a peer it cannot identify. It fails closed where
// it matters: the daemon only trusts a login that is on its allowlist, so an
// unidentified peer is rejected when the allowlist is set and falls back to the
// device token when it is not.
//
// WebSocket upgrades pass through httputil.ReverseProxy's upgrade support.
func newProxy(target *url.URL, whois WhoIsFunc, logf func(format string, args ...any)) http.Handler {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil // never route loopback traffic through an HTTP(S)_PROXY from the environment

	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = r.In.Host
			r.SetXForwarded()
			setIdentityHeaders(r, whois, logf)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			logf("proxy %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "bad gateway", http.StatusBadGateway)
		},
	}
}

// setIdentityHeaders replaces the Tailscale identity headers on the outgoing
// request with the ones derived from WhoIs (or none).
func setIdentityHeaders(r *httputil.ProxyRequest, whois WhoIsFunc, logf func(format string, args ...any)) {
	h := r.Out.Header
	for _, name := range []string{headerUserLogin, headerUserName, headerUserPic, headerInfo, headerFunnel, headerAppCaps} {
		h.Del(name)
	}

	host, _, err := net.SplitHostPort(r.In.RemoteAddr)
	if err != nil || host == "" {
		return
	}

	ctx, cancel := context.WithTimeout(r.In.Context(), whoIsTimeout)
	defer cancel()
	who, err := whois(ctx, r.In.RemoteAddr)
	if err != nil {
		logf("whois %s: %v", r.In.RemoteAddr, err)
		return
	}
	if who == nil || who.Node == nil || who.UserProfile == nil {
		return
	}
	if who.Node.IsTagged() {
		return // tagged nodes have no user; `tailscale serve` sets nothing for them
	}
	login := encodeHeaderValue(who.UserProfile.LoginName)
	if login == "" {
		return
	}
	h.Set(headerUserLogin, login)
	h.Set(headerUserName, encodeHeaderValue(who.UserProfile.DisplayName))
	h.Set(headerUserPic, who.UserProfile.ProfilePicURL)
	h.Set(headerInfo, headersInfoValue)
}

// encodeHeaderValue encodes v like `tailscale serve` does: ASCII passes through,
// other UTF-8 becomes an RFC 2047 Q-encoded word, invalid UTF-8 becomes empty.
func encodeHeaderValue(v string) string {
	if !utf8.ValidString(v) {
		return ""
	}
	return mime.QEncoding.Encode("utf-8", v)
}
