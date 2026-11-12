# Roadmap

## Validated by the proof of concept

- Agent, gateway and control plane working end to end, for terminals and desktops.
- Network isolation: a session only sees the gateway's public port.
- Selkies under gVisor on a Raspberry Pi 5 (arm64) and behind a base path.
- Queue with per-project and per-node caps, heartbeat loss, maximum age.
- Refusal to start when the node profile is not met.

## Done since

- Queue and session state in Postgres, with tests through the queue interface (PGlite locally,
  PostgreSQL in CI). See [ADR 0007](decisions/0007-queue-in-postgres.md).

## Proof-of-concept shortcuts to replace

| Current | Target |
|---|---|
| Polling every 2 s | SSE + heartbeat, with Postgres `LISTEN/NOTIFY` to push changes |
| Plain HTML embed page | React |
| JSON configuration | YAML validated by a JSON Schema shared by TypeScript and Go |
| Control plane → agent over HTTP + token | HTTPS / mTLS |
| Docker over `unix://` or `tcp://` | + SSH / TLS |
| ttyd baked into the sample image | ttyd mounted read-only by the agent |
| No rate limiting | Per-IP limits on ticket creation |

## Next

- Step-by-step dedicated rootless daemon and firewall (`DOCKER-USER`) setup for `single-host`.
- KVM VM node (`strict`) for desktop sessions.
- Published images (`ghcr.io`) for agent, gateway and control plane.
- Admin UI (React): running sessions, queue, forced stop. Screens follow the project's Figma designs.
- Metrics (Prometheus) and structured logs.
- Subdomain routing in the gateway.
