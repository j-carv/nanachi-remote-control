package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// absDir is an absolute path on the platform running the tests.
func absDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("testdata-state", "tsnet"))
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func validArgs(t *testing.T) []string {
	return []string{"--state-dir", absDir(t), "--hostname", "nanachi-my-pc", "--target", "http://127.0.0.1:7777"}
}

func TestParseArgsAcceptsValidFlags(t *testing.T) {
	cases := []struct {
		target     string
		wantTarget string
	}{
		{"http://127.0.0.1:7777", "http://127.0.0.1:7777"},
		{"http://localhost:7777", "http://localhost:7777"},
		{"http://LOCALHOST:7777", "http://localhost:7777"},
		{"http://127.0.0.1:7777/", "http://127.0.0.1:7777"},
		{"http://127.0.0.1:1", "http://127.0.0.1:1"},
		{"http://127.0.0.1:65535", "http://127.0.0.1:65535"},
		{"http://127.0.0.1:007777", "http://127.0.0.1:7777"},
	}
	for _, tc := range cases {
		t.Run(tc.target, func(t *testing.T) {
			dir := absDir(t)
			cfg, showVersion, err := parseArgs([]string{"--state-dir", dir, "--hostname", "nanachi-my-pc", "--target", tc.target}, &bytes.Buffer{})
			if err != nil || showVersion {
				t.Fatalf("err = %v, showVersion = %v", err, showVersion)
			}
			if cfg.Target.String() != tc.wantTarget {
				t.Errorf("target = %s, want %s", cfg.Target, tc.wantTarget)
			}
			if cfg.Hostname != "nanachi-my-pc" || cfg.StateDir != dir {
				t.Errorf("cfg = %+v", cfg)
			}
		})
	}
}

func TestParseArgsRejectsBadTargets(t *testing.T) {
	for _, target := range []string{
		"",
		"127.0.0.1:7777",
		"https://127.0.0.1:7777",
		"ftp://127.0.0.1:7777",
		"http://127.0.0.1",
		"http://127.0.0.1:",
		"http://127.0.0.1:0",
		"http://127.0.0.1:65536",
		"http://127.0.0.1:99999999999",
		"http://127.0.0.1:abc",
		"http://127.0.0.1:+80",
		"http://127.0.0.1:-1",
		"http://localhost",
		"http://0.0.0.0:7777",
		"http://[::1]:7777",
		"http://192.168.0.10:7777",
		"http://100.64.0.1:7777",
		"http://example.com:7777",
		"http://127.0.0.1.evil.example:7777",
		"http://evil.example:7777@127.0.0.1:7777",
		"http://user:pw@127.0.0.1:7777",
		"http://127.0.0.1:7777/api",
		"http://127.0.0.1:7777/?x=1",
		"http://127.0.0.1:7777#frag",
		"http://127.0.0.1:7777 ",
		"http://localhost.:7777",
	} {
		t.Run(target, func(t *testing.T) {
			args := []string{"--state-dir", absDir(t), "--hostname", "nanachi", "--target", target}
			_, _, err := parseArgs(args, &bytes.Buffer{})
			if err == nil {
				t.Fatalf("target %q was accepted", target)
			}
			if !strings.Contains(err.Error(), "--target") {
				t.Errorf("error %q should name the flag", err)
			}
		})
	}
}

