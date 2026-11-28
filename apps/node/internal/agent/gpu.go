package agent

import (
	"errors"
	"log/slog"
	"strings"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// checkGPU refuses a node with GPU_DEVICES whose GPU sessions could not be
// sandboxed or capped. GPU sessions always run under runsc (see
// session.Request.applyGPUPolicy), so the runsc runtime must have gVisor's
// nvproxy on: without it, runsc does not expose the GPU at all. GPU_SESSIONS
// is required because the right cap depends on the card's memory and encoder.
// A capability list without graphics and video only warns: sessions start,
// but render and encode on the CPU.
func (a *Agent) checkGPU(info *dockerapi.Info) error {
	if len(a.policy.GPUDevices) == 0 {
		return nil
	}

	if a.gpuSessions <= 0 {
		return errors.New("GPU_DEVICES is set: GPU_SESSIONS must cap the concurrent GPU sessions")
	}
	runsc, ok := info.Runtimes["runsc"]
	if !ok || !nvproxyOn(runsc.Args) {
		return errors.New("GPU_DEVICES is set: the runsc runtime needs --nvproxy in its runtimeArgs (daemon.json)")
	}

	if caps := nvproxyCapabilities(runsc.Args); !strings.Contains(caps, "graphics") || !strings.Contains(caps, "video") {
		slog.Warn("runsc nvproxy does not allow the graphics and video driver capabilities: GPU sessions will render and encode on the CPU", "capabilities", caps)
	}
	slog.Info("gpu", "devices", a.policy.GPUDevices, "sessions", a.gpuSessions)
	return nil
}

// nvproxyOn reports whether runsc arguments turn nvproxy on, the last
// occurrence winning as with any flag.
func nvproxyOn(args []string) bool {
	on := false
	for _, arg := range args {
		switch arg {
		case "--nvproxy", "--nvproxy=true", "-nvproxy", "-nvproxy=true":
			on = true
		case "--nvproxy=false", "-nvproxy=false":
			on = false
		}
	}
	return on
}

// nvproxyCapabilities returns the driver capabilities runsc arguments allow
// GPU sessions, or nvproxy's default (compute,utility) when they set none.
func nvproxyCapabilities(args []string) string {
	caps := "compute,utility"
	for _, arg := range args {
		if v, ok := strings.CutPrefix(strings.TrimLeft(arg, "-"), "nvproxy-allowed-driver-capabilities="); ok {
			caps = v
		}
	}
	return caps
}
