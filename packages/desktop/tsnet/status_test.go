package main

import (
	"bytes"
	"encoding/json"
	"net/netip"
	"strings"
	"testing"

	"tailscale.com/ipn/ipnstate"
)

func TestEventJSONMatchesTheContractExactly(t *testing.T) {
	cases := []struct {
		name string
		ev   Event
		want string
	}{
		{
			name: "needs_login",
			ev:   Event{Type: typeNeedsLogin, AuthURL: "https://login.tailscale.com/a/abc123"},
			want: `{"type":"needs_login","authUrl":"https://login.tailscale.com/a/abc123"}`,
		},
		{
			name: "running",
			ev:   Event{Type: typeRunning, DNSName: "nanachi-pc.tail1234.ts.net", Tailnet: "ana@example.com", IPs: []string{"100.64.0.1", "fd7a:115c:a1e0::1"}},
			want: `{"type":"running","dnsName":"nanachi-pc.tail1234.ts.net","tailnet":"ana@example.com","ips":["100.64.0.1","fd7a:115c:a1e0::1"]}`,
		},
		{
			name: "running with no ips is an empty array, never null",
			ev:   Event{Type: typeRunning, DNSName: "n.ts.net", Tailnet: "t"},
			want: `{"type":"running","dnsName":"n.ts.net","tailnet":"t","ips":[]}`,
		},
		{
			name: "stopped",
			ev:   Event{Type: typeStopped},
			want: `{"type":"stopped"}`,
		},
		{
			name: "error",
			ev:   errorEvent(`could not "serve"`),
			want: `{"type":"error","message":"could not \"serve\""}`,
		},
		{
			name: "html characters are not escaped",
			ev:   Event{Type: typeNeedsLogin, AuthURL: "https://login.tailscale.com/a/x?a=1&b=<2>"},
			want: `{"type":"needs_login","authUrl":"https://login.tailscale.com/a/x?a=1&b=<2>"}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := strings.TrimSuffix(encodeLine(tc.ev), "\n")
			if got != tc.want {
				t.Errorf("json = %s\nwant   %s", got, tc.want)
			}
		})
	}
}

func status(state string, mutate func(*ipnstate.Status)) *ipnstate.Status {
	st := &ipnstate.Status{BackendState: state}
	if mutate != nil {
		mutate(st)
	}
	return st
}

func runningStatus() *ipnstate.Status {
	return status("Running", func(st *ipnstate.Status) {
		st.Self = &ipnstate.PeerStatus{DNSName: "nanachi-pc.tail1234.ts.net."}
		st.TailscaleIPs = []netip.Addr{netip.MustParseAddr("100.64.0.1"), netip.MustParseAddr("fd7a:115c:a1e0::1")}
		st.CurrentTailnet = &ipnstate.TailnetStatus{Name: "ana@example.com", MagicDNSSuffix: "tail1234.ts.net"}
	})
}

func TestEventFromStatus(t *testing.T) {
	t.Run("running strips the trailing dot and lists the ips", func(t *testing.T) {
		ev, ok := eventFromStatus(runningStatus())
		if !ok {
			t.Fatal("no event")
		}
		want := Event{Type: typeRunning, DNSName: "nanachi-pc.tail1234.ts.net", Tailnet: "ana@example.com", IPs: []string{"100.64.0.1", "fd7a:115c:a1e0::1"}}
		assertEvent(t, ev, want)
	})

	t.Run("running falls back to the MagicDNS suffix when the tailnet has no name", func(t *testing.T) {
		st := runningStatus()
		st.CurrentTailnet.Name = ""
		ev, _ := eventFromStatus(st)
		if ev.Tailnet != "tail1234.ts.net" {
			t.Errorf("tailnet = %q, want the MagicDNS suffix", ev.Tailnet)
		}
	})

	t.Run("running without a tailnet reports an empty name", func(t *testing.T) {
		st := runningStatus()
		st.CurrentTailnet = nil
		ev, ok := eventFromStatus(st)
		if !ok || ev.Tailnet != "" {
			t.Errorf("got %+v ok=%v, want a running event with an empty tailnet", ev, ok)
		}
	})

	t.Run("running without a name or address is not ready yet", func(t *testing.T) {
		for name, mutate := range map[string]func(*ipnstate.Status){
			"no self":   func(st *ipnstate.Status) { st.Self = nil },
			"no dns":    func(st *ipnstate.Status) { st.Self.DNSName = "." },
			"no ips":    func(st *ipnstate.Status) { st.TailscaleIPs = nil },
			"all empty": func(st *ipnstate.Status) { st.Self, st.TailscaleIPs = nil, nil },
		} {
			st := runningStatus()
			mutate(st)
			if ev, ok := eventFromStatus(st); ok {
				t.Errorf("%s: got event %+v, want none", name, ev)
			}
		}
	})

	t.Run("needs login carries the auth url", func(t *testing.T) {
		ev, ok := eventFromStatus(status("NeedsLogin", func(st *ipnstate.Status) { st.AuthURL = "https://login.tailscale.com/a/x" }))
		if !ok {
			t.Fatal("no event")
		}
		assertEvent(t, ev, Event{Type: typeNeedsLogin, AuthURL: "https://login.tailscale.com/a/x"})
	})

	t.Run("needs login without a url yet is not reported", func(t *testing.T) {
		if ev, ok := eventFromStatus(status("NeedsLogin", nil)); ok {
			t.Errorf("got %+v, want none until control hands out the login URL", ev)
		}
	})

	t.Run("stopped", func(t *testing.T) {
		ev, ok := eventFromStatus(status("Stopped", nil))
		if !ok || ev.Type != typeStopped {
			t.Errorf("got %+v ok=%v, want stopped", ev, ok)
		}
	})

	t.Run("machine authorization is reported as an error", func(t *testing.T) {
		ev, ok := eventFromStatus(status("NeedsMachineAuth", nil))
		if !ok || ev.Type != typeError || !strings.Contains(ev.Message, "approved") {
			t.Errorf("got %+v ok=%v, want an error that says the device needs approval", ev, ok)
		}
	})

	t.Run("transient states report nothing", func(t *testing.T) {
		for _, state := range []string{"NoState", "Starting", ""} {
			if ev, ok := eventFromStatus(status(state, nil)); ok {
				t.Errorf("%q: got %+v, want none", state, ev)
			}
		}
		if _, ok := eventFromStatus(nil); ok {
			t.Error("nil status: want none")
		}
	})
}

func assertEvent(t *testing.T, got, want Event) {
	t.Helper()
	g, w := encodeLine(got), encodeLine(want)
	if g != w {
		t.Errorf("event = %s, want %s", strings.TrimSpace(g), strings.TrimSpace(w))
	}
}

func lines(buf *bytes.Buffer) []string {
	text := strings.TrimSuffix(buf.String(), "\n")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func TestReporterWritesOneJSONObjectPerLine(t *testing.T) {
	var buf bytes.Buffer
	rep := NewReporter(&buf)
	rep.Status(Event{Type: typeNeedsLogin, AuthURL: "https://login.tailscale.com/a/x"})
	rep.Status(runningEvent())
	rep.Error("boom")

	got := lines(&buf)
	if len(got) != 3 {
		t.Fatalf("got %d lines, want 3: %q", len(got), buf.String())
	}
	for _, line := range got {
		var decoded map[string]any
		if err := json.Unmarshal([]byte(line), &decoded); err != nil {
			t.Errorf("line %q is not a JSON object: %v", line, err)
		}
		if _, ok := decoded["type"].(string); !ok {
			t.Errorf("line %q has no string type", line)
		}
	}
	if !strings.HasSuffix(buf.String(), "\n") {
		t.Error("output must end with a newline")
	}
}

func runningEvent() Event {
	return Event{Type: typeRunning, DNSName: "nanachi-pc.tail1234.ts.net", Tailnet: "ana@example.com", IPs: []string{"100.64.0.1"}}
}

func TestReporterDropsRepeatedStatus(t *testing.T) {
	var buf bytes.Buffer
	rep := NewReporter(&buf)

	if !rep.Status(runningEvent()) {
		t.Error("first status must be written")
	}
	for i := 0; i < 5; i++ {
		if rep.Status(runningEvent()) {
			t.Error("an identical status must not be written again")
		}
	}
	changed := runningEvent()
	changed.IPs = []string{"100.64.0.2"}
	if !rep.Status(changed) {
		t.Error("a status that differs in any field must be written")
	}
	if !rep.Status(Event{Type: typeStopped}) {
		t.Error("a different type must be written")
	}
	if rep.Status(Event{Type: typeStopped}) {
		t.Error("stopped twice in a row must be written once")
	}
	if !rep.Status(runningEvent()) {
		t.Error("going back to an earlier state is a change and must be written")
	}
	if got := len(lines(&buf)); got != 4 {
		t.Errorf("got %d lines, want 4", got)
	}
}

func TestReporterServingErrorLifecycle(t *testing.T) {
	var buf bytes.Buffer
	rep := NewReporter(&buf)
	run := mustLine(t, runningEvent())
	httpsErr := mustLine(t, errorEvent("https is not enabled"))

	rep.Status(runningEvent())
	if !rep.Error("https is not enabled") {
		t.Fatal("first error must be written")
	}
	if rep.Error("https is not enabled") {
		t.Error("the same error again must be dropped")
	}
	// The status loop keeps polling "running" while serving fails: no flip-flop.
	if rep.Status(runningEvent()) {
		t.Error("an unchanged node status must not be written just because an error is outstanding")
	}
	if !rep.Error("a different error") {
		t.Error("a different message must be written")
	}

	if !rep.Recovered() {
		t.Fatal("recovery after an error must write the last status again")
	}
	if rep.Recovered() {
		t.Error("recovery with no outstanding error must write nothing")
	}

	// After recovery the same error is news again.
	if !rep.Error("https is not enabled") {
		t.Error("an error after recovery must be written even if it repeats an old message")
	}

	got := lines(&buf)
	want := []string{run, httpsErr, mustLine(t, errorEvent("a different error")), run, httpsErr}
	if len(got) != len(want) {
		t.Fatalf("got %d lines %q, want %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i]+"\n" != want[i] {
			t.Errorf("line %d = %s, want %s", i, got[i], strings.TrimSuffix(want[i], "\n"))
		}
	}
}

func TestReporterNewStatusSupersedesServingError(t *testing.T) {
	var buf bytes.Buffer
	rep := NewReporter(&buf)
	rep.Status(runningEvent())
	rep.Error("https is not enabled")
	rep.Status(Event{Type: typeStopped})

	if rep.Recovered() {
		t.Error("a status change already cleared the error; recovery must be a no-op")
	}
	if !rep.Error("https is not enabled") {
		t.Error("the same error after a state change is news again")
	}
}

func TestReporterRecoveredWithoutAStatusWritesNothing(t *testing.T) {
	var buf bytes.Buffer
	rep := NewReporter(&buf)
	rep.Error("early failure")
	if rep.Recovered() {
		t.Error("there is no status to repeat")
	}
	if got := len(lines(&buf)); got != 1 {
		t.Errorf("got %d lines, want only the error", got)
	}
}

func mustLine(t *testing.T, ev Event) string {
	t.Helper()
	return encodeLine(ev)
}
