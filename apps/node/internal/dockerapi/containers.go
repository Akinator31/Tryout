package dockerapi

import (
	"context"
	"net/http"
	"net/url"
)

// ContainerCreate is the body of POST /containers/create.
type ContainerCreate struct {
	Image            string
	Entrypoint       []string          `json:",omitempty"`
	Cmd              []string          `json:",omitempty"`
	Env              []string          `json:",omitempty"`
	User             string            `json:",omitempty"`
	Hostname         string            `json:",omitempty"`
	Labels           map[string]string `json:",omitempty"`
	HostConfig       HostConfig
	NetworkingConfig *NetworkingConfig `json:",omitempty"`
}

// HostConfig is the part of ContainerCreate that holds the isolation and
// resource settings. Privileged and PublishAllPorts are always sent, so
// that false is explicit.
type HostConfig struct {
	Runtime         string            `json:",omitempty"`
	NetworkMode     string            `json:",omitempty"`
	CapDrop         []string          `json:",omitempty"`
	CapAdd          []string          `json:",omitempty"`
	SecurityOpt     []string          `json:",omitempty"`
	ReadonlyRootfs  bool              `json:",omitempty"`
	Tmpfs           map[string]string `json:",omitempty"`
	Mounts          []Mount           `json:",omitempty"`
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

// Mount is an entry of HostConfig.Mounts. The agent only uses image mounts
// (Type "image", API 1.48): Source is an image, mounted at Target.
type Mount struct {
	Type     string
	Source   string
	Target   string
	ReadOnly bool
}

// LogConfig selects a container's logging driver and its options.
type LogConfig struct {
	Type   string
	Config map[string]string
}

// NetworkingConfig lists the networks to join at creation, by name.
type NetworkingConfig struct {
	EndpointsConfig map[string]struct{}
}

// ContainerCreate creates a container named name and returns its id.
func (c *Client) ContainerCreate(ctx context.Context, name string, spec ContainerCreate) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(name), spec, &out)
	return out.ID, err
}

// ContainerStart starts a container.
func (c *Client) ContainerStart(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/start", nil, nil)
}

// ContainerRemove removes a container, killing it if running, with its
// anonymous volumes.
func (c *Client) ContainerRemove(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(id)+"?force=true&v=true", nil, nil)
}

// ContainerSummary is an entry of GET /containers/json.
type ContainerSummary struct {
	ID     string `json:"Id"`
	Names  []string
	State  string
	Labels map[string]string
}

// ContainerList lists the containers carrying label, in any state.
func (c *Client) ContainerList(ctx context.Context, label string) ([]ContainerSummary, error) {
	var out []ContainerSummary
	return out, c.do(ctx, http.MethodGet, "/containers/json?all=true&filters="+labelFilter(label), nil, &out)
}

// ContainerInspect holds the fields of GET /containers/{id}/json the agent uses.
type ContainerInspect struct {
	ID              string `json:"Id"`
	NetworkSettings struct {
		Networks map[string]struct{} // keyed by network name
	}
}

// ContainerInspect describes a container.
func (c *Client) ContainerInspect(ctx context.Context, id string) (*ContainerInspect, error) {
	var out ContainerInspect
	return &out, c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/json", nil, &out)
}
