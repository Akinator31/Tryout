package main

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/logging"
)

// reconcileInterval is the period of the reconcile loop.
const reconcileInterval = 10 * time.Second

// stuckCreatedAfter is how long a container may stay created, without a
// create in progress, before the reconcile loop reaps it.
const stuckCreatedAfter = time.Minute

// reconcileForever runs the reconcile loop for the agent's whole life.
func (a *agent) reconcileForever(ctx context.Context) {
	for {
		a.reconcile(ctx)
		time.Sleep(reconcileInterval)
	}
}

// reconcile brings the node back to the state its Docker labels describe:
// Docker labels are the source of truth on the node. It reaps expired, dead
// and stuck sessions (see shouldReap), removes orphan networks, attaches a recreated gateway again
// to running sessions and pushes the route table. Sessions being created or
// removed through the API are left alone.
func (a *agent) reconcile(ctx context.Context) {
	busy := a.busyIDs()

	cs, err := a.docker.ContainerList(ctx, labelSession)
	if err != nil {
		slog.Warn("reconcile list", "err", err)
		return
	}

	live, running := a.reapSessions(ctx, cs, busy)
	a.removeOrphanNetworks(ctx, live, busy)
	a.reattachGateway(ctx, running)
	a.pushRoutes(ctx)
}

// reapSessions destroys the sessions shouldReap selects. It returns the ids
// of the sessions still alive (busy ones included) and of those running.
func (a *agent) reapSessions(ctx context.Context, cs []dockerapi.ContainerSummary, busy map[string]bool) (live map[string]bool, running []string) {
	now := time.Now()
	live = map[string]bool{}

	for _, c := range cs {
		id := c.Labels[labelSession]
		if busy[id] {
			live[id] = true
			continue
		}

		if reason := shouldReap(c, now); reason != "" {
			slog.Info("reaping", "id", logging.ID(id), "state", c.State, "reason", reason)
			a.metrics.reaped.Inc(reason)
			a.destroy(ctx, id)
			continue
		}

		live[id] = true
		if c.State == "running" {
			running = append(running, id)
		}
	}
	return live, running
}

// shouldReap tells why a session container that no request is creating or
// removing must go, or returns "" to keep it: "expired" past its maximum age,
// "dead" when neither running nor created, "stuck" when created more than
// stuckCreatedAfter ago.
//
// A stuck container is the trace of a create aborted by the control plane
// (the visitor left while the session was starting): Docker can finish
// creating it after create's rollback ran. Nobody will start it, and kept, it
// would hold a slot until it expires. The age, read from the agent's own
// label, also protects a create that starts after the pass's busy snapshot.
func shouldReap(c dockerapi.ContainerSummary, now time.Time) string {
	created, _ := strconv.ParseInt(c.Labels[labelCreated], 10, 64)
	expires, _ := strconv.ParseInt(c.Labels[labelExpires], 10, 64)

	switch {
	case expires < now.Unix():
		return "expired"
	case c.State != "running" && c.State != "created":
		return "dead"
	case c.State == "created" && now.Sub(time.Unix(created, 0)) > stuckCreatedAfter:
		return "stuck"
	}
	return ""
}

// removeOrphanNetworks removes the session networks left without a live
// session container, such as after a crash between network and container
// creation.
func (a *agent) removeOrphanNetworks(ctx context.Context, live, busy map[string]bool) {
	nets, err := a.docker.NetworkList(ctx, labelSession)
	if err != nil {
		return
	}

	for _, n := range nets {
		if id := n.Labels[labelSession]; !live[id] && !busy[id] {
			slog.Info("removing orphan network", "id", logging.ID(id))
			a.destroy(ctx, id)
		}
	}
}

// reattachGateway attaches the gateway to the network of every running session
// it is missing from. A recreated gateway container (an upgrade, a manual
// `docker compose up`) keeps its name but loses the networks the agent
// connected it to, which would leave running sessions unreachable.
//
// Ids come from labels, not from the agent, so an invalid one is skipped.
func (a *agent) reattachGateway(ctx context.Context, running []string) {
	gw, err := a.docker.ContainerInspect(ctx, a.cfg.gatewayName)
	if err != nil {
		slog.Warn("inspect gateway", "name", a.cfg.gatewayName, "err", err)
		return
	}

	for _, id := range running {
		name := namePrefix + id
		if _, ok := gw.NetworkSettings.Networks[name]; ok {
			continue
		}
		if !sessionIDRe.MatchString(id) {
			slog.Warn("reattach gateway: invalid session label", "id", logging.ID(id))
			continue
		}
		a.connectGatewayUnlessBusy(ctx, id, name)
	}
}

// connectGatewayUnlessBusy attaches the gateway to a session network, unless
// the session is being created (create attaches the gateway itself) or
// removed through the API. The check and the connect happen under the lock
// remove takes, so a reattachment never lands between destroy's disconnect
// and its network removal.
func (a *agent) connectGatewayUnlessBusy(ctx context.Context, id, name string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.creating[id] || a.destroying[id] {
		return
	}

	if err := a.docker.NetworkConnect(ctx, name, a.cfg.gatewayName); err != nil {
		slog.Warn("reattach gateway", "id", logging.ID(id), "err", err)
		return
	}
	slog.Info("gateway reattached", "id", logging.ID(id))
}
