package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/routes"
)

// testAgent returns an agent as CheckProfile would leave it on a daemon with
// runc and runsc, without a Docker client.
func testAgent(profile string, allowRunc bool) *Agent {
	a := New(Config{Profile: profile, AllowRunc: allowRunc, DefaultRuntime: "runsc", GatewayName: "tryout-gateway", MaxAge: 3600e9}, nil, nil, &fakeGateway{})
	a.policy.Runtimes = map[string]bool{"runc": true, "runsc": true}
	return a
}

// fakeGateway records the route tables the agent pushes.
type fakeGateway struct {
	mu     sync.Mutex
	tables [][]routes.Route
}

// Put records table.
func (g *fakeGateway) Put(_ context.Context, table []routes.Route) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	g.tables = append(g.tables, table)
	return nil
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
