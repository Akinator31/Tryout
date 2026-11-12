package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestGateway(t *testing.T, upstream *httptest.Server, strip bool) (*gateway, string) {
	t.Helper()
	g := &gateway{token: "secret", frameAncestors: "https://portfolio.example", routes: map[string]entry{}}
	id := strings.Repeat("a", 26)
	p, err := g.newProxy(route{ID: id, Target: upstream.URL, StripPrefix: strip})
	if err != nil {
		t.Fatal(err)
	}
	g.routes[id] = entry{proxy: p}
	return g, id
}

func TestHardenRewritesSecurityHeaders(t *testing.T) {
	g := &gateway{frameAncestors: "https://portfolio.example"}
	h := http.Header{}
	h.Set("X-Frame-Options", "DENY")
	h.Set("Service-Worker-Allowed", "/")
	h.Set("Set-Cookie", "a=b")
	h.Add("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
	if err := g.harden(&http.Response{Header: h}); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"X-Frame-Options", "Service-Worker-Allowed", "Set-Cookie"} {
		if h.Get(k) != "" {
			t.Errorf("%s should be removed, got %q", k, h.Get(k))
		}
	}
	csp := h.Values("Content-Security-Policy")
	if len(csp) != 2 || csp[0] != "default-src 'self'" || csp[1] != "frame-ancestors https://portfolio.example" {
		t.Errorf("unexpected CSP: %q", csp)
	}
	if h.Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("Referrer-Policy must be no-referrer")
	}
}

func TestPublicRouting(t *testing.T) {
	var gotPath, gotCookie string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotCookie = r.URL.Path, r.Header.Get("Cookie")
		io.WriteString(w, "ok")
	}))
	defer up.Close()

	for _, tc := range []struct {
		strip    bool
		wantPath string
	}{{false, "/s/" + strings.Repeat("a", 26) + "/x"}, {true, "/x"}} {
		g, id := newTestGateway(t, up, tc.strip)
		req := httptest.NewRequest("GET", "/s/"+id+"/x", nil)
		req.Header.Set("Cookie", "leak=1")
		rec := httptest.NewRecorder()
		g.public(rec, req)
		if rec.Code != 200 || gotPath != tc.wantPath {
			t.Errorf("strip=%v: code=%d path=%q want %q", tc.strip, rec.Code, gotPath, tc.wantPath)
		}
		if gotCookie != "" {
			t.Errorf("cookies must not reach the session, got %q", gotCookie)
		}
	}
}

func TestPublicRejectsUnknownAndMalformed(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer up.Close()
	g, id := newTestGateway(t, up, false)
	cases := map[string]int{
		"/s/" + strings.Repeat("b", 26) + "/": http.StatusNotFound,          // unknown session
		"/s/short/":                           http.StatusNotFound,          // malformed id
		"/admin":                              http.StatusNotFound,          // nothing else is served
		"/s/" + id:                            http.StatusPermanentRedirect, // missing trailing slash
		"/healthz":                            http.StatusNoContent,
	}
	for path, want := range cases {
		rec := httptest.NewRecorder()
		g.public(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Errorf("%s: got %d want %d", path, rec.Code, want)
		}
	}
}

func TestAdminRequiresToken(t *testing.T) {
	g := &gateway{token: "secret", routes: map[string]entry{}}
	body := `[{"id":"` + strings.Repeat("c", 26) + `","target":"http://x:1"}]`
	for token, want := range map[string]int{"": 401, "wrong": 401, "secret": 204} {
		req := httptest.NewRequest("PUT", "/routes", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		g.admin().ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("token %q: got %d want %d", token, rec.Code, want)
		}
	}
	if len(g.routes) != 1 {
		t.Errorf("route table not applied: %d entries", len(g.routes))
	}
}
