// tryout-agent: the only component that talks to Docker on a sandbox node.
//
// It exposes a small private HTTP API used by the control plane, over mutual
// TLS only, creates one hardened container + one --internal network per
// session, attaches the gateway to that network, and pushes the route table
// to the gateway. A reconcile loop removes expired/dead sessions and orphans,
// and attaches a recreated gateway again to every running session network.
//
// Files of this package, by responsibility:
//
//	config.go     environment variables
//	agent.go      the agent and its in-flight session bookkeeping
//	profile.go    startup checks: node profile and runtime policy
//	session.go    POST /v1/sessions body: validation, defaults, environment policy
//	hardening.go  the container specification (the hardening)
//	lifecycle.go  create, destroy and remove a session
//	reconcile.go  the reconcile loop and gateway reattachment
//	routes.go     the route table pushed to the gateway
//	api.go        HTTP handlers
//	tls.go        the API's mutual TLS configuration
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/logging"
	"github.com/Akinator31/Tryout/apps/node/internal/registryauth"
)

func main() {
	slog.SetDefault(logging.New(os.Stdout))

	cfg := loadConfig()
	if cfg.gatewayToken == "" {
		fatal("GATEWAY_TOKEN required")
	}

	tlsCfg, certs, err := serverTLS(cfg, time.Now())
	if err != nil {
		fatal("refusing to start", "err", err)
	}
	warnExpiry(certs, time.Now())

	docker, err := dockerapi.New(cfg.dockerHost)
	if err != nil {
		fatal("docker client", "err", err)
	}
	registry, err := loadRegistry(cfg.registryAuthFile)
	if err != nil {
		fatal("refusing to start: REGISTRY_AUTH_FILE", "err", err)
	}
	a := newAgent(cfg, docker, registry, unixSocketClient(cfg.gatewaySocket))

	ctx := context.Background()
	if err := a.checkProfile(ctx); err != nil {
		fatal("refusing to start", "err", err)
	}

	go a.reconcileForever(ctx)
	go warnExpiryForever(certs)

	srv := &http.Server{Addr: cfg.listen, Handler: a.apiHandler(), TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("agent listening (mutual TLS)", "addr", cfg.listen, "profile", cfg.profile, "default_runtime", a.cfg.defaultRuntime)
	if err := srv.ListenAndServeTLS("", ""); err != nil {
		fatal("server", "err", err)
	}
}

// fatal logs an error and exits. At startup, this is how the agent refuses a
// configuration it cannot honour.
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

// loadRegistry reads the registry credentials of REGISTRY_AUTH_FILE.
// No file means anonymous pulls: it returns a nil store, which sends nothing.
func loadRegistry(path string) (*registryauth.Store, error) {
	if path == "" {
		return nil, nil
	}

	store, err := registryauth.Load(path)
	if err != nil {
		return nil, err
	}

	slog.Info("registry credentials loaded", "registries", store.Registries())
	return store, nil
}

// unixSocketClient returns an HTTP client that sends every request to the
// unix socket at path, whatever the URL's host. The gateway admin API never
// listens on TCP: the gateway joins every session network, so a TCP port
// would be reachable from the sessions.
func unixSocketClient(path string) *http.Client {
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}
	return &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DialContext: dial}}
}
