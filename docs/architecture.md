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

Sources live in `src/`, one folder per area; `test/` mirrors it.

| Module | Role |
|---|---|
| `queue/queue.ts` | **The core.** Interface: `join`, `poll`, `watch`, `release`, `tick`, `configure`, `stats`, `list`, `stop`. Behind it: per-project and per-node caps, node health (no promotion to a node that is down), per-IP ticket limits, FIFO promotion, session start, heartbeat loss, maximum age, start timeout, change notifications (`LISTEN/NOTIFY`). State lives in Postgres. |
| `queue/*.ts` | The queue's internals: table and migrations (`schema`), per-IP ticket limits (`limits`), stream watchers (`watchers`), delays (`timing`). |
| `nodes/runtime.ts` | `SessionRuntime` adapter for real nodes: agent API over mutual TLS + readiness probe through the gateway. Tests use an in-memory adapter. |
| `nodes/agents.ts` | One mutual TLS client per node of the active settings, shared by the runtime, the health check and the metrics relay; the agent's `/healthz` and `/metrics` calls, with size-capped answers. |
| `nodes/health.ts` | Node health: checks every node's `/healthz` every 10 s and keeps the last result; the queue starts no session on a node that is not up. |
| `admin/http.ts` | The admin listener's routes: `/metrics` behind an optional bearer token, and the admin API under `/admin/api/` (login, logout, the signed-in account, accounts, and the routes of `admin/settings`), with its session cookie and same-origin checks. |
| `admin/settings.ts` | The admin API's settings routes: the active document, the dry run with node reachability, revisions and rollback, logos and the nodes' health. |
| `admin/sessions.ts` | The admin API's sessions routes: the live tickets, without session URLs or client addresses, and the operator's stop. |
| `admin/request.ts` | What the admin routes share: answers and refusals, the JSON body reader and the route matcher. |
| `admin/auth.ts`, `admin/password.ts` | Admin accounts, sessions and failed-login limits in Postgres; scrypt password hashes and the cap on hashes running at once. |
| `metrics/*.ts` | The `/metrics` page (`page`: ticket gauges, node health, start counters), the Prometheus text writer (`prometheus`) and the strict relay of the agents' metrics (`relay`). |
| `db/db.ts`, `db/listen.ts` | Database port (queries, transactions, `LISTEN`); adapters for node-postgres and, in tests, PGlite; the reconnecting `LISTEN` session. |
| `public/client.ts` | The visitor's IP address, read through trusted proxies only, and the cap on open event streams per IP. |
| `public/http.ts` | Embed page and its assets, demo page, queue API and its SSE stream. Thin. |
| `bundle.ts` | What the embed page and the admin interface share as builds served from memory: reading their hashed files, and serving one for good. |
| `admin/ui.ts` | The built admin interface (`apps/admin/dist`), read once at start: its page for every path under `/admin/` but the API, with a fresh CSP nonce per answer, and its hashed assets. |
| `public/embed.ts` | The built embed page (`apps/embed/dist`), read once at start: its template, its hashed assets, the theme's stylesheet and logo (applied again with each revision), and its Content-Security-Policy. |
| `config/*.ts` | Configuration: `tryout.yaml` validated against the shared JSON Schema (`schema`), then semantic checks (`config`); the settings checks shared by the file and stored revisions (`settings`); revisions and assets in Postgres (`store`); the active revision, followed on every instance (`live`); values (`values`), error reporting (`report`), agent TLS files (`tls`), theme (`theme`). |
| `cli.ts` | The operator's command line: `import` and `export` of the settings; admin accounts (`create-user`, `set-password`, `delete-user`, `list-users`). |
| `log.ts` | JSON log lines, with ids shortened. |
| `server.ts` | Wiring. |

What it does:

- Reads its bootstrap from `tryout.yaml` and its settings (nodes, projects, limits, embedding,
  theme) from Postgres, both validated against the JSON Schema; refuses to start on any error.
  A new revision of the settings applies to every instance without a restart.
