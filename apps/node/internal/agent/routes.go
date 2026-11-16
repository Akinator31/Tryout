package agent

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/routes"
	"github.com/Akinator31/Tryout/apps/node/internal/session"
)

// pushRoutes sends the gateway the full route table of the running sessions.
// The table is rebuilt from Docker labels each time, so a push also repairs a
// gateway that restarted with an empty table. Failures are logged only: the
// next reconcile pass pushes again.
func (a *Agent) pushRoutes(ctx context.Context) {
	cs, err := a.docker.ContainerList(ctx, session.LabelSession)
	if err != nil {
		slog.Warn("list for routes", "err", err)
		return
	}

	if err := a.gateway.Put(ctx, runningRoutes(cs)); err != nil {
		slog.Warn("push routes", "err", err)
	}
}

// runningRoutes builds the routes of the running session containers. The
// target is the container's name on the session network, which the gateway
// joins.
func runningRoutes(cs []dockerapi.ContainerSummary) []routes.Route {
	table := []routes.Route{}
	for _, c := range cs {
		if c.State != "running" {
			continue
		}

		id := c.Labels[session.LabelSession]
		table = append(table, routes.Route{
			ID:          id,
			Target:      fmt.Sprintf("http://%s:%s", session.Name(id), c.Labels[session.LabelPort]),
			StripPrefix: c.Labels[session.LabelStrip] == "true",
		})
	}
	return table
}
