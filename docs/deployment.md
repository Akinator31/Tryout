# Production deployment

This guide deploys Tryout from the [published images](published-images.md) on two kinds of
machines: **nodes**, which run sessions, and the **control plane**, which runs the queue and
the embed page. The example files are in the repository, one directory per kind of machine:

```
deploy/node/            the agent and the gateway (compose.yaml, .env.example)
deploy/control-plane/   the control plane and PostgreSQL (compose.yaml, .env.example, tryout.yaml)
```

Nothing in them is tied to a provider, a domain or a reverse proxy: you choose how the services
are exposed. CI deploys both compose files and their `.env.example`, with gVisor and the
`strict` profile, and runs the end-to-end tests against them (`scripts/e2e-deploy.sh`). It uses
its own `tryout.yaml`; the example one is checked against the schema by the unit tests.

```
                  ┌──────────── your reverse proxy or tunnel (TLS) ────────────┐
browser ─► https://tryout.example.org             https://sbx.example.dev/s/<id>/
                  │                                         │
       control plane machine                         node machine
       ┌──────────────────────────┐   mutual TLS   ┌──────────────────────────┐
       │ control-plane :3000      │ ─────────────► │ agent :7000 (private)    │
       │ postgres (internal only) │                │ gateway :8080            │
       └──────────────────────────┘                │ sessions (gVisor)        │
                                                   └──────────────────────────┘
```

