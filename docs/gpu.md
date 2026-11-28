# GPU desktop sessions

A node with an NVIDIA GPU can give it to desktop sessions. The GPU goes through gVisor's
**nvproxy**, so GPU sessions keep the `strict` isolation model: the visitor's code still talks to
gVisor's kernel, never to the host's, and only the NVIDIA driver calls nvproxy allows reach the
host driver.

What a GPU session gets:

- **Hardware video encoding**: Selkies encodes the stream with NVENC on its own. The agent sets
  no variable for it: the CDI devices bring the NVIDIA libraries.
- **OpenGL rendering on the GPU**, for applications started through VirtualGL
  (`vglrun -d egl`), which renders off screen on the GPU and copies each frame to the desktop.
  Applications started without it render on the CPU (llvmpipe).

What it does not get:

- **Vulkan**: under nvproxy, Vulkan applications crash (`vulkaninfo` segfaults). Zink, which runs
  OpenGL over Vulkan, does not help either.
- **Zero-copy capture**: the desktop is captured from memory, as without a GPU.
- **runc**: the agent gives a GPU only under `runsc`, whatever `ALLOW_RUNC` says. Under runc the
  visitor would reach the whole NVIDIA kernel driver.

Tested with an RTX A2000 (6 GB), driver 620.70.06, gVisor `release-20261123.1`,
NVIDIA Container Toolkit 1.20.2 and Docker 29, on Debian 13.

## Security

