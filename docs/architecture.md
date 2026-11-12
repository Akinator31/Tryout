# Architecture

```
browser ─► control plane (TypeScript)     queue, tickets, /embed/<project> page
              │ HTTP + token (the control plane calls the node, never the reverse)
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

- Loads the configuration (nodes and projects).
- Manages **tickets**: a visitor joins a project's queue and waits for a free slot.
- Enforces two caps: sessions per project and sessions per node.
- Starts a session through the agent, checks that it answers through the gateway, then hands
  the URL to the browser.
- Ends a session when the visitor leaves, when the heartbeat is lost (~30 s), or when the
  maximum age is reached.
- Serves the `/embed/<project>` page that portfolios embed in an iframe.

### Agent — `apps/node/cmd/agent`

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
  expired or dead sessions and orphan networks, then republishes the routes.
- Checks that the image architecture matches the node.

### Gateway — `apps/node/cmd/gateway`

- HTTP and WebSocket reverse proxy: `/s/<id>/…` → the session's container.
- **Has no Docker socket**: if it is compromised, the attacker does not control Docker.
- Receives its routes from the agent over a **shared unix socket**. A TCP port would be
  reachable from every session, since the gateway is attached to their networks.
- Rewrites security headers on every response (see [Security](security.md)).

## Life of a session

1. The portfolio shows `/embed/my-project` in an iframe.
2. The page creates a ticket (`POST /api/projects/my-project/tickets`) and polls
   `GET /api/tickets/<ticket>` every 2 s. Polling doubles as the heartbeat.
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
apps/control-plane/   control plane (TypeScript, Node ≥ 24, no runtime dependency)
apps/node/            agent + gateway (Go), one binary each, one image
deploy/               dev compose file, sample configuration
examples/             sample project images
scripts/              end-to-end tests, node feasibility script
docs/                 this documentation (Zensical)
```
