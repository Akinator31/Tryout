package main

import (
	"slices"
	"testing"
)

// TestLoadConfigGPU checks GPU_DEVICES, a comma-separated list of CDI device
// names, and GPU_SESSIONS.
func TestLoadConfigGPU(t *testing.T) {
	t.Setenv("GPU_DEVICES", " nvidia.com/gpu=0, ,nvidia.com/gpu=1 ")
	t.Setenv("GPU_SESSIONS", "4")

	cfg := loadConfig()
	if want := []string{"nvidia.com/gpu=0", "nvidia.com/gpu=1"}; !slices.Equal(cfg.agent.GPUDevices, want) {
		t.Errorf("GPUDevices = %q, want %q", cfg.agent.GPUDevices, want)
	}
	if cfg.agent.GPUSessions != 4 {
		t.Errorf("GPUSessions = %d", cfg.agent.GPUSessions)
	}

	t.Setenv("GPU_DEVICES", "")
	if cfg := loadConfig(); len(cfg.agent.GPUDevices) != 0 {
		t.Errorf("no GPU_DEVICES: %q", cfg.agent.GPUDevices)
	}
}
