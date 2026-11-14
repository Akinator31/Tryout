# Configuration

## Control plane

| Variable | Role |
|---|---|
| `DATABASE_URL` | Required. PostgreSQL (14 or later) connection string; the schema is created at startup. |
| `TRYOUT_CONFIG` | Path of the YAML configuration file (default `tryout.yaml`). |

The configuration file (see `deploy/tryout.dev.yaml`):

```yaml
# yaml-language-server: $schema=https://akinator31.github.io/Tryout/schema/v1/tryout.schema.json
listen: ":3000"
embed_frame_ancestors:
  - https://portfolio.example.org
agent_tls:
  ca: pki/ca.crt
  cert: pki/tls.crt
  key: pki/tls.key

nodes:
  cli:
    agent_url: https://10.0.50.10:7000
    public_url: https://sbx-cli.example.dev/s/{session}/
    probe_url: http://10.0.50.10:8080/s/{session}/
    max_sessions: 10

projects:
  my-cli:
    node: cli
    image: ghcr.io/me/my-cli@sha256:…
    kind: terminal
    port: 7681
    max_sessions: 5
    max_age: 15m
```

### Validation

The file is checked against a JSON Schema,
[`tryout.schema.json`](schema/v1/tryout.schema.json), at startup. The first line of the example
above lets editors that use the YAML language server (VS Code, Neovim, Zed…) complete keys and
underline errors as you type.

- Unknown keys are errors, at every level: a typo never goes unnoticed.
- Every problem is reported at once, with its path and its line, and the control plane exits
  before it opens its port. This includes the checks the schema cannot express: a project's
  node exists, and `max_age` is between 1 second and 24 hours.

  ```
  {"msg":"invalid configuration","problems":["/projects/my-cli/kind (line 18): must be equal to one of the allowed values: terminal, desktop","/projects/my-cli/port (line 19): must be <= 65535"]}
  ```

- A node whose projects allow more sessions than its own `max_sessions` gets a warning only:
  the node cap wins.

The agent validates each session request against the same schema and rejects any field it does
not know. A newer control plane that sends a new field to an older agent gets an error rather
than a silently ignored setting: upgrade nodes and the control plane together. The agent also
keeps its own checks of the fields the hardening depends on (session id, kind, port, reserved
variables), as defence in depth.

The file is read at startup only; a change needs a restart.

### Environment variables in values

`${NAME}` inside a value is replaced by the environment variable `NAME`, so the file can be kept
in version control without its secrets. An unset variable is an error; there is no default-value
syntax. Only values are substituted, never keys, and the substitution happens after the YAML is
parsed, so a variable cannot add keys. A substituted value is always a string, so `${VAR}` fits
string keys such as `image` or `server_name`, not numbers such as `port`. A literal `${` cannot
be written.

### Top level

