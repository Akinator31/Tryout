# Performance

Measurements taken during the proof of concept (November 2026). They are orders of magnitude:
small samples, with a manual load (a window dragged continuously).

## Startup

| Session | Machine | Runtime | Ready after |
|---|---|---|---|
| Terminal (ttyd) | x86_64, Docker Desktop | runc | ~0.5 s |
| Desktop (webtop, Selkies 2.2.1) | x86_64, Docker Desktop | runc | ~2 s (nginx), ~230 MB idle |
| Desktop (webtop) | Raspberry Pi 5, 16 GB, 4K-page kernel | runsc | ~4 s (nginx), ~390 MB idle |

## Desktop session CPU on a Raspberry Pi 5

Settings: 1280×720, 15–30 fps, software x264 encoding (no hardware encoder). 100% is one core,
and the Pi has 4.

| Runtime | Idle | Window dragged (average) | Peak | Feel |
|---|---|---|---|---|
| runc | ~0.5% | **~65%** | 106% | smooth |
| runsc (gVisor) | ~2% | **~130–155%** | 240% | slightly less smooth |

**gVisor costs 2 to 2.5× more CPU for a desktop session.** Capture goes through X shared memory
(XShm) and the encoder makes many system calls, which gVisor intercepts. For terminals, the
difference is negligible.

**Without a resolution cap**, Selkies adapts to the client screen. On a HiDPI laptop it encoded
3748×2044 at 60 fps, and a single session saturated the Pi. Hence the locked defaults in the
agent (see [Configuration](configuration.md)).

## Sizing a node

Size for peak load and keep at least one core for the host.

| 4-core node, ~3 cores available | Concurrent active desktop sessions |
|---|---|
| gVisor | ~2 |
| runc, or runc inside a KVM VM | ~3–4 |

A KVM VM (`strict` profile) gives the isolation of a separate kernel at a low CPU cost for video
encoding, but needs memory set aside for it.

## Measuring a node

```bash
DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock RUNTIME=runsc ./scripts/feasibility-node.sh
```

The script checks:
- page size, cgroup v2 and rootless mode;
- that the runtime is present;
- a hardened container and egress blocking;
- that Selkies boots behind a base path.
