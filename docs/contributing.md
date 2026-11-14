# Contributing

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/), title only, no body
  and no trailers. Examples: `feat(agent): refuse images of another architecture`,
  `docs: describe single-host profile`, `ci: build docs with zensical`.
- **Documentation**: any change in behaviour, configuration or security updates the relevant
  page in `docs/` (and `SECURITY.md` when needed) in the same change.
- **Design choices** are discussed with the maintainer first, then explained in the page that
  covers the topic, usually [Architecture](architecture.md). There are no decision records: the
  documentation describes the project as it is.
- **Schema**: edit only `schema/tryout.schema.json`, then run `scripts/sync-schema.sh`. `go:embed`
  and the Docker build contexts cannot reach outside their directory, so the agent, the control
  plane and the docs site each keep a copy; tests and CI fail on a stale one.

## Local checks

The same checks run in CI:

```bash
(cd apps/node && test -z "$(gofmt -l .)" && go vet ./... && go test -race ./...)
(cd apps/control-plane && npm ci && npm run typecheck && npm test)
(cd apps/embed && npm ci && npm run typecheck && npm test && npm run build && npm run size)
shellcheck scripts/*.sh examples/*/*.sh
zensical build --strict
```

`npm test` runs the queue tests against PGlite, an in-process Postgres. Set
`TEST_DATABASE_URL` to run them against a real PostgreSQL, as CI does; the `LISTEN` reconnect
tests (`test/db.test.ts`) need it and are skipped otherwise.

The control plane serves the embed page from `apps/embed/dist`: build it once before running
the control plane outside Docker. `npm run dev` in `apps/embed` serves the page with live reload
and forwards `/api` to a control plane on `localhost:3000`; open
`http://localhost:5173/?project=<name>`.

End-to-end tests: see [Local quickstart](quickstart.md).

## Documentation

```bash
pip install zensical
zensical serve      # http://localhost:8000
```
