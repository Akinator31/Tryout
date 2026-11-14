# Public exposure

Tryout manages **no DNS, no certificates and no tunnels**. It exposes two HTTP services, which
you publish with the tool of your choice: Cloudflare Tunnel, Traefik or Dokploy, Caddy, or a
plain port forward.

| Service | Expose? | Note |
|---|---|---|
| control plane (`:3000`) | yes | serves the embed page and the queue API |
| gateway of each node (`:8080`) | yes | serves sessions |
| agent (`:7000`) | **no** | private network, VPN or tunnel to the control plane, carrying TLS end to end: the agent requires a client certificate ([Certificates](certificates.md)) |

## Event stream

The embed page receives queue updates over server-sent events
(`/api/tickets/<ticket>/events`), a long-lived HTTP response.

- **Serve the control plane over HTTP/2** at your proxy. Browsers allow only six HTTP/1.1
  connections per origin, so a page with several embeds of the same control plane would stall.
- **Do not buffer** these responses. The control plane sends `X-Accel-Buffering: no`, which
  nginx honours. Other proxies may need their own setting.
- The server sends a message every 10 s, which keeps the stream alive under the idle timeouts
  of common proxies and tunnels (often about 100 s).

## Client address

The control plane limits tickets and event streams per visitor IP address
([Configuration](configuration.md#per-ip-limits)). Behind a proxy or a tunnel, the connection
comes from the proxy, so tell the control plane which proxies to believe:

- list their addresses in `client_ip.trusted_proxies`. Only a listed peer's `X-Forwarded-For`
  is read, from the right, skipping the other listed proxies;
- if your proxy puts the client's address in a header of its own, name it in `client_ip.header`
  (`CF-Connecting-IP` for Cloudflare, `X-Real-IP` for many nginx setups);
- make sure the control plane is reachable **only** through those proxies. Otherwise a client
  that connects from an address inside a trusted block could set the header itself.

Rate limiting raw requests at the proxy remains a useful complement, against floods that never
reach a limit counted by tickets.

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
- For the control plane, set `client_ip.header: CF-Connecting-IP` and list the address
  `cloudflared` connects from (often `127.0.0.1` or its container network) in
  `client_ip.trusted_proxies`.
- WebSockets work out of the box.
- Check your plan's terms regarding continuous video streaming (desktop sessions).

## Iframes

- `embed_frame_ancestors` (control plane): the origins of your portfolios.
- `FRAME_ANCESTORS` (gateway): the control plane's origin **and** the origins of your portfolios,
  space-separated. Browsers check `frame-ancestors` against every ancestor of a frame, and the
  session iframe is nested inside the embed page, itself inside the portfolio.
- Set the `allow` attribute on the portfolio's iframe: `clipboard-read; clipboard-write;
  autoplay; fullscreen; keyboard-map`.
