# Contributing

## Conventions

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/), title only, no body
  and no trailers. Examples: `feat(agent): refuse images of another architecture`,
  `docs: describe single-host profile`, `ci: build docs with zensical`.
- **Documentation**: any change in behaviour, configuration or security updates the relevant
  page in `docs/` (and `SECURITY.md` when needed) in the same change.
- **Decisions**: lasting architecture choices are recorded in `docs/decisions/`.

## Local checks

The same checks run in CI:

```bash
(cd apps/node && test -z "$(gofmt -l .)" && go vet ./... && go test -race ./...)
(cd apps/control-plane && npm ci && npm run typecheck && npm test)
shellcheck scripts/*.sh examples/*/*.sh
zensical build --strict
```

`npm test` runs the queue tests against PGlite, an in-process Postgres. Set
`TEST_DATABASE_URL` to run them against a real PostgreSQL, as CI does; the `LISTEN` reconnect
tests (`test/db.test.ts`) need it and are skipped otherwise.

End-to-end tests: see [Local quickstart](quickstart.md).

## Documentation

```bash
pip install zensical
zensical serve      # http://localhost:8000
```
