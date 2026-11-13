# 0015 — Mutual TLS between the control plane and the agent

**Status:** accepted, implemented. Milestone M1 (see [Roadmap](../roadmap.md)). Supersedes the
transport of [ADR 0004](0004-one-way-trust.md) (HTTP + token); the call direction is unchanged.

## Context

- The control plane called the agent over plain HTTP with a shared bearer token
  (`AGENT_TOKEN`). Both the token and the session ids it sends crossed the network in clear,
  and anything that could answer on the agent's address would receive them.
- M1's exit criterion is a control plane that reaches a **remote** node. The link then crosses
  networks the operator does not fully control.
- Nodes run hostile code. A compromised node must not gain anything towards the control plane
  or towards the other nodes ([ADR 0004](0004-one-way-trust.md)).
- Tryout must not depend on a particular PKI, tunnel or provider.

## Decision

- **Transport**: the agent's API is served over TLS 1.3 only, and every client must present a
  certificate. There is no plain-HTTP mode, in any profile, `dev` included. The bearer token is
  removed: the TLS handshake is the only authentication. The gateway's token, on its unix
  socket, is unrelated and stays.
- **Trust model**: one private CA per deployment. Leaf certificates carry a single extended key
  usage: `serverAuth` for agents, `clientAuth` for the control plane.
  - The agent accepts only a leaf certificate signed by its configured CA that states
    `clientAuth`, so a node's certificate cannot act as the control plane towards another node.
  - The control plane accepts only a server certificate signed by `agent_tls.ca` that states
    `serverAuth` and names the host of `agent_url` (or `server_name`). A node therefore cannot
    impersonate another node, nor can a stolen control plane certificate act as an agent.
  - The CA key stays on the operator's machine; it is never copied to a node or to the control
    plane.
- **Tooling**: `tryout-certs`, a third binary in the `tryout-node` image, creates the CA, the
  control plane's client certificate and each node's server certificate (ECDSA P-256; CA 10
  years, leaves 1 year by default). Any other PKI works: Tryout only reads PEM files.
- **Configuration**:
  - control plane: a top-level `agent_tls` block (`ca`, `cert`, `key`, paths relative to the
    configuration file); `agent_url` must be `https://`; an optional per-node `server_name`
    replaces the expected name when the URL host differs (tunnel, port forward);
  - agent: `AGENT_TLS_CERT`, `AGENT_TLS_KEY`, `AGENT_TLS_CLIENT_CA`, all required.
- **Checks at startup**: the control plane reads the three files and reports an unreadable
  file, a key that does not match the certificate, a certificate without `clientAuth`, a CA that
  is not a CA, or an expired certificate, with the other configuration errors. The agent refuses
  to start when a file is missing, invalid, expired or not yet valid. Both warn from 30 days
  before expiry: the control plane at startup, the agent at startup and daily.
- **Rotation**: files are read at startup; rotating means replacing them and restarting. Hot
  reload belongs to milestone M4, with configuration reload.
- **Client**: the control plane uses `undici` (its `fetch` and an `Agent` per node) to present
  a client certificate. The readiness probe through the public gateway is unchanged.

## Consequences

- Session ids and agent responses are encrypted between the control plane and the node, and
  the control plane only talks to the node it meant to reach.
- The path between the control plane and the agent must carry TLS end to end: a private
  network, a VPN, an SSH forward or a TCP-level tunnel. An HTTP reverse proxy that terminates
  TLS in between breaks client authentication.
- A compromised node holds only its own server certificate, which no other component accepts as
  a client.
- There is no revocation list. Revoking a certificate means issuing a new CA and new leaves, or,
  for a node, removing it from the configuration. A short validity can be chosen with
  `tryout-certs --days`.
- The dev compose file creates the PKI in a volume with two one-shot services, so the
  end-to-end tests run over the same mutual TLS as production, and `scripts/e2e-mtls.ts`
  checks the refusals.
- The configuration format changes (`agent_tls`, `server_name`, no `agent_token`) without a
  compatibility layer: no release had shipped. The schema keeps its `v1` path for the same
  reason.
- The control plane gains the `undici` dependency.
