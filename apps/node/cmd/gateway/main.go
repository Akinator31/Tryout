// tryout-gateway: public reverse proxy for sessions. It has NO Docker socket.
//
// Public:  /s/<session-id>/...  -> session container (HTTP + WebSocket)
// Admin:   PUT /routes on a unix socket (bearer token, agent only)
//
// The session id is a 128-bit+ random capability carried in every request,
// so no cookies are needed (third-party cookies are blocked in iframes).
package main

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

var pathRe = regexp.MustCompile(`^/s/([a-z0-9]{26})(/.*)?$`)

type route struct {
	ID          string `json:"id"`
	Target      string `json:"target"`
	StripPrefix bool   `json:"strip_prefix"`
}

type entry struct {
	proxy *httputil.ReverseProxy
}

type gateway struct {
	token          string
	frameAncestors string

	mu     sync.RWMutex
	routes map[string]entry
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func (g *gateway) newProxy(rt route) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(rt.Target)
	if err != nil {
		return nil, err
	}
	prefix := "/s/" + rt.ID
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			host := pr.In.Host
			pr.SetURL(target)
			pr.Out.Host = host // keep public Host so apps' Origin checks stay coherent
			if rt.StripPrefix {
				p := strings.TrimPrefix(pr.In.URL.Path, prefix)
				if p == "" {
					p = "/"
				}
				pr.Out.URL.Path, pr.Out.URL.RawPath = p, ""
			}
			pr.SetXForwarded()
			pr.Out.Header.Del("Cookie")
		},
		FlushInterval:  -1, // stream immediately (video, terminal)
		ModifyResponse: g.harden,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Debug("upstream error", "id", rt.ID, "err", err)
			http.Error(w, "session starting or ended", http.StatusBadGateway)
		},
	}, nil
}

// harden rewrites response headers whatever the session serves. The visitor
// may control the upstream server entirely (e.g. kill ttyd, bind the port).
func (g *gateway) harden(resp *http.Response) error {
	h := resp.Header
	h.Del("X-Frame-Options")
	h.Del("Service-Worker-Allowed") // a SW can never widen its scope beyond /s/<id>/
	h.Del("Set-Cookie")
	var kept []string
	for _, csp := range h.Values("Content-Security-Policy") {
		var parts []string
		for _, d := range strings.Split(csp, ";") {
			if !strings.HasPrefix(strings.TrimSpace(strings.ToLower(d)), "frame-ancestors") && strings.TrimSpace(d) != "" {
				parts = append(parts, strings.TrimSpace(d))
			}
		}
		if len(parts) > 0 {
			kept = append(kept, strings.Join(parts, "; "))
		}
	}
	h.Del("Content-Security-Policy")
	for _, k := range kept {
		h.Add("Content-Security-Policy", k)
	}
	h.Add("Content-Security-Policy", "frame-ancestors "+g.frameAncestors)
	h.Set("Referrer-Policy", "no-referrer") // the URL is the credential: never leak it
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	return nil
}

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
	g.mu.RLock()
	e, ok := g.routes[id]
	g.mu.RUnlock()
	if !ok {
		http.Error(w, "unknown or expired session", http.StatusNotFound)
		return
	}
	if rest == "" { // apps resolve relative URLs against the trailing slash
		u := *r.URL
		u.Path += "/"
		http.Redirect(w, r, u.String(), http.StatusPermanentRedirect)
		return
	}
	e.proxy.ServeHTTP(w, r)
}

func (g *gateway) admin() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /routes", func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(g.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var rs []route
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&rs); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		next := make(map[string]entry, len(rs))
		g.mu.RLock()
		for _, rt := range rs {
			if !pathRe.MatchString("/s/" + rt.ID) {
				continue
			}
			if old, ok := g.routes[rt.ID]; ok { // keep existing proxies (and their conns)
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
		g.mu.RUnlock()
		g.mu.Lock()
		g.routes = next
		g.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	g := &gateway{
		token:          os.Getenv("GATEWAY_TOKEN"),
		frameAncestors: env("FRAME_ANCESTORS", "'self'"),
		routes:         map[string]entry{},
	}
	if g.token == "" {
		slog.Error("GATEWAY_TOKEN required")
		os.Exit(1)
	}
	// The admin API listens on a unix socket in a volume shared with the agent
	// only. A TCP port would be reachable from every session network the
	// gateway is attached to.
	adminPath := strings.TrimPrefix(env("ADMIN_SOCKET", "unix:///run/tryout/gateway.sock"), "unix://")
	_ = os.Remove(adminPath)
	ln, err := net.Listen("unix", adminPath)
	if err != nil {
		slog.Error("admin socket", "err", err)
		os.Exit(1)
	}
	_ = os.Chmod(adminPath, 0o660)
	go func() {
		srv := &http.Server{Handler: g.admin(), ReadHeaderTimeout: 10 * time.Second}
		slog.Error("admin server", "err", srv.Serve(ln))
		os.Exit(1)
	}()
	srv := &http.Server{
		Addr:              env("PUBLIC_LISTEN", ":8080"),
		Handler:           http.HandlerFunc(g.public),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		// no Read/WriteTimeout: WebSocket streams live for the whole session
	}
	slog.Info("gateway listening", "public", srv.Addr, "frame_ancestors", g.frameAncestors)
	slog.Error("public server", "err", srv.ListenAndServe())
	os.Exit(1)
}
