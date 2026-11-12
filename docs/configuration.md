# Configuration

## Control plane

| Variable | Role |
|---|---|
| `DATABASE_URL` | Required. PostgreSQL (14 or later) connection string; the schema is created at startup. |
| `TRYOUT_CONFIG` | Path of the JSON configuration file (default `config.json`). |

The configuration file (see `deploy/config.dev.json`):

```json
{
  "listen_port": 3000,
  "embed_frame_ancestors": "'self' https://portfolio.example.org",
  "nodes": {
    "cli": {
      "agent_url": "http://10.0.50.10:7000",
      "agent_token": "…",
      "public_url": "https://sbx-cli.example.dev/s/{session}/",
      "probe_url": "http://10.0.50.10:8080/s/{session}/",
      "max_sessions": 10
    }
  },
  "projects": {
    "my-cli": {
      "node": "cli",
      "image": "ghcr.io/me/my-cli@sha256:…",
      "kind": "terminal",
      "port": 7681,
      "max_sessions": 5,
      "max_age_s": 900
    }
  }
}
```

### Nodes

| Key | Role |
|---|---|
| `agent_url` | URL of the agent's private API. |
| `agent_token` | Token shared with the agent (`AGENT_TOKEN`). |
| `public_url` | URL template loaded by the **browser**; `{session}` is replaced by the session id. |
| `probe_url` | URL template reachable **from the control plane**, to check that a session answers. Defaults to `public_url`. |
| `max_sessions` | Cap on concurrent sessions on the node, all projects combined. |

### Projects

| Key | Role |
|---|---|
| `node` | Node that runs the project. |
| `image` | Docker image, preferably pinned by digest. Must exist for the node's architecture. |
| `kind` | `terminal` or `desktop`. Selects the hardening profile (see [Security](security.md)). |
| `port` | HTTP port of the container (ttyd: 7681; LinuxServer images: 3000). |
| `max_sessions` | Concurrent sessions for this project. Later visitors wait in the queue. |
| `max_age_s` | Maximum session age. |
| `runtime` | Optional: `runsc`, `runc`… Defaults to the node's runtime. |
| `strip_prefix` | Optional: strip `/s/<id>` before forwarding, for an application that cannot serve under a base path. |
| `limits` | Optional: `memory_mb`, `cpus`, `pids`. Defaults: 256 MB / 0.5 CPU / 128 PIDs for terminals, 2 GB / 1.5 CPU / 1024 PIDs for desktops. |
| `env` | Optional: project environment variables. Reserved variables are rejected: `TRYOUT_*`, `SUBFOLDER`, `PUID`, `PGID`, `HOME`, and the Selkies security settings. |

## Agent

| Variable | Default | Role |
|---|---|---|
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Daemon for sessions (`unix://` or `tcp://`). In `single-host`, the socket of the dedicated **rootless** daemon. |
| `NODE_PROFILE` | `dev` | `dev`, `strict` or `single-host` (see [Security](security.md)). |
| `DEFAULT_RUNTIME` | `runsc` | Runtime used when the project does not set one. |
| `ALLOW_RUNC` | `false` | Allows `runc` in `strict` and `single-host`. A documented, weaker opt-out. |
| `AGENT_LISTEN` | `:7000` | Private API address. |
| `AGENT_TOKEN` | — | Required. Token expected from the control plane. |
| `GATEWAY_TOKEN` | — | Required. Token for the gateway's admin API. |
| `GATEWAY_CONTAINER` | `tryout-gateway` | Name of the gateway container to attach to session networks. |
| `GATEWAY_ADMIN_SOCKET` | `unix:///run/tryout/gateway.sock` | Gateway admin socket. |
| `MAX_SESSIONS` | `10` | Node-side safety cap. |
| `SESSION_MAX_AGE_CAP` | `2h` | Maximum age enforced whatever is requested. |

## Gateway

| Variable | Default | Role |
|---|---|---|
| `PUBLIC_LISTEN` | `:8080` | Public listener. |
| `ADMIN_SOCKET` | `unix:///run/tryout/gateway.sock` | Admin API, shared with the agent only. |
| `GATEWAY_TOKEN` | — | Required. |
| `FRAME_ANCESTORS` | `'self'` | Origins allowed to embed sessions: the control plane's origin, since the session iframe lives inside the embed page. |

## Desktop session defaults

Without these settings, Selkies sizes the stream to the visitor's screen. On a HiDPI laptop that
means close to 4K at 60 fps, and a single visitor saturates a small machine. The agent therefore
applies these defaults, which a project may override through `env`:

| Variable | Value |
|---|---|
| `SELKIES_MANUAL_RESOLUTION` | `true\|locked` |
| `SELKIES_MANUAL_WIDTH` × `SELKIES_MANUAL_HEIGHT` | `1280` × `720` |
| `SELKIES_SCALING_DPI` | `96` |
| `SELKIES_USE_CSS_SCALING` | `true\|locked` |
| `SELKIES_FRAMERATE` | `15-30` |
| `SELKIES_AUDIO_ENABLED` | `false\|locked` |

File transfer, microphone, webcam, printing, gamepads and second screen are disabled and
**cannot** be re-enabled.