This guide covers nodes in the `strict` profile: a machine or VM dedicated to sessions. The
control plane may run on the same machine. The `single-host` profile, for a machine shared with
other services, needs a dedicated rootless daemon and has its own guide on the
[Roadmap](roadmap.md#m5-hosting-options).

## Requirements

| Machine | Needs |
|---|---|
| Node | Linux, amd64 or arm64; Docker Engine with Compose v2; [gVisor](https://gvisor.dev/docs/user_guide/install/) registered in Docker as `runsc` |
| Control plane | Docker Engine with Compose v2 |
| Your machine | Docker, to run `tryout-certs` |
| Network | the control plane reaches each agent's port 7000 over a private network, a VPN or a tunnel; your proxy reaches the control plane's port 3000 and each gateway's port 8080 |
| DNS and TLS | one hostname for the control plane; one hostname per node, on a domain used for nothing but sessions ([Public exposure](exposure.md)) |

The images are pulled from `ghcr.io/akinator31/`. If they are private (before the first release,
or in a fork), run `docker login ghcr.io` on each machine first, with a read-only token.

## 1. Create the certificates

On your own machine, create the private CA, the control plane's certificate and one certificate
per node, as described in [Certificates](certificates.md):

```bash
IMAGE=ghcr.io/akinator31/tryout-node:<version>
certs() { docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/pki:/pki" "$IMAGE" tryout-certs "$@" --dir /pki; }
mkdir -p pki
certs init
certs node cli --san 10.0.50.10        # the host the control plane will use in agent_url
```

`pki/ca/` stays on your machine. You will copy `pki/nodes/cli/` to the node and
`pki/control-plane/` to the control plane.

## 2. Set up the node

On the node, install gVisor and check that Docker lists it:

```bash
docker info --format '{{json .Runtimes}}'     # must contain "runsc"
```

Copy `deploy/node/` to the node, then put its certificates in `pki/` and give them to the
agent, which runs as uid 65532 in the image:

```bash
cp -r pki/nodes/cli/ /opt/tryout-node/pki     # tls.crt, tls.key, ca.crt
sudo chown -R 65532:65532 /opt/tryout-node/pki
cd /opt/tryout-node && cp .env.example .env
```

Fill in `.env`:

| Variable | Value |
|---|---|
| `TRYOUT_VERSION` | the version to run, pinned by digest in production: `0.1.0@sha256:…` |
| `NODE_PROFILE` | `strict`: a machine or VM dedicated to sessions |
| `DOCKER_SOCKET`, `DOCKER_GID` | the socket of the daemon that runs sessions, and its group: `stat -c %g /var/run/docker.sock` |
| `GATEWAY_TOKEN` | `openssl rand -hex 32` |
| `AGENT_PUBLISH` | where the agent's API is published: a private or VPN address and port, or `127.0.0.1:7000` when a tunnel carries it. **Never a public address.** |
| `GATEWAY_PUBLISH` | where your proxy or tunnel reaches the gateway, e.g. `127.0.0.1:8080` |
| `FRAME_ANCESTORS` | the control plane's public origin, e.g. `https://tryout.example.org` |

The other variables are described in [Configuration](configuration.md#agent) and in the file
itself. Then start the node and check that the agent accepted its profile:

```bash
docker compose up -d
docker compose logs agent      # "agent listening (mutual TLS)" with profile strict
```

The agent refuses to start when the profile is not met, with the reason in its log.

### Private project images

If a project image is private, write its registry credentials to `registry/auth.json` next to
`compose.yaml` (Docker creates an empty `registry/` otherwise) and set `REGISTRY_AUTH_FILE=/etc/tryout/registry/auth.json` in `.env`. The file
format and the token to use are in [Project images](project-images.md#private-images). The
sample project `ghcr.io/akinator31/tryout-example-cli-hello` needs it while the packages are
private.

### Network isolation

Sessions have no egress, but the node itself should not be able to reach your LAN or your other
services. Isolate it (VLAN, firewall); Docker bypasses UFW, so filter in the `DOCKER-USER`
chain. See [Security](security.md#deployment-recommendations).

## 3. Set up the control plane

Copy `deploy/control-plane/` to the control plane, then put its certificates in `pki/` and give
them to the control plane, which runs as uid 1000 in the image:

```bash
cp -r pki/control-plane/ /opt/tryout/pki      # tls.crt, tls.key, ca.crt
sudo chown -R 1000:1000 /opt/tryout/pki
cd /opt/tryout && cp .env.example .env
```

Fill in `.env`:

| Variable | Value |
|---|---|
| `TRYOUT_VERSION` | the same version as the nodes, pinned by digest |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` (it is part of a URL: keep it URL-safe) |
| `CONTROL_PLANE_PUBLISH` | where your proxy or tunnel reaches the control plane, e.g. `127.0.0.1:3000` |

Then adapt `tryout.yaml` ([Configuration](configuration.md)):

- `embed_frame_ancestors`: the origins of your portfolios;
- `client_ip.trusted_proxies`: the address your proxy or tunnel connects from, as the control
  plane sees it. A proxy on the host that connects to a published port appears with the address
  of the Docker network's gateway, in `172.16.0.0/12` by default;
- `nodes`: for each node, `agent_url` (a host named in its certificate, or `server_name`),
  `public_url` (its gateway behind your proxy) and, optionally, `probe_url` (the gateway as the
  control plane reaches it directly);
- `projects`: your project images, pinned by digest.

Start it:

```bash
docker compose up -d
docker compose logs control-plane     # "control plane listening"
```

The control plane exits with every problem of `tryout.yaml` listed if the file is invalid.
PostgreSQL is on an internal network that only the control plane joins. It holds only the
queue and live sessions, nothing that needs a backup.

## 4. Expose the two services

Publish, with TLS, through your reverse proxy or tunnel ([Public exposure](exposure.md)):

| Public hostname | Target |
|---|---|
| `tryout.example.org` | the control plane, `CONTROL_PLANE_PUBLISH` |
| `sbx.example.dev` (one per node) | the node's gateway, `GATEWAY_PUBLISH` |

Serve the control plane over HTTP/2 and do not buffer its event streams. WebSockets must pass
through to the gateway.

## 5. Check and embed

Open `https://tryout.example.org/demo`: each "Try it" button opens a project as a portfolio
would. From a clone of the repository, the end-to-end test runs a terminal session through the
public URLs:

```bash
node scripts/e2e-cli.ts https://tryout.example.org cli-hello
```

From a machine that reaches a node's agent (the control plane's, or one on the same VPN), check
that the agent accepts the control plane's certificate and refuses every other client: no
certificate, TLS 1.2, plain HTTP, the node's own certificate, a certificate from another CA.
`--pki` is a directory in the `tryout-certs` layout holding `control-plane/` and
`nodes/<name>/` only: run the check on your own machine, or copy those two directories, never
`ca/`. Add `--server-name` when you connect through a tunnel or a port forward, under another
address than the one in the node's certificate. It needs the `openssl` command.

```bash
node scripts/e2e-mtls.ts 10.0.50.10:7000 --pki ./pki --node cli
# through a port forward to the agent, from your machine
node scripts/e2e-mtls.ts 127.0.0.1:7000 --pki ./pki --node cli --server-name 10.0.50.10
```

Then embed a project in your portfolio:

```html
<iframe src="https://tryout.example.org/embed/cli-hello"
        allow="clipboard-read; clipboard-write; autoplay; fullscreen; keyboard-map"
        style="width: 100%; aspect-ratio: 16 / 10; border: 0"></iframe>
```

The embed page shows the visitor's place in the queue while they wait, then the session above a
28-pixel bar with the project's name and the time left. When the session ends, it offers to start
a new one.

## Upgrade

Change `TRYOUT_VERSION` in each `.env`, then on each machine:

```bash
docker compose pull && docker compose up -d
```

Upgrade the nodes and the control plane to the same version. The control plane keeps its queue
in PostgreSQL across restarts.

Running sessions survive a node upgrade, with a short interruption. A recreated gateway is no
longer attached to the session networks: the agent attaches it again and pushes its routes on
its next reconcile pass, about 10 s later. Connections open through the old gateway (a terminal's
WebSocket, a desktop stream) are cut, so the visitor's page has to reconnect; the container and
its state are kept.
