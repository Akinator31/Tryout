// tryout-agent: the only component that talks to Docker on a sandbox node.
//
// This package reads the environment, loads the mutual TLS configuration and
// wires the agent (package internal/agent) to Docker, the registry
// credentials and the gateway's admin socket.
//
// Files of this package: main.go (wiring), config.go (environment
// variables), tls.go (the API's mutual TLS configuration).
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/agent"
	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/logging"
	"github.com/Akinator31/Tryout/apps/node/internal/registryauth"
	"github.com/Akinator31/Tryout/apps/node/internal/routes"
	"github.com/Akinator31/Tryout/apps/node/internal/version"
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

	docker, err := dockerapi.New(cfg.agent.DockerHost)
	if err != nil {
		fatal("docker client", "err", err)
	}
	registry, err := loadRegistry(cfg.registryAuthFile)
	if err != nil {
		fatal("refusing to start: REGISTRY_AUTH_FILE", "err", err)
	}
	a := agent.New(cfg.agent, docker, registry, routes.NewClient(cfg.gatewaySocket, cfg.gatewayToken))

	ctx := context.Background()
	if err := a.CheckProfile(ctx); err != nil {
		fatal("refusing to start", "err", err)
	}

	go a.ReconcileForever(ctx)
	go warnExpiryForever(certs)

	srv := &http.Server{Addr: cfg.listen, Handler: a.Handler(), TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("agent listening (mutual TLS)", "addr", cfg.listen, "version", version.Version, "profile", cfg.agent.Profile, "default_runtime", a.DefaultRuntime())
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
