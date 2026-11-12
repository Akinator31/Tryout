# 0012 — Push ticket changes with SSE and `LISTEN/NOTIFY`

**Status:** accepted, implemented. Carries out the push part of [0007](0007-queue-in-postgres.md)
and replaces the 2 s polling of [0011](0011-queue-implementation.md) in the embed page.

## Context

- The embed page polled `GET /api/tickets/<ticket>` every 2 s, and each poll was the heartbeat.
  A visitor learned of a promotion up to 2 s late, and every waiting visitor cost one request
  every 2 s.
- Several control plane instances may share one database (ADR 0011). A change made by one
  instance (a release, a promotion, an expiry) must reach a visitor connected to another.
- Server-sent events need no extra library in the browser (`EventSource`) and reconnect on their
  own. Postgres `LISTEN/NOTIFY` delivers notifications to every listening session when the
  transaction commits ([PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)).

## Decision

- **Endpoint**: `GET /api/tickets/<ticket>/events` streams `text/event-stream`. Each message is a
  `ticket` event whose data is the same JSON view as the poll endpoint. The server closes the
  stream after the `ended` view. An unknown ticket gets a 404 before the stream opens.
  Responses carry `cache-control: no-store` and `x-accel-buffering: no`, and the stream starts
  with `retry: 3000`.
- **Heartbeat**: an open stream is the heartbeat. `tick()` refreshes `last_seen` for every
  ticket watched on the instance. Closing the stream releases nothing by itself: the ticket is
  lost 30 s later, unless `EventSource` reconnects first. The `pagehide` beacon remains the
  explicit way to leave.
- **Notifications**: a trigger on `tickets` sends `pg_notify('tryout_tickets', project)` when a
  ticket's state changes. Heartbeat updates do not notify. The payload is the project because a
  state change can move every waiting ticket of that project. Each instance then re-reads the
  views of the tickets it streams for that project, in one query.
- **Safety net**: every 10 s, `tick()` sends a fresh view to every watcher, whether or not
  anything changed. This recovers lost notifications, keeps proxies from closing an idle
  stream, and resynchronises the page's countdown. When the `LISTEN` connection is
  re-established, every watcher gets a fresh view.
- **Module interface**: `Queue.watch(ticket, listener) → unwatch`. The queue owns the
  subscription, the heartbeat and the resynchronisation; the HTTP layer only writes events. The
  `Db` port gains `listen(channel, onNotify, onConnect)`. node-postgres uses a dedicated
  connection outside the pool and reconnects after 1 s. PGlite uses its built-in `listen`.
- **Countdown**: every `active` view carries `ends_in_s`; the page counts down locally between messages.
- **Polling stays**: `GET /api/tickets/<ticket>` still works and still counts as a heartbeat, for
  scripts and clients without `EventSource`.

## Consequences

- A promotion reaches the visitor as soon as the transaction commits, and a waiting visitor
  costs one open connection instead of one request every 2 s.
- Each instance holds one more Postgres connection, for `LISTEN`.
- The notification trigger uses `CREATE OR REPLACE TRIGGER`, so PostgreSQL 14 or later is
  required.
- Browsers allow only six HTTP/1.1 connections per origin. More than five embeds of the same
  control plane on one page would block, so serve the control plane over HTTP/2 (see
  [Public exposure](../exposure.md)).
- A peer that vanishes without closing its connection (sleeping laptop, dropped network) keeps
  its ticket alive until the TCP connection or the proxy times out, instead of 30 s. For an
  active session the project's maximum age still bounds it; a waiting ticket has no such bound
  and keeps its place in line. The server enables TCP keepalive on the stream's socket (first
  probe after 10 s): with Linux defaults (9 probes, 75 s apart) a vanished peer on a direct
  connection is dropped after about 11 minutes. Behind a proxy, the proxy's own timeouts
  apply.
- There is no cap on open streams per IP yet; it comes with the rate limiting on the
  [Roadmap](../roadmap.md).
