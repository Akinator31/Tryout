package main

import (
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/agent"
	"github.com/Akinator31/Tryout/apps/node/internal/version"
)

// config is the process's configuration, read once from the environment:
// the agent's own, and what main needs to wire it.
type config struct {
	agent            agent.Config
	listen           string
	tlsCert          string
	tlsKey           string
	tlsClientCA      string
	gatewaySocket    string
	gatewayToken     string
	registryAuthFile string // path of a config.json with registry credentials, optional
}

// loadConfig reads the agent's environment variables and applies their
// defaults. It does not validate them: CheckProfile and serverTLS do.
func loadConfig() config {
	maxSessions, _ := strconv.Atoi(env("MAX_SESSIONS", "10"))
	maxAge, _ := time.ParseDuration(env("SESSION_MAX_AGE_CAP", "2h"))

	return config{
		agent: agent.Config{
			DockerHost:     env("DOCKER_HOST", "unix:///var/run/docker.sock"),
			Profile:        env("NODE_PROFILE", "dev"),
			DefaultRuntime: env("DEFAULT_RUNTIME", "runsc"),
			AllowRunc:      env("ALLOW_RUNC", "false") == "true",
			GatewayName:    env("GATEWAY_CONTAINER", "tryout-gateway"),
			MaxSessions:    maxSessions,
			MaxAge:         maxAge,
			TTYDImage:      env("TTYD_IMAGE", version.TTYDImage),
		},
		listen:           env("AGENT_LISTEN", ":7000"),
		tlsCert:          os.Getenv("AGENT_TLS_CERT"),
		tlsKey:           os.Getenv("AGENT_TLS_KEY"),
		tlsClientCA:      os.Getenv("AGENT_TLS_CLIENT_CA"),
		gatewaySocket:    strings.TrimPrefix(env("GATEWAY_ADMIN_SOCKET", "unix:///run/tryout/gateway.sock"), "unix://"),
		gatewayToken:     os.Getenv("GATEWAY_TOKEN"),
		registryAuthFile: os.Getenv("REGISTRY_AUTH_FILE"),
	}
}

// env returns the environment variable k, or def when it is unset or empty.
func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
