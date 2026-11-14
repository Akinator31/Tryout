// Package logging gives the agent and the gateway the control plane's log
// format: one JSON object per line on stdout, with the time under "t" and the
// message under "msg".
//
// Session ids are the credentials in session URLs, so every line keeps only a
// prefix of each, wherever it appears.
package logging

import (
	"fmt"
	"io"
	"log"
	"log/slog"
	"regexp"
	"strings"
)

// idPrefix is how many characters of a session id a log line keeps.
const idPrefix = 6

// sessionID matches a session id (26 lower-case letters or digits, as the
// agent accepts them) inside a longer text, such as a container name in a
// Docker error.
var sessionID = regexp.MustCompile(`\b[a-z0-9]{26}\b`)

// clientAddr matches an "address:port" pair as net/http prints a peer, IPv4
// or bracketed IPv6.
var clientAddr = regexp.MustCompile(`(\[[0-9a-fA-F:.%]+\]|\b\d{1,3}(\.\d{1,3}){3}):\d+\b`)

// New returns a JSON logger writing to w, at level info and above.
func New(w io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{ReplaceAttr: replaceAttr}))
}

// HTTPErrorLog returns a standard logger for http.Server and
// httputil.ReverseProxy on a public listener. Their lines name the peer's
// address, which is the visitor's IP address, so it is removed.
func HTTPErrorLog(l *slog.Logger) *log.Logger {
	return log.New(peerFilter{l}, "", 0)
}

// peerFilter logs each line written by net/http as a warning, without the
// peer's address.
type peerFilter struct{ l *slog.Logger }

// Write logs one line.
func (f peerFilter) Write(p []byte) (int, error) {
	line := strings.TrimSpace(string(p))
	f.l.Warn(clientAddr.ReplaceAllString(line, "<client>"))
	return len(p), nil
}

// replaceAttr maps slog's built-in keys onto the control plane's ("t" for the
// time, in UTC with milliseconds, and a lower-case level) and shortens session
// ids in every other value, the message included.
func replaceAttr(groups []string, a slog.Attr) slog.Attr {
	if len(groups) == 0 {
		switch a.Key {
		case slog.TimeKey:
			return slog.String("t", a.Value.Time().UTC().Format("2006-01-02T15:04:05.000Z"))
		case slog.LevelKey:
			return slog.String(slog.LevelKey, strings.ToLower(a.Value.String()))
		}
	}
	return redact(a)
}

// redact shortens every session id inside a value. A value that is neither
// text nor a number is printed with fmt first when its text holds an id.
func redact(a slog.Attr) slog.Attr {
	switch a.Value.Kind() {
	case slog.KindString:
		return slog.String(a.Key, shorten(a.Value.String()))
	case slog.KindAny:
		text := fmt.Sprint(a.Value.Any())
		if _, isErr := a.Value.Any().(error); isErr || sessionID.MatchString(text) {
			return slog.String(a.Key, shorten(text))
		}
	}
	return a
}

// shorten replaces every session id in a text by its prefix.
func shorten(text string) string {
	return sessionID.ReplaceAllStringFunc(text, ID)
}

// ID shortens a session id for a log line, so logs keep only enough of it to
// correlate lines.
func ID(id string) string {
	if id == "" {
		return ""
	}
	return id[:min(len(id), idPrefix)] + "…"
}
