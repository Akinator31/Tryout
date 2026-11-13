// Package dockerapi is a deliberately tiny Docker Engine API client.
//
// POC choice: the Engine REST API is stable and versioned, while the Go SDK
// module layout is still moving (github.com/moby/moby/client v0.x). We only
// need a dozen endpoints, so we speak HTTP directly and keep zero deps.
//
// Files of this package: client.go (transport and errors), then one file per
// API area: system.go, images.go, networks.go, containers.go.
package dockerapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// apiVersion pins the Engine API version of every request.
const apiVersion = "v1.47"

// Client calls the Engine API of one Docker daemon.
type Client struct {
	http *http.Client
	base string
}

// New builds a client from a DOCKER_HOST-style endpoint:
// unix:///path/to/docker.sock or tcp://host:port (plain; put TLS/SSH in front).
func New(endpoint string) (*Client, error) {
	if endpoint == "" {
		endpoint = "unix:///var/run/docker.sock"
	}
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}

	switch u.Scheme {
	case "unix":
		return &Client{http: unixSocketClient(u.Path), base: "http://docker/" + apiVersion}, nil
	case "tcp", "http":
		return &Client{http: &http.Client{}, base: "http://" + u.Host + "/" + apiVersion}, nil
	default:
		return nil, fmt.Errorf("unsupported docker endpoint scheme %q (use unix:// or tcp://)", u.Scheme)
	}
}

// unixSocketClient returns an HTTP client that dials the unix socket at path
// whatever the URL's host.
func unixSocketClient(path string) *http.Client {
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}
	return &http.Client{Transport: &http.Transport{DialContext: dial}}
}

// APIError is an error status returned by the daemon, with its message.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("docker api %d: %s", e.Status, e.Message)
}

// IsNotFound reports whether err is a 404 from the daemon (no such
// container, network or image).
func IsNotFound(err error) bool {
	ae, ok := err.(*APIError)
	return ok && ae.Status == http.StatusNotFound
}

// do sends a request with an optional JSON body and decodes the JSON
// response into out, if not nil. A status of 300 or more, except 304 (Not
// Modified, such as starting a running container), is an *APIError.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	req, err := c.newRequest(ctx, method, path, body)
	if err != nil {
		return err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotModified {
		return readAPIError(resp)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// newRequest builds a request to the versioned API, with body as JSON.
func (c *Client) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// readAPIError turns an error response into an *APIError, with the daemon's
// {"message": ...} or else the raw body.
func readAPIError(resp *http.Response) error {
	var m struct{ Message string }
	raw, _ := io.ReadAll(resp.Body)
	_ = json.Unmarshal(raw, &m)
	if m.Message == "" {
		m.Message = strings.TrimSpace(string(raw))
	}
	return &APIError{Status: resp.StatusCode, Message: m.Message}
}

// labelFilter encodes the filters query parameter that selects objects
// carrying label.
func labelFilter(label string) string {
	f, _ := json.Marshal(map[string][]string{"label": {label}})
	return url.QueryEscape(string(f))
}
