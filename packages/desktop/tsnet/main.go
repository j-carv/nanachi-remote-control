// Command nanachi-tsnet is the Tailscale sidecar of Nanachi Desktop. It joins the
// tailnet as its own node (embedded tsnet, no system Tailscale needed) and serves
// the local Nanachi daemon over HTTPS on port 443 of that node, sending the same
// identity headers as `tailscale serve`. Status goes to stdout as JSON lines.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

func main() {
	os.Exit(realMain(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

// Exit codes.
const (
	exitOK       = 0
	exitFailure  = 1 // the node could not start
	exitUsageErr = 2 // invalid flags
)

func realMain(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	cfg, showVersion, err := parseArgs(args, stderr)
	switch {
	case errors.Is(err, flag.ErrHelp):
		return exitOK
	case err != nil:
		// One JSON line for Desktop, one human line for the log.
		rep := NewReporter(stdout)
		rep.Status(errorEvent(err.Error()))
		fmt.Fprintf(stderr, "nanachi-tsnet: %v\n", err)
		return exitUsageErr
	case showVersion:
		fmt.Fprintln(stdout, versionLine())
		return exitOK
	}

	// Shutdown: SIGINT/SIGTERM (on Windows Go maps CTRL_C, CTRL_BREAK, CTRL_CLOSE
	// and logoff/shutdown to these) and EOF on stdin, which is how Desktop asks
	// politely. Desktop kills the process tree if this takes too long.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		_, _ = io.Copy(io.Discard, stdin)
		cancel()
	}()

	srv := &tsnet.Server{
		Hostname: cfg.Hostname,
		Dir:      cfg.StateDir,
		Logf:     discardLogf,
		UserLogf: discardLogf,
	}
	rep := NewReporter(stdout)
	if err := run(ctx, cfg, &tsnetNode{srv: srv}, rep, defaultRunOptions(stderr)); err != nil {
		fmt.Fprintf(stderr, "nanachi-tsnet: %v\n", err)
		return exitFailure
	}
	return exitOK
}

func discardLogf(string, ...any) {}

// tsnetNode adapts a tsnet.Server to the node interface. It is the only place
// that touches the real Tailscale control plane, and nothing in the tests uses it.
type tsnetNode struct {
	srv *tsnet.Server
	lc  *local.Client // set by Start
}

func (n *tsnetNode) Start() error {
	if err := n.srv.Start(); err != nil {
		return err
	}
	lc, err := n.srv.LocalClient()
	if err != nil {
		return err
	}
	n.lc = lc
	return nil
}

func (n *tsnetNode) Status(ctx context.Context) (*ipnstate.Status, error) {
	return n.lc.StatusWithoutPeers(ctx)
}

func (n *tsnetNode) WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error) {
	return n.lc.WhoIs(ctx, remoteAddr)
}

func (n *tsnetNode) ListenTLS(network, addr string) (net.Listener, error) {
	return n.srv.ListenTLS(network, addr)
}

func (n *tsnetNode) Close() error { return n.srv.Close() }
