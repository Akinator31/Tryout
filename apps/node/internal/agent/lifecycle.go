package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/logging"
	"github.com/Akinator31/Tryout/apps/node/internal/session"
)

// errNodeFull refuses a session when the node runs MAX_SESSIONS already.
var errNodeFull = errors.New("node full")

// create starts a session: it pulls the image if needed, creates the
// session's --internal network and its hardened container, attaches the
// gateway to the network, starts the container and pushes the new route
// table. A failure after the network exists removes everything it made.
func (a *Agent) create(ctx context.Context, r session.Request) error {
	if err := a.reserveSlot(ctx, r.ID); err != nil {
		return err
	}
	defer a.finishCreating(r.ID)

	if err := a.ensureImage(ctx, r.Image); err != nil {
		return err
	}

	name := session.Name(r.ID)
	if err := a.createSessionNetwork(ctx, r.ID, name); err != nil {
		return err
	}

	if err := a.startSessionContainer(ctx, r, name); err != nil {
		a.destroy(context.WithoutCancel(ctx), r.ID)
		return err
	}

	slog.Info("session started", "id", logging.ID(r.ID), "project", r.Project, "runtime", r.Runtime, "kind", r.Kind)
	a.pushRoutes(ctx)
	return nil
}

// reserveSlot marks a session as being created, unless it already is or the
// node is full (MAX_SESSIONS, counting the sessions still being created).
// The count and the mark happen under the same lock, so two concurrent
// requests cannot both take the last slot.
func (a *Agent) reserveSlot(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.creating[id] {
		return errors.New("already creating")
	}

	n, err := a.countSessions(ctx)
	if err != nil {
		return err
	}
	if n+len(a.creating) >= a.maxSessions {
		return errNodeFull
	}

	a.creating[id] = true
	return nil
}

// countSessions counts the session containers on the node, in any state.
func (a *Agent) countSessions(ctx context.Context) (int, error) {
	cs, err := a.docker.ContainerList(ctx, session.LabelSession)
	return len(cs), err
}

// ensureImage pulls ref when it is missing, with the credentials of its
// registry if any, and refuses an image built for another
// architecture than the node's.
func (a *Agent) ensureImage(ctx context.Context, ref string) error {
	img, err := a.docker.ImageInspect(ctx, ref)
	if dockerapi.IsNotFound(err) {
		slog.Info("pulling image", "ref", ref)
		if err := a.docker.ImagePull(ctx, ref, a.registry.HeaderFor(ref)); err != nil {
			return err
		}
		img, err = a.docker.ImageInspect(ctx, ref)
	}
	if err != nil {
		return err
	}

	if normArch(img.Architecture) != a.arch {
		return fmt.Errorf("image %s is %s but this node is %s (build a multi-arch image or assign the project to another node)", ref, img.Architecture, a.arch)
	}
	return nil
}

// createSessionNetwork creates the session's own network. It is --internal:
// the session has no egress, and only the gateway joins it.
func (a *Agent) createSessionNetwork(ctx context.Context, id, name string) error {
	_, err := a.docker.NetworkCreate(ctx, dockerapi.NetworkCreate{
		Name:     name,
		Driver:   "bridge",
		Internal: true,
		Labels:   map[string]string{session.LabelSession: id},
		Options:  map[string]string{"com.docker.network.bridge.enable_icc": "true"},
	})
	if err != nil {
		return fmt.Errorf("network: %w", err)
	}
	return nil
}

// startSessionContainer creates the hardened container on the session
// network, attaches the gateway to that network, then starts the container.
func (a *Agent) startSessionContainer(ctx context.Context, r session.Request, name string) error {
	if _, err := a.docker.ContainerCreate(ctx, name, session.Spec(r, name, time.Now())); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	if err := a.docker.NetworkConnect(ctx, name, a.gatewayName); err != nil {
		return fmt.Errorf("attach gateway: %w", err)
	}
	if err := a.docker.ContainerStart(ctx, name); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	return nil
}

// remove destroys a session on the control plane's request. The id is marked
// so that the reconcile loop leaves it alone meanwhile.
func (a *Agent) remove(ctx context.Context, id string) {
	a.startDestroying(id)
	defer a.finishDestroying(id)

	a.destroy(ctx, id)
}

// destroy removes a session's container, detaches the gateway and removes the
// network. Each step tolerates what is already gone, so destroy can clean up
// a half-created session or run twice. It reports whether the container is
// gone; the other steps are retried by the next reconcile pass.
func (a *Agent) destroy(ctx context.Context, id string) bool {
	name := session.Name(id)

	removed := true
	if err := a.docker.ContainerRemove(ctx, name); err != nil && !dockerapi.IsNotFound(err) {
		slog.Warn("remove container", "id", logging.ID(id), "err", err)
		removed = false
	}
	if err := a.docker.NetworkDisconnect(ctx, name, a.gatewayName); err != nil && !dockerapi.IsNotFound(err) {
		slog.Debug("disconnect gateway", "id", logging.ID(id), "err", err)
	}
	if err := a.docker.NetworkRemove(ctx, name); err != nil && !dockerapi.IsNotFound(err) {
		slog.Warn("remove network", "id", logging.ID(id), "err", err)
	}

	slog.Info("session destroyed", "id", logging.ID(id))
	return removed
}
