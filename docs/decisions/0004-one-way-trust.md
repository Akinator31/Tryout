# 0004 — The control plane calls nodes, never the reverse

**Status:** accepted. The transport (HTTP + token) is superseded by
[ADR 0015](0015-mutual-tls-control-plane-agent.md): mutual TLS.

## Context

Sandbox nodes run hostile code. If a node held credentials to the control plane or to the
operator's infrastructure, an escape would give access to them. Dokploy's remote-server model
follows the same direction: the main instance connects to remote servers
([Dokploy remote servers](https://docs.dokploy.com/docs/core/remote-servers)).

## Decision

- The control plane calls the agent API (HTTP + token for now, mTLS later).
- Nodes never initiate connections to the control plane or the operator's network, and the
  firewall should enforce it.
- The control plane checks session readiness through the gateway.

## Consequences

- A compromised node cannot attack the control plane through a credential it holds.
- The agent API must be reachable from the control plane over a private network or a tunnel.
