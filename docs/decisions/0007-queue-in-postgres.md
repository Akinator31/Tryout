# 0007 — Queue and leases in Postgres

**Status:** accepted, implemented

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
- Push changes to browsers with `LISTEN/NOTIFY` and SSE.

## Implementation notes

- Promotion runs in one transaction under `pg_advisory_xact_lock`. The node cap spans projects,
  so a global lock is simpler than per-row locks and cheap at this volume.
- A ticket only becomes `active` if it is still `starting` when the session is ready.
  Otherwise the fresh session is stopped: the visitor left during the start.
- A `starting` ticket expires after 180 s, which covers a control plane restarted mid-start.
- Times come from an injected clock and are stored as epoch milliseconds, which keeps tests
  deterministic.

## Consequences

- One dependency (Postgres) and no Redis.
- State survives control plane restarts; several instances can share one database.
