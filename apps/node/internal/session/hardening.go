package session

import (
	"slices"
	"strconv"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// Docker labels set on session containers and networks. They are the node's
// source of truth: the agent's reconcile loop and route table read them
// back, the agent keeps no session state of its own. Times are Unix seconds
// on the agent's clock, which may differ from a remote daemon's.
const (
	LabelSession = "tryout.session"
	LabelProject = "tryout.project"
	LabelCreated = "tryout.created"
	LabelExpires = "tryout.expires"
	LabelPort    = "tryout.port"
	LabelStrip   = "tryout.strip-prefix"
)

// namePrefix starts the names of session containers and networks.
const namePrefix = "tryout-s-"

// Name is the name of a session's container and of its network.
func Name(id string) string {
	return namePrefix + id
}

// desktopCapabilities is the minimal capability set for the boot sequence of
// LinuxServer/Selkies images: they boot as root under s6, chown files and
// then drop to PUID. Every other capability is dropped.
var desktopCapabilities = []string{"CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"}

// Spec is the container of a parsed request, on the session network named
// network, created at now. img is what the agent read from the request's
// image; a terminal with the agent's ttyd runs its program, and fails when
// it has none. This is where the hardening lives. It is NOT configurable by
// the control plane on purpose: only the image, the kind, the program, the
// limits and the project environment come from outside.
func Spec(r Request, img Image, network string, now time.Time) (dockerapi.ContainerCreate, error) {
	c := dockerapi.ContainerCreate{
		Image:      r.Image,
		Env:        containerEnv(r),
		Hostname:   "tryout",
		Labels:     labels(r, now),
		HostConfig: hostConfig(r, network),
	}

	if r.TTYD == TTYDAgent {
		if err := withTTYD(&c, r, img); err != nil {
			return c, err
		}
	}
	return c, nil
}

// hostConfig is the hardening common to every session (no capabilities, no
// privilege escalation, hard resource limits, no swap beyond memory, small
// logs, the session's own network), plus the kind's specifics:
//
//   - terminal: an init process, a read-only root filesystem and a small /tmp;
//   - desktop: desktopCapabilities and a 1 GiB /dev/shm for the browser
//     stream.
func hostConfig(r Request, network string) dockerapi.HostConfig {
	memory := int64(r.Limits.MemoryMB) << 20
	hc := dockerapi.HostConfig{
		Runtime:     r.Runtime,
		NetworkMode: network,
		CapDrop:     []string{"ALL"},
		SecurityOpt: []string{"no-new-privileges:true"},
		Memory:      memory,
		MemorySwap:  memory,
		NanoCpus:    int64(r.Limits.CPUs * 1e9),
		PidsLimit:   r.Limits.Pids,
		LogConfig:   &dockerapi.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "1m", "max-file": "1"}},
	}

	switch r.Kind {
	case Terminal:
		hc.Init = true
		hc.ReadonlyRootfs = true
		hc.Tmpfs = map[string]string{"/tmp": "rw,nosuid,nodev,size=64m,mode=1777"}
	case Desktop:
		hc.CapAdd = slices.Clone(desktopCapabilities)
		hc.ShmSize = 1 << 30
	}
	return hc
}

// labels are the Docker labels that describe a session (see LabelSession).
func labels(r Request, created time.Time) map[string]string {
	expires := created.Add(time.Duration(r.MaxAgeS) * time.Second)
	return map[string]string{
		LabelSession: r.ID,
		LabelProject: r.Project,
		LabelCreated: strconv.FormatInt(created.Unix(), 10),
		LabelExpires: strconv.FormatInt(expires.Unix(), 10),
		LabelPort:    strconv.Itoa(r.Port),
		LabelStrip:   strconv.FormatBool(r.StripPrefix),
	}
}
