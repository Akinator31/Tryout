# CLAUDE.md

Context and rules for working on this repository. Read this file in full at the start of every
session.

## What this project is

**Tryout** lets portfolio visitors try projects in their browser. Each visitor gets a dedicated,
disposable Docker container:

- **command-line** projects are served through a web terminal (**ttyd**);
- **graphical** projects are streamed through **Selkies** (WebSocket mode);
- each project has a **limit on concurrent sessions** and an app-managed **queue**;
- every session is a **fresh container** on its own `--internal` network, with no egress and a
  hardened specification; **gVisor** (`runsc`) is the default runtime.

The portfolio embeds `https://<control-plane>/embed/<project>` in an iframe.

**The project is public (GitHub, AGPL-3.0-or-later) and must not depend on the maintainer's own
infrastructure.** Everything environment-specific is configuration: Docker endpoint, node profile,
runtime, public URL template, caps. Never hard-code a domain, tunnel provider, reverse proxy,
host layout or architecture.

## Architecture (summary)

```
browser ─► control plane (TypeScript)   queue, tickets, /embed/<project>; calls nodes (never the reverse)
              ▼
           node: agent (Go)             only component with the Docker socket; hard-coded hardening
                 gateway (Go)           public reverse proxy /s/<id>/; NO Docker socket
                   ▼
                 session container      per-session --internal network; gateway attached to it
```

Key facts that are easy to forget:

- **Control plane → agent** is mutual TLS 1.3 only (ADR 0015): private CA from `tryout-certs`,
  `serverAuth` leaves for agents, a `clientAuth` leaf for the control plane, no token, no
  plain-HTTP mode. The dev compose file creates the PKI in a volume (`pki-ca`, `pki-node`).
- **Agent ↔ gateway** talk over a **unix socket in a shared volume**, never TCP: the gateway joins
  every session network, so a TCP admin port would be reachable from sessions.
- **Session URL = capability**: `/s/<26 base32 chars>/` (130 bits). There are no cookies; the
  gateway strips `Set-Cookie`, incoming `Cookie` and `Service-Worker-Allowed`, and enforces
  `frame-ancestors` and `Referrer-Policy: no-referrer`.
- **Node profiles** (`NODE_PROFILE`):
  - `dev`: anything goes, local only;
  - `strict`: dedicated machine or VM, gVisor required;
  - `single-host`: shared machine, which requires a dedicated rootless daemon, cgroup v2 and gVisor.
  
  The agent refuses to start when a profile is not met. Outside `dev`, the runtime rule is an
  allowlist: only the runtime named `runsc`, as `DEFAULT_RUNTIME` and per session, because Docker
  also lists runc as `io.containerd.runc.v2`. `ALLOW_RUNC=true` is the documented opt-out and
  unlocks every runtime.
- **Desktop sessions**:
  - LinuxServer/Selkies images need `CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE`, `FOWNER` and
    `KILL` for their s6 init. Everything else is dropped.
  - The agent sets `SUBFOLDER=/s/<id>/` for base-path routing.
  - It also sets defaults a project may override: 720p, 96 DPI, 15–30 fps, audio off.
  - It locks, with no override: file transfer, microphone, webcam, printing, gamepads, second
    screen.
- **Measured costs**: gVisor uses 2–2.5× the CPU of runc for Selkies desktops on a Raspberry Pi 5,
  with negligible overhead for terminals. Without the resolution cap, a HiDPI client pushes near-4K
  at 60 fps and saturates a small node.
- **Config schema**: `schema/tryout.schema.json` validates the control plane's YAML and the
  agent's `POST /v1/sessions` body (`$defs/workload` is shared). Edit only that file, then run
  `scripts/sync-schema.sh` to refresh its three copies; tests and CI fail on a stale copy.
- **Docker client**: a hand-written Engine API client (`apps/node/internal/dockerapi`, API
  v1.47), with no SDK dependency.
