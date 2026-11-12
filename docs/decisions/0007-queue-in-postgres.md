# 0007 — Queue and leases in Postgres

**Status:** accepted, implemented; refined by [0011](0011-queue-implementation.md)

## Context

- The queue must enforce a per-project concurrency cap and survive restarts. BullMQ's
  per-group concurrency is a Pro feature
  ([BullMQ Pro groups](https://docs.bullmq.io/bullmq-pro/groups/concurrency)).
- Postgres row locking with `SKIP LOCKED` is a well-known queue pattern
  ([PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html)).
- JupyterHub's idle culler gives a reference for idle timeouts
  ([jupyterhub-idle-culler](https://github.com/jupyterhub/jupyterhub-idle-culler)).

## Decision

- Model sessions as **leases**, not jobs.
- To admit a ticket: lock the project row, count assigned, starting, active and draining
  sessions, then promote the oldest waiting ticket with `SKIP LOCKED`.
- Timings: heartbeat ~10 s, lease lost after ~30 s, maximum age per project.
- Push changes to browsers with `LISTEN/NOTIFY` and SSE (implemented in
  [0012](0012-ticket-push-sse.md)).

## Consequences

- One dependency (Postgres) and no Redis.
- State survives control plane restarts; several instances can share one database.
- How the decision was implemented, and where it departs from the text above, is recorded in
  [0011](0011-queue-implementation.md).