func TestParseArgsHostname(t *testing.T) {
	long63 := strings.Repeat("a", 63)
	for _, ok := range []string{"a", "nanachi-my-pc", "pc01", "a-b-c", long63, "0"} {
		if _, _, err := parseArgs(argsWith(t, "--hostname", ok), &bytes.Buffer{}); err != nil {
			t.Errorf("hostname %q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "Nanachi", "my_pc", "my.pc", "my pc", "joão", strings.Repeat("a", 64), "pc!", "pc\n"} {
		_, _, err := parseArgs(argsWith(t, "--hostname", bad), &bytes.Buffer{})
		if err == nil {
			t.Errorf("hostname %q accepted", bad)
			continue
		}
		if !strings.Contains(err.Error(), "--hostname") {
			t.Errorf("error %q should name the flag", err)
		}
	}
}

func TestParseArgsStateDir(t *testing.T) {
	if _, _, err := parseArgs(argsWith(t, "--state-dir", ""), &bytes.Buffer{}); err == nil {
		t.Error("empty --state-dir accepted")
	}
	if _, _, err := parseArgs(argsWith(t, "--state-dir", filepath.Join("relative", "tsnet")), &bytes.Buffer{}); err == nil {
		t.Error("relative --state-dir accepted: tsnet would resolve it against whatever the working directory is")
	}
	if runtime.GOOS == "windows" {
		dir := `C:\Users\Joao Álvaro\.nanachi-remote\tsnet`
		cfg, _, err := parseArgs(argsWith(t, "--state-dir", dir), &bytes.Buffer{})
		if err != nil || cfg.StateDir != dir {
			t.Errorf("a path with spaces and accents was rejected or altered: %q, %v", cfg.StateDir, err)
		}
	}
}

func TestParseArgsRequiresEveryFlag(t *testing.T) {
	for _, drop := range []string{"--state-dir", "--hostname", "--target"} {
		var args []string
		full := validArgs(t)
		for i := 0; i < len(full); i += 2 {
			if full[i] != drop {
				args = append(args, full[i], full[i+1])
			}
		}
		_, _, err := parseArgs(args, &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), drop) {
			t.Errorf("without %s: err = %v, want a complaint naming it", drop, err)
		}
	}
}

func TestParseArgsRejectsUnknownFlagsAndPositionals(t *testing.T) {
	var out bytes.Buffer
	if _, _, err := parseArgs(append(validArgs(t), "--auth-key", "tskey-abc"), &out); err == nil {
		t.Error("unknown flag accepted")
	}
	if _, _, err := parseArgs(append(validArgs(t), "extra"), &out); err == nil {
		t.Error("positional argument accepted")
	}
	if out.Len() != 0 {
		t.Errorf("parse errors must be returned, not printed; got %q", out.String())
	}
}

func TestParseArgsVersionNeedsNoOtherFlags(t *testing.T) {
	_, showVersion, err := parseArgs([]string{"--version"}, &bytes.Buffer{})
	if err != nil || !showVersion {
		t.Fatalf("showVersion = %v, err = %v", showVersion, err)
	}
}

func TestParseArgsHelpPrintsUsage(t *testing.T) {
	var out bytes.Buffer
	_, _, err := parseArgs([]string{"--help"}, &out)
	if !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("err = %v, want flag.ErrHelp", err)
	}
	for _, name := range []string{"--state-dir", "--hostname", "--target", "--version"} {
		// The flag package prints single-dash names.
		if !strings.Contains(out.String(), strings.TrimPrefix(name, "-")) {
			t.Errorf("usage does not mention %s:\n%s", name, out.String())
		}
	}
}

func argsWith(t *testing.T, flagName, value string) []string {
	t.Helper()
	args := validArgs(t)
	for i := 0; i < len(args); i += 2 {
		if args[i] == flagName {
			args[i+1] = value
		}
	}
	return args
}

// The realMain tests only use flags that fail validation or print and exit. A
// valid command line would start a real tsnet server against the Tailscale
// control plane, which no test may do.

func TestRealMainVersion(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := realMain([]string{"--version"}, strings.NewReader(""), &stdout, &stderr); code != exitOK {
		t.Fatalf("exit = %d", code)
	}
	line := strings.TrimSpace(stdout.String())
	if !strings.HasPrefix(line, "nanachi-tsnet "+version) || !strings.Contains(line, "tailscale.com v") {
		t.Errorf("version line = %q", line)
	}
}

func TestRealMainHelpExitsZero(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := realMain([]string{"--help"}, strings.NewReader(""), &stdout, &stderr); code != exitOK {
		t.Fatalf("exit = %d, want 0", code)
	}
	if stdout.Len() != 0 {
		t.Errorf("--help must not write JSON to stdout, got %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "state-dir") {
		t.Errorf("usage missing from stderr: %q", stderr.String())
	}
}

func TestRealMainInvalidFlagsReportAnErrorEventAndExit2(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := realMain([]string{"--state-dir", absDir(t), "--hostname", "Bad_Name", "--target", "http://127.0.0.1:7777"}, strings.NewReader(""), &stdout, &stderr)
	if code != exitUsageErr {
		t.Fatalf("exit = %d, want %d", code, exitUsageErr)
	}
	var ev struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &ev); err != nil {
		t.Fatalf("stdout %q is not one JSON object: %v", stdout.String(), err)
	}
	if ev.Type != "error" || !strings.Contains(ev.Message, "--hostname") {
		t.Errorf("event = %+v", ev)
	}
	if !strings.Contains(stderr.String(), "--hostname") {
		t.Errorf("stderr = %q, want a human message", stderr.String())
	}
}
