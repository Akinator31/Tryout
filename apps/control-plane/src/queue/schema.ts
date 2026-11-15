// The queue's Postgres storage: the tickets table, its change
// notifications, and the queries shared by the queue modules.
import type { Db } from "../db/db.ts";
import type { TicketState } from "./queue.ts";

/** NOTIFY channel carrying the project of every ticket whose state changed. */
export const CHANNEL = "tryout_tickets";

// Advisory lock keys: arbitrary constants, private to the queue modules.
export const SCHEDULER_LOCK = 0x7472796f; // "tryo"
export const SCHEMA_LOCK = 0x74727973; // "trys"
export const CLIENT_LOCK = 0x7472796c; // "tryl", paired with a hash of the client key

/**
 * Applied in order at every startup, so each statement must be idempotent.
 *
 * - `client_key` and its index were added after the table's first release, for
 *   the per-client limits; `started_at` and `end_reason` later, for the admin's
 *   sessions list and the operator's stop.
 * - The trigger notifies on state changes only: any of them may move every
 *   waiting ticket of the project, so the payload is the project. NOTIFY is
 *   sent on commit and deduplicated per transaction; heartbeats (`last_seen`)
 *   do not notify.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tickets (
  id          text PRIMARY KEY,
  seq         bigint GENERATED ALWAYS AS IDENTITY,
  project     text NOT NULL,
  node        text NOT NULL,
  state       text NOT NULL CHECK (state IN ('waiting', 'starting', 'active', 'ended')),
  session_id  text UNIQUE,
  url         text,
  error       text,
  created_at  double precision NOT NULL,
  last_seen   double precision NOT NULL,
  ends_at     double precision,
  start_deadline double precision,
  ended_at    double precision
)`,
  `CREATE INDEX IF NOT EXISTS tickets_project_state ON tickets (project, state, seq)`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS client_key text`,
  `CREATE INDEX IF NOT EXISTS tickets_client ON tickets (client_key, created_at)`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS started_at double precision`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS end_reason text`,
  `CREATE OR REPLACE FUNCTION tickets_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('${CHANNEL}', NEW.project);
  RETURN NULL;
END $$`,
  `CREATE OR REPLACE TRIGGER tickets_notify AFTER UPDATE OF state ON tickets
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION tickets_notify()`,
];

/**
 * Creates or upgrades the tickets table. Several instances may start at once
 * and `CREATE ... IF NOT EXISTS` is not race-free, so the statements run
 * under an advisory lock.
 */
export async function migrate(db: Db): Promise<void> {
  await db.tx(async (q) => {
    await q(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`);

    for (const statement of SCHEMA) {
      await q(statement);
    }
  });
}

/** A ticket as read from the table; `position` comes from SELECT_WITH_POSITION only. */
export interface Row {
  id: string;
  project: string;
  node: string;
  state: TicketState;
  session_id: string | null;
  url: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ends_at: number | null;
  /** `stopped` when the operator ended the ticket, or its project was removed. */
  end_reason: string | null;
  position: number | null;
}

/**
 * Reads the tickets whose ids are in `$1` (a text array). A waiting ticket's
 * position is 1 + the waiting tickets of the same project ahead of it.
 */
export const SELECT_WITH_POSITION = `
  SELECT t.*,
    CASE WHEN t.state = 'waiting' THEN 1 + (
      SELECT count(*)::int
      FROM tickets o
      WHERE o.project = t.project AND o.state = 'waiting' AND o.seq < t.seq
    ) END AS position
  FROM tickets t
  WHERE t.id = ANY($1::text[])`;
