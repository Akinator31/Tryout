# 0010 — Prebuilt pinned images, a fresh container per session

**Status:** accepted

## Context

- Building images on the sandbox node exposes it to builder vulnerabilities, such as the BuildKit
  flaws disclosed with [Leaky Vessels](https://wiz.io/blog/leaky-vessels-container-escape-vulnerabilities)
  and the November 2025 runc issues
  ([oss-security](https://openwall.com/lists/oss-security/2025/11/05/3)).
- A clean environment per visitor is a functional requirement.

## Decision

- Images are built elsewhere and referenced by digest.
- Each session gets a fresh container and network, removed at the end; nothing is reused.
- A warm pool will be considered only if cold start exceeds about 10 s. The POC measured about
  0.5 s for terminals and about 4 s for a desktop on a Raspberry Pi 5.

## Consequences

- No state leaks between visitors.
- The first session of a new image pays the pull time.
