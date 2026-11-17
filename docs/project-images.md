# Project images

A project image is a regular Docker image that follows a small contract. This page is the
reference; [Packaging a project](packaging.md) walks through a terminal and a desktop example,
and `scripts/check-image.sh` checks an image against the contract before it goes to production.

## Common contract

- It **needs no network**: sessions have no outbound access.
- It exists for the **node's architecture** (amd64 or arm64). Otherwise the agent refuses the
  session with an explicit message. Building multi-architecture images is the image author's
  responsibility (`docker buildx build --platform linux/amd64,linux/arm64`).

Variables provided by the agent: `TRYOUT_SESSION_ID`, `TRYOUT_BASE_PATH`.

An image that **serves its own page** (a desktop, or a terminal with a `port`) also:

- listens over **HTTP** on the port declared in the configuration (`port`), on every interface;
- serves its UI **under the path `$TRYOUT_BASE_PATH`** (e.g. `/s/abc…`), or the project
  declares `strip_prefix: true`.

## Private images

The agent pulls a missing image itself, through the Docker Engine API. A `docker login` on the
node does not help: the Docker CLI keeps that login for its own commands. To pull private images,
give the agent a credentials file with `REGISTRY_AUTH_FILE`, mounted read-only:

```json
{
  "auths": {
    "ghcr.io": { "auth": "<base64 of user:token>" }
  }
}
```

- The format is the Docker CLI's `config.json`. Each entry holds `auth` (base64 of
  `user:password`), or `username` and `password`, or `identitytoken`. The key is the registry
  host alone; Docker Hub is `docker.io` or `https://index.docker.io/v1/`. Keys scoped to a path
  (`ghcr.io/owner`) are refused rather than widened to the whole registry.
- Credential helpers (`credsStore`, `credHelpers`) are refused: they are external programs, and
  the agent runs nothing but its own code. Registries with short-lived tokens need a token
  refreshed outside Tryout, written as a static entry, then an agent restart. A `config.json` written by
  `docker login` on a desktop usually uses one; write the file by hand instead
  (`printf 'user:token' | base64 -w0`; without `-w0`, GNU `base64` wraps long values onto
  several lines, which breaks the JSON string).
- The agent sends an image's credentials only to that image's registry. Other images are pulled
  anonymously.
- The file is read at startup: restart the agent after changing it. A broken file stops the
  agent with an explicit error.
- **Use a read-only token** limited to the project images, on an account that owns nothing
  else of value. For `ghcr.io`, a token with the `read:packages` scope only. A session that
  escapes its sandbox could read it; the exposure is then a read-only token for images the node
  already runs (see [Security](security.md)).
- An image is pulled only when it is missing on the node: pin images by digest to roll out a new
  version.

## Command-line project (`kind: terminal`)

- The root filesystem is **read-only**. Only `/tmp` is writable, and `HOME=/tmp`.
- No capabilities and `no-new-privileges`: use a non-root user.
- **Tryout serves the terminal.** The agent mounts its web terminal, ttyd, read-only at
  `/opt/tryout` and runs the image's program in it: its `ENTRYPOINT` and `CMD`, or the project's
  `command`. The image needs no web server and declares no port; it keeps its own user, working
  directory and environment. A complete example lives in `examples/cli-hello`:

```dockerfile
FROM debian:trixie-slim
RUN useradd -u 1000 -m -s /bin/bash visitor
COPY hello.sh /usr/local/bin/hello
USER 1000:1000
CMD ["bash", "-c", "hello; exec bash -l"]
```

- An image with neither `ENTRYPOINT` nor `CMD`, and no `command`, is refused when the session
  starts. Anything the image has at `/opt/tryout` is hidden by the mount.
- The agent fixes ttyd's options: one visitor at a time, writable, the session's base path, the
  Tryout colours and font. A project cannot change them.
- With a `port` (or `ttyd: image` and a `port`), the image serves its own page instead: the
  terminal hardening stays, the common contract above applies. Terminal projects configured
  before the agent's ttyd all have a `port`, so they keep working unchanged.

## Graphical project (`kind: desktop`)

Start from a Selkies-based LinuxServer image (`lscr.io/linuxserver/baseimage-selkies` or
`lscr.io/linuxserver/webtop`) and install your application. The agent provides `SUBFOLDER`, which
the image's nginx applies, and the Selkies settings (see [Configuration](configuration.md)). The
port is `3000`. The session opens once `<base path>api/websockets` answers below 400, which
LinuxServer's nginx forwards to the Selkies backend.

- **Tested**: `lscr.io/linuxserver/webtop` boots with the reduced capability set, under runc and
  gVisor, on amd64 and arm64.
- **Resources**: plan at least 2 GB of memory and `--shm-size 1g`, which the agent applies. For
  CPU, see [Performance](performance.md).
