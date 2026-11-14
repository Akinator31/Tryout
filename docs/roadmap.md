# Roadmap

Tryout moves through ordered milestones. Each milestone has a goal and exit criteria; an item
moves to [Done](#done) when it ships. There are no dates.

Next: the rest of M4, released as `v0.2.0`.

| Milestone | Goal | Status |
|---|---|---|
| [M0 — Proof of concept](#m0-proof-of-concept) | Show that the stack works end to end | Done |
| [M1 — Deployable](#m1-deployable) | Run Tryout on real infrastructure without building anything on the node | Done |
| [M2 — Live](#m2-live) | A first public deployment, a public repository and versioned releases | Done |
| [M3 — Design](#m3-design) | A dark, clear and robust visitor experience, designed before it is built | Done |
| [M4 — Operate](#m4-operate) | Set up and control projects from an admin UI; metrics and logs | In progress |
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
| Optional: GitHub Milestones and one issue per roadmap item | This page stays the source of truth |

**Exit criteria:** a portfolio embeds Tryout in production; the repository is public; `v0.1.0`
is released with its images.

Done. A portfolio embeds a terminal project in production, from the `v0.1.0` images:

- node in profile `strict` with gVisor on a small cloud VM (2 vCPU, 1 GB of RAM), its agent and
  gateway published on the loopback only;
- control plane and PostgreSQL on another machine, behind a reverse proxy;
- the control plane reaches the agent through a TCP tunnel that carries mutual TLS end to end,
  with `server_name`; the tunnel's own access policy is a second barrier;
- sessions run under `runsc`, read-only, with no capabilities and no egress, and are destroyed
  at the end.

The deployment found that the gateway's `FRAME_ANCESTORS` must list the portfolios as well as
the control plane, since browsers check every ancestor of a frame; the documentation said
otherwise and is fixed.

## M3 — Design

**Goal:** a visitor experience that is very dark, professional and striking, and above all clear,
intuitive and robust. The design is settled in Figma before the UI code is written.

Design steps, in order:

1. **Theme brief:** mood, references, typography, accent colour, motion, and what can be
   customised by the embedding site.
2. **Two or three directions** as throwaway HTML prototypes of the real embed states:
   connecting, waiting with position, starting, active with the remaining time, ending soon,
   ended, error, unavailable project. One direction is chosen.
3. **Figma mock-ups** of the chosen direction: design tokens, components, every embed state,
   and the admin screens of M4. Figma becomes the reference for the UI.
4. **UI kit choice** (done): Chakra UI v3 for the admin (React); the embed in TypeScript
   without a UI framework, styled with CSS custom properties. One token module, kept in step
   with the Figma variables, is shared by both. IBM Plex fonts are bundled and served by the
   control plane, with no CDN.

Built: the embed page from the mock-ups, in English and French, with theming by configuration
(see [Done](#done)).

**Exit criteria:** every embed state matches the Figma mock-ups, in English and French, and the
end-to-end tests still pass.

## M4 — Operate

**Goal:** the operator sets up projects, nodes and limits from an admin UI, sees what runs and
can act on it. Released as `v0.2.0`.

| Item | Notes |
|---|---|
| Configuration stored in Postgres, with revisions validated by the JSON Schema | Nodes, projects, limits, embedding and theme; each revision is a full snapshot, applied to every instance without a restart. Listen address, agent TLS files and trusted proxies stay in `tryout.yaml`. A file with nodes and projects seeds an empty database; YAML import and export stay |
| Admin authentication | Local accounts with scrypt passwords and server-side sessions; the first account is made from the command line, with no open sign-up |
| Admin API and UI on their own listener (`admin_listen`) | Off by default, so the admin can stay off the Internet. Projects (with a pause switch), nodes, embedding and limits, theme, revisions and rollback, running sessions and forced stop. React and Chakra UI, screens from the M3 Figma file |
| Node health from the agent's `/healthz`, called by the control plane | Nodes still never call the control plane. No session starts on a node that does not answer |
| Metrics (Prometheus): sessions, queue length, start time, failures | On the admin listener. The control plane relays each agent's metrics over mutual TLS, so nodes open no new port |

**Exit criteria:** an operator can set up a project from scratch, find and stop any session from
the admin UI, and graph queue and session metrics.

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
  PostgreSQL in CI). See [Architecture](architecture.md#the-queue-in-postgres).
- Ticket changes pushed over SSE, with Postgres `LISTEN/NOTIFY` across instances. The open
  stream is the heartbeat. See [Architecture](architecture.md#ticket-changes-over-sse).
- **M1:** multi-architecture images on `ghcr.io` for the node, the control plane and the sample
  project, published by CI on `main` and on tags. See [Published images](published-images.md).
- **M1:** YAML configuration validated by one JSON Schema, shared by the control plane and the
  agent, with every error reported at startup. See [Configuration](configuration.md).
- **M1:** mutual TLS 1.3 between the control plane and the agents, with a private CA made by
  `tryout-certs`; the end-to-end tests run over it. See [Certificates](certificates.md).
- **M1:** per-IP limits on live tickets, ticket creation and open event streams, with the
  client address read through trusted proxies only. See [Configuration](configuration.md#per-ip-limits).
- **M1:** the node-postgres `LISTEN` reconnect is tested against PostgreSQL in CI: server-side
  termination, unreachable or silent database, a link cut during `LISTEN`, and `close()` during
  an attempt.
- **M1:** outside the `dev` profile, the agent accepts only the `runsc` runtime, as
  `DEFAULT_RUNTIME` and per session, unless `ALLOW_RUNC=true`. See [Security](security.md#node-profiles).
- **M1** closed: exit criteria checked on fresh machines, see [above](#m1-deployable).
- **M2:** the agent pulls private project images with registry credentials from a
  `config.json`-style file (`REGISTRY_AUTH_FILE`), sent only to the image's registry. See
  [Project images](project-images.md#private-images).
- **M2:** production deployment guide and example compose files from the published images,
  one directory per kind of machine (`deploy/node`, `deploy/control-plane`). CI deploys them as
  written, in profile `strict` with gVisor, and runs the end-to-end tests against them. See
  [Production deployment](deployment.md).
- **M2:** `scripts/e2e-mtls.ts` checks any agent, local or remote, with the operator's
  `tryout-certs` directory; CI runs it against the production layout's published agent port.
  See [Production deployment](deployment.md#5-check-and-embed).
- **M2:** the agent's reconcile loop attaches a recreated gateway again to every running session
  network, so sessions survive a node upgrade with an interruption of about one reconcile
  period (10 s). `scripts/e2e-reattach.ts` recreates the gateway during a session in CI: alone
  on the dev layout, with the agent on the production layout, as an upgrade does. See [Production deployment](deployment.md#upgrade).
- **M2:** the reconcile loop reaps session containers stuck in `created` for over a minute,
  measured with the agent's `tryout.created` label. A create aborted by the control plane (the
  visitor left while the session was starting) could leave one behind, holding a slot until its
  maximum age and eventually filling the node; now the slot is free again after about a minute.
- **M2:** [Packaging a project](packaging.md), a step-by-step guide for a terminal project (a
  Python tool behind ttyd) and a desktop project (an application on a LinuxServer Selkies
  image), and `scripts/check-image.sh`, which runs an image with the session constraints and
  probes its base path. CI checks the example image with it.
- **M2:** the repository is public, with private vulnerability reporting enabled.
- **M2:** a minimal visual pass on the embed page, so the first visitors do not see raw HTML:
  a dark status card (queue position, spinner, "Start again"), a bar under the session with the
  time left, and server messages shown as text only. The real design is M3.
- **M3:** the embed page built from the Figma mock-ups (`apps/embed`), framework-free, on shared
  design tokens with bundled IBM Plex subsets (`packages/tokens`). Every designed state has its
  screen: connecting, position in line, starting, active, ending soon, reconnecting, ended,
  start failed, per-IP limit, unavailable project, narrow parent. Robust to network loss (dimmed
  session and banner, polling fallback, join retries with backoff, overdue session ended
  locally); keyboard use, visible focus, reduced motion and screen reader announcements. The
  control plane serves it as hashed static files under a strict Content-Security-Policy; CI
  checks a size budget (25 KB of script and style gzipped, 100 KB of fonts).
- **M3:** the embed page speaks English and French ("vous", French typography): `?lang=` on the
  iframe URL, else the browser's first language the page speaks, else English. See
  [Production deployment](deployment.md#5-check-and-embed).
- **M3:** theming by configuration: `theme.accent` recolours the brand tokens (hover and text
  colours derived, contrast of at least 3:1 checked at startup), `theme.logo` shows an SVG, PNG
  or WebP logo at the top of every card, and each project's `title` replaces its key for
  visitors. Served as hashed files from the control plane, so the CSP does not widen. See
  [Theme](configuration.md#theme).
- **M2:** versioned releases: semantic version tags, release notes generated by GitHub, images
  tagged per release; the deployment examples pin the release. First release `v0.1.0`. See
  [Contributing](contributing.md#releasing).
- **M2** closed: a portfolio embeds Tryout in production, see [above](#m2-live).
- **M4:** the agent and the gateway log JSON lines in the control plane's format; every
  component keeps only a 6-character prefix of session and ticket ids in its logs. See
  [Production deployment](deployment.md#logs).
- **M4:** the agent reports its version, policy and load on `/healthz` (503 when Docker does not
  answer) and Prometheus metrics on `/metrics`, on its mutual TLS API. See
  [Health and metrics](deployment.md#health-and-metrics).
