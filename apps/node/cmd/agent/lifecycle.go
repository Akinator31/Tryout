package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// Docker labels set on session containers and networks, and the prefix of
// their names (namePrefix + session id, for both).
const (
	labelSession = "tryout.session"
	labelProject = "tryout.project"
	labelExpires = "tryout.expires"
	labelPort    = "tryout.port"
	labelStrip   = "tryout.strip-prefix"
	namePrefix   = "tryout-s-"
)

// create starts a session: it pulls the image if needed, creates the
// session's --internal network and its hardened container, attaches the
// gateway to the network, starts the container and pushes the new route
// table. A failure after the network exists removes everything it made.
func (a *agent) create(ctx context.Context, r sessionReq) error {
	if err := a.reserveSlot(ctx, r.ID); err != nil {
		return err
	}
	defer a.finishCreating(r.ID)

	if err := a.ensureImage(ctx, r.Image); err != nil {
		return err
	}

	name := namePrefix + r.ID
	if err := a.createSessionNetwork(ctx, r.ID, name); err != nil {
		return err
	}

	if err := a.startSessionContainer(ctx, r, name); err != nil {
		a.destroy(context.WithoutCancel(ctx), r.ID)
		return err
	}

	slog.Info("session started", "id", r.ID, "project", r.Project, "runtime", r.Runtime, "kind", r.Kind)
	a.pushRoutes(ctx)
	return nil
}

// reserveSlot marks a session as being created, unless it already is or the
// node is full (MAX_SESSIONS, counting the sessions still being created).
// The count and the mark happen under the same lock, so two concurrent
// requests cannot both take the last slot.
func (a *agent) reserveSlot(ctx context.Context, id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.creating[id] {
		return errors.New("already creating")
	}

	n, err := a.countSessions(ctx)
	if err != nil {
		return err
	}
	if n+len(a.creating) >= a.cfg.maxSessions {
		return errors.New("node full")
	}

	a.creating[id] = true
	return nil
}

// countSessions counts the session containers on the node, in any state.
func (a *agent) countSessions(ctx context.Context) (int, error) {
	cs, err := a.docker.ContainerList(ctx, labelSession)
	return len(cs), err
}

// ensureImage pulls ref when it is missing, with the credentials of its
// registry if any (ADR 0017), and refuses an image built for another
// architecture than the node's.
func (a *agent) ensureImage(ctx context.Context, ref string) error {
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
func (a *agent) createSessionNetwork(ctx context.Context, id, name string) error {
	_, err := a.docker.NetworkCreate(ctx, dockerapi.NetworkCreate{
		Name:     name,
		Driver:   "bridge",
		Internal: true,
		Labels:   map[string]string{labelSession: id},
		Options:  map[string]string{"com.docker.network.bridge.enable_icc": "true"},
	})
	if err != nil {
		return fmt.Errorf("network: %w", err)
	}
	return nil
}

// startSessionContainer creates the hardened container on the session
// network, attaches the gateway to that network, then starts the container.
func (a *agent) startSessionContainer(ctx context.Context, r sessionReq, name string) error {
	if _, err := a.docker.ContainerCreate(ctx, name, a.containerSpec(r, name)); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	if err := a.docker.NetworkConnect(ctx, name, a.cfg.gatewayName); err != nil {
		return fmt.Errorf("attach gateway: %w", err)
	}
	if err := a.docker.ContainerStart(ctx, name); err != nil {
		return fmt.Errorf("start: %w", err)
	}
	return nil
}

// remove destroys a session on the control plane's request. The id is marked
// so that the reconcile loop leaves it alone meanwhile.
func (a *agent) remove(ctx context.Context, id string) {
	a.startDestroying(id)
	defer a.finishDestroying(id)

	a.destroy(ctx, id)
}

// destroy removes a session's container, detaches the gateway and removes the
// network. Each step tolerates what is already gone, so destroy can clean up
// a half-created session or run twice.
func (a *agent) destroy(ctx context.Context, id string) {
	name := namePrefix + id

	if err := a.docker.ContainerRemove(ctx, name); err != nil && !dockerapi.IsNotFound(err) {
		slog.Warn("remove container", "id", id, "err", err)
	}
	if err := a.docker.NetworkDisconnect(ctx, name, a.cfg.gatewayName); err != nil && !dockerapi.IsNotFound(err) {
		slog.Debug("disconnect gateway", "id", id, "err", err)
	}
	if err := a.docker.NetworkRemove(ctx, name); err != nil && !dockerapi.IsNotFound(err) {
		slog.Warn("remove network", "id", id, "err", err)
	}

	slog.Info("session destroyed", "id", id)
}
