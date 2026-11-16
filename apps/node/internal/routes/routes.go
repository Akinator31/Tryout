// Package routes is the contract between the agent and the gateway: the
// route table the agent pushes with PUT /routes on the gateway's admin API.
//
// The admin API listens on a unix socket in a volume shared by the two
// containers, never on TCP: the gateway joins every session network, so a
// TCP port would be reachable from the sessions.
package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"
)

// MaxTableBytes bounds the body of PUT /routes.
const MaxTableBytes = 1 << 20

// Route is one entry of the gateway's route table: /s/<ID>/ goes to Target.
type Route struct {
	ID          string `json:"id"`
	Target      string `json:"target"`
	StripPrefix bool   `json:"strip_prefix"`
}

// Client pushes route tables to the gateway's admin API.
type Client struct {
	http  *http.Client
	token string
}

// NewClient returns a client for the admin API on the unix socket at path,
// authenticated with the shared bearer token.
func NewClient(path, token string) *Client {
	dial := func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}
	hc := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DialContext: dial}}
	return &Client{http: hc, token: token}
}

// Put replaces the gateway's whole route table with table.
func (c *Client) Put(ctx context.Context, table []Route) error {
	b, err := json.Marshal(table)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://gateway/routes", bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("gateway answered %d", resp.StatusCode)
	}
	return nil
}
