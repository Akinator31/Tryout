# 0011 — Queue implementation choices

**Status:** accepted. Refines [0007](0007-queue-in-postgres.md).

## Context

ADR 0007 sketched the queue as leases: lock the project row, count assigned, starting, active and
draining sessions, then promote with `SKIP LOCKED`. Implementing it, two needs reshaped the
details:

- the **node cap spans projects**, so per-project row locks are not enough;
- **several control plane instances** may run at once, sharing one database.

## Decision

- **States**: `waiting → starting → active → ended`. A ticket is the lease. There is no separate
  `assigned` or `draining` state: a `starting` ticket already holds its slot, and ending is
  immediate, since the agent removes the container synchronously.
- **Promotion** runs in one transaction under a global `pg_advisory_xact_lock`. Inside it, the
  queue counts busy tickets per project and per node, then promotes waiting tickets in arrival
  order. At this volume (a few promotions per minute), one global lock is simpler than per-row
  locks and needs no `SKIP LOCKED`.
- **Schema creation** also runs under an advisory lock, because concurrent
  `CREATE … IF NOT EXISTS` statements can race.
- **Activation is conditional**: a ticket becomes `active` only if it is still `starting` when the
  session is ready. Otherwise, and whenever a start fails, the session is stopped: the visitor
  may have left before the agent created the container.
- **One deadline**: the queue aborts the runtime's start through an `AbortSignal` after 180 s, or
  as soon as the ticket ends on this instance. `tick` also expires `starting` tickets past their
  deadline, which covers an instance that died mid-start.
- **Timings**: the browser polls every 2 s, which doubles as the heartbeat. A ticket is lost after
  30 s without a poll. (The embed page now streams instead of polling; see
  [0012](0012-ticket-push-sse.md).) Ended tickets are kept 5 minutes so the page can show why they ended.
- **Clock**: times come from an injected clock (epoch milliseconds), which keeps tests
  deterministic.

## Consequences

- Instances must have synchronized clocks (NTP), because heartbeat and expiry compare timestamps
  written by different instances. Moving these comparisons to the database's `now()` is possible
  later, at the cost of an injectable clock in tests.
- A ticket that was `starting` on an instance that died is not resumed: it keeps its slot until
  its deadline (≤ 180 s), and the agent's reaper removes the container later.
- `LISTEN/NOTIFY` and SSE were added later, in [0012](0012-ticket-push-sse.md).
