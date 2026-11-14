package main

import (
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/Akinator31/Tryout/apps/node/internal/logging"
)

// newProxy returns the reverse proxy of one session. It keeps the public
// Host header (so that the apps' Origin checks stay coherent), optionally
// strips the /s/<id> prefix, never forwards cookies, streams responses
// immediately (video, terminal) and hardens every response.
func (g *gateway) newProxy(rt route) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(rt.Target)
	if err != nil {
		return nil, err
	}

	prefix := "/s/" + rt.ID
	rewrite := func(pr *httputil.ProxyRequest) {
		host := pr.In.Host
		pr.SetURL(target)
		pr.Out.Host = host
		if rt.StripPrefix {
			pr.Out.URL.Path, pr.Out.URL.RawPath = stripPrefix(pr.In.URL.Path, prefix), ""
		}
		pr.SetXForwarded()
		pr.Out.Header.Del("Cookie")
	}
	onError := func(w http.ResponseWriter, r *http.Request, err error) {
		slog.Debug("upstream error", "id", logging.ID(rt.ID), "err", err)
		http.Error(w, "session starting or ended", http.StatusBadGateway)
	}

	return &httputil.ReverseProxy{
		Rewrite:        rewrite,
		FlushInterval:  -1,
		ModifyResponse: g.harden,
		ErrorHandler:   onError,
		ErrorLog:       logging.HTTPErrorLog(slog.Default()),
	}, nil
}

// stripPrefix removes prefix from path, leaving at least "/".
func stripPrefix(path, prefix string) string {
	p := strings.TrimPrefix(path, prefix)
	if p == "" {
		return "/"
	}
	return p
}

// harden rewrites response headers whatever the session serves. The visitor
// may control the upstream server entirely (e.g. kill ttyd, bind the port).
//
//   - X-Frame-Options and the session's frame-ancestors are replaced by the
//     gateway's own frame-ancestors (FRAME_ANCESTORS);
//   - Service-Worker-Allowed is removed: a service worker can never widen its
//     scope beyond /s/<id>/;
//   - Set-Cookie is removed: sessions get no cookies;
//   - Referrer-Policy is no-referrer: the URL is the credential, never leak it;
//   - nosniff, and no-store caching.
func (g *gateway) harden(resp *http.Response) error {
	h := resp.Header
	h.Del("X-Frame-Options")
	h.Del("Service-Worker-Allowed")
	h.Del("Set-Cookie")

	kept := withoutFrameAncestors(h.Values("Content-Security-Policy"))
	h.Del("Content-Security-Policy")
	for _, csp := range kept {
		h.Add("Content-Security-Policy", csp)
	}
	h.Add("Content-Security-Policy", "frame-ancestors "+g.frameAncestors)

	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "no-store")
	return nil
}

// withoutFrameAncestors removes the frame-ancestors directive (and empty
// directives) from each Content-Security-Policy value, dropping the values
// left empty.
func withoutFrameAncestors(policies []string) []string {
	var kept []string
	for _, csp := range policies {
		var directives []string
		for _, d := range strings.Split(csp, ";") {
			d = strings.TrimSpace(d)
			if d != "" && !strings.HasPrefix(strings.ToLower(d), "frame-ancestors") {
				directives = append(directives, d)
			}
		}

		if len(directives) > 0 {
			kept = append(kept, strings.Join(directives, "; "))
		}
	}
	return kept
}
