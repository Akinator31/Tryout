package logging

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestNewWritesOneJSONObjectPerLine(t *testing.T) {
	var buf bytes.Buffer
	New(&buf).Info("session started", "project", "cli-hello")

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("not JSON: %q", buf.String())
	}
	if line["msg"] != "session started" || line["project"] != "cli-hello" || line["level"] != "info" {
		t.Fatalf("unexpected line: %v", line)
	}
	if _, ok := line["time"]; ok {
		t.Fatalf("time must be logged as t: %v", line)
	}
	stamp, ok := line["t"].(string)
	if !ok {
		t.Fatalf("missing t: %v", line)
	}
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", stamp); err != nil {
		t.Fatalf("t is not an ISO 8601 UTC time with milliseconds: %q", stamp)
	}
}

func TestNewHidesDebug(t *testing.T) {
	var buf bytes.Buffer
	New(&buf).Debug("noise")
	if buf.Len() != 0 {
		t.Fatalf("debug logged: %q", buf.String())
	}
}

func TestNewLowercasesLevels(t *testing.T) {
	var buf bytes.Buffer
	New(&buf).Warn("w", slog.String("err", "boom"))

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line["err"] != "boom" || line["level"] != "warn" {
		t.Fatalf("unexpected line: %v", line)
	}
}

func TestIDKeepsOnlyAPrefix(t *testing.T) {
	cases := map[string]string{
		"abcdefghijklmnopqrstuvwxyz": "abcdef…",
		"abcdef":                     "abcdef…",
		"abc":                        "abc…",
		"":                           "",
	}
	for in, want := range cases {
		if got := ID(in); got != want {
			t.Errorf("ID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNewShortensSessionIDsInsideValues(t *testing.T) {
	var buf bytes.Buffer
	id := "abcdefghijklmnopqrstuvwxyz"
	New(&buf).Warn("remove container",
		"err", errors.New("No such container: tryout-s-"+id),
		"url", "https://n.example/s/"+id+"/",
		"note", "the word incomprehensibilities stays") // 25 letters, not an id

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line["err"] != "No such container: tryout-s-abcdef…" {
		t.Errorf("err = %v", line["err"])
	}
	if line["url"] != "https://n.example/s/abcdef…/" {
		t.Errorf("url = %v", line["url"])
	}
	if line["note"] != "the word incomprehensibilities stays" {
		t.Errorf("note = %v", line["note"])
	}
	if strings.Contains(buf.String(), id) {
		t.Fatalf("full id logged: %s", buf.String())
	}
}

func TestNewShortensIDsInMessagesAndOtherValues(t *testing.T) {
	var buf bytes.Buffer
	id := "0189abcdefghijklmnopqrstuv"
	u, _ := url.Parse("https://n.example/s/" + id + "/")
	New(&buf).Info("http: proxy error for /s/"+id+"/", "url", u, "ids", []string{id}, "n", 3)

	out := buf.String()
	if strings.Contains(out, id) {
		t.Fatalf("full id logged: %s", out)
	}
	if !strings.Contains(out, `"n":3`) {
		t.Fatalf("numbers must stay numbers: %s", out)
	}
}

func TestHTTPErrorLogRemovesPeerAddresses(t *testing.T) {
	var buf bytes.Buffer
	l := HTTPErrorLog(New(&buf))
	l.Printf("http: panic serving 203.0.113.7:51234: boom")
	l.Printf("http: TLS handshake error from [2001:db8::1]:443: EOF")

	out := buf.String()
	for _, peer := range []string{"203.0.113.7", "2001:db8::1"} {
		if strings.Contains(out, peer) {
			t.Fatalf("peer address logged: %s", out)
		}
	}
	if strings.Count(out, `"level":"warn"`) != 2 || !strings.Contains(out, "panic serving <client>: boom") {
		t.Fatalf("unexpected lines: %s", out)
	}
}
