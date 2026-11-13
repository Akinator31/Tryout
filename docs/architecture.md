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
| `http.ts` | Embed page, demo page, queue API and its SSE stream. Thin. |
| `config.ts`, `config-*.ts` | Configuration loading: YAML validated against the shared JSON Schema, then semantic checks; values (`config-values`), error reporting (`config-report`), agent TLS files (`config-tls`). |
| `server.ts` | Wiring. |

What it does:

- Loads the YAML configuration (nodes and projects), validates it against the JSON Schema and
  refuses to start on any error.
- Manages **tickets**: a visitor joins a project's queue and waits for a free slot.
- Enforces two caps: sessions per project and sessions per node.
- Limits what one IP address can hold: live tickets, tickets created per minute and open event
  streams ([ADR 0016](decisions/0016-per-ip-limits.md)).
- Starts a session through the agent, checks that it answers through the gateway, then hands
  the URL to the browser.
- Ends a session when the visitor leaves, when the heartbeat is lost (~30 s), when the
  maximum age is reached, or when a start takes more than 180 s.
- Keeps its state in **Postgres**: sessions survive a control plane restart, and several
  instances can share one database. Promotion is serialized by a transaction-scoped advisory
  lock, so caps hold even with concurrent instances.
- Pushes every ticket change to the visitor over server-sent events. A trigger on the tickets
  table sends a Postgres `NOTIFY`, so a change made by any instance reaches every instance.
- Serves the `/embed/<project>` page that portfolios embed in an iframe.

### Agent — `apps/node/cmd/agent`

- Serves its private API over **mutual TLS 1.3** only: the control plane presents a client
  certificate from the deployment's private CA, made with `tryout-certs`
  ([ADR 0015](decisions/0015-mutual-tls-control-plane-agent.md), [Certificates](certificates.md)).
- The only component that talks to Docker, through a configurable endpoint (`DOCKER_HOST`).
- Checks at startup that the node **profile** is met (gVisor, rootless, cgroup v2), and refuses
  to start otherwise.
- For each session:
  1. creates an `--internal` network;
  2. creates the hardened container;
  3. attaches the gateway to the network;
  4. starts the container;
  5. pushes the route table to the gateway.
- Runs a **reconcile loop** every 10 s, with Docker labels as the source of truth: it removes
  expired or dead sessions, containers stuck in `created` for over a minute (the trace of a
  start the control plane aborted), and orphan networks, attaches the gateway again to every running
  session network it is missing from (a recreated gateway container starts with only its
  compose networks), then republishes the routes.
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
   every 10 s. The open stream doubles as the heartbeat
   ([ADR 0012](decisions/0012-ticket-push-sse.md)). `GET /api/tickets/<ticket>` remains for
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

## Repository layout

```
apps/control-plane/   control plane (TypeScript, Node ≥ 24, Postgres via node-postgres)
apps/node/            agent + gateway (Go), one binary each, one image
deploy/               dev compose file and its configuration; node/ and control-plane/: production examples
schema/               JSON Schema of the configuration and the agent API, shared fixtures
examples/             sample project images
scripts/              end-to-end tests, node feasibility script
docs/                 this documentation (Zensical)
```
