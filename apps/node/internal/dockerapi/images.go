package dockerapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// ImageInspect holds the fields of GET /images/{name}/json the agent uses.
type ImageInspect struct {
	ID           string `json:"Id"`
	Architecture string
	Os           string
	Config       struct {
		Entrypoint []string
		Cmd        []string
	}
}

// ImageInspect describes a local image; a missing one is IsNotFound.
func (c *Client) ImageInspect(ctx context.Context, ref string) (*ImageInspect, error) {
	var i ImageInspect
	return &i, c.do(ctx, http.MethodGet, "/images/"+url.PathEscape(ref)+"/json", nil, &i)
}

// ImagePull pulls ref and waits for the stream to finish. registryAuth is the
// X-Registry-Auth value (base64url JSON AuthConfig), or "" for an anonymous pull.
func (c *Client) ImagePull(ctx context.Context, ref, registryAuth string) error {
	q := url.Values{"fromImage": {ref}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/images/create?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	if registryAuth != "" {
		req.Header.Set("X-Registry-Auth", registryAuth)
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
	return waitForPull(resp.Body, ref)
}

// waitForPull reads the pull's progress stream to its end. The daemon
// answers 200 before pulling, so a failed pull only shows as an "error"
// message in the stream.
func waitForPull(stream io.Reader, ref string) error {
	dec := json.NewDecoder(stream)
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
