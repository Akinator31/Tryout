package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// CheckProfile inspects the Docker daemon and refuses to start when the node
// profile (NODE_PROFILE) is not met: the profile is a contract, not a hint.
//
//   - dev: anything goes, with a loud warning;
//   - strict: gVisor (runsc) installed, unless ALLOW_RUNC=true;
//   - single-host: a dedicated rootless daemon, cgroup v2 (otherwise rootless
//     resource limits are silently ignored) and gVisor, unless ALLOW_RUNC=true.
//
// It also records the daemon's architecture and runtimes, and settles the
// default runtime (see resolveDefaultRuntime).
func (a *Agent) CheckProfile(ctx context.Context) error {
	info, err := a.docker.Info(ctx)
	if err != nil {
		return fmt.Errorf("docker unreachable at %s: %w", a.cfg.DockerHost, err)
	}

	a.arch = normArch(info.Architecture)
	a.policy.Runtimes = map[string]bool{}
	for r := range info.Runtimes {
		a.policy.Runtimes[r] = true
	}
	rootless := isRootless(info)
	slog.Info("docker", "arch", a.arch, "runtimes", sortedKeys(a.policy.Runtimes), "rootless", rootless, "cgroup", info.CgroupVersion)

	if err := a.checkProfileRequirements(info, rootless); err != nil {
		return err
	}
	if a.policy.AllowRunc && a.policy.Profile != "dev" {
		slog.Warn("ALLOW_RUNC=true: sessions may use runtimes other than gVisor, such as runc on the host kernel")
	}
	return a.resolveDefaultRuntime()
}

// checkProfileRequirements checks what the node profile demands of the daemon.
func (a *Agent) checkProfileRequirements(info *dockerapi.Info, rootless bool) error {
	hasRunsc := a.policy.Runtimes["runsc"]

	switch a.policy.Profile {
	case "dev":
		slog.Warn("PROFILE=dev: NO SECURITY GUARANTEE, do not expose to the internet")

	case "strict":
		if !hasRunsc && !a.policy.AllowRunc {
			return errors.New("profile strict: runtime runsc (gVisor) not installed; install it or set ALLOW_RUNC=true explicitly")
		}

	case "single-host":
		if !rootless {
			return errors.New("profile single-host: DOCKER_HOST must point to a dedicated ROOTLESS daemon, never the main root socket")
		}
		if info.CgroupVersion != "2" {
			return errors.New("profile single-host: cgroup v2 required (otherwise rootless resource limits are silently ignored)")
		}
		if !hasRunsc && !a.policy.AllowRunc {
			return errors.New("profile single-host: runsc (gVisor) required; ALLOW_RUNC=true is a documented, weaker opt-out")
		}

	default:
		return fmt.Errorf("unknown NODE_PROFILE %q", a.policy.Profile)
	}
	return nil
}

// resolveDefaultRuntime makes sure DEFAULT_RUNTIME is installed and allowed.
// In dev, or with ALLOW_RUNC=true, a missing default falls back to runc.
// The allow check matters: otherwise the agent would start, then refuse every
// session that uses the default.
func (a *Agent) resolveDefaultRuntime() error {
	if !a.policy.Runtimes[a.policy.DefaultRuntime] && (a.policy.Profile == "dev" || a.policy.AllowRunc) {
		slog.Warn("default runtime missing, falling back to runc", "wanted", a.policy.DefaultRuntime)
		a.policy.DefaultRuntime = "runc"
	}

	if !a.policy.Runtimes[a.policy.DefaultRuntime] {
		return fmt.Errorf("DEFAULT_RUNTIME %q not available on this daemon", a.policy.DefaultRuntime)
	}
	if !a.policy.RuntimeAllowed(a.policy.DefaultRuntime) {
		return fmt.Errorf("profile %s: DEFAULT_RUNTIME %q is refused: use runsc, or set ALLOW_RUNC=true explicitly", a.policy.Profile, a.policy.DefaultRuntime)
	}
	return nil
}

// isRootless reports whether the daemon runs in rootless mode.
func isRootless(info *dockerapi.Info) bool {
	return slices.ContainsFunc(info.SecurityOptions, func(s string) bool {
		return strings.Contains(s, "name=rootless")
	})
}

// normArch maps the architecture names of `docker info` (uname style) to the
// names images use, so that the two can be compared.
func normArch(a string) string {
	switch a {
	case "x86_64":
		return "amd64"
	case "aarch64":
		return "arm64"
	}
	return a
}

// sortedKeys returns the keys of a set, sorted, for logs and the health check.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}
