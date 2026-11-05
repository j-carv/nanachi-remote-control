# nanachi-tsnet

The Tailscale sidecar of Nanachi Desktop. It joins the tailnet as its own node
(embedded [tsnet](https://pkg.go.dev/tailscale.com/tsnet), no Tailscale install
needed) and serves the local Nanachi daemon over HTTPS on port 443 of that node.
It sends the same identity headers as `tailscale serve`, so the daemon's Tailscale
checks keep working.

## Safety: never run it against the real tailnet by accident

Starting the sidecar (or any `tsnet.Server`) registers a new device in the tailnet
of whoever logs in. The tests never do that: they use a fake node and `httptest`.
`go test`, `go vet` and `nanachi-tsnet --version/--help` are safe; a command line
that passes validation starts a real node.

## Flags

| Flag | Meaning |
| --- | --- |
| `--state-dir <dir>` | Absolute path where the node keeps its state (keys, certificates). Created if missing. Desktop uses `<NANACHI_HOME>\tsnet`. |
| `--hostname <name>` | Node name on the tailnet, `[a-z0-9-]{1,63}`. Desktop uses `nanachi-<pc name>`. |
| `--target <url>` | The daemon: `http://127.0.0.1:<port>` or `http://localhost:<port>`. Nothing else is accepted. |
| `--version` | Print the version (sidecar, `tailscale.com` module, Go) and exit. |

Invalid flags print one `error` line on stdout, a human message on stderr, and exit
with code 2. Exit code 1 means the node could not start; 0 is a clean shutdown.

## Stdout protocol

One JSON object per line, written only when the state changes:

```json
{"type":"needs_login","authUrl":"https://login.tailscale.com/a/..."}
{"type":"running","dnsName":"nanachi-pc.tail1234.ts.net","tailnet":"you@example.com","ips":["100.64.0.1","fd7a:115c:a1e0::1"]}
{"type":"stopped"}
{"type":"error","message":"..."}
```

- `needs_login`: open `authUrl` to add this node to a tailnet. Not sent until control
  has handed out the URL.
- `running`: the node is up. `dnsName` has no trailing dot, so the address is
  `https://<dnsName>`. `tailnet` is the tailnet name (its MagicDNS suffix when the
  name is empty).
- `stopped`: the node is stopped, or the sidecar is shutting down (last line written).
- `error`: a failure. It is also used for a device that waits for admin approval.
  While HTTPS cannot be served (MagicDNS or HTTPS certificates are not enabled on
  the tailnet) the sidecar keeps retrying every 15 s. It writes the `error` once and,
  when serving starts, repeats the last `running` line so the error is superseded.

Anything else the process prints (stderr) is for the log, not for parsing.

## Shutdown

The sidecar stops on EOF of stdin, on SIGINT/SIGTERM and on Ctrl+C / Ctrl+Break /
console close on Windows. Keep stdin as a pipe when spawning it: a closed or null
stdin looks like EOF and ends the process at once. Desktop also kills the process
tree if shutdown takes too long.

## What the proxy sends to the daemon

- `Host` is kept as the peer sent it (the daemon accepts `*.ts.net`).
- `X-Forwarded-For` (peer IP), `X-Forwarded-Host` and `X-Forwarded-Proto` (`https`) are
  set from the connection. Incoming values are dropped.
- `Tailscale-User-Login`, `-Name` and `-Profile-Pic` (plus `Tailscale-Headers-Info`) are
  deleted from the incoming request, then set from WhoIs, RFC 2047 Q-encoded when not
  ASCII, exactly like `tailscale serve`. `Tailscale-Funnel-Request` and
  `Tailscale-App-Capabilities` are deleted and never set.
- A tagged node has no user: it gets no identity headers.
- If WhoIs fails, the request is still proxied, without identity headers (what
  `tailscale serve` does for a peer it cannot identify). The daemon only trusts a
  login on its allowlist, so an unidentified peer is refused when the allowlist is
  set and otherwise still needs a device token.
- WebSocket upgrades pass through. If the daemon is down the peer gets a plain `502`.

HTTPS needs MagicDNS and HTTPS certificates enabled on the tailnet, the same
requirement as `tailscale serve`.

## Build and test

Run from this folder. The build is pure Go (no cgo).

```powershell
go vet ./...
go test ./...
go build -trimpath -ldflags "-s -w" -o "$env:LOCALAPPDATA\nanachi-desktop-build\stage\bin\nanachi-tsnet.exe" .
```

The binary goes to `<build dir>\stage\bin`, outside the repository (the build dir is
`%LOCALAPPDATA%\nanachi-desktop-build`, or `NANACHI_DESKTOP_BUILD_DIR`). A development
Desktop (`npm run dev -w @nanachi/desktop`) looks for it there.

`tailscale.com` requires a newer Go than some installs have; Go downloads the matching
toolchain on first use (`GOTOOLCHAIN=auto`, the default).