- **Docker Desktop**: its socket is `root:root` inside the VM, which is why the dev compose runs
  the agent as root.

## Repository layout

```
apps/control-plane/   TypeScript, Node ≥ 24 (native type stripping); queue.ts is the core module
apps/node/            Go: cmd/agent, cmd/gateway, cmd/certs, internal/{dockerapi,pki,spec}; one image
deploy/               compose.dev.yaml, tryout.dev.yaml, .env.example (dev); node/, control-plane/ (production
                      examples from published images, docs/deployment.md)
schema/               tryout.schema.json (source of truth) + testdata/ fixtures shared by TS and Go
examples/cli-hello/   sample terminal project (ttyd)
scripts/              e2e-*.ts (cli, queue, sse, mtls, limits, reattach), e2e-deploy.sh, check-image.sh,
                      feasibility-node.sh
docs/                 Zensical documentation (English); decisions/ holds the ADRs
SECURITY.md           threat model and profiles (included in the docs site)
```

## Documentation to read

Read these regularly to keep the project's behaviour in mind:

- before any change: `docs/architecture.md` and `SECURITY.md`;
- before touching a topic: the related `docs/decisions/*.md`;
- `docs/roadmap.md` for the milestones (M1–M5), what is provisional and what comes next.

Background research (not part of the repository) lives in `../Tryout-research/`: a hyperresearch
vault with the original stack study (in French) and its sources.

## Current status

- The proof of concept has been validated end to end:
  - terminal and desktop sessions, queue, heartbeat loss, cleanup, network isolation, profile
    refusal;
  - Selkies under gVisor on a Raspberry Pi 5 (arm64), behind a base path.
- The roadmap is organised in milestones (`docs/roadmap.md`): M1 Deployable is done
  (ghcr.io images, ADR 0013; YAML config + JSON Schema, ADR 0014; mTLS, ADR 0015; per-IP limits,
  ADR 0016; exit criteria checked on fresh VMs). M2 Live in progress:
  - registry credentials for private project images (ADR 0017);
  - production deployment guide and example compose files (`docs/deployment.md`), tested in CI
    by `scripts/e2e-deploy.sh` with gVisor; `scripts/e2e-mtls.ts` checks any agent with `--pki`;
  - the reconcile loop reattaches a recreated gateway (`scripts/e2e-reattach.ts`) and reaps
    containers stuck in `created`;
  - packaging guide (`docs/packaging.md`) and `scripts/check-image.sh`.

  Then M3 Design (theme, Figma, React embed; the UI kit is chosen there), M4 Operate, M5
  Hosting options.
- CI publishes `tryout-node`, `tryout-control-plane` and `tryout-example-cli-hello` to
  `ghcr.io/<owner>/` (`edge`, `sha-*`, semver on `v*` tags) after all tests pass.
- Repository: <https://github.com/Akinator31/Tryout> (Go module
  `github.com/Akinator31/Tryout/apps/node`, docs at <https://akinator31.github.io/Tryout/>).
- Queue state is in Postgres (`apps/control-plane/src/queue.ts`, ADRs 0007 and 0011), tested through its
  interface with PGlite locally and PostgreSQL in CI.
- Ticket changes are pushed over SSE (`GET /api/tickets/<id>/events`), with Postgres
  `LISTEN/NOTIFY` across instances; the open stream is the heartbeat (ADR 0012). Polling remains
  for scripts.
- UI work (React embed page, admin) starts from the maintainer's **Figma** designs, following the
  M3 design steps in `docs/roadmap.md`. The Figma file's location is in the persistent memory.

## Workflow skills

The `mattpocock-skills:*` skills are available. Use them at these moments:

