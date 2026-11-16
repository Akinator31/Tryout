package dockerapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"
)

// Info holds the fields of GET /info the agent uses.
type Info struct {
	Architecture    string
	SecurityOptions []string
	Runtimes        map[string]any
	DefaultRuntime  string
	CgroupVersion   string

	// Whether the daemon applies each resource limit the agent sets: a
	// rootless daemon ignores those whose cgroup controller is not delegated.
	MemoryLimit bool
	SwapLimit   bool
	CPUCfsQuota bool `json:"CpuCfsQuota"`
	PidsLimit   bool
}

// Info describes the daemon: architecture, runtimes, rootless mode, cgroup
// version, supported resource limits.
func (c *Client) Info(ctx context.Context) (*Info, error) {
	var i Info
	return &i, c.do(ctx, http.MethodGet, "/info", nil, &i)
}

// Version holds the fields of GET /version the agent uses.
type Version struct {
	Version    string // the Engine's, e.g. 28.0.1
	APIVersion string `json:"ApiVersion"`
}

// Version describes the daemon's Engine and API versions. It calls the
// unversioned endpoint, which answers whatever API the daemon speaks, so that
// an older daemon is reported as such rather than as unreachable.
func (c *Client) Version(ctx context.Context) (*Version, error) {
	var v Version
	return &v, c.send(ctx, http.MethodGet, c.root+"/version", nil, &v)
}

// APIAtLeast reports whether the API version v ("1.48") is min or later.
func APIAtLeast(v, min string) bool {
	vMajor, vMinor := splitAPIVersion(v)
	mMajor, mMinor := splitAPIVersion(min)
	return vMajor > mMajor || (vMajor == mMajor && vMinor >= mMinor)
}

// splitAPIVersion parses "major.minor"; anything else is 0.0.
func splitAPIVersion(v string) (int, int) {
	major, minor, ok := strings.Cut(v, ".")
	if !ok {
		return 0, 0
	}
	ma, err1 := strconv.Atoi(major)
	mi, err2 := strconv.Atoi(minor)
	if err1 != nil || err2 != nil {
		return 0, 0
	}
	return ma, mi
}
