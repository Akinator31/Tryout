package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/session"
)

// sessionsDocker returns a fake Docker client listing one session container
// per "project/state" pair.
func sessionsDocker(t *testing.T, sessions ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/containers/json") {
			t.Errorf("unexpected docker call %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}

		out := []any{}
		for i, s := range sessions {
			project, state, _ := strings.Cut(s, "/")
			out = append(out, map[string]any{"Id": fmt.Sprint(i), "State": state, "Labels": map[string]string{session.LabelSession: fmt.Sprint(i), session.LabelProject: project}})
		}
		_ = json.NewEncoder(w).Encode(out)
	}
}

// serveAPI sends a GET to the agent's API and returns the recorded response.
func serveAPI(a *Agent, path string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

// TestHealthz: a node whose daemon answers reports its version, policy and
// load; a node whose daemon does not answers 503.
func TestHealthz(t *testing.T) {
	a := testAgent("strict", false)
	a.arch = "arm64"
	a.maxSessions = 4
	a.docker = fakeDockerClient(t, sessionsDocker(t, "hello/running", "hello/created"))

	rec := serveAPI(a, "/healthz")
	var got map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &got)

	want := map[string]any{"ok": true, "version": "dev", "profile": "strict", "arch": "arm64", "default_runtime": "runsc", "sessions": 2.0, "max_sessions": 4.0}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status %d", rec.Code)
	}

	a.docker = fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "daemon down", http.StatusInternalServerError)
	})
	rec = serveAPI(a, "/healthz")
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"ok":false`) {
		t.Errorf("daemon down: status %d, body %s", rec.Code, rec.Body)
	}
}

// TestMetrics checks the exposition: build info, sessions by project and
// state, the cap, start outcomes and reaping reasons.
func TestMetrics(t *testing.T) {
	a := testAgent("dev", false)
	a.arch = "amd64"
	a.maxSessions = 10
	a.docker = fakeDockerClient(t, sessionsDocker(t, "b/running", "a/running", "b/running", "a/created"))

	a.metrics.observeStart("a", 3*time.Second, nil)
	a.metrics.observeStart("a", 0, fmt.Errorf("reserve: %w", errNodeFull))
	a.metrics.observeStart("b", 0, errors.New("pull failed"))
	a.metrics.reaped.Inc("expired")

	rec := serveAPI(a, "/metrics")
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain; version=0.0.4") {
		t.Errorf("content type %q", ct)
	}

	body := rec.Body.String()
	for _, line := range []string{
		`tryout_agent_info{version="dev",profile="dev",default_runtime="runsc",arch="amd64"} 1`,
		`tryout_node_sessions{project="a",state="created"} 1`,
		`tryout_node_sessions{project="a",state="running"} 1`,
		`tryout_node_sessions{project="b",state="running"} 2`,
		`tryout_node_sessions_max 10`,
		`tryout_node_docker_up 1`,
		`tryout_session_starts_total{project="a",result="full"} 1`,
		`tryout_session_starts_total{project="a",result="ok"} 1`,
		`tryout_session_starts_total{project="b",result="error"} 1`,
		`tryout_session_start_seconds_bucket{project="a",le="2"} 0`,
		`tryout_session_start_seconds_bucket{project="a",le="5"} 1`,
		`tryout_session_start_seconds_count{project="a"} 1`,
		`tryout_sessions_reaped_total{reason="expired"} 1`,
	} {
		if !strings.Contains(body, line+"\n") {
			t.Errorf("missing %s", line)
		}
	}
	if t.Failed() {
		t.Log(body)
	}
}

// TestMetricsDockerDown: without a daemon, the counters are still served and
// tryout_node_docker_up says why the session gauge is missing.
func TestMetricsDockerDown(t *testing.T) {
	a := testAgent("dev", false)
	a.docker = fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) { http.Error(w, "down", http.StatusInternalServerError) })
	a.metrics.observeStart("a", 0, errors.New("docker down"))

	rec := serveAPI(a, "/metrics")
	body := rec.Body.String()
	if rec.Code != http.StatusOK || !strings.Contains(body, "tryout_node_docker_up 0\n") ||
		!strings.Contains(body, `tryout_session_starts_total{project="a",result="error"} 1`) ||
		strings.Contains(body, "tryout_node_sessions{") {
		t.Errorf("status %d, body:\n%s", rec.Code, body)
	}
}
