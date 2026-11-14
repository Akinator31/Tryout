# Architecture

```
browser ─► control plane (TypeScript)     queue, tickets, /embed/<project> page
              │ mutual TLS (the control plane calls the node, never the reverse)
              ▼
           node: agent (Go)               sole holder of the Docker socket
                 gateway (Go)             public proxy /s/<id>/, NO Docker socket
                   │ attached to each session's --internal network
                   ▼
                 session container        hardened, runtime runsc | runc, destroyed at the end
```

There can be **several nodes**, for example a VM for command-line projects and an ARM machine
for graphical ones. Each project is assigned to a node.

## Components

### Control plane — `apps/control-plane`

| Module | Role |
|---|---|
| `queue.ts` | **The core.** Interface: `join`, `poll`, `watch`, `release`, `tick`. Behind it: per-project and per-node caps, per-IP ticket limits, FIFO promotion, session start, heartbeat loss, maximum age, start timeout, change notifications (`LISTEN/NOTIFY`). State lives in Postgres. |
| `queue-*.ts` | The queue's internals: table and migrations (`queue-schema`), per-IP ticket limits (`queue-limits`), stream watchers (`queue-watchers`), delays (`queue-timing`). |
| `runtime.ts` | `SessionRuntime` adapter for real nodes: agent API over mutual TLS + readiness probe through the gateway. Tests use an in-memory adapter. |
| `db.ts`, `db-listen.ts` | Database port (queries, transactions, `LISTEN`); adapters for node-postgres and, in tests, PGlite; the reconnecting `LISTEN` session. |
| `client.ts` | The visitor's IP address, read through trusted proxies only, and the cap on open event streams per IP. |
| `http.ts` | Embed page and its assets, demo page, queue API and its SSE stream. Thin. |
| `embed.ts` | The built embed page (`apps/embed/dist`), read once at start: its template, its hashed assets and its Content-Security-Policy. |
| `config.ts`, `config-*.ts` | Configuration loading: YAML validated against the shared JSON Schema, then semantic checks; values (`config-values`), error reporting (`config-report`), agent TLS files (`config-tls`). |
| `server.ts` | Wiring. |

What it does:

- Loads the YAML configuration (nodes and projects), validates it against the JSON Schema and
  refuses to start on any error.
