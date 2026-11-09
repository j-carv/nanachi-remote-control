package main

import (
	"bytes"
	"encoding/json"
	"io"
	"sort"
	"strings"
	"sync"

	"tailscale.com/ipn/ipnstate"
)

// Event types written to stdout, one JSON object per line.
const (
	typeNeedsLogin = "needs_login"
	typeRunning    = "running"
	typeStopped    = "stopped"
	typeError      = "error"
)

// Event is one status line for Desktop. Only the fields of its type are encoded:
//
//	{"type":"needs_login","authUrl":"..."}
//	{"type":"running","dnsName":"...","tailnet":"...","ips":["..."]}
//	{"type":"stopped"}
//	{"type":"error","message":"..."}
type Event struct {
	Type    string
	AuthURL string
	DNSName string
	Tailnet string
	IPs     []string
	Message string
}

// MarshalJSON encodes the event with exactly the fields of its type. Use encodeLine to
// write one: json.Marshal would escape <, > and & again.
func (e Event) MarshalJSON() ([]byte, error) {
	switch e.Type {
	case typeNeedsLogin:
		return marshalPlain(struct {
			Type    string `json:"type"`
			AuthURL string `json:"authUrl"`
		}{e.Type, e.AuthURL})
	case typeRunning:
		ips := e.IPs
		if ips == nil {
			ips = []string{}
		}
		return marshalPlain(struct {
			Type    string   `json:"type"`
			DNSName string   `json:"dnsName"`
			Tailnet string   `json:"tailnet"`
			IPs     []string `json:"ips"`
		}{e.Type, e.DNSName, e.Tailnet, ips})
	case typeError:
		return marshalPlain(struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}{e.Type, e.Message})
	default:
		return marshalPlain(struct {
			Type string `json:"type"`
		}{e.Type})
	}
}

// marshalPlain is json.Marshal without HTML escaping: login URLs and messages
// contain & and <, and Desktop reads these lines as text too.
func marshalPlain(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func errorEvent(message string) Event { return Event{Type: typeError, Message: message} }

// eventFromStatus maps the LocalClient status to an event. ok is false while the
// node has nothing to report yet (starting, or logging in before control has
// handed out the login URL).
func eventFromStatus(st *ipnstate.Status) (ev Event, ok bool) {
	if st == nil {
		return Event{}, false
	}
	switch st.BackendState {
	case "NeedsLogin":
		if st.AuthURL == "" {
			return Event{}, false
		}
		return Event{Type: typeNeedsLogin, AuthURL: st.AuthURL}, true
	case "NeedsMachineAuth":
		return errorEvent("this device must be approved by an admin of the tailnet before it can connect"), true
	case "Stopped":
		return Event{Type: typeStopped}, true
	case "Running":
		if st.Self == nil || len(st.TailscaleIPs) == 0 {
			return Event{}, false
		}
		dnsName := strings.TrimSuffix(st.Self.DNSName, ".")
		if dnsName == "" {
			return Event{}, false
		}
		ips := make([]string, 0, len(st.TailscaleIPs))
		for _, ip := range st.TailscaleIPs {
			ips = append(ips, ip.String())
		}
		return Event{Type: typeRunning, DNSName: dnsName, Tailnet: tailnetName(st), IPs: ips}, true
	default: // NoState, Starting
		return Event{}, false
	}
}

// tailnetName is the tailnet's display name, or its MagicDNS suffix when control
// did not send a name.
func tailnetName(st *ipnstate.Status) string {
	if st.CurrentTailnet == nil {
		return ""
	}
	if st.CurrentTailnet.Name != "" {
		return st.CurrentTailnet.Name
	}
	return st.CurrentTailnet.MagicDNSSuffix
}

// Reporter writes events to out as JSON lines and drops repeats.
//
// Node status and listener errors have separate lifecycles. Errors are tracked by
// listener, so recovery on 443 cannot clear a failure on 8443. While any listener
// is failing, a combined error remains the latest event even if node state changes.
type Reporter struct {
	mu            sync.Mutex
	out           io.Writer
	lastStatus    string // JSON line of the last node status event
	servingErrors map[string]string
}

// NewReporter returns a Reporter that writes to out.
func NewReporter(out io.Writer) *Reporter { return &Reporter{out: out} }

// Status writes ev unless it equals the previous node status. Outstanding serving
// errors are repeated after changed node status, and cleared only when stopped.
func (r *Reporter) Status(ev Event) bool {
	line := encodeLine(ev)
	r.mu.Lock()
	defer r.mu.Unlock()
	if line == r.lastStatus {
		return false
	}
	r.lastStatus = line
	if ev.Type == typeStopped {
		r.servingErrors = nil
	}
	r.write(line)
	if len(r.servingErrors) != 0 {
		r.writeServingErrors()
	}
	return true
}

// Error records a listener failure, deduplicated independently of other listeners.
func (r *Reporter) Error(source, message string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.servingErrors[source] == message {
		return false
	}
	if r.servingErrors == nil {
		r.servingErrors = make(map[string]string)
	}
	r.servingErrors[source] = message
	r.writeServingErrors()
	return true
}

// Recovered clears only this listener's failure. Node status is restored only
// after every listener has recovered; otherwise the remaining errors are written.
func (r *Reporter) Recovered(source string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.servingErrors[source]; !ok {
		return false
	}
	delete(r.servingErrors, source)
	if len(r.servingErrors) != 0 {
		r.writeServingErrors()
		return true
	}
	if r.lastStatus == "" {
		return false
	}
	r.write(r.lastStatus)
	return true
}

// writeServingErrors runs with mu held and keeps combined messages deterministic.
func (r *Reporter) writeServingErrors() {
	sources := make([]string, 0, len(r.servingErrors))
	for source := range r.servingErrors {
		sources = append(sources, source)
	}
	sort.Strings(sources)
	messages := make([]string, 0, len(sources))
	for _, source := range sources {
		messages = append(messages, r.servingErrors[source])
	}
	r.write(encodeLine(errorEvent(strings.Join(messages, "; "))))
}

func (r *Reporter) write(line string) {
	// A broken stdout pipe means Desktop is gone; stdin EOF will end the process.
	_, _ = io.WriteString(r.out, line)
}

// encodeLine renders an event as a single newline-terminated JSON line.
func encodeLine(ev Event) string {
	// MarshalJSON directly: going through json.Marshal would re-escape the output.
	b, err := ev.MarshalJSON()
	if err != nil { // cannot happen: every field is a string or []string
		b = []byte(`{"type":"error","message":"internal error encoding status"}`)
	}
	return string(b) + "\n"
}
