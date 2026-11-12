# 0006 — Selkies in WebSocket mode with locked settings

**Status:** accepted

## Context

- Selkies supports WebRTC and WebSocket transports. WebRTC uses UDP, which bypasses HTTP
  proxies and tunnels and needs TURN
  ([Selkies WebRTC guide](https://docs.linuxserver.io/selkies/user-guide/webrtc/)).
- LinuxServer's [baseimage-selkies](https://docs.linuxserver.io/images/docker-baseimage-selkies/)
  is built for x86_64 and aarch64.
- During the POC, Selkies sized the stream to the client: 3748×2044 at 60 fps from a HiDPI
  laptop, which saturated a Raspberry Pi 5 with one visitor.
- Selkies 2.2.1 accepts server-side overrides with a `|locked` suffix that the client cannot
  change.

## Decision

- Use WebSocket mode only: one HTTP path through the gateway.
- The agent sets defaults a project may override: 1280×720, 96 DPI, CSS scaling, 15–30 fps,
  audio off.
- It locks, with no override possible: file transfer (`none`), microphone, webcam, printing,
  gamepads, second screen.

## Consequences

- Predictable CPU per session and a smaller attack surface for a public sandbox.
- Projects that need audio or a higher resolution opt in explicitly through their `env`.
