# Roadmap

Tryout moves through ordered milestones. Each milestone has a goal and exit criteria; an item
moves to [Done](#done) when it ships. There are no dates.

| Milestone | Goal | Status |
|---|---|---|
| [M0 — Proof of concept](#m0-proof-of-concept) | Show that the stack works end to end | Done |
| [M1 — Deployable](#m1-deployable) | Run Tryout on real infrastructure without building anything on the node | In progress |
| [M2 — Live](#m2-live) | A first public deployment, a public repository and versioned releases | Planned |
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

| Item | Replaces | Notes |
|---|---|---|
| Per-IP limits on ticket creation and on open event streams | No rate limiting | Also bounds waiting tickets kept alive by half-open streams (ADR 0012) |
| Unit test for the node-postgres `LISTEN` reconnect | Manual check | Follow-up of ADR 0012 |

**Exit criteria:** a fresh machine runs the stack from `ghcr.io` images and a YAML file; the
control plane reaches a remote node over mTLS; CI covers all of it.

## M2 — Live

**Goal:** Tryout serves real visitors from a portfolio, and the project is public.

| Item | Notes |
|---|---|
| Production deployment guide and example compose file using the published images | Generic: no provider, domain or host layout baked in |
| Guide for packaging a project for Tryout | Extends [Project images](project-images.md) with a step-by-step walkthrough |
| A minimal visual pass on the current embed page | Only so the first visitors do not see raw HTML; the real design is M3 |
| Public repository: private vulnerability reporting enabled, security policy checked | |
| Versioned releases: semantic version tags, changelog, images tagged per release | First release `v0.1.0` |
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
