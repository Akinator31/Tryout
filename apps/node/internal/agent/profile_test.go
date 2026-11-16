package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// fakeDocker answers GET /version and GET /info like a Docker 28 daemon with
// the given runtimes.
func fakeDocker(t *testing.T, runtimes ...string) *dockerapi.Client {
	return fakeDockerAt(t, "1.48", runtimes...)
}

// fakeDockerAt is fakeDocker for a daemon whose API is apiVersion.
func fakeDockerAt(t *testing.T, apiVersion string, runtimes ...string) *dockerapi.Client {
	return fakeDockerInfo(t, apiVersion, fakeInfo(runtimes...))
}

// fakeInfo is the GET /info answer of a daemon with the given runtimes, cgroup
// v2 and every resource limit supported.
func fakeInfo(runtimes ...string) map[string]any {
	rts := map[string]any{}
	for _, r := range runtimes {
		rts[r] = map[string]any{"path": r}
	}
	return map[string]any{
		"Architecture": "x86_64", "Runtimes": rts, "CgroupVersion": "2",
		"MemoryLimit": true, "SwapLimit": true, "CpuCfsQuota": true, "PidsLimit": true,
	}
}

// fakeDockerInfo returns a client for a daemon whose API is apiVersion and
// whose GET /info answers info. Like a real daemon, it refuses requests for a
// newer API than its own.
func fakeDockerInfo(t *testing.T, apiVersion string, info map[string]any) *dockerapi.Client {
	t.Helper()

	version := map[string]any{"Version": "test", "ApiVersion": apiVersion}

	return fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		var answer any
		switch {
		case r.URL.Path == "/version":
			answer = version
		case !dockerapi.APIAtLeast(apiVersion, strings.TrimPrefix(strings.Split(r.URL.Path, "/")[1], "v")):
			http.Error(w, `{"message":"client version is too new"}`, http.StatusBadRequest)
			return
		case strings.HasSuffix(r.URL.Path, "/info"):
			answer = info
		default:
			http.NotFound(w, r)
			return
		}
		if err := json.NewEncoder(w).Encode(answer); err != nil {
			t.Error(err)
		}
	})
}

// TestCheckProfileRefusesOldDocker checks that a daemon older than Docker
// Engine 28 (API 1.48) stops the agent with a clear message, in any profile.
func TestCheckProfileRefusesOldDocker(t *testing.T) {
	for _, profile := range []string{"dev", "strict"} {
		a := New(Config{Profile: profile, DefaultRuntime: "runsc"}, fakeDockerAt(t, "1.47", "runc", "runsc"), nil, &fakeGateway{})

		err := a.CheckProfile(context.Background())
		if err == nil || !strings.Contains(err.Error(), "Docker Engine 28 or later is required") {
			t.Errorf("profile %s, API 1.47: %v", profile, err)
		}
	}

	a := New(Config{Profile: "strict", DefaultRuntime: "runsc"}, fakeDockerAt(t, "1.52", "runc", "runsc"), nil, &fakeGateway{})
	if err := a.CheckProfile(context.Background()); err != nil {
		t.Errorf("API 1.52: %v", err)
	}
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
		a := New(Config{Profile: c.profile, DefaultRuntime: c.def, AllowRunc: c.allowRunc}, fakeDocker(t, c.installed...), nil, &fakeGateway{})
		err := a.CheckProfile(context.Background())

		name := fmt.Sprintf("profile %s, DEFAULT_RUNTIME %s, ALLOW_RUNC %v, runtimes %v", c.profile, c.def, c.allowRunc, c.installed)
		switch {
		case c.wantErr == "" && err != nil:
			t.Errorf("%s: want start, got %v", name, err)
		case c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)):
			t.Errorf("%s: want error containing %q, got %v", name, c.wantErr, err)
		}
	}
}

// TestCheckProfileResourceLimits checks that, outside dev, the agent refuses a
// daemon that would ignore a session's memory, CPU or pids limit, as a
// rootless daemon does when its cgroup controllers are not delegated.
func TestCheckProfileResourceLimits(t *testing.T) {
	controllers := map[string]string{"MemoryLimit": "memory", "CpuCfsQuota": "cpu", "PidsLimit": "pids"}

	for missing, controller := range controllers {
		for _, profile := range []string{"strict", "single-host"} {
			info := fakeInfo("runc", "runsc")
			info[missing] = false
			if profile == "single-host" {
				info["SecurityOptions"] = []string{"name=rootless"}
			}
			a := New(Config{Profile: profile, DefaultRuntime: "runsc"}, fakeDockerInfo(t, "1.48", info), nil, &fakeGateway{})

			err := a.CheckProfile(context.Background())
			if err == nil || !strings.Contains(err.Error(), "ignores the "+controller+" limit") {
				t.Errorf("profile %s, %s false: want a refusal for %s, got %v", profile, missing, controller, err)
			}
		}

		info := fakeInfo("runc", "runsc")
		info[missing] = false
		a := New(Config{Profile: "dev", DefaultRuntime: "runsc"}, fakeDockerInfo(t, "1.48", info), nil, &fakeGateway{})
		if err := a.CheckProfile(context.Background()); err != nil {
			t.Errorf("profile dev, %s false: %v", missing, err)
		}
	}
}
