# Architecture decisions

Lasting choices, with their context and consequences. A decision is never rewritten: if it
changes, a new record supersedes it.

| # | Decision | Status |
|---|---|---|
| [0001](0001-split-agent-and-gateway.md) | Split the node into an agent (Docker) and a gateway (public) | Accepted |
| [0002](0002-path-routing-capability-urls.md) | Path routing with capability URLs, no cookies | Accepted |
| [0003](0003-node-profiles-and-runtimes.md) | Security profiles per node, runtime per project | Accepted |
| [0004](0004-one-way-trust.md) | The control plane calls nodes, never the reverse | Accepted |
| [0005](0005-build-a-thin-orchestrator.md) | Build a thin orchestrator instead of adopting Kasm, Neko or similar | Accepted |
| [0006](0006-selkies-websocket-locked-settings.md) | Selkies in WebSocket mode with locked server-side settings | Accepted |
| [0007](0007-queue-in-postgres.md) | Queue and leases in Postgres | Accepted, implemented |
| [0008](0008-stack-and-license.md) | Go for the node, TypeScript/React for the control plane, AGPL-3.0 | Accepted |
| [0009](0009-minimal-docker-client.md) | Minimal Docker Engine API client instead of the Go SDK | Accepted |
| [0010](0010-fresh-container-per-session.md) | Prebuilt pinned images, a fresh container per session | Accepted |
| [0011](0011-queue-implementation.md) | Queue implementation: ticket states, global advisory lock, one start deadline | Accepted |
| [0012](0012-ticket-push-sse.md) | Push ticket changes with SSE and `LISTEN/NOTIFY` | Accepted, implemented |
| [0013](0013-published-images.md) | Publish multi-architecture images on ghcr.io from CI | Accepted, implemented |
| [0014](0014-yaml-configuration-json-schema.md) | YAML configuration validated by one JSON Schema | Accepted, implemented |
| [0015](0015-mutual-tls-control-plane-agent.md) | Mutual TLS between the control plane and the agent | Accepted, implemented |
| [0016](0016-per-ip-limits.md) | Per-IP limits on tickets and event streams | Accepted, implemented |
