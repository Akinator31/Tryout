// tryout-gateway: public reverse proxy for sessions. It has NO Docker socket.
//
// Public:  /s/<session-id>/...  -> session container (HTTP + WebSocket)
// Admin:   PUT /routes on a unix socket (bearer token, agent only)
//
// The session id is a 130-bit random capability carried in every request,
// so no cookies are needed (third-party cookies are blocked in iframes).
//
// Files of this package: main.go (wiring), routes.go (the route table, the
// public and admin handlers), proxy.go (the per-session reverse proxy and
// the response hardening).
package main

import (
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/logging"
	"github.com/Akinator31/Tryout/apps/node/internal/version"
)

func main() {
	slog.SetDefault(logging.New(os.Stdout))

	g := &gateway{
		token:          os.Getenv("GATEWAY_TOKEN"),
		frameAncestors: env("FRAME_ANCESTORS", "'self'"),
		routes:         map[string]entry{},
	}
	if g.token == "" {
		fatal("GATEWAY_TOKEN required")
	}

	adminPath := strings.TrimPrefix(env("ADMIN_SOCKET", "unix:///run/tryout/gateway.sock"), "unix://")
	ln, err := listenAdminSocket(adminPath)
	if err != nil {
		fatal("admin socket", "err", err)
	}
	go serveAdmin(g, ln)

	srv := &http.Server{
		Addr:              env("PUBLIC_LISTEN", ":8080"),
		Handler:           http.HandlerFunc(g.public),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          logging.HTTPErrorLog(slog.Default()),
		// no Read/WriteTimeout: WebSocket streams live for the whole session
	}
	slog.Info("gateway listening", "public", srv.Addr, "version", version.Version, "frame_ancestors", g.frameAncestors)
	fatal("public server", "err", srv.ListenAndServe())
}

// listenAdminSocket listens on the admin unix socket, replacing a stale one.
// The admin API listens on a unix socket in a volume shared with the agent
// only. A TCP port would be reachable from every session network the
// gateway is attached to.
func listenAdminSocket(path string) (net.Listener, error) {
	_ = os.Remove(path)

	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}

	_ = os.Chmod(path, 0o660)
	return ln, nil
}

// serveAdmin serves the admin API on ln; the gateway exits if it stops.
func serveAdmin(g *gateway, ln net.Listener) {
	srv := &http.Server{Handler: g.admin(), ReadHeaderTimeout: 10 * time.Second}
	fatal("admin server", "err", srv.Serve(ln))
}

// fatal logs an error and exits.
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

// env returns the environment variable k, or def when it is unset or empty.
func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