| Moment | Skill |
|---|---|
| Before a large piece of work (queue model, mTLS, config format…) | `grilling`, to stress-test the design with the maintainer |
| Before restructuring a component or adding a module | `codebase-design` |
| Implementing behaviour with clear rules (queue, leases, agent policy) | `tdd` |
| Naming and domain vocabulary | `domain-modeling`; ADRs stay in `docs/decisions/` |
| Exploring a UI from the Figma designs | `prototype` |
| Steps only a human can do (rootless daemon, gVisor, KVM VM, tunnels) | `wizard` |
| A real bug or a regression | `diagnosing-bugs` |
| Before opening or merging a PR | `code-review`, including the security invariants below |
| Editing this file | `writing-for-agents` |

The rules below take precedence over any skill convention: commit format, no AI mentions, ADR
location, English only.

## Commands

```bash
# Go (node)
(cd apps/node && test -z "$(gofmt -l .)" && go vet ./... && go test -race ./...)
# TypeScript (control plane)
(cd apps/control-plane && npm ci && npm run typecheck && npm test)   # TEST_DATABASE_URL for real Postgres
# Shell
shellcheck scripts/*.sh examples/*/*.sh
# Docs
zensical build --clean --strict      # or: zensical serve
# Full local stack + end-to-end tests
docker build -t tryout-example/cli-hello:dev examples/cli-hello
cp deploy/.env.example deploy/.env
docker compose -f deploy/compose.dev.yaml up -d --build
node scripts/e2e-cli.ts && node scripts/e2e-queue.ts && node scripts/e2e-sse.ts && node scripts/e2e-mtls.ts \
  && node scripts/e2e-limits.ts \
  && node scripts/e2e-reattach.ts http://localhost:3000 cli-hello -- \
       docker compose -f deploy/compose.dev.yaml up -d --force-recreate --no-deps gateway
docker compose -f deploy/compose.dev.yaml down -v
# Production layout (deploy/node + deploy/control-plane); defaults to strict + gVisor.
# Docker Desktop: NODE_PROFILE=dev HOST_ADDR=host.docker.internal BIND_ADDR=127.0.0.1 CHOWN_CMD=: DOCKER_GID=0
scripts/e2e-deploy.sh
```

CI (`.github/workflows/ci.yml`) runs all of the above, plus multi-arch image builds.
`.github/workflows/docs.yml` builds the Zensical site and deploys it to GitHub Pages from `main`.

## Rules

- **Language**: everything in the repository is in English: code, comments, docs, commits, PRs,
  issues. The maintainer writes in French; answer in French in conversation.
- **Commits**: follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`,
  `docs`, `ci`, `build`, `refactor`, `test`, `chore`, with an optional scope such as
  `feat(agent): …`), including documentation changes (`docs: …`).
  - **Title only.** No body, no description, no `Co-Authored-By` or any other trailer.
- **No mention of AI** (Claude, assistant, generated by…) in commits, PRs, issues, review comments,
  release notes or any other GitHub content.
- **Always update the documentation** when a change affects behaviour, configuration, security or
  operations, in the same change: the relevant `docs/` page, `SECURITY.md`, and a new ADR in
  `docs/decisions/` for lasting architecture choices. Keep the "Current status" section above up to
  date.
- **Keep the docs in mind**: re-read the relevant pages (see above) before designing or changing
  something, rather than relying on memory.
- **Pull requests**: open one when a feature is finished, after running `code-review` and fixing
  its findings. Check Dependabot PRs regularly and recommend merge or close; ask the maintainer
  before merging or closing.
- **Remember across sessions**: save anything worth keeping between sessions in the persistent
  memory: decisions, the maintainer's preferences, environment facts that must not go into this
  public repository. Update this file when the project's state or rules change.
- **Security invariants** (do not weaken without an ADR and a `SECURITY.md` update):
  - only the agent has a Docker socket;
  - PostgreSQL is reachable by the control plane only;
  - the hardening is hard-coded in the agent, not configurable;
  - sessions have no egress;
  - nodes never call the control plane;
  - the gateway admin API never listens on TCP.
