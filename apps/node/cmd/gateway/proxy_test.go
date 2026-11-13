package main

import (
	"net/http"
	"testing"
)

// TestHardenRewritesSecurityHeaders checks that the headers a session could
// use against the visitor or the embedding page are removed or replaced.
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
