package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// config is the agent's configuration, read once from the environment.
type config struct {
	listen           string
	tlsCert          string
	tlsKey           string
	tlsClientCA      string
	dockerHost       string
	profile          string // dev | strict | single-host
	defaultRuntime   string
	allowRunc        bool
	gatewayName      string
	gatewaySocket    string
	gatewayToken     string
	registryAuthFile string // path of a config.json with registry credentials, optional
	maxSessions      int
	maxAge           time.Duration
}

// loadConfig reads the agent's environment variables and applies their
// defaults. It does not validate them: checkProfile and serverTLS do.
func loadConfig() config {
	maxSessions, _ := strconv.Atoi(env("MAX_SESSIONS", "10"))
	maxAge, _ := time.ParseDuration(env("SESSION_MAX_AGE_CAP", "2h"))

	return config{
		listen:           env("AGENT_LISTEN", ":7000"),
		tlsCert:          os.Getenv("AGENT_TLS_CERT"),
		tlsKey:           os.Getenv("AGENT_TLS_KEY"),
		tlsClientCA:      os.Getenv("AGENT_TLS_CLIENT_CA"),
		dockerHost:       env("DOCKER_HOST", "unix:///var/run/docker.sock"),
		profile:          env("NODE_PROFILE", "dev"),
		defaultRuntime:   env("DEFAULT_RUNTIME", "runsc"),
		allowRunc:        env("ALLOW_RUNC", "false") == "true",
		gatewayName:      env("GATEWAY_CONTAINER", "tryout-gateway"),
		gatewaySocket:    strings.TrimPrefix(env("GATEWAY_ADMIN_SOCKET", "unix:///run/tryout/gateway.sock"), "unix://"),
		gatewayToken:     os.Getenv("GATEWAY_TOKEN"),
		registryAuthFile: os.Getenv("REGISTRY_AUTH_FILE"),
		maxSessions:      maxSessions,
		maxAge:           maxAge,
	}
}

// env returns the environment variable k, or def when it is unset or empty.
func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
