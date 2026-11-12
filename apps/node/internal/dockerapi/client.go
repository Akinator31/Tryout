// Package dockerapi is a deliberately tiny Docker Engine API client.
//
// POC choice: the Engine REST API is stable and versioned, while the Go SDK
// module layout is still moving (github.com/moby/moby/client v0.x). We only
// need a dozen endpoints, so we speak HTTP directly and keep zero deps.
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

const apiVersion = "v1.47"

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
		path := u.Path
		tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		}}
		return &Client{http: &http.Client{Transport: tr}, base: "http://docker/" + apiVersion}, nil
	case "tcp", "http":
		return &Client{http: &http.Client{}, base: "http://" + u.Host + "/" + apiVersion}, nil
	default:
		return nil, fmt.Errorf("unsupported docker endpoint scheme %q (use unix:// or tcp://)", u.Scheme)
	}
}

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("docker api %d: %s", e.Status, e.Message) }

func IsNotFound(err error) bool {
	ae, ok := err.(*APIError)
	return ok && ae.Status == http.StatusNotFound
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && resp.StatusCode != http.StatusNotModified {
		var m struct{ Message string }
		raw, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(raw, &m)
		if m.Message == "" {
			m.Message = strings.TrimSpace(string(raw))
		}
		return &APIError{Status: resp.StatusCode, Message: m.Message}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

// ---- system ----

type Info struct {
	Architecture    string
	SecurityOptions []string
	Runtimes        map[string]any
	DefaultRuntime  string
	CgroupVersion   string
}

func (c *Client) Info(ctx context.Context) (*Info, error) {
	var i Info
	return &i, c.do(ctx, http.MethodGet, "/info", nil, &i)
}

// ---- images ----

type ImageInspect struct {
	ID           string `json:"Id"`
	Architecture string
	Os           string
}

func (c *Client) ImageInspect(ctx context.Context, ref string) (*ImageInspect, error) {
	var i ImageInspect
	return &i, c.do(ctx, http.MethodGet, "/images/"+url.PathEscape(ref)+"/json", nil, &i)
}

// ImagePull pulls ref and waits for the stream to finish.
func (c *Client) ImagePull(ctx context.Context, ref string) error {
	q := url.Values{"fromImage": {ref}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/images/create?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return &APIError{Status: resp.StatusCode, Message: string(raw)}
	}
	dec := json.NewDecoder(resp.Body)
	for {
		var msg struct{ Error string }
		if err := dec.Decode(&msg); err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
		if msg.Error != "" {
			return fmt.Errorf("pull %s: %s", ref, msg.Error)
		}
	}
}

// ---- networks ----

type NetworkCreate struct {
	Name       string
	Driver     string
	Internal   bool
	EnableIPv6 bool
	Labels     map[string]string
	Options    map[string]string `json:",omitempty"`
}

func (c *Client) NetworkCreate(ctx context.Context, n NetworkCreate) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, http.MethodPost, "/networks/create", n, &out)
	return out.ID, err
}

func (c *Client) NetworkConnect(ctx context.Context, network, container string) error {
	return c.do(ctx, http.MethodPost, "/networks/"+url.PathEscape(network)+"/connect",
		map[string]any{"Container": container}, nil)
}

func (c *Client) NetworkDisconnect(ctx context.Context, network, container string) error {
	return c.do(ctx, http.MethodPost, "/networks/"+url.PathEscape(network)+"/disconnect",
		map[string]any{"Container": container, "Force": true}, nil)
}

func (c *Client) NetworkRemove(ctx context.Context, network string) error {
	return c.do(ctx, http.MethodDelete, "/networks/"+url.PathEscape(network), nil, nil)
}

type NetworkSummary struct {
	ID     string `json:"Id"`
	Name   string
	Labels map[string]string
}

func (c *Client) NetworkList(ctx context.Context, label string) ([]NetworkSummary, error) {
	f, _ := json.Marshal(map[string][]string{"label": {label}})
	var out []NetworkSummary
	return out, c.do(ctx, http.MethodGet, "/networks?filters="+url.QueryEscape(string(f)), nil, &out)
}

// ---- containers ----

type ContainerCreate struct {
	Image            string
	Cmd              []string          `json:",omitempty"`
	Env              []string          `json:",omitempty"`
	User             string            `json:",omitempty"`
	Hostname         string            `json:",omitempty"`
	Labels           map[string]string `json:",omitempty"`
	HostConfig       HostConfig
	NetworkingConfig *NetworkingConfig `json:",omitempty"`
}

type HostConfig struct {
	Runtime         string            `json:",omitempty"`
	NetworkMode     string            `json:",omitempty"`
	CapDrop         []string          `json:",omitempty"`
	CapAdd          []string          `json:",omitempty"`
	SecurityOpt     []string          `json:",omitempty"`
	ReadonlyRootfs  bool              `json:",omitempty"`
	Tmpfs           map[string]string `json:",omitempty"`
	Memory          int64             `json:",omitempty"`
	MemorySwap      int64             `json:",omitempty"`
	NanoCpus        int64             `json:",omitempty"`
	PidsLimit       int64             `json:",omitempty"`
	ShmSize         int64             `json:",omitempty"`
	Init            bool              `json:",omitempty"`
	AutoRemove      bool              `json:",omitempty"`
	Privileged      bool
	PublishAllPorts bool
	LogConfig       *LogConfig `json:",omitempty"`
}

type LogConfig struct {
	Type   string
	Config map[string]string
}

type NetworkingConfig struct {
	EndpointsConfig map[string]struct{}
}

func (c *Client) ContainerCreate(ctx context.Context, name string, spec ContainerCreate) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(name), spec, &out)
	return out.ID, err
}

func (c *Client) ContainerStart(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/start", nil, nil)
}

func (c *Client) ContainerRemove(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(id)+"?force=true&v=true", nil, nil)
}

type ContainerSummary struct {
	ID     string `json:"Id"`
	Names  []string
	State  string
	Labels map[string]string
}

func (c *Client) ContainerList(ctx context.Context, label string) ([]ContainerSummary, error) {
	f, _ := json.Marshal(map[string][]string{"label": {label}})
	var out []ContainerSummary
	return out, c.do(ctx, http.MethodGet, "/containers/json?all=true&filters="+url.QueryEscape(string(f)), nil, &out)
}
