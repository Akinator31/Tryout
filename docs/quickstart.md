# Local quickstart

This guide runs the whole stack on one machine with the `dev` profile, which gives **no security
guarantee**. It is for development and evaluation, not for exposure to the Internet. To deploy
Tryout for real visitors, follow [Production deployment](deployment.md).

## Requirements

- Docker Engine 26 or newer with Compose 2.23 or newer, or a recent Docker Desktop: the dev
  compose file mounts volume sub-directories (`subpath`).
- Node.js 24 or newer, for the end-to-end tests.
- Go 1.24 or newer, for the node's unit tests.

## Run

```bash
docker build -t tryout-example/cli-hello:dev examples/cli-hello
cp deploy/.env.example deploy/.env
docker compose -f deploy/compose.dev.yaml up -d --build
```

Then open <http://localhost:3000/demo>. The page simulates a portfolio: each "Try it" button
opens an iframe to `/embed/<project>`.

| Service | Address | Role |
|---|---|---|
| control plane | `localhost:3000` | queue and embed page |
| gateway | `localhost:8080` | public proxy for sessions (`/s/<id>/`) |
| agent | `127.0.0.1:7000` (mutual TLS) | creates and destroys sessions |
| postgres | internal network only | control plane state (queue, sessions) |

The `webtop` project downloads about 4 GB the first time.

Two one-shot services, `pki-ca` and `pki-node`, create the mutual TLS certificates between the
control plane and the agent in the `pki` volume on the first start, and reuse them afterwards
(see [Certificates](certificates.md)). `down -v` removes them.

## Test

```bash
node scripts/e2e-cli.ts      # queue → gateway → ttyd WebSocket → commands
node scripts/e2e-queue.ts    # session cap, promotion, heartbeat loss
node scripts/e2e-sse.ts      # pushed promotion, stream as heartbeat, stream end
node scripts/e2e-mtls.ts     # the agent refuses every client but the control plane
node scripts/e2e-limits.ts   # per-IP limits on tickets and event streams
scripts/e2e-deploy.sh        # the production layout with gVisor; Docker Desktop: see the script
(cd apps/node && go test ./...)
(cd apps/control-plane && npm ci && npm run typecheck && npm test)
```

## Stop

```bash
docker compose -f deploy/compose.dev.yaml down -v
```

The agent removes sessions still running the next time it starts. To clean them up right away:

```bash
docker rm -f $(docker ps -aq --filter label=tryout.session)
docker network rm $(docker network ls -q --filter label=tryout.session)
```

## Docker Desktop

Docker Desktop's socket is owned by `root:root` inside its VM, so the dev compose file runs the
agent as root (`AGENT_USER=0`). With a native daemon, set `AGENT_USER` to your uid and
`DOCKER_GID` to the socket's group (`stat -c %g /var/run/docker.sock`).
