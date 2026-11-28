// Package agent is the only part of Tryout that talks to Docker on a sandbox
// node. It serves a small private API to the control plane, creates one
// hardened container and one --internal network per session (the container
// itself comes from package session), attaches the gateway to that network
// and pushes the route table to the gateway. A reconcile loop removes
// expired, dead and stuck sessions and orphans, and attaches a recreated
// gateway again to every running session network.
//
// Files of this package, by responsibility:
//
//	agent.go      the agent and its in-flight session bookkeeping
//	profile.go    startup checks: Docker version, node profile, runtime policy
//	ttyd.go       startup: the ttyd image mounted into terminals
//	gpu.go        startup: the GPU check; the cap on GPU sessions
//	lifecycle.go  create, destroy and remove a session
//	reconcile.go  the reconcile loop and gateway reattachment
//	routes.go     the route table pushed to the gateway
//	api.go        HTTP handlers
//	metrics.go    Prometheus metrics
package agent

import (
	"context"
	"sync"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/registryauth"
	"github.com/Akinator31/Tryout/apps/node/internal/routes"
	"github.com/Akinator31/Tryout/apps/node/internal/session"
)

// Config is the agent's configuration, from its environment variables.
type Config struct {
	DockerHost     string        // DOCKER_HOST, for error messages
	Profile        string        // NODE_PROFILE: dev | strict | single-host
	DefaultRuntime string        // DEFAULT_RUNTIME
	AllowRunc      bool          // ALLOW_RUNC
	GatewayName    string        // GATEWAY_CONTAINER
	MaxSessions    int           // MAX_SESSIONS
	MaxAge         time.Duration // SESSION_MAX_AGE_CAP
	TTYDImage      string        // TTYD_IMAGE: the ttyd mounted into terminals
	GPUDevices     []string      // GPU_DEVICES: CDI device names given to GPU sessions
	GPUSessions    int           // GPU_SESSIONS: cap on concurrent GPU sessions
}

// RouteTable is where the agent pushes the route table: the gateway's admin
// API (routes.Client), or a fake in the tests.
type RouteTable interface {
	Put(ctx context.Context, table []routes.Route) error
}

// Agent holds the node's state. Docker labels are the source of truth for
// sessions; the agent itself only remembers the sessions it is creating or
// removing right now, so that the reconcile loop leaves them alone.
type Agent struct {
	dockerHost  string
	gatewayName string
	maxSessions int
	gpuSessions int
	policy      session.Policy // the rest of Config, completed by CheckProfile
	arch        string         // normalised daemon architecture, set by CheckProfile
	docker      *dockerapi.Client
	registry    *registryauth.Store // nil: anonymous pulls
	gateway     RouteTable
	metrics     *agentMetrics

	mu          sync.Mutex
	creating    map[string]bool // ids being created: reconciler must not touch them
	creatingGPU map[string]bool // the GPU sessions among creating
	destroying  map[string]bool // ids being removed through the API: same
}

// New wires an agent. CheckProfile must succeed before it serves requests.
func New(cfg Config, docker *dockerapi.Client, registry *registryauth.Store, gateway RouteTable) *Agent {
	return &Agent{
		dockerHost:  cfg.DockerHost,
		gatewayName: cfg.GatewayName,
		maxSessions: cfg.MaxSessions,
		gpuSessions: cfg.GPUSessions,
		policy: session.Policy{
			Profile:        cfg.Profile,
			AllowRunc:      cfg.AllowRunc,
			DefaultRuntime: cfg.DefaultRuntime,
			MaxAge:         cfg.MaxAge,
			TTYDImage:      cfg.TTYDImage,
			GPUDevices:     cfg.GPUDevices,
		},
		docker:      docker,
		registry:    registry,
		gateway:     gateway,
		metrics:     newAgentMetrics(),
		creating:    map[string]bool{},
		creatingGPU: map[string]bool{},
		destroying:  map[string]bool{},
	}
}

// DefaultRuntime is the runtime of the sessions that name none, as
// CheckProfile settled it.
func (a *Agent) DefaultRuntime() string {
	return a.policy.DefaultRuntime
}

// finishCreating forgets a session once create has returned, successfully or not.
func (a *Agent) finishCreating(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	delete(a.creating, id)
	delete(a.creatingGPU, id)
}

// startDestroying marks a session as being removed through the API.
func (a *Agent) startDestroying(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.destroying[id] = true
}

// finishDestroying forgets a session once remove has returned.
func (a *Agent) finishDestroying(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	delete(a.destroying, id)
}

// creatingCount returns how many sessions are being created.
func (a *Agent) creatingCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()

	return len(a.creating)
}

// creatingGPUCount returns how many GPU sessions are being created.
func (a *Agent) creatingGPUCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()

	return len(a.creatingGPU)
}

// busyIDs returns a snapshot of the sessions being created or removed.
func (a *Agent) busyIDs() map[string]bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	busy := map[string]bool{}
	for id := range a.creating {
		busy[id] = true
	}
	for id := range a.destroying {
		busy[id] = true
	}
	return busy
}
