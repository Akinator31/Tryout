# Public exposure

Tryout manages **no DNS, no certificates and no tunnels**. It exposes two HTTP services, which
you publish with the tool of your choice: Cloudflare Tunnel, Traefik or Dokploy, Caddy, or a
plain port forward.

| Service | Expose? | Note |
|---|---|---|
| control plane (`:3000`) | yes | serves the embed page and the queue API |
| gateway of each node (`:8080`) | yes | serves sessions |
| agent (`:7000`) | **no** | private network only, reachable by the control plane |

## Path routing (default)

A session is served under `https://<node-host>/s/<id>/`. You need **one hostname and one
certificate per node**. A single subdomain level is enough, which most providers' free
certificates cover.

```json
"public_url": "https://sbx-gui.example.dev/s/{session}/"
```

Subdomain-per-session routing (`https://{session}.sbx.example.org/`) would give each session its
own origin, but it needs wildcard DNS and TLS. **The gateway currently routes by path only.**
Subdomain routing is on the [Roadmap](roadmap.md).

## Use a dedicated domain for sessions

A visitor fully controls what their session serves, and can serve their own HTML page from the
session URL. Host sessions on a **domain used for nothing but Tryout**, to prevent phishing in
your name and cookies being set on your main domain.

## Example: Cloudflare Tunnel

- Run one `cloudflared` per node, **on the host**, never inside a session. It only makes outbound
  connections, so no port needs to be opened.
- Map one public hostname per node to `http://localhost:8080` (the gateway).
- WebSockets work out of the box.
- Check your plan's terms regarding continuous video streaming (desktop sessions).

## Iframes

- `embed_frame_ancestors` (control plane): the origins of your portfolios.
- `FRAME_ANCESTORS` (gateway): the control plane's origin, since the session iframe is nested
  inside the embed page.
- Set the `allow` attribute on the portfolio's iframe: `clipboard-read; clipboard-write;
  autoplay; fullscreen; keyboard-map`.