- Manages **tickets**: a visitor joins a project's queue and waits for a free slot.
- Enforces two caps: sessions per project and sessions per node.
- Limits what one IP address can hold: live tickets, tickets created per minute and open event
  streams ([Configuration](configuration.md#per-ip-limits)).
- Starts a session through the agent, checks that it answers through the gateway, then hands
  the URL to the browser.
- Ends a session when the visitor leaves, when the heartbeat is lost (~30 s), when the
  maximum age is reached, or when a start takes more than 180 s.
- Keeps its state in **Postgres**: sessions survive a control plane restart, and several
  instances can share one database. Promotion is serialized by a transaction-scoped advisory
  lock, so caps hold even with concurrent instances.
- Pushes every ticket change to the visitor over server-sent events. A trigger on the tickets
  table sends a Postgres `NOTIFY`, so a change made by any instance reaches every instance.
- Serves the `/embed/<project>` page that portfolios embed in an iframe, and its files under
  `/assets/`. An unknown project gets the same page with a `404` status, which tells the
  visitor that the project is unavailable inside the portfolio's frame.

### Embed page — `apps/embed`, `packages/tokens`

The page a visitor sees inside the portfolio's iframe, built from the Figma mock-ups in
TypeScript without a UI framework, then bundled by Vite into `apps/embed/dist`. The control
plane's image builds it and serves it; nothing loads from a CDN.

| Module | Role |
|---|---|
| `visit.ts` | **The core.** One visit: takes a ticket, follows it over the event stream, falls back to polling, retries joining with backoff, and ends cleanly (End, Leave the queue, page closed, session overdue). No DOM. |
| `screens.ts` | What each phase shows, as plain data: the status card (spinner or number, title, detail, actions) and the bar under the session (live, ending, reconnecting). |
| `page.ts` | Renders a phase into `index.html`'s markup, text only; screen reader announcements; the session iframe. |
| `api.ts`, `strings.ts`, `main.ts` | The queue API, every visible text, and the wiring. |
| `packages/tokens` | Design tokens kept in step with the Figma variables (colours, spacing, radii, text styles) and IBM Plex fonts cut to Latin by `scripts/subset-fonts.sh`. The embed turns the tokens into CSS custom properties at build time; the admin UI will use them too. |

What it does:

- Shows one card per phase: connecting, position in the queue, starting, ended, start failed,
  left the queue, per-IP limit countdown, unavailable project. Once active, the session fills the
  frame above a 36 px bar with the time left, full screen and End; under a minute the bar turns
  amber.
- Keeps the visit alive through network trouble: a stream down for more than 5 s dims the
  session and shows "Connection lost"; the page polls when its stream is refused and joins again
  with a growing delay (3 s up to 30 s) when the control plane is unreachable.
- Weighs about 6 KB of script and style (gzip) and 60 KB of fonts; CI fails the build above
  25 KB and 100 KB.

### Agent — `apps/node/cmd/agent`

- Serves its private API over **mutual TLS 1.3** only: the control plane presents a client
  certificate from the deployment's private CA, made with `tryout-certs`
  ([Certificates](certificates.md)).
- The only component that talks to Docker, through a configurable endpoint (`DOCKER_HOST`).
- Checks at startup that the node **profile** is met (gVisor, rootless, cgroup v2), and refuses
  to start otherwise.
- For each session:
  1. creates an `--internal` network;
  2. creates the hardened container;
  3. attaches the gateway to the network;
  4. starts the container;
  5. pushes the route table to the gateway.
- Runs a **reconcile loop** every 10 s, with Docker labels as the source of truth:
  - removes expired or dead sessions, and containers stuck in `created` for over a minute (the
    trace of a create the control plane aborted when the visitor left during the start);
  - removes orphan networks;
  - attaches the gateway again to every running session network it is missing from (a recreated
    gateway container starts with only its compose networks);
  - republishes the routes.
- Validates every session request against the shared JSON Schema and refuses unknown fields.
- Pulls a missing project image, with the registry credentials of `REGISTRY_AUTH_FILE` when
  the registry has an entry.
- Checks that the image architecture matches the node.

### Gateway — `apps/node/cmd/gateway`

- HTTP and WebSocket reverse proxy: `/s/<id>/…` → the session's container.
- **Has no Docker socket**: if it is compromised, the attacker does not control Docker.
- Receives its routes from the agent over a **shared unix socket**. A TCP port would be
  reachable from every session, since the gateway is attached to their networks.
- Rewrites security headers on every response (see [Security](security.md)).

## Life of a session

1. The portfolio shows `/embed/my-project` in an iframe.
2. The page creates a ticket (`POST /api/projects/my-project/tickets`) and opens the stream
   `GET /api/tickets/<ticket>/events`. The server pushes the ticket's view on every change and
   every 10 s. The open stream doubles as the heartbeat. `GET /api/tickets/<ticket>` remains for
   polling clients.
3. When a slot is free, the control plane generates a 130-bit session id and calls
   `POST /v1/sessions` on the agent.
4. The agent creates the network and the container, attaches the gateway, and publishes the
   route.
5. The control plane probes the URL through the gateway, then marks the ticket `active` with
   the public URL.
6. The page shows the session URL in a nested iframe.
7. At the end, the control plane calls `DELETE /v1/sessions/<id>`, and the agent removes
   everything.

## Why it works this way

### A thin orchestrator

Existing tools did not fit an anonymous, queued sandbox: Kasm Workspaces Community Edition caps
concurrent sessions and is limited to non-commercial use, neko-rooms only orchestrates Neko,
SealSkin is built around users rather than anonymous queues, and JupyterHub's DockerSpawner is
tied to the JupyterHub model. Tryout is therefore a small agent with a hard-coded container
specification and a control plane that owns the queue. This keeps full control of the security
posture and the queue semantics, at the cost of building features such as the admin UI and
metrics.

### Agent and gateway are separate

Access to the Docker socket is equivalent to root on the host, and socket proxies filter by API
path and method, not by request body, so they cannot forbid `Privileged: true` on a container
create. The component that receives Internet traffic is also the most exposed one. Splitting the
node means that compromising the gateway does not give control of Docker. The gateway reaches
sessions from inside their networks rather than from the host, which also works with rootless
daemons, whose container addresses are not routable from the host.

### The control plane calls nodes

Nodes run hostile code: any credential a node held towards the control plane or the operator's
infrastructure would be exposed by an escape. So the control plane calls the agent, nodes never
open connections back (the firewall should enforce it), and readiness is checked through the
gateway. The link uses mutual TLS rather than a shared token because it may cross networks the
operator does not fully control, on the way to a remote node: session ids are encrypted, the
control plane only talks to the node it meant to reach, and a compromised node holds only its
own server certificate, which no other component accepts as a client. Tryout only reads PEM
files, so it does not depend on a particular PKI, tunnel or provider.

### Session URLs are capabilities

Sessions are served under one path per session on one hostname per node. Free certificates
often cover a single subdomain level, sessions run in a cross-site iframe where third-party
cookies are blocked or partitioned, and per-session reverse proxy labels would add a refresh
delay and tie Tryout to one proxy. Path routing works behind any tunnel or proxy, and the
`public_url` template leaves room for subdomain routing later. Because every session of a node
shares a browser origin, the gateway strips cookies and service worker headers (see
[Security](security.md)).

### A fresh container per session

A clean environment per visitor is a requirement, and building images on a sandbox node would
expose it to builder flaws (for example the BuildKit issues known as Leaky Vessels). Images are
built elsewhere and pinned by digest; each session gets a new container and network, removed at
the end, so no state leaks between visitors. A warm pool will only be considered if cold starts
exceed about 10 s: the proof of concept measured about 0.5 s for a terminal and about 4 s for a
desktop on a Raspberry Pi 5. The first session of a new image pays the pull time.

### Selkies over WebSocket

Selkies also supports WebRTC, but WebRTC uses UDP, which bypasses HTTP proxies and tunnels and
needs a TURN server. WebSocket mode keeps a single HTTP path through the gateway. The locked
settings (see [Configuration](configuration.md#desktop-session-defaults)) rely on Selkies'
`|locked` suffix, which the client cannot change: they keep the CPU per session predictable and
the attack surface small. Projects that need audio or a higher resolution opt in through `env`.

### The queue in Postgres

Sessions are leases, not jobs: a ticket holds its slot from `starting` until it ends. Postgres
keeps the state across restarts and lets several instances share one database, with no Redis
(BullMQ's per-group concurrency, which the caps would need, is a paid feature).

- **One global lock.** The node cap spans projects and several instances may promote at once,
  so promotion runs in one transaction under a global advisory lock. At a few promotions per
  minute, this is simpler than per-row locks. Schema creation also takes an advisory lock,
  because concurrent `CREATE … IF NOT EXISTS` statements can race.
- **Few states.** `waiting → starting → active → ended`. A `starting` ticket already holds its
  slot, and ending is immediate since the agent removes the container synchronously.
- **Conditional activation.** A ticket becomes `active` only if it is still `starting` when the
  session is ready; otherwise the session is stopped, because the visitor may have left during
  the start.
- **One deadline.** A start is aborted after 180 s, or as soon as the ticket ends on the
  instance. A ticket that was `starting` on an instance that died is not resumed: it keeps its
  slot until that deadline, and the agent's reaper removes the container.
- **Clocks.** Heartbeat and expiry compare timestamps written by different instances, so
  instances need synchronized clocks (NTP). Times come from an injected clock, which keeps tests
  deterministic.

### Ticket changes over SSE

Polling made a visitor learn of a promotion up to 2 s late and cost one request every 2 s per
waiting visitor. Server-sent events need no browser library and reconnect on their own, and
Postgres `LISTEN/NOTIFY` delivers a change made by one instance to every instance when the
transaction commits.

- The notification payload is the project, because one state change can move every waiting
  ticket of that project; each instance then re-reads the views it streams for it in one query.
  Heartbeat updates do not notify.
- A fresh view every 10 s recovers lost notifications, keeps proxies from closing an idle
  stream and resynchronises the page's countdown.
- Each instance holds one extra Postgres connection for `LISTEN`. The trigger uses
  `CREATE OR REPLACE TRIGGER`, hence PostgreSQL 14 or later.

### Stack and license

- **Go for the node**: static binaries, easy cross-compilation to arm64, low memory on small
  nodes, and a standard-library reverse proxy with WebSocket support.
- **TypeScript on Node.js ≥ 24 for the control plane**, run directly thanks to native type
  stripping. The admin UI will use React with Chakra UI. The embed page stays framework-free
  and small, because it loads for every portfolio visitor; both share one module of design
  tokens (`packages/tokens`).
- **The embed page as hashed static files.** Vite names each script, style and font after its
  content, so browsers cache them for good and every project's page shares them; only the small
  HTML is filled per project and revalidated. With no inline script or style, the page's
  Content-Security-Policy allows only its own files, its own API, and frames from the nodes'
  public URLs.
- **A minimal Docker client.** The agent needs about a dozen Engine API endpoints. The Go SDK is
  moving to new modules whose API is not yet stable, while the versioned REST API is, so the
  agent uses a small hand-written client pinned to API `v1.47`. The node has few third-party
  dependencies; new Docker features are added to the client by hand.
- **AGPL-3.0-or-later**: operators who run a modified version as a service must publish their
  changes.

## Repository layout

```
apps/control-plane/   control plane (TypeScript, Node ≥ 24, Postgres via node-postgres)
apps/embed/           embed page (TypeScript, no UI framework, built by Vite)
packages/tokens/      design tokens and bundled IBM Plex fonts, shared by the UIs
apps/node/            agent + gateway (Go), one binary each, one image
deploy/               dev compose file and its configuration; node/ and control-plane/: production examples
schema/               JSON Schema of the configuration and the agent API, shared fixtures
examples/             sample project images
scripts/              end-to-end tests, node feasibility script
docs/                 this documentation (Zensical)
```