- Manages **tickets**: a visitor joins a project's queue and waits for a free slot.
- Enforces two caps: sessions per project and sessions per node.
- Checks each node's health every 10 s and starts no session on a node that does not answer;
  its visitors keep waiting.
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
- Serves Prometheus metrics on a separate admin listener (`admin_listen`, off by default): its
  own, and every agent's, relayed over mutual TLS with a `node` label. The same listener serves
  the admin API, behind local accounts.

### Admin interface — `apps/admin`

The operator's pages, built from the Figma mock-ups with React, Chakra UI v3 (its theme made
from `packages/tokens`), React Router and TanStack Query, then bundled by Vite into
`apps/admin/dist`. The control plane's image builds it and serves it on the admin listener;
nothing loads from a CDN.

| Module | Role |
|---|---|
| `api.ts` | The admin API client: JSON both ways, errors with status and `Retry-After`, and whether the control plane answered the last call. |
| `queries.ts` | One hook per API resource; lists refresh every 3 s while the tab is visible. |
| `app/App.tsx` | Providers, routes, and the rule that any `401` leads to the sign-in page, then back. |
| `app/Shell.tsx`, `app/Sidebar.tsx` | The signed-in frame: navigation, the control plane's state and version, the account and sign-out. |
| `pages/` | Sign-in, Projects (list, form, project page with pause, remove, preview and embed snippet), Nodes (health, add and edit drawer with a connection test), Embedding (origins, visitor limits), Theme, Sessions (with stop), Revisions (diff, YAML, rollback), Accounts (add, delete, own password). |
| `useDraft.tsx`, `settings/` | The pending changes: one draft of the whole settings document in the tab's `sessionStorage` (`draft.ts`), moved on top of a revision published meanwhile by a three-way merge (`merge.ts`); the YAML writer (`yaml.ts`) and line diff (`diff.ts`) of the review, the change labels, the YAML download, and the origin and contrast checks. |
| `components/ReviewDialog.tsx` | The review: changes, YAML diff, dry run, note, and publication of the draft as the next revision. |
| `format.ts`, `sessions.ts`, `projects.ts`, `nodes.ts`, `preview.ts`, `signin.ts`, `navigation.ts` | Pure functions: times and countdowns, the sessions' cells and summary, the projects' states and summary, the project and node forms with their checks, the embed address and snippet and when the preview may run, sign-in messages, the safe page to return to. |
| `strings.ts`, `theme.ts`, `main.tsx` | Every visible text (English), the Chakra system, and the entry point. |

What it does:

- Keeps no state of its own on the server: every page reads the admin API, and a `401` from
  any call returns to the sign-in page with the current page as `next`, which must be a path
  of the app.
- Says before sending a sign-in when the page is plain HTTP on a host other than localhost,
  since the browser would drop the `Secure` cookie.
- Never shows a session's URL or a visitor's address, which the API does not send anyway;
  tickets show their 6-character prefix.
- Edits the settings as one draft of the whole document, kept in the browser tab rather than
  on the server: the API only knows whole documents, so nothing half-edited is ever stored, and
  every change goes through the same review, dry run and publication. A draft made from an
  older revision is merged onto the newer one path by path rather than thrown away; where both
  changed a value, the draft wins and the review shows it, since the operator is looking at
  that diff when applying.
- Checks the project and node forms in the browser with the schema's rules, to say what is
  wrong while typing; the control plane's dry run in the review stays the judge. Testing a
  node's connection is that same dry run with the node in the settings: no API is needed for
  it, and the control plane, not the browser, reaches the agent.
- Previews a project with the real embed page from `public_url` in a frame, rather than a
  special admin session: it tests exactly what a portfolio shows, through the same queue,
  limits and Content-Security-Policy, and needs no new API. It starts on a click only, since
  it takes a visitor's slot, and needs the admin's origin among the allowed parents like any
  portfolio. `public_url` is bootstrap, not a setting: it names where this control plane is
  served, which only changes with its deployment.

### Embed page — `apps/embed`, `packages/tokens`

The page a visitor sees inside the portfolio's iframe, built from the Figma mock-ups in
TypeScript without a UI framework, then bundled by Vite into `apps/embed/dist`. The control
plane's image builds it and serves it; nothing loads from a CDN.

