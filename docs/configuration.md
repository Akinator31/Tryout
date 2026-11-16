# Configuration

## Control plane

| Variable | Role |
|---|---|
| `DATABASE_URL` | Required. PostgreSQL (14 or later) connection string; the schema is created at startup. |
| `TRYOUT_CONFIG` | Path of the YAML configuration file (default `tryout.yaml`). |
| `TRYOUT_VERSION` | Version shown in the admin interface; set by the published images (`dev` otherwise). |

The configuration has two parts:

- the **bootstrap**, in `tryout.yaml`: `listen`, `admin_listen`, `admin_metrics_token`,
  `public_url`, `admin_preview`, `agent_tls` and `client_ip`.
  It is read at startup; a change needs a restart.
- the **settings**, in PostgreSQL: `embed_frame_ancestors`, `theme`, `limits`, `nodes` and
  `projects`. They are stored as [revisions](#settings-and-revisions) and applied to every
  instance without a restart. `tryout.yaml` may hold them too, to seed an empty database.

The configuration file, with both parts (see `deploy/tryout.dev.yaml`):

```yaml
# yaml-language-server: $schema=https://akinator31.github.io/Tryout/schema/v1/tryout.schema.json
listen: ":3000"
admin_listen: "127.0.0.1:9090"   # optional
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

theme:                     # optional
  accent: "#ffb000"
  logo: { file: logo.svg, alt: Jane Doe }

projects:
  my-cli:
    title: My CLI            # optional
    node: cli
    image: ghcr.io/me/my-cli@sha256:…
    kind: terminal
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

A stored revision is checked against the same schema (`$defs/settings_document`) and the same
semantic checks before it is published.

### Environment variables in values

`${NAME}` inside a value is replaced by the environment variable `NAME`, so the file can be kept
in version control without its secrets. An unset variable is an error; there is no default-value
syntax. Only values are substituted, never keys, and the substitution happens after the YAML is
parsed, so a variable cannot add keys. A substituted value is always a string, so `${VAR}` fits
string keys such as `image` or `server_name`, not numbers such as `port`. A literal `${` cannot
be written.

### Settings and revisions

Each revision is a full copy of the settings, with its author, its date and the revision it was
edited from. The latest revision is the active one. A rollback publishes an older revision's
settings again, as a new revision.

**At startup**, the settings in `tryout.yaml` (any of `embed_frame_ancestors`, `theme`, `limits`,
`nodes`, `projects`) are handled this way:

| Database | `tryout.yaml` | Result |
|---|---|---|
| No revision | No settings | The control plane starts with no node and no project. |
| No revision | Settings | They are published as revision 1, by `tryout.yaml`. |
| Revisions | No settings | The active revision applies. |
| Revisions | The same settings | The active revision applies; a warning says the file's settings are ignored. |
| Revisions | Different settings | The control plane refuses to start, so a stale file never hides a change. |

Once the database is seeded, remove the settings from `tryout.yaml`, or keep them in step with
the active revision. Settings are compared after `${VAR}` substitution, and the logo by its
content.

**Changing the settings** happens in the [admin interface](#admin-interface), through the
[admin API](#admin-api), or from the command line. The commands run where the control plane runs, with the same `DATABASE_URL`. With the
production example, the image's own directories are read-only for its user, so work in
`/tmp` and copy files in and out:

```sh
docker compose exec control-plane node apps/control-plane/src/cli.ts export /tmp/settings.yaml
docker compose cp control-plane:/tmp/settings.yaml .    # and the logo file, if any
# edit settings.yaml, then:
docker compose cp settings.yaml control-plane:/tmp/settings.yaml
docker compose exec control-plane node apps/control-plane/src/cli.ts import /tmp/settings.yaml
```

`import` accepts a file written by `export` or a whole `tryout.yaml`, whose bootstrap it ignores
(its `${VAR}` included). A logo file is read relative to the imported file. It reports every
problem with its line, like the startup check, and publishes nothing then. It refuses a file
with no settings at all, and a revision that removes a node on which sessions are starting or
running, or changes its `agent_url` or `server_name`.

**Every instance applies a new revision within a second** (PostgreSQL `LISTEN/NOTIFY`):

- caps, maximum ages, limits, embedding origins and the theme apply to the next request or
  promotion; a lower cap evicts nobody;
- a change of image, port or node applies to sessions that start afterwards; a running
  session keeps what it started with;
- a removed project's tickets end and their sessions stop; its visitors see that the operator
  stopped their session;
- a project with `enabled: false` is paused: new visitors see that it is offline, and those
  already in line or in a session keep their place.

The gateway's `FRAME_ANCESTORS` is set on each node, not in the settings: when you add a
portfolio to `embed_frame_ancestors`, add it there too.

Do not put secrets in the settings: they are stored in PostgreSQL in clear, and a project's `env`
is visible inside its sessions anyway. `${VAR}` values in a seeding file are stored as
substituted.

### Top level

| Key | Role |
|---|---|
| `listen` | Optional: `[host]:port` to listen on. Default `:3000` (every interface). |
| `admin_listen` | Optional: `[host]:port` of the admin listener: the admin API, behind a login (see [Admin accounts](#admin-accounts)), and Prometheus metrics on `/metrics` (see [Health and metrics](deployment.md#health-and-metrics)). Off when left out. Keep it off the Internet, or behind an identity-aware proxy (see [Production deployment](deployment.md#3-set-up-the-control-plane)). It may equal `listen`, which puts the admin on the public address. Another host on the port of `listen` is refused, since the two servers would overlap. |
| `admin_metrics_token` | Optional: bearer token, 32 to 1024 characters, that Prometheus must send to read `/metrics`. Write it as `${VAR}` to keep it out of the file. Without it, `/metrics` is open to anyone who reaches `admin_listen`, and the control plane warns unless `admin_listen` is a loopback address. |
| `public_url` | Optional: the origin at which visitors reach the control plane, `scheme://host[:port]` with no path (`https://tryout.example.org`). The admin interface shows the address to embed with it and runs the project preview from it; without it, the admin shows `/embed/<project>` alone and no preview. |
| `admin_preview` | Optional: `false` turns off the project preview in the admin interface. Default `true`; it needs `public_url`. |
| `agent_tls` | Mutual TLS towards the agents: `ca` (the CA that signs the agents' certificates), `cert` and `key` (the control plane's client certificate, with the `clientAuth` usage). Paths of PEM files, relative to the configuration file. See [Certificates](certificates.md). |
| `client_ip` | Optional: how to find a visitor's IP address behind proxies. See [Per-IP limits](#per-ip-limits). |

The keys above are the bootstrap; the keys below are the settings, all optional.

| Key | Role |
|---|---|
| `limits` | Optional: per-IP limits on tickets and event streams. See [Per-IP limits](#per-ip-limits). |
| `theme` | Optional: accent colour and logo of the embed page. See [Theme](#theme). |
| `embed_frame_ancestors` | Origins allowed to embed `/embed/<project>` in an iframe: `https://example.org`, `https://*.example.org`, `http://localhost:3000`. `'self'` is always allowed. |
| `nodes` | Nodes by name (lower-case letters, digits, `-`). |
| `projects` | Projects by name (same rule); the name appears in `/embed/<project>`. |

### Theme

The embed page has a dark look with an amber accent. `theme` adapts it to the portfolio, for
every project at once:

```yaml
theme:
  accent: "#4c9aff"
  logo:
    file: brand/logo.svg   # relative to this file
    alt: Jane Doe
```

| Key | Role |
|---|---|
| `theme.accent` | Optional: the accent colour as `#rrggbb`. It colours the queue number, the spinner, the primary button and the focus ring. The control plane derives the hover colour and picks black or white text for the button. It refuses an accent with a contrast below 3:1 on the card (`#141414`), the minimum for interface elements. |
| `theme.logo.file` | In `tryout.yaml` and imported files: the logo, shown 20 px high at the top of every status card, never over a session. An SVG, PNG or WebP file of at most 64 KB, recognised by its content. Prefer an SVG or an image at least 40 px high, for sharp rendering on high-density screens. |
| `theme.logo.asset` | In stored revisions: the SHA-256 of the logo, stored in the database. The control plane writes it; `export` turns it back into a file. |
| `theme.logo.alt` | Required with a logo: the text screen readers say instead of it, such as your name. |

The control plane stores the logo in the database when the settings are published, and serves
it, with the accent's stylesheet, under `/assets/` with a name derived from its content. The page
loads nothing from elsewhere, so its Content-Security-Policy stays as strict as without a
theme. The fonts and the dark background cannot be changed.

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
| `public_url` | URL template loaded by the **browser**; must contain `{session}`, replaced by the session id, in the path (`https://sbx.example.org/s/{session}/`) or in the first label of the host (`https://{session}.sbx.example.org/`). The embed page allows session frames from these URLs only; with `{session}` elsewhere in the host it must allow any origin of that scheme, and the control plane warns at startup. |
| `probe_url` | Optional: URL template reachable **from the control plane**, to check that a session answers. Defaults to `public_url`. |
| `max_sessions` | Cap on concurrent sessions on the node, all projects combined. |

### Projects

| Key | Role |
|---|---|
| `enabled` | Optional, default `true`. `false` pauses the project: new visitors see that it is offline; those in line or in a session keep their place. |
| `title` | Optional: the project's name for visitors, up to 40 characters, in the session bar, the starting card ("Starting My CLI…") and the browser tab. Defaults to the project's key. |
| `node` | Node that runs the project. |
| `image` | Docker image, preferably pinned by digest. Must exist for the node's architecture. |
| `kind` | `terminal` or `desktop`. Selects the hardening profile (see [Security](security.md)). |
| `ttyd` | Terminals only, default `agent`: the agent runs the image's program in its own web terminal, ttyd, so the image needs no web server (see [Project images](project-images.md#command-line-project-kind-terminal)). `image`: the image serves its own page on `port`. |
| `command` | Optional, with the agent's ttyd only: the program ttyd runs, as a list (`[python3, -q]`). Defaults to the image's `ENTRYPOINT` and `CMD`. |
| `port` | HTTP port of an image that serves its own page: a desktop (LinuxServer images: 3000) or a terminal with `ttyd: image`. Not allowed with the agent's ttyd. |
| `max_sessions` | Concurrent sessions for this project. Later visitors wait in the queue. |
| `max_age` | Maximum session age: `90s`, `15m`, `1h30m`, at most `24h`. The agent also enforces its own cap (`SESSION_MAX_AGE_CAP`). |
| `runtime` | Optional: `runsc`, `runc`… Defaults to the node's runtime. Outside the `dev` profile, the agent refuses any runtime but `runsc` unless it runs with `ALLOW_RUNC=true`. |
| `strip_prefix` | Optional, for an image that serves its own page: strip `/s/<id>` before forwarding, for an application that cannot serve under a base path. |
| `limits` | Optional: `memory_mb`, `cpus`, `pids`. Defaults: 256 MB / 0.5 CPU / 128 PIDs for terminals, 2 GB / 1.5 CPU / 1024 PIDs for desktops. |
| `env` | Optional: project environment variables, as strings (quote numbers: `WIDTH: "1920"`). Reserved variables are rejected: `TRYOUT_*`, `SUBFOLDER`, `PUID`, `PGID`, `HOME`, and the Selkies security settings. |

### Admin accounts

The admin API, on `admin_listen`, needs an account. There is no sign-up: accounts are made from
the command line, then by a signed-in admin. Every account has the same rights. The commands
run where the control plane runs, with the same `DATABASE_URL`:

```sh
docker compose exec control-plane node apps/control-plane/src/cli.ts create-user alice
docker compose exec control-plane node apps/control-plane/src/cli.ts list-users
docker compose exec control-plane node apps/control-plane/src/cli.ts set-password alice
docker compose exec control-plane node apps/control-plane/src/cli.ts delete-user alice
```

On a terminal, the password is asked twice, without echo. Otherwise it is read from the first
line of the standard input (`printf '%s\n' "$PASSWORD" | docker compose exec -T …`), never from
the arguments, which other users of the machine can see. `set-password` is the way back in when
every password is lost; it closes the account's sessions. `delete-user` may delete the last
account, unlike the admin API.

- **Names** have 1 to 64 lower-case letters, digits, dots, dashes or underscores. They appear
  as the author of settings revisions and in logs.
- **Passwords** have 12 to 1024 characters, with no other rule. They are hashed with scrypt
  (N = 2^17, r = 8, p = 1: about 128 MB and a few hundred milliseconds per check). An instance
  runs two checks at once and queues 16; beyond that, a login gets `503`.
- **Sessions** end after 12 hours without a request, and 7 days after login in any case.
  Changing one's password closes one's other sessions; deleting an account closes all of its
  sessions.
- **Failed logins** are limited to 10 per account name (known or not) and 20 per client address
  in 15 minutes, across instances. Beyond that, logins get `429` with `Retry-After`, even with
  the right password. The address is read through `client_ip.trusted_proxies`, like the per-IP
  limits. Whoever reaches the admin listener can therefore keep an account locked by failing on
  purpose: keep the listener private, and use `set-password`, which also clears the account's
  failures, to get back in.

The browser keeps the session in a `__Host-` cookie marked `Secure`, which browsers accept over
HTTPS and on `localhost` only. Reach the admin over HTTPS, through a reverse proxy, or over an
SSH tunnel to `localhost`: elsewhere, a login over plain HTTP is refused with a message saying
so. The control plane decides from the `Origin` the browser sends: `https://…`, or `http://` on
`localhost`, `127.0.0.0/8` or `[::1]`. A reverse proxy must keep the `Host` header: requests that change something must come from
a page of the same origin.

### Admin interface

With `admin_listen` set, the control plane serves the admin interface on that listener, at
`/admin/` (`/` redirects there). It opens on the sign-in page, then:

- **Projects**: every project with its kind, node, sessions out of its cap, queue and state
  (ready, running, full, paused, node offline, or not applied yet), under a line that sums up
  the slots, the queues, the paused projects and the nodes down; with no project, the first
  steps. *New project* and *Edit settings* open a form (identity, image and how it is served:
  Tryout's terminal and its command, or the image's own port; node and
  runtime, capacity, resources, environment) that the browser checks as it is typed, warns when
  a node's projects would ask for more sessions than its cap, and shows the project as YAML.
  A project's page shows its load, live sessions and settings, with *Pause project* (or
  *Resume*) and *Remove*, a preview (see below), and the address to embed with the allowed
  parents and an iframe snippet to copy. The name of a project or a node cannot change once
  created;
- **Nodes**: every node with its last health check (agent version, profile, runtime and
  architecture, or why it does not answer) and the projects it runs, a warning for the dev
  profile, and a drawer to add or edit one. *Test connection* runs the dry run with the node in
  the settings, so the control plane tries the agent over mutual TLS. A node that projects
  still use cannot be removed;
- **Embedding**: the origins allowed to frame `/embed/<project>`, with a hint when a typed
  origin lacks its scheme or has a path, and the per-IP visitor limits. The trusted proxies
  stay in `tryout.yaml` (`client_ip`);
- **Theme**: the accent colour, with its contrast on the embed card, and the logo with its
  alt text, beside a preview of the waiting card;
- **Sessions**: every live ticket with its state, place in line, start and time left,
  refreshed every 3 seconds while the tab is visible, and a Stop button that asks first;
- **Revisions**: every revision, newest first; for each, its changes from its parent, its
  settings as YAML to download, and rolling back to it;
- **Accounts**: the accounts, adding and deleting one (not one's own, nor the last), and
  changing one's own password.

The sidebar shows whether the last call to the control plane got an answer, the control
plane's version (`TRYOUT_VERSION`) and the active revision.

**Pending changes.** Edits on any settings page join one draft of the whole settings, kept
in the browser tab (it survives a reload, not closing the tab; signing out drops it, and another
account signing in on the tab never sees it). While
it holds changes, every settings page shows *Discard* and *Review N changes*. Creating or
saving a project or a node, pausing, resuming and removing put the change in the draft and open
the review at once. The review lists
the changes and their YAML diff, runs the dry run (problems block Apply, warnings such as an
unreachable node do not), takes an optional note, and publishes the draft as the next
revision. *Download YAML* saves the draft, or a revision, in the format of the `import`
command, with a stored logo named as a file beside it, which *Download logo* saves.

If another account publishes a revision meanwhile, the draft moves on top of it: each side's
changes are kept, and where both changed the same value, the draft's value is kept and the
review marks it. A rollback waits until the draft is applied or discarded.

**Project preview.** *Start preview* loads the real `/embed/<project>` from `public_url` in a
frame on the project's page, as a visitor would: it goes through the queue, takes one of the
project's slots and counts towards the per-IP limits of the admin's address. *Stop preview*
removes the frame, and the embed page gives its ticket back. Nothing starts until the click.
Without `public_url` there is no preview card. The preview also needs `admin_preview` left
on, the project applied and not paused, and the admin's own origin in `embed_frame_ancestors`
(the embed page refuses other parents); otherwise the card says which is missing. The session inside the preview also needs the
admin's origin in the node's `FRAME_ANCESTORS`, since browsers check every ancestor of a frame
(see [Iframes](exposure.md#iframes)); the admin cannot see that setting, so a refused session
shows as the browser's error inside the preview. The dev stack allows `http://localhost:9090`
in both.

A logo is stored as soon as it is picked, before the review: a logo picked and then dropped
stays in the database (64 KB at most each), unused.

After an edit from the admin interface, the settings in the database differ from those in
`tryout.yaml`, so the control plane refuses to restart until they are removed from the file
(see the table above). With the dev stack, `down -v` starts again from `tryout.dev.yaml`.

The interface is plain files built into the control plane's image, served with a
Content-Security-Policy that allows only its own scripts and API, frames from `public_url`
only (none when the preview is off), and forbids framing it. Its
session is the same cookie as the API's, so it needs HTTPS or `localhost` like the API.

### Admin API

Signed in, the admin API under `/admin/api/` edits the settings as one whole document, the
JSON form of the settings sections, and lists and stops sessions. The admin interface uses it;
scripts can too, with the session cookie and an `Origin` naming the host on every request that
changes something.

| Route | Role |
|---|---|
| `GET me` | The signed-in account's `name`, the control plane's `version`, its `public_url` (`null` when not set) and `preview`, whether the project preview is on. |
| `GET settings` | The active revision's id and document; `{revision: null, document: {}}` before the first one. |
| `POST config/validate` `{document}` | Dry run: runs every check of a publication and publishes nothing. `422` with `problems` when invalid, or when it removes or readdresses a node with sessions (with `nodes` too); otherwise `200` with `warnings`, including each node whose agent does not answer `/healthz` within 3 s, with the reason. An unreachable node does not prevent publishing. |
| `POST revisions` `{base, document, note?}` | Publishes the document as a new revision, authored by the signed-in account. `base` is the revision it was edited from (`null` for the first one): `409` with `latest` when another was published since. `422` when invalid, `409` with `nodes` when it removes or readdresses a node with sessions. |
| `GET revisions`, `GET revisions/:id` | Every revision newest first, without its document; one revision with its document. |
| `POST revisions/:id/rollback` `{base}` | Publishes that revision's document again, as a new revision noted "Rollback to revision N". |
| `POST assets` `{data}` | Stores a logo given in base64 (SVG, PNG or WebP, at most 64 KB) and answers its `sha256`, to put in `theme.logo.asset`. |
| `GET assets/:sha256` | A stored logo, for a preview. |
| `GET nodes` | Each node of the active settings with its last health check, as seen by the instance that answers, and its live tickets by state. |
| `GET sessions` | Every live ticket (waiting, starting or active), by project then queue order: ticket id, project, node, state, position in line, when it was created, when its session started and when it reaches its maximum age. Never the session's URL, which would open the visitor's session, nor the visitor's address. |
| `POST sessions/:ticket/stop` | Ends the ticket, whatever its state, and stops its session; the slot goes to the next visitor, and the visitor sees that the operator stopped the session. `404` when the ticket is unknown or already ended. |

A settings document may weigh up to 256 KB, a logo upload 128 KB, any other body 16 KB. Each
publication, rollback, logo upload and stop is logged with the account name.

## Agent

| Variable | Default | Role |
|---|---|---|
| `DOCKER_HOST` | `unix:///var/run/docker.sock` | Daemon for sessions (`unix://` or `tcp://`), Docker Engine 28 or later: the agent refuses to start on an older one. In `single-host`, the socket of the dedicated **rootless** daemon. |
| `NODE_PROFILE` | `dev` | `dev`, `strict` or `single-host` (see [Security](security.md)). |
| `DEFAULT_RUNTIME` | `runsc` | Runtime used when the project does not set one. In `strict` and `single-host`, the agent refuses to start with anything but `runsc` unless `ALLOW_RUNC=true`. |
| `ALLOW_RUNC` | `false` | Allows runtimes other than `runsc` (`runc`, `io.containerd.runc.v2`…) in `strict` and `single-host`. A documented, weaker opt-out. |
| `AGENT_LISTEN` | `:7000` | Private API address, served over mutual TLS only, `/healthz` and `/metrics` included. |
| `AGENT_TLS_CERT` | — | Required. PEM server certificate of the agent (`serverAuth`). |
| `AGENT_TLS_KEY` | — | Required. Its private key. |
| `AGENT_TLS_CLIENT_CA` | — | Required. PEM CA that signs the control plane's client certificate. |
| `GATEWAY_TOKEN` | — | Required. Token for the gateway's admin API. |
| `GATEWAY_CONTAINER` | `tryout-gateway` | Name of the gateway container to attach to session networks. |
| `GATEWAY_ADMIN_SOCKET` | `unix:///run/tryout/gateway.sock` | Gateway admin socket. |
| `REGISTRY_AUTH_FILE` | — | Optional. Path of a Docker `config.json` with static `auths` entries, used to pull private project images. See [Project images](project-images.md#private-images). |
| `MAX_SESSIONS` | `10` | Node-side safety cap. |
| `SESSION_MAX_AGE_CAP` | `2h` | Maximum age enforced whatever is requested. |
| `TTYD_IMAGE` | the release's | The web terminal mounted into terminal sessions: an image holding a static `/ttyd`. Published node images default to the `tryout-ttyd` image of their release, pinned by digest; a local build has no default. The agent pulls it at startup and refuses to start when it is missing or built for another architecture. Outside `dev`, a reference without a digest is a warning. |

## Gateway

| Variable | Default | Role |
|---|---|---|
| `PUBLIC_LISTEN` | `:8080` | Public listener. |
| `ADMIN_SOCKET` | `unix:///run/tryout/gateway.sock` | Admin API, shared with the agent only. |
| `GATEWAY_TOKEN` | — | Required. |
| `FRAME_ANCESTORS` | `'self'` | Origins allowed to embed sessions, space-separated: the control plane's origin and every portfolio's origin. The session iframe lives inside the embed page, itself inside the portfolio, and browsers check every ancestor. |

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
