package agent

import (
	"errors"
	"log/slog"
	"slices"
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
		if a.gpuSessions > 0 {
			slog.Warn("GPU_SESSIONS is set without GPU_DEVICES: this node gives no GPU")
		}
		return nil
	}

	if a.gpuSessions <= 0 {
		return errors.New("GPU_DEVICES is set: GPU_SESSIONS must cap the concurrent GPU sessions")
	}
	runsc, ok := info.Runtimes["runsc"]
	if !ok || !nvproxyOn(runsc.Args) {
		return errors.New("GPU_DEVICES is set: the runsc runtime needs --nvproxy in its runtimeArgs (daemon.json)")
	}

	if caps := nvproxyCapabilities(runsc.Args); !rendersOnGPU(caps) {
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
// The flag may carry its value (--flag=caps) or be followed by it.
func nvproxyCapabilities(args []string) string {
	const flag = "nvproxy-allowed-driver-capabilities"

	caps := "compute,utility"
	for i, arg := range args {
		name, value, hasValue := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		switch {
		case name != flag:
		case hasValue:
			caps = value
		case i+1 < len(args):
			caps = args[i+1]
		}
	}
	return caps
}

// rendersOnGPU reports whether a capability list lets sessions render
// (graphics) and encode (video) on the GPU.
func rendersOnGPU(caps string) bool {
	list := strings.Split(caps, ",")
	return slices.Contains(list, "all") || (slices.Contains(list, "graphics") && slices.Contains(list, "video"))
}