| Module | Role |
|---|---|
| `visit.ts` | **The core.** One visit: takes a ticket, follows it over the event stream, falls back to polling, retries joining with backoff, and ends cleanly (End, Leave the queue, page closed, session overdue). No DOM. |
| `screens.ts` | What each phase shows, as plain data: the status card (spinner or number, title, detail, actions) and the bar under the session (live, ending, reconnecting). |
| `page.ts` | Renders a phase into `index.html`'s markup, text only; screen reader announcements; the session iframe. |
| `strings.ts` | Every visible text, one catalogue per language (English, French), and the choice of language. |
| `api.ts`, `main.ts` | The queue API, and the wiring. |
| `packages/tokens` | Design tokens kept in step with the Figma variables (colours, spacing, radii, text styles) and IBM Plex fonts cut to Latin by `scripts/subset-fonts.sh`. The embed turns the tokens into CSS custom properties at build time; the admin interface builds its Chakra UI theme from them. |

What it does:

- Shows one card per phase: connecting, position in the queue, starting, ended, start failed,
  left the queue, per-IP limit countdown, unavailable project. Once active, the session fills the
  frame above a 36 px bar with the time left, full screen and End; under a minute the bar turns
  amber.
- Takes the operator's theme: an accent colour and a logo at the top of every card, and each
  project's `title` in the bar, the starting card and the tab title.
- Speaks English or French: the `lang` parameter of the iframe URL (`/embed/<project>?lang=fr`)
  if the page speaks it, else the first of the browser's languages it speaks (`fr-CA` counts as
  `fr`), else English. Both catalogues ship in the bundle, so no extra request is made.
- Keeps the visit alive through network trouble: a stream down for more than 5 s dims the
  session and shows "Connection lost"; the page polls when its stream is refused and joins again
  with a growing delay (3 s up to 30 s) when the control plane is unreachable.
- Weighs about 6 KB of script and style (gzip) and 60 KB of fonts; CI fails the build above
  25 KB and 100 KB.

### Agent — `apps/node/internal/agent`, `internal/session`

- Serves its private API over **mutual TLS 1.3** only: the control plane presents a client
  certificate from the deployment's private CA, made with `tryout-certs`
  ([Certificates](certificates.md)).
- The only component that talks to Docker, through a configurable endpoint (`DOCKER_HOST`).
- Checks at startup that the node **profile** is met (gVisor, rootless, cgroup v2), that the
  daemon applies memory, CPU and pids limits (outside `dev`) and that it is Docker Engine 28 or
  later, pulls its **ttyd image** (`TTYD_IMAGE`), and refuses to
  start otherwise.
