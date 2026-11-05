// Command fake-tsnet is a test double for nanachi-tsnet.exe. It speaks the same stdout protocol and shutdown rules
// (stop on EOF of stdin) but never touches the network, so a smoke run of Nanachi Desktop can exercise the Tailscale
// card without joining the maintainer's tailnet. It is never packaged.
//
// Build (see e2e/run-desktop.mjs, which does this into a temp folder):
//
//	go build -o fake-tsnet.exe .
//
// Environment:
//
//	FAKE_TSNET_RECORD           file that receives {"args":[...],"env":{...},"pid":N} when the process starts, and
//	                            <file>.log with one line per lifecycle event ("start", "running", "stdin-eof").
//	FAKE_TSNET_RUNNING_AFTER_MS delay between the needs_login line and the running line (default 2500).
package main

import (
	"encoding/json"
	"io"
	"os"
	"strconv"
	"time"
)

type record struct {
	Args []string          `json:"args"`
	Env  map[string]string `json:"env"`
	PID  int               `json:"pid"`
}

func main() {
	recordPath := os.Getenv("FAKE_TSNET_RECORD")
	if recordPath != "" {
		data, _ := json.Marshal(record{
			Args: os.Args[1:],
			Env:  map[string]string{"TS_NO_LOGS_NO_SUPPORT": os.Getenv("TS_NO_LOGS_NO_SUPPORT")},
			PID:  os.Getpid(),
		})
		_ = os.WriteFile(recordPath, data, 0o600)
	}
	note := func(event string) {
		if recordPath == "" {
			return
		}
		f, err := os.OpenFile(recordPath+".log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return
		}
		defer f.Close()
		_, _ = f.WriteString(event + "\n")
	}
	note("start")

	out := json.NewEncoder(os.Stdout)
	emit := func(v map[string]any) { _ = out.Encode(v) }

	emit(map[string]any{"type": "needs_login", "authUrl": "https://login.tailscale.com/a/fake-smoke-login"})

	after := 2500
	if v, err := strconv.Atoi(os.Getenv("FAKE_TSNET_RUNNING_AFTER_MS")); err == nil && v >= 0 {
		after = v
	}
	go func() {
		time.Sleep(time.Duration(after) * time.Millisecond)
		note("running")
		emit(map[string]any{
			"type":    "running",
			"dnsName": "nanachi-smoke.tail-fake.ts.net",
			"tailnet": "smoke@example.invalid",
			"ips":     []string{"100.64.0.99", "fd7a:115c:a1e0::99"},
		})
	}()

	// The real sidecar stops when its stdin reaches EOF; a closed or null stdin ends it at once.
	_, _ = io.Copy(io.Discard, os.Stdin)
	note("stdin-eof")
	emit(map[string]any{"type": "stopped"})
}
