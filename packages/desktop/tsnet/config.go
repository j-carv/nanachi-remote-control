package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
)

// version is the sidecar's own version. Override at build time with
// -ldflags "-X main.version=<v>".
var version = "0.1.0"

// hostnamePattern is the contract for --hostname: lowercase letters, digits and
// hyphens, 1 to 63 characters (one DNS label). Tailscale sanitizes the rest.
var hostnamePattern = regexp.MustCompile(`^[a-z0-9-]{1,63}$`)

// config holds the validated command-line options.
type config struct {
	StateDir string
	Hostname string
	Target   *url.URL
}

// parseArgs parses and validates the command line. It returns showVersion=true
// for --version (no other validation is done then). For --help it prints the usage
// to usageOut and returns flag.ErrHelp so the caller can exit 0. Other errors are
// returned, not printed.
func parseArgs(args []string, usageOut io.Writer) (cfg config, showVersion bool, err error) {
	fs := flag.NewFlagSet("nanachi-tsnet", flag.ContinueOnError)
	fs.SetOutput(io.Discard) // errors are returned and printed once by the caller
	stateDir := fs.String("state-dir", "", "directory that holds the Tailscale node state (absolute path, required)")
	hostname := fs.String("hostname", "", "node name on the tailnet, [a-z0-9-]{1,63} (required)")
	target := fs.String("target", "", "daemon to proxy to: http://127.0.0.1:<port> or http://localhost:<port> (required)")
	fs.BoolVar(&showVersion, "version", false, "print the version and exit")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fs.SetOutput(usageOut)
			fmt.Fprintln(usageOut, "Usage: nanachi-tsnet --state-dir <dir> --hostname <name> --target <url>")
			fs.PrintDefaults()
		}
		return config{}, false, err
	}
	if showVersion {
		return config{}, true, nil
	}
	if fs.NArg() > 0 {
		return config{}, false, fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}

	dir, err := validateStateDir(*stateDir)
	if err != nil {
		return config{}, false, err
	}
	if err := validateHostname(*hostname); err != nil {
		return config{}, false, err
	}
	targetURL, err := validateTarget(*target)
	if err != nil {
		return config{}, false, err
	}
	return config{StateDir: dir, Hostname: *hostname, Target: targetURL}, false, nil
}

func validateStateDir(value string) (string, error) {
	if value == "" {
		return "", errors.New("--state-dir is required")
	}
	if !filepath.IsAbs(value) {
		return "", fmt.Errorf("--state-dir must be an absolute path, got %q", value)
	}
	return filepath.Clean(value), nil
}

func validateHostname(value string) error {
	if value == "" {
		return errors.New("--hostname is required")
	}
	if !hostnamePattern.MatchString(value) {
		return fmt.Errorf("--hostname must match [a-z0-9-]{1,63}, got %q", value)
	}
	return nil
}

// validateTarget accepts only http://127.0.0.1:<port> and http://localhost:<port>
// (an optional single trailing slash is tolerated). The sidecar must never proxy
// to anything but the local daemon.
func validateTarget(value string) (*url.URL, error) {
	if value == "" {
		return nil, errors.New("--target is required")
	}
	bad := func(reason string) (*url.URL, error) {
		return nil, fmt.Errorf("--target must be http://127.0.0.1:<port> or http://localhost:<port>: %s (got %q)", reason, value)
	}
	u, err := url.Parse(value)
	if err != nil {
		return bad("not a valid URL")
	}
	if u.Scheme != "http" {
		return bad("scheme must be http")
	}
	if u.User != nil {
		return bad("no credentials allowed")
	}
	if u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return bad("no path, query or fragment allowed")
	}
	host := strings.ToLower(u.Hostname())
	if host != "127.0.0.1" && host != "localhost" {
		return bad("host must be 127.0.0.1 or localhost")
	}
	port := u.Port()
	if port == "" || strings.Trim(port, "0123456789") != "" {
		return bad("a numeric port is required")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return bad("port must be between 1 and 65535")
	}
	return &url.URL{Scheme: "http", Host: host + ":" + strconv.Itoa(n)}, nil
}

// versionLine is what --version prints: the sidecar, the tailscale.com module
// it was built with, and the Go toolchain.
func versionLine() string {
	ts := "unknown"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == "tailscale.com" {
				ts = dep.Version
				break
			}
		}
	}
	return fmt.Sprintf("nanachi-tsnet %s (tailscale.com %s, %s)", version, ts, runtime.Version())
}