- For each session:
  1. creates an `--internal` network whose bridge has no address (gateway mode `isolated`), so
     the session cannot reach what listens on the host either;
  2. creates the hardened container; a terminal runs the image's program in the agent's ttyd,
     mounted read-only from the ttyd image (see [Terminals served by the agent](#terminals-served-by-the-agent));
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
- Reports its health on `/healthz` (version, profile, default runtime, session count and cap;
  503 when its Docker daemon does not answer) and Prometheus metrics on `/metrics`, both on the
  same mutual TLS API: the node opens no other port.

### Gateway — `apps/node/internal/gateway`

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

### Terminals served by the agent

The agent serves terminal sessions with its own web terminal, ttyd, rather than each project
image shipping one. Packaging a command-line tool then takes its program alone, and every terminal
runs the ttyd version, options and theme of its node's release.

- **A Docker image mount.** ttyd comes from an image holding one static binary (`tryout-ttyd`,
  built in `apps/node/ttyd`). The agent mounts it read-only at `/opt/tryout` in the session
  (`Mounts` of type `image`, Engine API 1.48, Docker Engine 28): the daemon pulls it for its own
  architecture, it works under gVisor and rootless daemons, and on a remote daemon, since nothing
  has to exist on the host. A bind mount from the host would not, and a volume filled by a helper
  container would add a lifecycle to manage.
- **Pinned by the release.** CI publishes `tryout-ttyd` before `tryout-node` and builds its digest
  into the agent as the default `TTYD_IMAGE`, so a node release always runs the ttyd it was
  tested with. The agent pulls it at startup, so no visitor waits for it.
- **The image's program.** ttyd runs the image's `ENTRYPOINT` and `CMD`, as `docker run` would,
  or the project's `command`, after its own options and `--`. The container keeps the image's
  user, working directory and environment. ttyd's options are locked: writable, one client, the
  session's base path, Tryout's colours and font.
- **An image that serves its own page** declares a `port` (with `ttyd: image`, or alone), and
  runs unchanged, like a desktop image. Without `ttyd`, the mode follows `port`: every terminal
  configured before the agent's ttyd has one, so stored revisions and their images keep working
  through the upgrade, with no migration. The schema refuses `port` and `strip_prefix` with
  `ttyd: agent`, and `command` without the agent's ttyd, rather than ignore them.

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

### Settings in Postgres

An admin interface changes nodes and projects while visitors use them, so the settings live in
Postgres, not in a file that every instance reads at startup. The file keeps what an instance
needs before it can reach the database or that touches its own sockets: listeners, agent TLS
files and trusted proxies. No secret goes into the database: TLS keys stay files.

- **Revisions are full snapshots**, checked by the same schema and semantic checks as the file.
  The latest is active; rollback republishes an old one. A publication names the revision it
  was edited from and is refused if another was published since, so two operators never
  overwrite each other silently. Publications are serialized by an advisory lock.
- **One source of truth.** A file's settings only seed an empty database. Once revisions exist,
  settings in the file that differ from the active revision refuse the start: a forgotten file
  never brings back old settings after a restart.
- **Hot apply.** Publishing sends `NOTIFY tryout_config`; every instance reloads the active
  revision, one at a time, and on each (re)connection of its `LISTEN`, in case it missed one.
  The queue, the node clients, the health checks, the embed page and the HTTP limits read the
  active settings at each use. A removed project's tickets end, as stopped by the operator, on
  every instance, which is harmless since ending a ticket is idempotent. Removing a node with
  sessions, or changing its agent address, is refused, since stopping them needs the address
  they started on; a removed node's client is kept, for an instance that applied the revision
  late. A failed application is tried again after a few seconds. A revision that fails the
  checks of a newer control plane refuses its start, and is skipped (logged) by a running
  instance.
- **Assets** (the logo) are stored by SHA-256, so a revision names its logo without copying it.
- **Edited as one document.** The admin API reads and publishes the whole settings document,
  never one project or node at a time: the admin keeps pending changes in the browser, checks
  them with a dry run, then publishes them in one revision. One path checks every change, and
  a rollback is a publication like any other. The dry run also calls each node's `/healthz`
  with a client made for the call, since the node may not be published yet; a node that does
  not answer is a warning, not an error, as it may come up later.

### Health and metrics through the control plane

Nodes never call the control plane, so the control plane asks them: it checks each agent's
`/healthz` and fetches its `/metrics` over the mutual TLS link it already has. Prometheus then
scrapes the control plane alone, needs no certificate from the Tryout CA, and nodes open no new
port. A node runs hostile code, so its metrics are parsed strictly and rebuilt with its own
`node` label rather than copied, and its answers are size-capped.

- **Health per instance.** Each control plane instance checks the nodes itself and keeps the
  result in memory. Two instances may disagree for a few seconds after a node changes state,
  which at worst starts a session that fails and ends with an error, as it would without the
  check.
- **Down until checked.** A node counts as down until its first check, so a control plane that
  just started never sends a session to a node it has not reached. The first check runs at
  startup, followed by a promotion pass.
- **A separate listener.** Metrics tell queue lengths and node versions, and the admin API
  shares the same listener. Keeping it off by default, on its own address, lets the
  operator leave it off the Internet.

### Admin accounts

- **Local accounts, no sign-up.** The first account is made from the command line, which needs
  access to the database anyway; a signed-in admin makes the next ones. All accounts have the
  same rights. The tables leave room for other ways to sign in (OIDC, passkeys) later.
- **Server-side sessions.** A session is a random token in a cookie; the database keeps only
  its SHA-256, so a copy of the database opens no session, and a session can be ended at once
  (logout, password change, deleted account), which a signed token could not do.
- **Cookie rather than a header.** The cookie is `__Host-` (this host only, path `/`),
  `HttpOnly` (no script reads it) and `SameSite=Strict` (no cross-site request carries it).
  Requests that change something must also send a JSON body and an `Origin` naming the host,
  which a cross-site form cannot do; there is no CSRF token to manage.
- **`Secure` without exception.** Browsers accept the cookie over HTTPS and on `localhost` only.
  The control plane has no TLS of its own, so the admin is reached through a TLS proxy or an SSH
  tunnel. A login from any other origin is refused with an explanation, rather than silently
  losing the cookie.
- **Limits in Postgres.** Failed logins are counted per account name and per client address in
  the database, so limits hold across instances. An unknown name is checked against a dummy
  hash and limited like a known one, so neither timing nor locks tell which names exist. scrypt
  costs about 128 MB per check, so each instance runs two at once and queues a few.
- **A token for Prometheus.** Prometheus cannot hold a session, so `/metrics` takes an optional
  bearer token from `tryout.yaml`: the bootstrap holds secrets, the settings never do.

### One log format

The control plane, the agent and the gateway write the same JSON lines on standard output (`t`,
`msg`, flat fields), so one collector parses all three. Logs are often shipped to services with
wider access than the control plane, while session and ticket ids are credentials: the log
writer of each component keeps a 6-character prefix of anything shaped like an id, in every
value, rather than relying on each call site.

### Stack and license

- **Go for the node**: static binaries, easy cross-compilation to arm64, low memory on small
  nodes, and a standard-library reverse proxy with WebSocket support.
- **TypeScript on Node.js ≥ 24 for the control plane**, run directly thanks to native type
  stripping. The admin interface uses React with Chakra UI. The embed page stays framework-free
  and small, because it loads for every portfolio visitor; both share one module of design
  tokens (`packages/tokens`).
- **The embed page as hashed static files.** Vite names each script, style and font after its
  content, so browsers cache them for good and every project's page shares them; only the small
  HTML is filled per project and revalidated. With no inline script or style, the page's
  Content-Security-Policy allows only its own files, its own API, and frames from the nodes'
  public URLs.
- **The admin interface as hashed static files too**, served by the control plane rather than
  a separate web server, so it needs no new component or port. Chakra UI inserts its styles at
  run time; rather than allowing inline styles, the control plane puts a fresh nonce in each
  HTML answer and its CSP, and the page hands that nonce to Emotion. Scripts stay `'self'` only.
  The sizes of its scripts and styles are checked against a budget in CI (300 KB compressed).
- **The theme as more hashed files.** At startup the control plane turns `theme.accent` into a
  small stylesheet that overrides the brand tokens, and serves it and the logo next to the
  build's files, linked from the HTML template. The page paints in the operator's colours from
  the first frame, works before its script runs, and keeps the same CSP. The theme is
  configuration, not a parameter of the iframe URL: the operator decides how their page looks,
  and the page has nothing to validate. Only the accent and the logo change: the dark
  background and the fonts are the product's look, and a light variant would double what must
  be designed and tested.
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
apps/admin/           admin interface (React, Chakra UI, built by Vite)
packages/tokens/      design tokens and bundled IBM Plex fonts, shared by the UIs
apps/node/            agent + gateway + certificate tool (Go), one binary each, one image
deploy/               dev compose file and its configuration; node/ and control-plane/: production examples
schema/               JSON Schema of the configuration and the agent API, shared fixtures
examples/             sample project images
scripts/              end-to-end tests, node feasibility script
docs/                 this documentation (Zensical)
```

The Go module in `apps/node` keeps its commands thin: `cmd/agent`, `cmd/gateway` and `cmd/certs`
read their environment or flags and wire the packages of `internal/`:

| Package | Holds |
|---|---|
| `session` | The node's security policy, with no Docker calls: a session request checked against the schema and the node profile, then turned into the hardened container, its environment and its labels |
| `agent` | Everything that talks to Docker: the profile check, the session lifecycle, the reconcile loop, the private API and its metrics |
| `gateway` | The public reverse proxy, its route table and the response hardening |
| `routes` | The contract between the agent and the gateway: the route table and its push over the unix socket |
| `dockerapi` | The minimal Docker Engine API client |
| `pki`, `registryauth`, `logging`, `metrics`, `version` | Certificates, registry credentials, JSON logs, Prometheus text format, build version |
