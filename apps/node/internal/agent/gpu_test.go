package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// gpuInfo is the GET /info answer of a daemon whose runsc runtime has the
// given arguments.
func gpuInfo(runscArgs ...string) map[string]any {
	info := fakeInfo("runc")
	info["Runtimes"].(map[string]any)["runsc"] = map[string]any{"path": "/usr/bin/runsc", "runtimeArgs": runscArgs}
	return info
}

// nvproxyArgs are the runsc arguments of a node set up for GPU sessions.
var nvproxyArgs = []string{"--nvproxy", "--nvproxy-allowed-driver-capabilities=compute,utility,graphics,video"}

// TestCheckProfileGPU checks when a node with GPU_DEVICES starts: only when
// its runsc runtime has nvproxy on and GPU_SESSIONS caps the GPU sessions.
// GPU sessions always run under runsc, so the check holds in every profile.
func TestCheckProfileGPU(t *testing.T) {
	cases := []struct {
		name     string
		profile  string
		sessions int
		args     []string
		wantErr  string // "" = starts
	}{
		{"nvproxy on", "strict", 4, nvproxyArgs, ""},
		{"nvproxy=true", "strict", 4, []string{"--nvproxy=true"}, ""},
		{"no nvproxy", "strict", 4, nil, "--nvproxy"},
		{"nvproxy=false", "strict", 4, []string{"--nvproxy=false"}, "--nvproxy"},
		{"no nvproxy in dev", "dev", 4, nil, "--nvproxy"},
		{"no GPU_SESSIONS", "strict", 0, nvproxyArgs, "GPU_SESSIONS"},
	}

	for _, c := range cases {
		cfg := Config{Profile: c.profile, DefaultRuntime: "runsc", GPUDevices: []string{"nvidia.com/gpu=all"}, GPUSessions: c.sessions}
		a := New(cfg, fakeDockerInfo(t, "1.48", gpuInfo(c.args...)), nil, &fakeGateway{})
		err := a.CheckProfile(context.Background())

		switch {
		case c.wantErr == "" && err != nil:
			t.Errorf("%s: want start, got %v", c.name, err)
		case c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)):
			t.Errorf("%s: want error containing %q, got %v", c.name, c.wantErr, err)
		}
	}
}

// TestCheckProfileWithoutGPU checks that a node without GPU_DEVICES does not
// care about nvproxy.
func TestCheckProfileWithoutGPU(t *testing.T) {
	a := New(Config{Profile: "strict", DefaultRuntime: "runsc"}, fakeDockerInfo(t, "1.48", gpuInfo()), nil, &fakeGateway{})
	if err := a.CheckProfile(context.Background()); err != nil {
		t.Error(err)
	}
}

// gpuAgent returns a strict agent with one GPU device and room for slots GPU
// sessions, on a daemon that lists the given sessions (see sessionsDocker).
func gpuAgent(t *testing.T, slots int, sessions ...string) *Agent {
	a := testAgent("strict", false)
	a.maxSessions = 10
	a.gpuSessions = slots
	a.policy.GPUDevices = []string{"nvidia.com/gpu=all"}
	a.docker = fakeDockerClient(t, sessionsDocker(t, sessions...))
	return a
}

// postSession sends body to POST /v1/sessions and returns the response.
func postSession(a *Agent, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	a.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/sessions", strings.NewReader(body)))
	return rec
}

// TestCreateRefusesBeyondGPUSessions checks that a GPU session is refused
// once GPU_SESSIONS GPU sessions run, before anything is created.
func TestCreateRefusesBeyondGPUSessions(t *testing.T) {
	a := gpuAgent(t, 1, "game/running/gpu", "shell/running")
	body := `{"id":"` + strings.Repeat("b", 26) + `","project":"game","image":"img","kind":"desktop","port":3000,"max_age_s":60,"gpu":true}`

	rec := postSession(a, body)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "GPU") {
		t.Errorf("status %d, body %s", rec.Code, rec.Body)
	}
}

// TestReserveSlotCountsGPU checks the GPU cap against running GPU sessions
// and those still being created, and that other sessions ignore it.
func TestReserveSlotCountsGPU(t *testing.T) {
	ctx := context.Background()
	a := gpuAgent(t, 2, "game/running/gpu", "shell/running")

	if err := a.reserveSlot(ctx, "creating-gpu", true); err != nil {
		t.Fatalf("second GPU session: %v", err)
	}
	if err := a.reserveSlot(ctx, "third-gpu", true); !errors.Is(err, errGPUFull) {
		t.Errorf("third GPU session: got %v, want errGPUFull", err)
	}
	if err := a.reserveSlot(ctx, "plain", false); err != nil {
		t.Errorf("session without GPU: %v", err)
	}
}

// TestHealthzGPU checks that a GPU node reports its devices, its cap and the
// GPU sessions in use, and that a node without a GPU reports no gpu at all.
func TestHealthzGPU(t *testing.T) {
	a := gpuAgent(t, 4, "game/running/gpu", "shell/running")
	var got struct {
		GPU *struct {
			Devices  []string `json:"devices"`
			Sessions int      `json:"sessions"`
			InUse    int      `json:"in_use"`
		} `json:"gpu"`
	}
	_ = json.Unmarshal(serveAPI(a, "/healthz").Body.Bytes(), &got)

	if got.GPU == nil || len(got.GPU.Devices) != 1 || got.GPU.Devices[0] != "nvidia.com/gpu=all" || got.GPU.Sessions != 4 || got.GPU.InUse != 1 {
		t.Errorf("gpu = %+v", got.GPU)
	}

	plain := testAgent("strict", false)
	plain.docker = fakeDockerClient(t, sessionsDocker(t, "shell/running"))
	if body := serveAPI(plain, "/healthz").Body.String(); strings.Contains(body, `"gpu"`) {
		t.Errorf("node without GPU: %s", body)
	}
}

// TestGPUFullStartIsFull checks that a start refused by GPU_SESSIONS counts
// as a full node, not as an error.
func TestGPUFullStartIsFull(t *testing.T) {
	a := gpuAgent(t, 1)
	a.metrics.observeStart("game", 0, errGPUFull)

	if body := serveAPI(a, "/metrics").Body.String(); !strings.Contains(body, `tryout_session_starts_total{project="game",result="full"} 1`) {
		t.Errorf("metrics:\n%s", body)
	}
}

// TestNvproxyCapabilities checks the capability list read from runsc's
// arguments, whatever the flag's spelling.
func TestNvproxyCapabilities(t *testing.T) {
	cases := map[string][]string{
		"compute,utility":                {"--nvproxy"},
		"compute,utility,graphics,video": nvproxyArgs,
		"all":                            {"--nvproxy", "--nvproxy-allowed-driver-capabilities", "all"},
	}
	for want, args := range cases {
		if got := nvproxyCapabilities(args); got != want {
			t.Errorf("%q: got %q, want %q", args, got, want)
		}
	}
	if !rendersOnGPU("all") || !rendersOnGPU("graphics,video,compute") || rendersOnGPU("compute,utility,video") {
		t.Error("rendersOnGPU")
	}
}
