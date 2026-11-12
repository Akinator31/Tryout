# Security policy

Tryout runs code in containers on behalf of anonymous visitors. Security is the core of the
project, not an add-on. This document describes the threat model, the protections in place, what
they do not cover, and how to report a vulnerability.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub private vulnerability reporting: the *Security* tab
of the repository, then *Report a vulnerability*.

Include the commit, the node profile, the runtime in use and a reproducible scenario. We aim to
send a first answer within 7 days.

## Supported versions

The project is pre-release. Only the `main` branch receives fixes.

## Threat model

### Actors

| Actor | Assumption |
|---|---|
| **Visitor** | Anonymous and potentially malicious. Has **full control** of whatever runs in their session: can run any program, kill the session's web server and replace it with their own, and serve arbitrary HTML from the session URL. |
| **Internet** | Anyone can reach the public gateway and control plane. |
| **Operator** | Trusted. Writes the configuration, chooses project images, administers nodes. |
| **Project images** | Provided by the operator and assumed benign, but executed for strangers: anything inside them is within the visitor's reach. |

### What we protect, in order

1. The node host and the operator's other services (e.g. a Dokploy instance and its databases).
2. The operator's local network.
3. The control plane, which decides who gets a session.
4. Other visitors' sessions.
5. The reputation of the operator's domain (phishing, cookies).
6. Service availability.

### Trust boundaries

```
Internet ──► gateway (no Docker socket) ──► session (hardened container, chosen runtime)
                                                │
                                   kernel: gVisor (Sentry) or host kernel (runc) or VM
                                                │
                   dedicated Docker daemon (rootless in single-host) ◄── agent (sole socket holder)
                                                ▲
                   control plane ───────────────┘  (the control plane calls the agent, never the reverse)
```

## Protections in place

They are **hard-coded in the agent**. Neither the control plane nor a project's configuration
can turn them off.

| Area | Measure |
|---|---|
| Privileges | `--cap-drop ALL`, `no-new-privileges`, never `--privileged`. Desktop sessions get back only `CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`, `FOWNER` and `KILL`, required by the s6 init of LinuxServer images. |
| Resources | Per-session memory (swap included), CPU and PID limits; logs capped at 1 MB. |
| Filesystem | Terminal: read-only root, tmpfs `/tmp`. Fresh container and volume for every session, removed at the end. |
| Network | One `--internal` network per session, with no route to the Internet, the LAN or the host. Only the gateway is attached to it. |
| Gateway | No access to the Docker socket. Its admin API listens on a unix socket shared only with the agent, never on a TCP port reachable from sessions. |
| Session authentication | The URL carries a 130-bit random id, checked on every request, WebSocket included. No cookies. |
| Response headers | The gateway rewrites every response, whatever the session serves: enforced `frame-ancestors`; `X-Frame-Options`, `Set-Cookie` and `Service-Worker-Allowed` stripped; `Referrer-Policy: no-referrer` (the URL is the secret); `nosniff`; `no-store`. Browser cookies are not forwarded to the session. |
| Selkies features | File transfer, microphone, webcam, printing, gamepads and second screen are disabled and locked. The visitor cannot re-enable them. |
| Lifetime | Maximum session age. A session ends about 30 s after its heartbeat is lost. The agent keeps a safety net: it removes expired containers and orphan networks even if the control plane is gone. |
| Call direction | The control plane calls the agent with a token. The node holds no credential towards the rest of the infrastructure. |
| Prerequisites | The agent **refuses to start** if the declared profile is not met (see below). |

## Node profiles

The profile is declared per node (`NODE_PROFILE`). It describes the situation of the machine that
runs sessions.

### `strict`: dedicated machine or VM

- **Assumes**: a host or VM running nothing else, ideally on an isolated network (VLAN), with no
  secrets towards the rest of the infrastructure.
- **The agent requires** gVisor (`runsc`). `runc` is accepted only with `ALLOW_RUNC=true`.
- **If a session escapes**, the attacker gets a disposable machine. Reinstall it.
- **Residual risk**: lateral movement if the network is not segmented; resource exhaustion.

### `single-host`: machine shared with other services

- **Assumes**: the machine also runs important services.
- **The agent requires**:
  - a **dedicated rootless Docker daemon**, never the main root socket;
  - **cgroup v2**, otherwise resource limits are silently ignored in rootless mode;
  - **gVisor**, unless `ALLOW_RUNC=true`, a documented weaker opt-out.
- **If a session escapes**, the attacker must get through gVisor, then exploit a kernel flaw to
  get past the unprivileged user of the rootless daemon.
- **Residual risk**: a flaw in the shared kernel. With `ALLOW_RUNC=true`, a single kernel flaw
  is enough.

### `dev`: local development

No guarantee. The regular Docker socket and any runtime are accepted. Never expose it to the
Internet.

## Choosing a runtime

| Runtime | Isolation | Measured cost |
|---|---|---|
| `runc` | Shared host kernel; only the surface filtered by seccomp and AppArmor protects it. | Baseline. |
| `runsc` (gVisor) | The container talks to a kernel reimplemented in user space. The host kernel is reached only through a small, filtered set of calls. | Negligible for terminals. **2 to 2.5× more CPU** for a software-encoded desktop session (see the Performance page, `docs/performance.md`). |
| VM (KVM, Kata) | Dedicated kernel. | A few hundred MB of RAM; low CPU cost for video encoding. |

## Deployment recommendations

- **Serve sessions from a dedicated domain**, not the one of your site or other services. A
  visitor can serve any page from their session: on a shared domain, they could phish in your
  name or set cookies on the parent domain.
- **Isolate the node's network**: it must not be able to open connections to your LAN or your
  infrastructure. Docker bypasses UFW, so filter in the `DOCKER-USER` chain.
- **Never mount the main daemon's socket into the agent** in `single-host`. Holding that socket
  is equivalent to root on the host.
- **Keep the kernel, Docker, runc (≥ 1.2.8 or 1.3.3) and gVisor up to date.** Several past
  container escapes (CVE-2019-5736, CVE-2024-21626, CVE-2025-31133/52565/52881) were fixed in
  runc.
- **Pin project images by digest**, and do not build images on the node.
- **Keep AppArmor and seccomp enabled** on the host.

## Known limitations

- **Pre-release**:
  - the control plane → agent link is HTTP with a token (no TLS or mTLS yet): expose the agent
    API on a private network only;
  - there is no rate limiting on ticket creation yet.
- **A session URL can be shared** by the visitor who received it. This is by design: it only
  grants access to that session, for its lifetime.
- **Resource-exhaustion denial of service** remains possible within the configured limits.
  Without egress, a session cannot be used as a relay or mine towards the outside, but it does
  use its CPU quota.
- **CPU side channels** (Spectre and variants) between sessions sharing a host are not covered,
  except with a VM node.
