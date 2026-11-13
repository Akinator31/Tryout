package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// route is one entry of the gateway's route table: /s/<ID>/ goes to Target.
type route struct {
	ID          string `json:"id"`
	Target      string `json:"target"`
	StripPrefix bool   `json:"strip_prefix"`
}

// pushRoutes sends the gateway the full route table of the running sessions.
// The table is rebuilt from Docker labels each time, so a push also repairs a
// gateway that restarted with an empty table. Failures are logged only: the
// next reconcile pass pushes again.
func (a *agent) pushRoutes(ctx context.Context) {
	cs, err := a.docker.ContainerList(ctx, labelSession)
	if err != nil {
		slog.Warn("list for routes", "err", err)
		return
	}

	a.putRoutes(ctx, runningRoutes(cs))
}

// runningRoutes builds the routes of the running session containers. The
// target is the container's name on the session network, which the gateway
// joins.
func runningRoutes(cs []dockerapi.ContainerSummary) []route {
	routes := []route{}
	for _, c := range cs {
		if c.State != "running" {
			continue
		}

		id := c.Labels[labelSession]
		routes = append(routes, route{
			ID:          id,
			Target:      fmt.Sprintf("http://%s%s:%s", namePrefix, id, c.Labels[labelPort]),
			StripPrefix: c.Labels[labelStrip] == "true",
		})
	}
	return routes
}

// putRoutes calls PUT /routes on the gateway admin API, over its unix socket,
// with the shared bearer token.
func (a *agent) putRoutes(ctx context.Context, routes []route) {
	b, _ := json.Marshal(routes)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPut, "http://gateway/routes", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+a.cfg.gatewayToken)

	resp, err := a.gatewayHTTP.Do(req)
	if err != nil {
		slog.Warn("push routes", "err", err)
		return
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		slog.Warn("push routes", "status", resp.StatusCode)
	}
}
