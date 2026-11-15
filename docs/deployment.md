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
`strict` profile, and runs the end-to-end tests against them (`scripts/e2e/deploy.sh`). It uses
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

The images are pulled from `ghcr.io/akinator31/`. If they are private (in a fork),
run `docker login ghcr.io` on each machine first, with a read-only token.

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
| `FRAME_ANCESTORS` | the control plane's public origin and your portfolios' origins, space-separated: `"https://tryout.example.org https://portfolio.example.org"` ([Iframes](exposure.md#iframes)) |

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

The control plane exits with every problem of `tryout.yaml` listed if the file is invalid. On
its first start, it publishes the file's settings (embedding, theme, limits, nodes, projects)
as revision 1 in PostgreSQL. From then on the database is the source of truth: change the
settings with the `import` command, and remove them from `tryout.yaml` or keep them in step,
since different settings in the file refuse the start. See
[Settings and revisions](configuration.md#settings-and-revisions).

PostgreSQL is on an internal network that only the control plane joins. It holds the queue,
the live sessions, the settings with their history and the admin accounts: back it up, or keep
an `export` of the settings.

To use the admin API, set `admin_listen`, publish it on a private address (see the comments of
`compose.yaml`) and create the first account; the password is asked without echo:

```bash
docker compose exec control-plane node apps/control-plane/src/cli.ts create-user alice
```

Reach the admin over HTTPS or an SSH tunnel to `localhost`, since its session cookie is
`Secure`. See [Admin accounts](configuration.md#admin-accounts).

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
node scripts/e2e/cli.ts https://tryout.example.org cli-hello
```

From a machine that reaches a node's agent (the control plane's, or one on the same VPN), check
that the agent accepts the control plane's certificate and refuses every other client: no
certificate, TLS 1.2, plain HTTP, the node's own certificate, a certificate from another CA.
`--pki` is a directory in the `tryout-certs` layout holding `control-plane/` and
`nodes/<name>/` only: run the check on your own machine, or copy those two directories, never
`ca/`. Add `--server-name` when you connect through a tunnel or a port forward, under another
address than the one in the node's certificate. It needs the `openssl` command.

```bash
node scripts/e2e/mtls.ts 10.0.50.10:7000 --pki ./pki --node cli
# through a port forward to the agent, from your machine
node scripts/e2e/mtls.ts 127.0.0.1:7000 --pki ./pki --node cli --server-name 10.0.50.10
```

Then embed a project in your portfolio:

```html
<iframe src="https://tryout.example.org/embed/cli-hello"
        allow="clipboard-read; clipboard-write; autoplay; fullscreen; keyboard-map"
        style="width: 100%; aspect-ratio: 16 / 10; border: 0"></iframe>
```

The embed page shows the visitor's place in the queue while they wait, then the session above a
36 px bar with the project's `title` (or its key, `cli-hello` here), the time left, a full-screen button and
End; the session area is the iframe minus that bar. When the session ends, it offers to start a
new one. Keep `fullscreen` in the `allow` attribute, or the full-screen button stays hidden.

The page speaks English and French, in the visitor's browser language by default. A portfolio
that shows one language can set the page's to match with `lang`:
`src="https://tryout.example.org/embed/cli-hello?lang=fr"`. A language the page does not speak
falls back to the browser's, then to English.

To match the portfolio's colours and show your logo on the waiting card, set `theme` in the
settings, with the logo file next to the imported file; see [Theme](configuration.md#theme).

## Logs

The control plane, the agent and the gateway write one JSON object per line on standard output
(`docker compose logs`), with the time under `t` and the message under `msg`; the agent and the
gateway add a `level`. Any log collector that reads Docker's output can parse them.

Session and ticket ids are the credentials in the session URL, so log lines keep only their
first 6 characters (`k2m7qa…`), wherever they appear, error messages included. Visitor IP
addresses are never logged; the gateway writes `<client>` in their place in the HTTP server's
error lines.

## Health and metrics

The control plane checks each node's `/healthz` every 10 s, over mutual TLS. A node that
answers anything but `200`, or nothing within 5 s, is down: its waiting visitors keep their place
and no session starts there until a check succeeds again. A node is down from the control
plane's start until its first check, a few seconds later. The control plane logs `node down`
and `node up` when a node changes state. Each instance checks the nodes on its own; nodes never
call the control plane.

With `admin_listen` set (see [Configuration](configuration.md#top-level)), the control plane
serves Prometheus metrics on `/metrics` of that listener: its own, then every agent's, which it
fetches over mutual TLS at each scrape and labels with `node`. Prometheus scrapes one target
per control plane instance and needs no certificate, and nodes open no new port. Set
`admin_metrics_token` so that only Prometheus reads it, and keep the admin listener off the
Internet: it also serves the admin API (see [Admin accounts](configuration.md#admin-accounts)).

```yaml
scrape_configs:
  - job_name: tryout
    authorization:
      credentials_file: /etc/prometheus/tryout-token   # the value of admin_metrics_token
    static_configs:
      - targets: ["127.0.0.1:9090"]
```

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `tryout_tickets` | gauge | `project`, `state` | Live tickets: `waiting` (the queue length), `starting`, `active`. Read from PostgreSQL, so every instance reports the same values. |
| `tryout_node_up` | gauge | `node` | 1 when this instance's last health check of the node succeeded, else 0. |
| `tryout_node_metrics_up` | gauge | `node` | 1 when the node's metrics were relayed in this scrape, else 0. |
| `tryout_ticket_starts_total` | counter | `project`, `result` | Session starts run by this instance: `ok`, `error` (the node or the readiness probe failed), `timeout` (no session after 180 s) or `abandoned` (the ticket ended during the start, usually because the visitor left). |
| `tryout_ticket_start_seconds` | histogram | `project` | Time from a slot being granted to a reachable session, as the visitor waits for it, for successful starts run by this instance. |

Counters belong to the instance that ran the start and restart from zero with it; with several
instances, scrape each one and sum. Concurrent scrapes share one round of calls to the nodes.
The control plane relays only `tryout_` families, at most 2000 series per node, and drops lines
it cannot parse, labels a node sets itself (`node`, `__name__`…) and any family a node sends under
one of the names above, so a node cannot break the scrape, flood Prometheus or speak for another
node.

### Agent endpoints

Each agent serves two read-only endpoints on its mutual TLS API, so only a client with the
control plane's certificate can call them:

- `GET /healthz` answers `200` with the node's version, profile, architecture, default
  runtime, installed runtimes, session count (starts in progress included) and `MAX_SESSIONS`, or `503` when the agent cannot
  reach its Docker daemon.
- `GET /metrics` answers in the Prometheus text format, relayed by the control plane with a
  `node` label:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `tryout_agent_info` | gauge | `version`, `profile`, `default_runtime`, `arch` | Always 1; describes the agent. |
| `tryout_node_sessions` | gauge | `project`, `state` | Session containers on the node, by Docker state (`running`, `created`…). |
| `tryout_node_sessions_max` | gauge | | `MAX_SESSIONS`. |
| `tryout_node_docker_up` | gauge | | 1 when the Docker daemon answered the scrape, else 0 (the session gauge is then missing). |
| `tryout_session_starts_total` | counter | `project`, `result` | Session creations: `ok`, `full` (the node was at `MAX_SESSIONS`) or `error`. |
| `tryout_session_start_seconds` | histogram | `project` | Time to start a session, image pull included, for successful starts. |
| `tryout_sessions_reaped_total` | counter | `reason` | Sessions the reconcile loop removed: `expired`, `dead` or `stuck`. |

Counters restart from zero when the agent restarts. To check a node by hand, with the control
plane's certificate:

```bash
cd pki/control-plane
curl --cacert ca.crt --cert tls.crt --key tls.key https://10.0.50.10:7000/metrics
```

## Upgrade

Change `TRYOUT_VERSION` in each `.env`, then on each machine:

```bash
docker compose pull && docker compose up -d
```

Upgrade the nodes and the control plane to the same version. The control plane keeps its queue
and its settings in PostgreSQL across restarts.

From `v0.1`, the first start of `v0.2` publishes the settings of `tryout.yaml` as revision 1.
Later changes go through the `import` command, not through the file: see
[Settings and revisions](configuration.md#settings-and-revisions).

Running sessions survive a node upgrade, with a short interruption. A recreated gateway is no
longer attached to the session networks: the agent attaches it again and pushes its routes on
its next reconcile pass, about 10 s later. Connections open through the old gateway (a terminal's
WebSocket, a desktop stream) are cut, so the visitor's page has to reconnect; the container and
its state are kept.
