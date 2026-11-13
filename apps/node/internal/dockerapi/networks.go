package dockerapi

import (
	"context"
	"net/http"
	"net/url"
)

// NetworkCreate is the body of POST /networks/create.
type NetworkCreate struct {
	Name       string
	Driver     string
	Internal   bool
	EnableIPv6 bool
	Labels     map[string]string
	Options    map[string]string `json:",omitempty"`
}

// NetworkCreate creates a network and returns its id.
func (c *Client) NetworkCreate(ctx context.Context, n NetworkCreate) (string, error) {
	var out struct {
		ID string `json:"Id"`
	}
	err := c.do(ctx, http.MethodPost, "/networks/create", n, &out)
	return out.ID, err
}

// NetworkConnect attaches a container to a network.
func (c *Client) NetworkConnect(ctx context.Context, network, container string) error {
	body := map[string]any{"Container": container}
	return c.do(ctx, http.MethodPost, "/networks/"+url.PathEscape(network)+"/connect", body, nil)
}

// NetworkDisconnect detaches a container from a network, forcibly.
func (c *Client) NetworkDisconnect(ctx context.Context, network, container string) error {
	body := map[string]any{"Container": container, "Force": true}
	return c.do(ctx, http.MethodPost, "/networks/"+url.PathEscape(network)+"/disconnect", body, nil)
}

// NetworkRemove removes a network.
func (c *Client) NetworkRemove(ctx context.Context, network string) error {
	return c.do(ctx, http.MethodDelete, "/networks/"+url.PathEscape(network), nil, nil)
}

// NetworkSummary is an entry of GET /networks.
type NetworkSummary struct {
	ID     string `json:"Id"`
	Name   string
	Labels map[string]string
}

// NetworkList lists the networks carrying label.
func (c *Client) NetworkList(ctx context.Context, label string) ([]NetworkSummary, error) {
	var out []NetworkSummary
	return out, c.do(ctx, http.MethodGet, "/networks?filters="+labelFilter(label), nil, &out)
}
