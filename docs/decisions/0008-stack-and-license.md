# 0008 — Stack and license

**Status:** accepted

## Decision

- **Node (agent, gateway): Go.** Static binaries, trivial cross-compilation to arm64, low memory
  on small nodes, a standard-library reverse proxy with WebSocket support.
- **Control plane: TypeScript on Node.js ≥ 24**, run directly thanks to native type stripping.
  The UI will be React (Chakra UI is the candidate component kit). The embed page stays minimal
  because it loads for every portfolio visitor. The kit is settled in
  [ADR 0018](0018-ui-kit.md).
- **Database: Postgres** (see [0007](0007-queue-in-postgres.md)).
- **Documentation: Zensical.**
- **License: AGPL-3.0-or-later.** Operators who run a modified version as a service must publish
  their changes.

## Consequences

- Two languages in the repository, each where it fits best.
- Multi-architecture images for *projects* remain the responsibility of their authors.
