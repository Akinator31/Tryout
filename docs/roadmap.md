# Roadmap

Tryout moves through ordered milestones. Each milestone has a goal and exit criteria; an item
moves to [Done](#done) when it ships. There are no dates.

| Milestone | Goal | Status |
|---|---|---|
| [M0 — Proof of concept](#m0-proof-of-concept) | Show that the stack works end to end | Done |
| [M1 — Deployable](#m1-deployable) | Run Tryout on real infrastructure without building anything on the node | Done |
| [M2 — Live](#m2-live) | A first public deployment, a public repository and versioned releases | In progress |
| [M3 — Design](#m3-design) | A dark, clear and robust visitor experience, designed before it is built | Planned |
| [M4 — Operate](#m4-operate) | See and control what runs: admin UI, metrics, logs | Planned |
| [M5 — Hosting options](#m5-hosting-options) | More ways to run nodes safely | Planned |

## M0 — Proof of concept

Done. Validated end to end:

- agent, gateway and control plane, for terminals and desktops;
- network isolation: a session only sees the gateway's public port;
- Selkies under gVisor on a Raspberry Pi 5 (arm64), behind a base path;
- queue with per-project and per-node caps, heartbeat loss and maximum age;
- refusal to start when the node profile is not met.

## M1 — Deployable

**Goal:** an operator can run Tryout from published images and a documented configuration, with
the control plane and its nodes on different networks.

**Exit criteria:** a fresh machine runs the stack from `ghcr.io` images and a YAML file; the
control plane reaches a remote node over mTLS; CI covers all of it.

Done. Checked on two fresh Debian 13 virtual machines, each behind its own NAT, with the
control plane and the node reaching each other only through forwarded ports:

- node in profile `strict` with gVisor, control plane with PostgreSQL, both from `ghcr.io`
  images pinned by digest and a YAML file;
- the control plane reaches the agent over mutual TLS through a port forward, with
  `server_name`; every other client is refused;
- `e2e-cli`, `e2e-queue` and `e2e-sse` pass against that deployment; sessions run under `runsc`,
  read-only, with no capabilities, on their own internal network.

The check found that the agent accepted runc under another name in `strict`; fixed before
closing (see [Done](#done)). Its other findings are M2 items.

## M2 — Live

**Goal:** Tryout serves real visitors from a portfolio, and the project is public.

| Item | Notes |
|---|---|
| Guide for packaging a project for Tryout | Extends [Project images](project-images.md) with a step-by-step walkthrough |
| A minimal visual pass on the current embed page | Only so the first visitors do not see raw HTML; the real design is M3 |
| Public repository: private vulnerability reporting enabled, security policy checked | |
| Versioned releases: semantic version tags, changelog, images tagged per release | First release `v0.1.0` |
| `scripts/e2e-mtls.ts` against a remote node | It reads certificates from the dev compose stack only |
| The agent reattaches the gateway to every live session network | Today it attaches the gateway only when it creates a session: a recreated gateway (an upgrade) leaves running sessions unreachable while the control plane still counts them as active |
| Optional: GitHub Milestones and one issue per roadmap item | This page stays the source of truth |

**Exit criteria:** a portfolio embeds Tryout in production; the repository is public; `v0.1.0`
is released with its images.

## M3 — Design

**Goal:** a visitor experience that is very dark, professional and striking, and above all clear,
intuitive and robust. The design is settled in Figma before the React code is written.

Design steps, in order:

1. **Theme brief:** mood, references, typography, accent colour, motion, and what can be
   customised by the embedding site.
2. **Two or three directions** as throwaway HTML prototypes of the real embed states:
   connecting, waiting with position, starting, active with the remaining time, ending soon,
   ended, error, unavailable project. One direction is chosen.
3. **Figma mock-ups** of the chosen direction: design tokens, components, every embed state,
   and the admin screens of M4. Figma becomes the reference for the UI.
4. **UI kit choice**, recorded in an ADR. Chakra UI is the current candidate
   ([ADR 0008](decisions/0008-stack-and-license.md)); another kit may replace it if it fits the
   design better.

Build:

| Item | Replaces | Notes |
|---|---|---|
| Embed page in React, from the Figma mock-ups | Plain HTML embed page | Same queue API and event stream |
| Theming by configuration: accent colour, logo, texts | One built-in look | A dark default theme; the embedding site can adapt it |
| Internationalisation: English and French to start | English only | Language from the browser or a parameter |
| Accessibility: keyboard use, contrast, reduced motion, screen reader labels | | |
| Robust states: reconnection, network loss, errors, session about to end | | Every state has a designed screen |

**Exit criteria:** every embed state matches the Figma mock-ups, in English and French, and the
end-to-end tests still pass.

## M4 — Operate

**Goal:** the operator sees what runs and can act on it.

| Item | Notes |
|---|---|
| Admin authentication | Design and ADR first: the admin API must not weaken the security invariants |
| Admin UI (React): running sessions, queue per project, nodes, forced stop | Screens from the M3 Figma file |
| Metrics (Prometheus): sessions, queue length, start time, failures | Control plane and agent |
| Structured logs in the agent and the gateway | The control plane already logs JSON |

**Exit criteria:** an operator can find and stop any session from the admin UI, and graph queue
and session metrics.

## M5 — Hosting options

**Goal:** more ways to run nodes, each with a documented security level.

| Item | Replaces | Notes |
|---|---|---|
| Step-by-step `single-host` guide: dedicated rootless daemon and `DOCKER-USER` firewall | | |
| KVM virtual machine node (`strict`) for desktop sessions | | |
| Docker endpoint over SSH or TLS | `unix://` or `tcp://` only | |
| ttyd mounted read-only by the agent | ttyd baked into each image | Project images no longer ship ttyd |
| Subdomain routing in the gateway | Path routing only | Needs wildcard DNS and TLS; see [Public exposure](exposure.md) |

## Done

- **M0** — proof of concept, see [above](#m0-proof-of-concept).
- Queue and session state in Postgres, with tests through the queue interface (PGlite locally,
  PostgreSQL in CI). See ADRs [0007](decisions/0007-queue-in-postgres.md) and
  [0011](decisions/0011-queue-implementation.md).
- Ticket changes pushed over SSE, with Postgres `LISTEN/NOTIFY` across instances. The open
  stream is the heartbeat. See ADR [0012](decisions/0012-ticket-push-sse.md).
- **M1:** multi-architecture images on `ghcr.io` for the node, the control plane and the sample
  project, published by CI on `main` and on tags. See [Published images](published-images.md)
  and ADR [0013](decisions/0013-published-images.md).
- **M1:** YAML configuration validated by one JSON Schema, shared by the control plane and the
  agent, with every error reported at startup. See [Configuration](configuration.md) and ADR
  [0014](decisions/0014-yaml-configuration-json-schema.md).
- **M1:** mutual TLS 1.3 between the control plane and the agents, with a private CA made by
  `tryout-certs`; the end-to-end tests run over it. See [Certificates](certificates.md) and ADR
  [0015](decisions/0015-mutual-tls-control-plane-agent.md).
- **M1:** per-IP limits on live tickets, ticket creation and open event streams, with the
  client address read through trusted proxies only. See [Configuration](configuration.md#per-ip-limits)
  and ADR [0016](decisions/0016-per-ip-limits.md).
- **M1:** the node-postgres `LISTEN` reconnect is tested against PostgreSQL in CI: server-side
  termination, unreachable or silent database, a link cut during `LISTEN`, and `close()` during
  an attempt.
- **M1:** outside the `dev` profile, the agent accepts only the `runsc` runtime, as
  `DEFAULT_RUNTIME` and per session, unless `ALLOW_RUNC=true`. See ADR
  [0003](decisions/0003-node-profiles-and-runtimes.md).
- **M1** closed: exit criteria checked on fresh machines, see [above](#m1-deployable).
- **M2:** the agent pulls private project images with registry credentials from a
  `config.json`-style file (`REGISTRY_AUTH_FILE`), sent only to the image's registry. See
  [Project images](project-images.md#private-images) and ADR
  [0017](decisions/0017-registry-credentials.md).
- **M2:** production deployment guide and example compose files from the published images,
  one directory per kind of machine (`deploy/node`, `deploy/control-plane`). CI deploys them as
  written, in profile `strict` with gVisor, and runs the end-to-end tests against them. See
  [Production deployment](deployment.md).
