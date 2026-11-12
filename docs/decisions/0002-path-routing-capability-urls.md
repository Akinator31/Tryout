# 0002 — Path routing with capability URLs

**Status:** accepted

## Context

- Free certificates (e.g. Cloudflare Universal SSL) cover one subdomain level only, so
  `<id>.sbx.example.org` needs a paid or self-managed wildcard.
- Sessions are embedded in a cross-site iframe, where third-party cookies are blocked or
  partitioned ([CHIPS](https://developers.google.com/privacy-sandbox/cookies/chips)).
- Per-session Traefik labels add a provider refresh delay
  ([Traefik Docker provider](https://doc.traefik.io/traefik/providers/docker/)) and tie the
  project to one reverse proxy.

## Decision

- Sessions are served under `https://<node-host>/s/<id>/`, where `<id>` is 26 base32 characters
  (130 random bits).
- The id **is** the credential: it is checked on every request, and no cookies are used.
- `Referrer-Policy: no-referrer` prevents leaking it.
- Each node declares a `public_url` template, so subdomain routing can be added later without
  changing the model.
- The POC validated that ttyd (`-b`) and Selkies (`SUBFOLDER`) both work behind a base path,
  WebSocket included.

## Consequences

- One hostname and one certificate per node. Works behind any tunnel or proxy.
- All sessions of a node share a browser origin. The gateway therefore strips `Set-Cookie`,
  incoming cookies and `Service-Worker-Allowed`, so that a session cannot reach beyond its path.
- A visitor can share their session URL; it only grants that session, for its lifetime.
