package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// fakeDocker answers GET /info like a daemon with the given runtimes.
func fakeDocker(t *testing.T, runtimes ...string) *dockerapi.Client {
	t.Helper()

	rts := map[string]any{}
	for _, r := range runtimes {
		rts[r] = map[string]any{"path": r}
	}
	info := map[string]any{"Architecture": "x86_64", "Runtimes": rts, "CgroupVersion": "2"}

	return fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/info") {
			http.NotFound(w, r)
			return
		}
		if err := json.NewEncoder(w).Encode(info); err != nil {
			t.Error(err)
		}
	})
}

// TestCheckProfileDefaultRuntime checks when the agent starts, depending on
// the profile, DEFAULT_RUNTIME, ALLOW_RUNC and the installed runtimes.
func TestCheckProfileDefaultRuntime(t *testing.T) {
	all := []string{"io.containerd.runc.v2", "runc", "runsc"}
	noGVisor := []string{"io.containerd.runc.v2", "runc"}
	onlyShim := []string{"io.containerd.runc.v2"}
	cases := []struct {
		profile, def string
		allowRunc    bool
		installed    []string
		wantErr      string // "" = starts
	}{
		{"strict", "runsc", false, all, ""},
		{"strict", "runc", false, all, `DEFAULT_RUNTIME "runc" is refused`},
		{"strict", "io.containerd.runc.v2", false, all, `DEFAULT_RUNTIME "io.containerd.runc.v2" is refused`},
		{"strict", "runc", true, all, ""},
		{"strict", "runsc", false, noGVisor, "runsc (gVisor) not installed"},
		{"strict", "runsc", true, noGVisor, ""}, // falls back to runc
		{"strict", "runsc", true, onlyShim, "not available"},
		{"dev", "runc", false, all, ""},
		{"dev", "runsc", false, noGVisor, ""}, // falls back to runc
		{"dev", "runsc", false, onlyShim, "not available"},
	}

	for _, c := range cases {
		a := &agent{
			cfg:    config{profile: c.profile, defaultRuntime: c.def, allowRunc: c.allowRunc},
			docker: fakeDocker(t, c.installed...),
		}
		err := a.checkProfile(context.Background())

		name := fmt.Sprintf("profile %s, DEFAULT_RUNTIME %s, ALLOW_RUNC %v, runtimes %v", c.profile, c.def, c.allowRunc, c.installed)
		switch {
		case c.wantErr == "" && err != nil:
			t.Errorf("%s: want start, got %v", name, err)
		case c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)):
			t.Errorf("%s: want error containing %q, got %v", name, c.wantErr, err)
		}
	}
}
