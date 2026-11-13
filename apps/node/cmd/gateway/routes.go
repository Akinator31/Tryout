package main

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"regexp"
	"strings"
	"sync"
)

// maxRoutesBytes bounds the body of PUT /routes.
const maxRoutesBytes = 1 << 20

// pathRe matches a public session path and captures the session id and the
// rest of the path.
var pathRe = regexp.MustCompile(`^/s/([a-z0-9]{26})(/.*)?$`)

// route is one entry of the route table the agent pushes.
type route struct {
	ID          string `json:"id"`
	Target      string `json:"target"`
	StripPrefix bool   `json:"strip_prefix"`
}

// entry is a session's live proxy.
type entry struct {
	proxy *httputil.ReverseProxy
}

// gateway holds the route table, replaced as a whole by each PUT /routes.
type gateway struct {
	token          string
	frameAncestors string

	mu     sync.RWMutex
	routes map[string]entry
}

// public serves /healthz and /s/<id>/... for the sessions in the route table;
// everything else is a 404. The session path is the only credential.
func (g *gateway) public(w http.ResponseWriter, r *http.Request) {
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
func (g *gateway) lookup(id string) (entry, bool) {
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

// admin is the admin API, served on the unix socket only: PUT /routes
// replaces the route table, with the agent's bearer token.
func (g *gateway) admin() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /routes", g.handlePutRoutes)
	return mux
}

// handlePutRoutes checks the token, then replaces the route table.
func (g *gateway) handlePutRoutes(w http.ResponseWriter, r *http.Request) {
	if !g.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var rs []route
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRoutesBytes)).Decode(&rs); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	next := g.buildRouteTable(rs)

	g.mu.Lock()
	g.routes = next
	g.mu.Unlock()

	w.WriteHeader(http.StatusNoContent)
}

// authorized compares the bearer token in constant time.
func (g *gateway) authorized(r *http.Request) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(g.token)) == 1
}

// buildRouteTable builds the next route table. A session already routed keeps
// its proxy, and with it its open connections; routes with a malformed id or
// target are skipped.
func (g *gateway) buildRouteTable(rs []route) map[string]entry {
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
			slog.Warn("bad route", "id", rt.ID, "err", err)
			continue
		}
		next[rt.ID] = entry{proxy: p}
	}
	return next
}
