# 0017 — Registry credentials for private project images

**Status:** accepted, implemented. Milestone M2 (see [Roadmap](../roadmap.md)).

## Context

- The agent pulls a project image the first time a session needs it. It called the Engine API
  without credentials, so a private image failed to pull, even after `docker login` on the node:
  the login is stored by the Docker CLI on the client side, and the Engine API only uses the
  credentials sent with each pull request.
- The only workaround was to pull every private image on the node beforehand, then pull it
  again for each new version.
- Operators keep project images private for good reasons: unreleased work, images that are not
  meant to be distributed, or a registry account they do not want to open.
- Nodes run hostile code. Any credential stored on a node must be assumed exposed if a session
  escapes.

## Decision

- **Source**: the agent reads one optional file, named by `REGISTRY_AUTH_FILE`, in the Docker
  CLI's `config.json` format, so an operator can reuse a file written by `docker login` or write
  it by hand. The file is read at startup; changing it means restarting the agent, as for
  certificates ([ADR 0015](0015-mutual-tls-control-plane-agent.md)).
- **Supported entries**: only static `auths` entries: `auth` (base64 `user:password`), or
  `username` and `password`, or `identitytoken`. A file that names a credential helper
  (`credsStore`, `credHelpers`) is refused: those are external programs, and the agent runs
  nothing but its own code.
- **Matching**: for each pull, the agent derives the image's registry with Docker's rules (the
  first path component is a registry when it contains a dot or a colon, or is `localhost`;
  otherwise Docker Hub) and sends that registry's credentials, and only them, in
  `X-Registry-Auth`. An image on a registry without an entry is pulled anonymously.
- **Checks at startup**: an unreadable file, invalid JSON, a credential helper, an entry with no
  usable credential, invalid base64, or two entries for the same registry (`docker.io` and
  `https://index.docker.io/v1/`) stop the agent with every error at once. The agent logs the
  registries it has credentials for, never the credentials; error messages never contain them.
- **Scope**: credentials stay on the node. They are never part of the configuration of the
  control plane nor of `POST /v1/sessions`, so the control plane holds no registry secret and a
  session request cannot choose credentials.

## Consequences

- Private project images work without pre-pulling. The documentation asks for a read-only token
  limited to the project images (for `ghcr.io`, a token with `read:packages` only), on an
  account that owns nothing else of value.
- A session that escapes its sandbox could read the file, like anything else on the node. The
  exposure is a read-only token for images that the node already runs; the node profiles and
  gVisor stay the protection against the escape itself.
- Registries that need a credential helper (cloud registries with short-lived tokens) need a
  token refreshed outside Tryout and written as a static entry, then an agent restart.
- An image is still pulled only when it is missing on the node. Pinning project images by
  digest remains the recommended way to roll out a new version.

## Alternatives considered

- **Document pre-pulling only**: no code, but every new version needs a manual step on every
  node, and a pinned digest that is not pulled yet fails the session.
- **Credentials in the control plane's configuration, sent with each session request**: one
  place to manage them, but the control plane would hold registry secrets for every node, and
  they would cross the network for each session.
- **Running credential helpers**: the agent would execute external programs with access to its
  Docker socket.
