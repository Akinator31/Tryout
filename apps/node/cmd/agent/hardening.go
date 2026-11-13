package main

import (
	"slices"
	"strconv"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// desktopCapabilities is the minimal capability set for the boot sequence of
// LinuxServer/Selkies images: they boot as root under s6, chown files and
// then drop to PUID. Every other capability is dropped.
var desktopCapabilities = []string{"CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"}

// containerSpec is where the hardening lives. It is NOT configurable by the
// control plane on purpose: only image/kind/limits come from outside.
func (a *agent) containerSpec(r sessionReq, netName string) dockerapi.ContainerCreate {
	return dockerapi.ContainerCreate{
		Image:      r.Image,
		Env:        sessionEnv(r),
		Hostname:   "tryout",
		Labels:     sessionLabels(r),
		HostConfig: hostConfig(r, netName),
	}
}

// hostConfig is the hardening common to every session (no capabilities, no
// privilege escalation, hard resource limits, no swap beyond memory, small
// logs, the session's own network), plus the kind's specifics:
//
//   - terminal: an init process, a read-only root filesystem and a small /tmp;
//   - desktop: desktopCapabilities and a 1 GiB /dev/shm for the browser
//     stream.
func hostConfig(r sessionReq, netName string) dockerapi.HostConfig {
	memory := int64(r.Limits.MemoryMB) << 20
	hc := dockerapi.HostConfig{
		Runtime:     r.Runtime,
		NetworkMode: netName,
		CapDrop:     []string{"ALL"},
		SecurityOpt: []string{"no-new-privileges:true"},
		Memory:      memory,
		MemorySwap:  memory,
		NanoCpus:    int64(r.Limits.CPUs * 1e9),
		PidsLimit:   r.Limits.Pids,
		LogConfig:   &dockerapi.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "1m", "max-file": "1"}},
	}

	switch r.Kind {
	case kindTerminal:
		hc.Init = true
		hc.ReadonlyRootfs = true
		hc.Tmpfs = map[string]string{"/tmp": "rw,nosuid,nodev,size=64m,mode=1777"}
	case kindDesktop:
		hc.CapAdd = slices.Clone(desktopCapabilities)
		hc.ShmSize = 1 << 30
	}
	return hc
}

// sessionLabels are the Docker labels that describe a session. They are the
// node's source of truth: the reconcile loop and the route table read them
// back, the agent keeps no session state of its own. Times are Unix seconds
// on the agent's clock, which may differ from a remote daemon's.
func sessionLabels(r sessionReq) map[string]string {
	created := time.Now()
	expires := created.Add(time.Duration(r.MaxAgeS) * time.Second)
	return map[string]string{
		labelSession: r.ID,
		labelProject: r.Project,
		labelCreated: strconv.FormatInt(created.Unix(), 10),
		labelExpires: strconv.FormatInt(expires.Unix(), 10),
		labelPort:    strconv.Itoa(r.Port),
		labelStrip:   strconv.FormatBool(r.StripPrefix),
	}
}
