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
(cd apps/control-plane && npm ci && npm run typecheck)
shellcheck scripts/*.sh examples/*/*.sh
zensical build --strict
```

End-to-end tests: see [Local quickstart](quickstart.md).

## Documentation

```bash
pip install zensical
zensical serve      # http://localhost:8000
```
