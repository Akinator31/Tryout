// Package gateway is the node's public reverse proxy: /s/<session-id>/...
// goes to the session's container, over HTTP and WebSocket. It has NO Docker
// socket. The agent replaces its route table through the admin API, on a
// unix socket only (see package routes).
//
// The session id is a 130-bit random capability carried in every request,
// so no cookies are needed (third-party cookies are blocked in iframes).
//
// Files of this package: routes.go (the route table, the public and admin
// handlers), proxy.go (the per-session reverse proxy and the response
// hardening).
package gateway

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"regexp"
	"strings"
	"sync"

	"github.com/Akinator31/Tryout/apps/node/internal/logging"
	"github.com/Akinator31/Tryout/apps/node/internal/routes"
)

// pathRe matches a public session path and captures the session id and the
// rest of the path.
var pathRe = regexp.MustCompile(`^/s/([a-z0-9]{26})(/.*)?$`)

// entry is a session's live proxy.
type entry struct {
	proxy *httputil.ReverseProxy
}

// Gateway holds the route table, replaced as a whole by each PUT /routes.
type Gateway struct {
	token          string
	frameAncestors string

	mu     sync.RWMutex
	routes map[string]entry
}

// New returns a gateway with an empty route table. token authenticates the
// agent on the admin API; frameAncestors is the CSP frame-ancestors value
// every session answer carries.
func New(token, frameAncestors string) *Gateway {
	return &Gateway{token: token, frameAncestors: frameAncestors, routes: map[string]entry{}}
}

// Public is the public handler: /healthz and the routed sessions.
func (g *Gateway) Public() http.Handler {
	return http.HandlerFunc(g.public)
}

// public serves /healthz and /s/<id>/... for the sessions in the route table;
// everything else is a 404. The session path is the only credential.
func (g *Gateway) public(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	m := pathRe.FindStringSubmatch(r.URL.Path)
	if m == nil {
		http.NotFound(w, r)
		return
	}
	id, rest := m[1], m[2]

	e, ok := g.lookup(id)
	if !ok {
		http.Error(w, "unknown or expired session", http.StatusNotFound)
		return
	}

	if rest == "" {
		redirectToTrailingSlash(w, r)
		return
	}
	e.proxy.ServeHTTP(w, r)
}

// lookup returns the proxy of a session.
func (g *Gateway) lookup(id string) (entry, bool) {
	g.mu.RLock()
	defer g.mu.RUnlock()

	e, ok := g.routes[id]
	return e, ok
}

// redirectToTrailingSlash sends /s/<id> to /s/<id>/: apps resolve relative
// URLs against the trailing slash.
func redirectToTrailingSlash(w http.ResponseWriter, r *http.Request) {
	u := *r.URL
	u.Path += "/"
	http.Redirect(w, r, u.String(), http.StatusPermanentRedirect)
}

// Admin is the admin API, to serve on the unix socket only: PUT /routes
// replaces the route table, with the agent's bearer token.
func (g *Gateway) Admin() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /routes", g.handlePutRoutes)
	return mux
}

// handlePutRoutes checks the token, then replaces the route table.
func (g *Gateway) handlePutRoutes(w http.ResponseWriter, r *http.Request) {
	if !g.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var rs []routes.Route
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, routes.MaxTableBytes)).Decode(&rs); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	next := g.buildRouteTable(rs)

	g.mu.Lock()
	g.routes = next
	g.mu.Unlock()

	w.WriteHeader(http.StatusNoContent)
}

// authorized compares the bearer token in constant time. A gateway without a
// token refuses every request: an empty token would otherwise match an
// absent header.
func (g *Gateway) authorized(r *http.Request) bool {
	if g.token == "" {
		return false
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(g.token)) == 1
}

// buildRouteTable builds the next route table. A session already routed keeps
// its proxy, and with it its open connections; routes with a malformed id or
// target are skipped.
func (g *Gateway) buildRouteTable(rs []routes.Route) map[string]entry {
	g.mu.RLock()
	defer g.mu.RUnlock()

	next := make(map[string]entry, len(rs))
	for _, rt := range rs {
		if !pathRe.MatchString("/s/" + rt.ID) {
			continue
		}
		if old, ok := g.routes[rt.ID]; ok {
			next[rt.ID] = old
			continue
		}

		p, err := g.newProxy(rt)
		if err != nil {
			slog.Warn("bad route", "id", logging.ID(rt.ID), "err", err)
			continue
		}
		next[rt.ID] = entry{proxy: p}
	}
	return next
}
