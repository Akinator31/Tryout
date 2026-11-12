# 0009 — Minimal Docker Engine API client

**Status:** accepted

## Context

The agent needs about a dozen Engine API endpoints. The Go SDK is moving to new modules
(`github.com/moby/moby/client` v0.x) whose API is not yet stable, while the Engine REST API is
versioned and stable ([Engine API](https://docs.docker.com/reference/api/engine/sdk/)).

## Decision

Use a small hand-written client (`apps/node/internal/dockerapi`) pinned to API `v1.47`, over
`unix://` or `tcp://`. TLS and SSH transports will be added when needed.

## Consequences

- Zero third-party dependencies in the node.
- New Docker features must be added by hand to the client.
