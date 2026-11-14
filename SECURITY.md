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

Fixes land on `main` and ship in the next release. Until 1.0, only the latest release is
supported: upgrade to it to get a fix.

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
3. The control plane and its PostgreSQL database, which hold the session ids (the credentials in
   the session URLs).
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
| Embed page | Served by the control plane with a strict Content-Security-Policy: scripts, styles, fonts and requests from its own origin only, no inline code, session frames only from the nodes' public URLs (any origin of the scheme if a `public_url` puts `{session}` deeper than the first label of its host, which the control plane warns about), framed only by `embed_frame_ancestors`. No third-party resource, font CDN included. Server messages are shown as text, never parsed as HTML. `Referrer-Policy: no-referrer`, so the session URL in the nested frame never leaks. The operator's theme (accent and logo) is served from the same origin, so the policy does not widen for it; project titles are escaped in the HTML and written as text. |
| Theme logo | A file the operator chooses, possibly an SVG. Read once at startup, at most 64 KB, accepted only if its content is an SVG, PNG or WebP image. The page shows it with `<img>`, where an SVG runs no script; opened on its own, it is served with `nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so it cannot run anything either. |
| Selkies features | File transfer, microphone, webcam, printing, gamepads and second screen are disabled and locked. The visitor cannot re-enable them. |
| Lifetime | Maximum session age. A session ends about 30 s after its heartbeat is lost (the event stream closes or polling stops). A peer that vanishes without closing its connection is only detected when the TCP connection or the proxy times out (about 11 minutes with Linux TCP keepalive defaults on a direct connection). The maximum age bounds an active session; a waiting ticket keeps its place until then. The agent keeps a safety net: it removes expired containers and orphan networks even if the control plane is gone. |
| Session requests | The agent validates every session request against the JSON Schema shared with the control plane: unknown fields are refused, and so are environment variables the agent sets itself. |
| Call direction | The control plane calls the agent, never the reverse, over mutual TLS 1.3 with a private CA. The agent accepts only a client certificate with the `clientAuth` usage; the control plane accepts only an agent certificate with the `serverAuth` usage that names the node it called. A node's certificate cannot impersonate the control plane or another node. The node holds no credential towards the rest of the infrastructure, except an optional read-only registry token for private project images. |
| Per-IP limits | An IP address (an IPv6 /64) may hold 4 live tickets, create 10 tickets a minute and keep 8 event streams open, by default. Beyond that the control plane answers `429`. A single client cannot monopolise a queue. The address comes from the connection, or from forwarding headers only when the connection comes from a configured trusted proxy. It is stored in clear with the ticket (hashing would protect little: every IPv4 address can be hashed in seconds) and deleted 5 minutes after the ticket ends; it is never logged. |
| State store | PostgreSQL is reachable by the control plane only: the dev compose file and the production example (`deploy/control-plane`) put it on an internal network that no node component joins. |
| Prerequisites | The agent **refuses to start** if the declared profile is not met (see below). |

## Node profiles

The profile is declared per node (`NODE_PROFILE`). It describes the situation of the machine that
runs sessions. Operators run Tryout on very different machines (a dedicated VM, one small server
running everything, a laptop), so the isolation level is a deployment choice checked at startup,
not a code fork.

### `strict`: dedicated machine or VM

- **Assumes**: a host or VM running nothing else, ideally on an isolated network (VLAN), with no
  secrets towards the rest of the infrastructure.
- **The agent requires** gVisor (`runsc`). Any other runtime (`runc`, `io.containerd.runc.v2`,
  Kata…) is accepted only with `ALLOW_RUNC=true`, for the default runtime and for each session.
  The rule is an allowlist because the daemon can list runc under other names, and the agent
  cannot judge the isolation of an unknown runtime.
- **If a session escapes**, the attacker gets a disposable machine. Reinstall it.
- **Residual risk**: lateral movement if the network is not segmented; resource exhaustion.

### `single-host`: machine shared with other services

- **Assumes**: the machine also runs important services.
- **The agent requires**:
  - a **dedicated rootless Docker daemon**, never the main root socket;
  - **cgroup v2**, otherwise resource limits are silently ignored in rootless mode;
  - **gVisor**, unless `ALLOW_RUNC=true`, a documented weaker opt-out. Without it, the agent
    accepts no runtime but `runsc`, for the default runtime and for each session.
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

On a small node, desktop sessions force a choice between gVisor (fewer sessions), runc (weaker
isolation) and a VM node (memory). Sysbox is not offered: an analysis reports that it greatly
increases the reachable kernel attack surface.

## Deployment recommendations

The production example files (`deploy/node`, `deploy/control-plane`, see the Production
deployment page, `docs/deployment.md`) follow these recommendations where a compose file can:
read-only containers with no capabilities and `no-new-privileges` for the agent, the gateway
and the control plane, `strict` and gVisor by default, and an agent port that must be
published on an address you choose.

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
- **Pin project images by digest**, and do not build images on the node. Run Tryout itself from
  the published images (see the Published images page, `docs/published-images.md`), pinned
  by digest, and check their provenance.
- **Give the agent a read-only registry token** for private project images
  (`REGISTRY_AUTH_FILE`), limited to those images, on an account that owns nothing else of
  value. A session that escapes its sandbox could read it. The credentials stay on the node:
  they are never part of the control plane's configuration nor of a session request, so the
  control plane holds no registry secret and a session request cannot choose credentials.
- **Keep AppArmor and seccomp enabled** on the host.
- **Keep the Tryout CA key on your own machine.** Never copy `ca/ca.key` to a node or to the
  control plane, and use a CA dedicated to Tryout: an agent accepts any client certificate with
  the `clientAuth` usage from the CA it trusts. There is no revocation list: after a leak of the
  control plane's key or of the CA, issue a new CA (see the Certificates page,
  `docs/certificates.md`).
- **Keep the agent API off the Internet** even with mutual TLS: a private network, a VPN or a
  tunnel that carries TLS end to end.
- **Declare your reverse proxies in `client_ip.trusted_proxies`**, and only them. Without it,
  every visitor behind the proxy shares its address and its limits; with a block that is too
  broad, a visitor can claim any address in `X-Forwarded-For`. Rate limiting raw requests at the
  proxy is a useful complement.
- **Keep PostgreSQL private to the control plane.** Never expose it on a network that nodes or
  the Internet can reach, and use a strong password. It holds the ids of live sessions.

## Known limitations

- **Per-IP limits** count visitors by IP address (IPv6: by /64). Visitors behind one shared
  address share one budget, and an attacker with many addresses gets many budgets. Each control
  plane instance counts open event streams on its own.
- **A session URL can be shared** by the visitor who received it. This is by design: it only
  grants access to that session, for its lifetime.
- **Resource-exhaustion denial of service** remains possible within the configured limits.
  Without egress, a session cannot be used as a relay or mine towards the outside, but it does
  use its CPU quota.
- **CPU side channels** (Spectre and variants) between sessions sharing a host are not covered,
  except with a VM node.