| Key | Role |
|---|---|
| `listen` | Optional: `[host]:port` to listen on. Default `:3000` (every interface). |
| `agent_tls` | Mutual TLS towards the agents: `ca` (the CA that signs the agents' certificates), `cert` and `key` (the control plane's client certificate, with the `clientAuth` usage). Paths of PEM files, relative to the configuration file. See [Certificates](certificates.md). |
| `client_ip` | Optional: how to find a visitor's IP address behind proxies. See [Per-IP limits](#per-ip-limits). |
| `limits` | Optional: per-IP limits on tickets and event streams. See [Per-IP limits](#per-ip-limits). |
| `embed_frame_ancestors` | Origins allowed to embed `/embed/<project>` in an iframe: `https://example.org`, `https://*.example.org`, `http://localhost:3000`. `'self'` is always allowed. |
| `nodes` | Nodes by name (lower-case letters, digits, `-`). |
| `projects` | Projects by name (same rule); the name appears in `/embed/<project>`. |

### Per-IP limits

The control plane limits what one visitor IP address can hold, to keep a single client from
filling a queue. A reverse proxy can limit request rates, but it cannot see how many tickets a
client holds, so the limits live in the control plane. IPv6 addresses count per /64, since one
client usually holds a whole /64.
The limits apply across all projects and are on by default:

```yaml
client_ip:
  trusted_proxies: [10.0.0.0/8, "fd00::/8"]   # default: none
  header: CF-Connecting-IP                    # optional
limits:
  live_tickets_per_ip: 4                      # default 4
  new_tickets_per_ip: { max: 10, per: 1m }    # default 10 per minute
  streams_per_ip: 8                           # default 8
```

| Key | Role |
|---|---|
| `client_ip.trusted_proxies` | IP addresses or CIDR blocks of the reverse proxies and tunnels in front of the control plane. Without them, the address of the connection is the visitor's and forwarding headers are ignored. |
| `client_ip.header` | Optional: a header in which your trusted proxy puts the visitor's address. Defaults to `X-Forwarded-For`, read from the right: the first address that is not a trusted proxy is the visitor's. |
| `limits.live_tickets_per_ip` | Tickets an IP may hold at once: waiting, starting or active. |
| `limits.new_tickets_per_ip` | Tickets an IP may create within a sliding window of `per` (at most `5m`), released ones included. |
| `limits.streams_per_ip` | Event streams an IP may keep open at once, **on each instance** of the control plane. |

`0` disables a limit. Beyond a limit, the API answers `429 Too Many Requests` with
`{"error": …, "limit": "live_tickets" | "new_tickets" | "streams"}`. A refused ticket also carries
`Retry-After`, and the embed page waits that long and tries again. A refused event stream makes
the embed page poll instead, which keeps its place in line.

- **Behind a proxy, set `trusted_proxies`.** Otherwise every visitor shares the proxy's address
  and its limits.
- **List only your own proxies**, and keep the control plane unreachable except through them: a
  client connecting from a trusted address could write the header itself.
- If a trusted proxy sends no usable address (header missing, malformed entry), its own address
  is used, so its visitors share one budget; the control plane logs a `client address warning`
  the first time. Ports written after an address (`192.0.2.1:4711`, `[2001:db8::1]:4711`) are
  ignored. Write IPv4 blocks as IPv4, not as `::ffff:` blocks.
- **Shared addresses** (a school, an office, a mobile carrier) share one budget. Raise the
  limits if you expect groups of visitors behind one address.

### Nodes

| Key | Role |
|---|---|
| `agent_url` | URL of the agent's private API: `https://host[:port]`, without a path. The agent's certificate must name the host. |
| `server_name` | Optional: DNS name expected in the agent's certificate when it differs from the host of `agent_url` (a tunnel, a port forward). |
| `public_url` | URL template loaded by the **browser**; must contain `{session}`, replaced by the session id. |
| `probe_url` | Optional: URL template reachable **from the control plane**, to check that a session answers. Defaults to `public_url`. |
| `max_sessions` | Cap on concurrent sessions on the node, all projects combined. |

### Projects

| Key | Role |
|---|---|
| `node` | Node that runs the project. |
| `image` | Docker image, preferably pinned by digest. Must exist for the node's architecture. |
| `kind` | `terminal` or `desktop`. Selects the hardening profile (see [Security](security.md)). |
| `port` | HTTP port of the container (ttyd: 7681; LinuxServer images: 3000). |
| `max_sessions` | Concurrent sessions for this project. Later visitors wait in the queue. |
| `max_age` | Maximum session age: `90s`, `15m`, `1h30m`, at most `24h`. The agent also enforces its own cap (`SESSION_MAX_AGE_CAP`). |
| `runtime` | Optional: `runsc`, `runc`… Defaults to the node's runtime. Outside the `dev` profile, the agent refuses any runtime but `runsc` unless it runs with `ALLOW_RUNC=true`. |
| `strip_prefix` | Optional: strip `/s/<id>` before forwarding, for an application that cannot serve under a base path. |
| `limits` | Optional: `memory_mb`, `cpus`, `pids`. Defaults: 256 MB / 0.5 CPU / 128 PIDs for terminals, 2 GB / 1.5 CPU / 1024 PIDs for desktops. |
| `env` | Optional: project environment variables, as strings (quote numbers: `WIDTH: "1920"`). Reserved variables are rejected: `TRYOUT_*`, `SUBFOLDER`, `PUID`, `PGID`, `HOME`, and the Selkies security settings. |

## Agent

| Variable | Default | Role |
|---|---|---|
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Daemon for sessions (`unix://` or `tcp://`). In `single-host`, the socket of the dedicated **rootless** daemon. |
| `NODE_PROFILE` | `dev` | `dev`, `strict` or `single-host` (see [Security](security.md)). |
| `DEFAULT_RUNTIME` | `runsc` | Runtime used when the project does not set one. In `strict` and `single-host`, the agent refuses to start with anything but `runsc` unless `ALLOW_RUNC=true`. |
| `ALLOW_RUNC` | `false` | Allows runtimes other than `runsc` (`runc`, `io.containerd.runc.v2`…) in `strict` and `single-host`. A documented, weaker opt-out. |
| `AGENT_LISTEN` | `:7000` | Private API address, served over mutual TLS only, `/healthz` included. |
| `AGENT_TLS_CERT` | — | Required. PEM server certificate of the agent (`serverAuth`). |
| `AGENT_TLS_KEY` | — | Required. Its private key. |
| `AGENT_TLS_CLIENT_CA` | — | Required. PEM CA that signs the control plane's client certificate. |
| `GATEWAY_TOKEN` | — | Required. Token for the gateway's admin API. |
| `GATEWAY_CONTAINER` | `tryout-gateway` | Name of the gateway container to attach to session networks. |
| `GATEWAY_ADMIN_SOCKET` | `unix:///run/tryout/gateway.sock` | Gateway admin socket. |
| `REGISTRY_AUTH_FILE` | — | Optional. Path of a Docker `config.json` with static `auths` entries, used to pull private project images. See [Project images](project-images.md#private-images). |
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
