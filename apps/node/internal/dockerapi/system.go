package dockerapi

import (
	"context"
	"net/http"
)

// Info holds the fields of GET /info the agent uses.
type Info struct {
	Architecture    string
	SecurityOptions []string
	Runtimes        map[string]any
	DefaultRuntime  string
	CgroupVersion   string
}

// Info describes the daemon: architecture, runtimes, rootless mode, cgroup
// version.
func (c *Client) Info(ctx context.Context) (*Info, error) {
	var i Info
	return &i, c.do(ctx, http.MethodGet, "/info", nil, &i)
}
