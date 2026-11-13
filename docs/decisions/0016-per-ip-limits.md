# 0016 — Per-IP limits on tickets and event streams

**Status:** accepted, implemented. Milestone M1 (see [Roadmap](../roadmap.md)). Completes the
open point of [ADR 0012](0012-ticket-push-sse.md) on streams per IP.

## Context

- Anyone can create tickets. A waiting ticket stays in line as long as something keeps it
  alive: an open event stream, or a poll every 30 s. One client could hold hundreds of
  tickets and push real visitors back in the FIFO queue indefinitely.
- Creating and releasing tickets in a loop costs database writes and session starts.
- Each open event stream holds a connection and a watcher on its instance. A peer that vanishes
  without closing its connection keeps its stream for minutes (ADR 0012).
- A reverse proxy can limit request rates, but it cannot see how many tickets a client holds.
  Tryout must not depend on a particular proxy, tunnel or provider.
- Several control plane instances may share one database (ADR 0011).

## Decision

- **Where**: in the control plane. Limiting raw request rates at the reverse proxy remains a
  useful complement, documented in [Public exposure](../exposure.md).
- **Client key**: the visitor's IP address. IPv6 addresses are grouped by /64, since one client
  usually holds a whole /64; IPv4-mapped IPv6 addresses count as IPv4.
- **Finding the address**: the socket's peer address by default; forwarding headers are then
  ignored. `client_ip.trusted_proxies` lists the CIDR blocks of the operator's proxies. When the
  peer is one of them, `X-Forwarded-For` is read from the right, each trusted hop vouching for
  the address on its left: the first address that is not a trusted proxy is the client. The
  leftmost entries, written by the client itself, are never used. `client_ip.header` names a
  single-address header instead (`CF-Connecting-IP`, `X-Real-IP`), believed only from a trusted
  proxy. No provider is named in the code or the defaults. When a trusted proxy sends no usable
  address, the last address a trusted hop vouched for is used (never one the client wrote), and
  a warning is logged once.
- **Limits**, global to every project, on by default, `0` disabling one:

  | Key | Default | Counted |
  |---|---|---|
  | `live_tickets_per_ip` | 4 | Tickets not ended (waiting, starting, active), in Postgres |
  | `new_tickets_per_ip` | 10 per `1m` | Tickets created within a sliding window, released ones included, in Postgres |
  | `streams_per_ip` | 8 | Open event streams, in the memory of each instance |

- **Storage**: tickets gain a `client_key` column and an index on `(client_key, created_at)`.
  `Queue.join(project, client)` checks both ticket limits in the transaction that inserts the
  ticket, under a transaction-scoped advisory lock keyed by the client, so concurrent joins
  from any instance cannot overshoot. The sliding window counts rows still in the table, so it
  is capped at 5 minutes, the time ended tickets are kept.
- **Streams**: a connection belongs to one process, so each instance counts its own. With `N`
  instances, a client may open up to `N ×` the limit.
- **Responses**: `429` with `{"error": …, "limit": "live_tickets" | "new_tickets" | "streams"}`.
  A refused ticket carries `Retry-After`: the exact time until the window frees a slot, or 30 s
  (the heartbeat timeout) for live tickets.
- **Embed page**: a refused ticket shows a short message and retries after `Retry-After`. A
  refused stream makes `EventSource` give up; the page then polls, which keeps the ticket alive,
  and retries the stream every 3 s.
- **Privacy**: the key is stored in clear and deleted with its ticket, 5 minutes after the
  ticket ends. Hashing it would protect little: every IPv4 address can be hashed in seconds.
  IP addresses are not logged.

## Consequences

- One client can no longer monopolise a queue, and one IP cannot hold more than a few
  connections per instance.
- Visitors behind one shared address (a school, an office, a carrier-grade NAT) share one
  budget. The defaults allow a page with several embeds and a few reloads; operators expecting
  groups behind one address raise the limits.
- Without `trusted_proxies` behind a proxy, every visitor shares the proxy's address and the
  limits apply to all of them together. A too-broad `trusted_proxies` lets clients choose their
  own address. Both mistakes are documented in [Configuration](../configuration.md).
- Limits are global. A per-project setting can be added later without changing the model.
