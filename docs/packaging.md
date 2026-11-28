# Packaging a project

This guide turns a program into an image that Tryout can serve, step by step: a command-line
tool in Tryout's web terminal, then a graphical application behind a streamed desktop. It ends with
publishing the image and declaring the project. [Project images](project-images.md) is the
reference for the contract every image follows; this page shows how to meet it.

## Before you start

Check that your program fits a session:

- **It works offline.** Sessions have no network at all: install every dependency when the image
  is built, and do not call external APIs at runtime.
- **It writes only to `/tmp`.** A terminal session has a read-only root filesystem; `HOME` is
  `/tmp` and holds 64 MB. A desktop session can write to its own filesystem, which is discarded
  at the end.
- **It runs without privileges.** Sessions have no capabilities and `no-new-privileges`: a
  terminal image runs as a non-root user, and a desktop image's init keeps only the few
  capabilities it needs to start the desktop as one.
- **It fits the limits.** By default, a terminal session gets 256 MB of memory and half a CPU, a
  desktop 2 GB and 1.5 CPUs. A project may change them (see
  [Configuration](configuration.md#projects)).
- **It exists for your nodes' architecture**, amd64 or arm64, or both.

Each visitor gets a fresh container from the image, destroyed when the session ends: nothing
persists between visitors.

## A command-line project

The example packages `wordfreq`, a small Python tool that prints the ten most frequent words of a
text. The same steps apply to a program in any language. Tryout serves the terminal itself: the
agent mounts its own web terminal, [ttyd](https://github.com/tsl0922/ttyd), read-only into the
session and runs your image's program in it. The image holds the program and nothing else.

```
wordfreq/
├── pyproject.toml
├── wordfreq/__init__.py
├── Dockerfile
└── tryout/
    └── welcome.sh
```

### The Dockerfile

```dockerfile
FROM python:3.13-slim

# The visitor is a non-root user.
RUN useradd -u 1000 -m -s /bin/bash visitor

# Everything the tool needs is installed now: sessions have no network.
COPY . /opt/wordfreq
RUN pip install --no-cache-dir /opt/wordfreq

# A login shell runs the scripts of /etc/profile.d: the visitor is greeted.
COPY tryout/welcome.sh /etc/profile.d/welcome.sh

# The root filesystem is read-only in a session: no bytecode cache to write.
ENV PYTHONDONTWRITEBYTECODE=1
USER 1000:1000

# What the visitor gets: a shell, which survives the tool exiting.
CMD ["bash", "-l"]
```

- **The program** is the image's `ENTRYPOINT` and `CMD`, as `docker run` would start it. Here
  it is a login shell. To run the tool alone, make it the command, such as
  `CMD ["wordfreq", "--interactive"]`, or set the project's `command` instead (see
  [Configuration](configuration.md#projects)). When the program exits, the page offers to
  reconnect, which starts it again.
- **No web server, no port.** ttyd listens on a port the agent picks and serves the session's base
  path; it comes with the node, in the version the node release pins.
- **The user** is not root: sessions have no capabilities, so root would gain nothing, and a
  program that expects root's privileges fails.
- **Dependencies** are installed during the build. Anything fetched at runtime fails.
- **Read-only filesystem**: look for what your program writes outside `/tmp` (caches, logs,
  configuration files) and point it to `/tmp`, or turn it off as `PYTHONDONTWRITEBYTECODE` does
  here.
- **`/opt/tryout`** is where the agent mounts ttyd: anything the image has there is hidden.

`tryout/welcome.sh` greets the visitor:

```sh
cat <<'MSG'
wordfreq: the ten most frequent words of a text.
Try:  wordfreq /etc/os-release
      ls -R /usr/share/doc | wordfreq
MSG
```

An image that already serves its own terminal page, such as one with its own ttyd, or any web
application with the terminal's hardening, declares its `port` instead (and `ttyd: image`, to say
so explicitly): it then serves `/s/<id>/` itself, like a desktop image (see
[Project images](project-images.md)).

### Check the image

Build the image, then check it against the contract:

```bash
docker build -t wordfreq:dev .
scripts/check-image.sh wordfreq:dev
```

```
ok   architecture amd64
ok   runs in the agent's ttyd: bash -l
ok   started with the session constraints (terminal, port 7681)
ok   answers 200 on /s/check9db9ff0827241bd2/ after 0 s
OK   wordfreq:dev meets the contract for a terminal session
```

`scripts/check-image.sh`, from the Tryout repository, runs the image the way the agent runs a
session: internal network, no capabilities, read-only root filesystem, the kind's limits and
variables, and the program in ttyd (the published `tryout-ttyd` image, or `--ttyd-image`). It then
probes the base path the way the control plane does (the Selkies backend for a desktop), and prints the container's logs when the
image does not answer. Its options mirror the project's configuration:

- `--kind terminal|desktop`;
- a command after `--`, as the project's `command`: `scripts/check-image.sh wordfreq:dev -- wordfreq --interactive`;
- `--port N` (or `--own-server` on 7681) and `--strip-prefix` for an image that serves its own
  page;
- `--env KEY=VALUE`, repeatable, for the project's variables;
- `--runtime runsc` to try the image under gVisor, like a production node.

The check only proves that the page answers. Open a shell in similar conditions to try the tool
itself:

```bash
docker run --rm -it --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges --network none -e HOME=/tmp wordfreq:dev
```

## A graphical project

The example packages Mousepad, a text editor, as a desktop streamed with Selkies. The base image
is a LinuxServer Selkies image: it brings the desktop (X server, openbox), the stream and the nginx
that serves it under the session's base path. You add the application and say what to start.

```
mousepad-desktop/
├── Dockerfile
└── tryout/
    ├── autostart
    └── menu.xml
```

### The Dockerfile

```dockerfile
FROM lscr.io/linuxserver/baseimage-selkies:debianbookworm

# The application, with everything it needs: sessions have no network.
RUN apt-get update \
 && apt-get install -y --no-install-recommends mousepad \
 && rm -rf /var/lib/apt/lists/*

# What the desktop starts, and what its right-click menu offers.
COPY tryout/autostart /defaults/autostart
COPY tryout/menu.xml /defaults/menu.xml
```

- **The base image** exists for amd64 and arm64, on Alpine, Debian, Ubuntu, Fedora and Arch
  (`alpine322`, `debianbookworm`, `ubuntunoble`, `fedora42`, `arch`…). Pick the distribution
  that packages your application, and pin a versioned tag or a digest for reproducible builds.
- **Do not change the user or the entrypoint**: the image starts as root under its s6 init, then
  runs the desktop as an unprivileged user. The agent grants only the capabilities this init
  needs, sets `SUBFOLDER` to the base path and locks the features a public sandbox must not
  expose (file transfer, microphone, webcam, printing, gamepads, second screen). You configure
  nothing for Tryout.
- **The port** is `3000`, the image's nginx.

`tryout/autostart` holds the command the desktop runs at startup:

```
mousepad
```

`tryout/menu.xml` is the menu of a right click on the desktop, so that a visitor who closes the
application can start it again:

```xml
<?xml version="1.0" encoding="utf-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
<menu id="root-menu" label="MENU">
<item label="Mousepad"><action name="Execute"><command>/usr/bin/mousepad</command></action></item>
</menu>
</openbox_menu>
```

### Check the image

```bash
docker build -t mousepad-desktop:dev .
scripts/check-image.sh --kind desktop mousepad-desktop:dev
```

```
ok   architecture amd64
ok   started with the session constraints (desktop, port 3000)
ok   answers 204 on /s/check84055b320749516a/api/websockets after 5 s
OK   mousepad-desktop:dev meets the contract for a desktop session
```

That run used runc; under gVisor (`--runtime runsc`), the stream backend can take about a minute
to answer. The check proves that the backend answers under the base path, as the control plane
waits for before it opens the session, not that your application started. To see it, run the project on the dev stack ([Quickstart](quickstart.md)): copy the
`webtop` entry of `deploy/tryout.dev.yaml` and change its image.

- **Resources**: the stream costs far more than the application. The agent caps it at 720p and
  15–30 fps by default; under gVisor, a desktop uses 2 to 2.5 times the CPU of runc (see
  [Performance](performance.md)). Keep `max_sessions` low on small nodes.
- **Settings**: a project may override the stream's defaults through `env`, such as a higher
  resolution (see [Desktop session defaults](configuration.md#desktop-session-defaults)).
- **GPU**: on a node with an NVIDIA GPU, a desktop can render with OpenGL and encode on it
  through VirtualGL: see [Package a GPU project](gpu.md#package-a-gpu-project).
- **Games and animations**: at 15–30 fps, an application that draws 60 frames per second looks
  choppy in the stream even when the node keeps up. Set `SELKIES_FRAMERATE: "60"` in the
  project's `env`, and raise `limits.cpus` above the desktop default of 1.5 so that the
  application and the encoder are not throttled.

## Publish the image

A node pulls the image from a registry the first time a session needs it. Build it for every
architecture your nodes use, and push it:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<owner>/wordfreq:1.0.0 --push .
```

- **Pin a digest** in the configuration (`image: ghcr.io/<owner>/wordfreq@sha256:…`). A node
  pulls an image only when it is missing, so a tag that moves keeps serving the old version
  on nodes that already have it. `docker buildx imagetools inspect ghcr.io/<owner>/wordfreq:1.0.0`
  prints the digest.
- **Private images** need registry credentials on the node: see
  [Private images](project-images.md#private-images).
- A first session on a node waits for the pull. Pull large images beforehand, on the daemon the
  agent uses (its `DOCKER_HOST`), so that the first visitor does not wait.

## Declare the project

Add the project to the control plane's `tryout.yaml`:

```yaml
projects:
  wordfreq:
    node: cli
    image: ghcr.io/<owner>/wordfreq@sha256:…
    kind: terminal
    max_sessions: 2
    max_age: 10m
```

The name (`wordfreq`) is the one portfolios embed, as `https://<control-plane>/embed/wordfreq`.
Restart the control plane to load it. [Configuration](configuration.md#projects) lists every
field: `command` to run another program than the image's, `limits` to give the project more
memory or CPU, `env` for its own variables, `runtime` per project.

To try it end to end before production, add the project to `deploy/tryout.dev.yaml` and follow
the [Quickstart](quickstart.md).

## When the check fails

| Symptom | Likely cause |
|---|---|
| `the image has no entrypoint or command` | The image starts nothing: add a `CMD`, or set the project's `command`. |
| The page shows, the terminal closes at once | The program exits or fails: run it with the `docker run` above. It may write outside `/tmp`, or need root. |
| `404` on `/s/<id>/` | An image that serves its own page serves it at `/`. Pass the base path to it, or declare `strip_prefix: true` and check with `--strip-prefix`. |
| The container exits at once | It writes outside `/tmp` (read the logs for `Read-only file system`), needs root, or needs a capability. |
| No answer until the timeout | For an image that serves its own page: wrong `port`, the application listens on `127.0.0.1` instead of every interface, or it waits for the network. |
| `image is arm64 but this machine is amd64` | Build for both architectures with `docker buildx`. |
| Works locally, fails on a node | The node pulled another version (pin a digest), or the image is private and the node has no credentials. |
