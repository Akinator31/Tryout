package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// testAgent returns an agent as checkProfile would leave it on a daemon with
// runc and runsc, without a Docker client.
func testAgent(profile string, allowRunc bool) *agent {
	return &agent{
		cfg: config{
			profile:        profile,
			allowRunc:      allowRunc,
			defaultRuntime: "runsc",
			maxAge:         3600e9,
		},
		runtimes: map[string]bool{"runc": true, "runsc": true},
	}
}

// validReq returns a minimal valid request of the given kind.
func validReq(kind sessionKind) sessionReq {
	return sessionReq{ID: strings.Repeat("a", 26), Project: "p", Image: "img", Kind: kind, Port: 3000}
}

// envMap returns the session's container environment as a map.
func envMap(r sessionReq) map[string]string {
	m := map[string]string{}
	for _, kv := range sessionEnv(r) {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

// fakeDockerClient returns a client for a fake Engine API served by handler.
func fakeDockerClient(t *testing.T, handler http.HandlerFunc) *dockerapi.Client {
	t.Helper()

	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	c, err := dockerapi.New("tcp://" + srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// writeTestFile writes b to dir/name and returns its path.
func writeTestFile(t *testing.T, dir, name string, b []byte) string {
	t.Helper()

	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}
