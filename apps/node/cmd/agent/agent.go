package main

import (
	"net/http"
	"sync"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/registryauth"
)

// agent holds the node's state. Docker labels are the source of truth for
// sessions; the agent itself only remembers the sessions it is creating or
// removing right now, so that the reconcile loop leaves them alone.
type agent struct {
	cfg      config
	docker   *dockerapi.Client
	arch     string              // normalised daemon architecture, set by checkProfile
	runtimes map[string]bool     // runtimes installed on the daemon, set by checkProfile
	registry *registryauth.Store // nil: anonymous pulls

	gatewayHTTP *http.Client // over the shared unix socket
	metrics     *agentMetrics

	mu         sync.Mutex
	creating   map[string]bool // ids being created: reconciler must not touch them
	destroying map[string]bool // ids being removed through the API: same
}

// newAgent wires an agent. checkProfile must run before it serves requests.
func newAgent(cfg config, docker *dockerapi.Client, registry *registryauth.Store, gatewayHTTP *http.Client) *agent {
	return &agent{
		cfg:         cfg,
		docker:      docker,
		registry:    registry,
		gatewayHTTP: gatewayHTTP,
		metrics:     newAgentMetrics(),
		creating:    map[string]bool{},
		destroying:  map[string]bool{},
	}
}

// finishCreating forgets a session once create has returned, successfully or not.
func (a *agent) finishCreating(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	delete(a.creating, id)
}

// startDestroying marks a session as being removed through the API.
func (a *agent) startDestroying(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.destroying[id] = true
}

// finishDestroying forgets a session once remove has returned.
func (a *agent) finishDestroying(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	delete(a.destroying, id)
}

// busyIDs returns a snapshot of the sessions being created or removed.
func (a *agent) busyIDs() map[string]bool {
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
