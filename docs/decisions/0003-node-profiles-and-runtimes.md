# 0003 — Security profiles per node, runtime per project

**Status:** accepted

## Context

Operators have very different setups: a dedicated VM, a single small server running everything,
a laptop. The project is public and must not encode one operator's infrastructure.

- [gVisor](https://gvisor.dev/docs/architecture_guide/security/) shrinks the host kernel attack
  surface, but costs performance on syscall-heavy workloads
  ([gVisor performance guide](https://gvisor.dev/docs/architecture_guide/performance/)).
- The POC measured gVisor at **2 to 2.5× the CPU of runc** for a Selkies desktop on a Raspberry
  Pi 5, and negligible overhead for terminals (see [Performance](../performance.md)).
- Kata/VM isolation needs KVM and memory
  ([comparison](https://computingforgeeks.com/gvisor-vs-kata-containers-vs-runc/)).
- Sysbox was rejected: an analysis reports a large increase in the reachable kernel attack
  surface ([Edera](https://edera.dev/stories/sysbox-increases-kernel-attack-surface-by-267-percent)).

## Decision

- Each node declares a profile: `dev`, `strict` (dedicated machine or VM) or `single-host`
  (shared machine).
- The agent checks the prerequisites at startup and refuses to start if they are missing:
  - `strict`: gVisor installed;
  - `single-host`: a dedicated rootless daemon, cgroup v2 and gVisor.
- `ALLOW_RUNC=true` is an explicit, documented opt-out.
- Outside `dev`, the runtime rule is an allowlist: without `ALLOW_RUNC=true`, the agent accepts
  only the runtime named `runsc`, both as `DEFAULT_RUNTIME` (checked at startup) and in each
  session request. The daemon can list runc under other names (`io.containerd.runc.v2`), and the
  agent cannot judge the isolation of an unknown runtime.
- The runtime can be set per project, with the node default as fallback.

## Consequences

- The isolation level is a deployment choice, documented in `SECURITY.md`, not a code fork.
- Operators running desktops on small nodes must choose between gVisor (fewer sessions), runc
  (weaker isolation) and a VM node (memory).