Read [GPU sessions in the security policy](security.md#gpu-sessions) before you enable it. In
short: sessions share the GPU with no memory or fault isolation between them, and the NVIDIA
driver calls that nvproxy lets through still reach the host driver, which regularly has
privilege escalation flaws. Keep the driver up to date, within the versions gVisor supports.

## Set up the node

The node is a dedicated machine or VM (`strict`), with the GPU passed through to it if it is a
VM.

1. **Install an NVIDIA driver that gVisor supports.** nvproxy refuses any driver it does not
   know, and distribution packages often lag behind. List the supported versions with the
   `runsc` installed on the node:

    ```bash
    runsc nvproxy list-supported-drivers
    ```

    Install one of them from NVIDIA's repository and **pin it**: NVIDIA's repository ships newer
    versions before gVisor supports them, and an upgrade would stop every GPU session.

2. **Install the NVIDIA Container Toolkit** and generate the CDI specification, which tells
   Docker which device files and libraries make up the GPU:

    ```bash
    sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
    nvidia-ctk cdi list    # nvidia.com/gpu=0, nvidia.com/gpu=all...
    ```

    Generate it again after each driver upgrade. If Docker answers that CDI is disabled, add
    `"features": {"cdi": true}` to `/etc/docker/daemon.json`.

3. **Turn nvproxy on for the `runsc` runtime**, in `/etc/docker/daemon.json`, then restart
   Docker:

    ```json
    {
      "runtimes": {
        "runsc": {
          "path": "/usr/bin/runsc",
          "runtimeArgs": [
            "--nvproxy",
            "--nvproxy-allowed-driver-capabilities=compute,utility,graphics,video"
          ]
        }
      }
    }
    ```

    `graphics` lets applications render, `video` lets Selkies encode. nvproxy only acts on
    containers given a GPU device: other sessions see no NVIDIA device at all.

4. **Give the GPU to the agent**, in the node's `.env` (see
   [Configuration](configuration.md#agent)):

    ```bash
    GPU_DEVICES=nvidia.com/gpu=all
    GPU_SESSIONS=4
    ```

    The agent refuses to start when `GPU_DEVICES` is set and the `runsc` runtime lacks
    `--nvproxy`, or when `GPU_SESSIONS` is missing. It warns when nvproxy does not allow the
    `graphics` and `video` capabilities.

5. **Check** that the agent's `/healthz` reports the GPU:
   `"gpu": {"devices": ["nvidia.com/gpu=all"], "sessions": 4, "in_use": 0}`.

### How many sessions

`GPU_SESSIONS` caps the GPU sessions on the node, on top of `MAX_SESSIONS`. Measured on the
A2000 at 720p and 30 fps, each session takes about 350 MB of GPU memory before its application
renders anything, and four streaming sessions use about 13 % of its single encoder. GPU memory is the first limit: nothing caps a
session's share, so leave room for the heaviest application you run.

A GPU session takes a project slot, a node slot and a GPU slot. The control plane reads
`GPU_SESSIONS` from the agent's `/healthz` and counts the GPU sessions it starts, at least as
many as the agent reports in use, so a visitor beyond it waits in the queue like any other;
sessions without a GPU on the same node go ahead. A freed GPU slot may wait for the next health
check, up to 10 s.
On a node without `GPU_DEVICES`, or before its first health check, a GPU project's visitors wait
until the node reports a GPU. The settings review warns about both cases: a GPU project on a
node without a GPU, and GPU projects allowing more sessions than the node's `GPU_SESSIONS`. The
admin's Nodes page shows each node's GPU sessions in use.

The agent keeps its own count and refuses a GPU session beyond `GPU_SESSIONS` (`409`) or on a
node without `GPU_DEVICES` (`400`), for instance when several control planes share a node.

## Package a GPU project

Start from a [graphical project](packaging.md#a-graphical-project), with two changes:

- **A glibc image** (Debian, Ubuntu, Fedora, Arch): the NVIDIA libraries the toolkit injects do
  not load on Alpine, and the session falls back to the CPU without an error.
- **VirtualGL**, and the application started through it:

```dockerfile
FROM lscr.io/linuxserver/baseimage-selkies:ubuntunoble

ARG VIRTUALGL=3.1.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates libegl1 libglu1-mesa libxv1 libxtst6 \
 && curl -fsSL -o /tmp/virtualgl.deb \
      "https://github.com/VirtualGL/virtualgl/releases/download/${VIRTUALGL}/virtualgl_${VIRTUALGL}_amd64.deb" \
 && apt-get install -y /tmp/virtualgl.deb \
 && rm -rf /tmp/virtualgl.deb /var/lib/apt/lists/*

# Your application, then what the desktop starts.
COPY tryout/autostart /defaults/autostart
COPY tryout/menu.xml /defaults/menu.xml
```

`tryout/autostart`, and the command of the menu entry, start the application through VirtualGL:

```
/opt/VirtualGL/bin/vglrun -d egl my-game
```

`-d egl` matters: VirtualGL then renders on the first EGL device, the GPU. Check the image with
`--gpu`, which warns about a musl image and a missing `vglrun` before the usual checks (the
session itself runs without a GPU):

```bash
scripts/check-image.sh --kind desktop --gpu my-game:dev
```

Then declare the project with `gpu: true` (see [Configuration](configuration.md#projects)), or
turn on **Use the node's GPU** in the admin's project form:

```yaml
projects:
  my-game:
    node: gpu
    image: ghcr.io/<owner>/my-game@sha256:…
    kind: desktop
    port: 3000
    gpu: true
    max_sessions: 4
    max_age: 15m
```

## Test a GPU node

`scripts/e2e/gpu.ts` checks a GPU node end to end, by hand: CI has no GPU. Run it on the node,
whose `docker` reaches the agent's daemon, against a control plane with a GPU project whose
`max_sessions` is above `GPU_SESSIONS`:

```bash
node scripts/e2e/gpu.ts https://tryout.example.org my-game 4
```

It starts `GPU_SESSIONS` sessions, checks that `nvidia-smi` lists the GPU in each, that one
more visitor waits in the queue, and that releasing a session gives them its slot. Its tickets
come from one address, so `GPU_SESSIONS` + 1 must stay within `live_tickets_per_ip`.

## Measured gain

glxspheres in a session limited to 1.5 CPU, at 720p:

| Scene | CPU (llvmpipe) | GPU (VirtualGL) |
|---|---|---|
| Default | 54 fps | about 470 fps |
| Heavy (500,000 polygons, 100 spheres) | 11 fps | 347 fps |

Without a frame limit, the application still keeps the session's CPU busy: VirtualGL reads every
frame back from the GPU, and each driver call goes through gVisor. An application that limits
itself to the stream's frame rate leaves most of that CPU free.
